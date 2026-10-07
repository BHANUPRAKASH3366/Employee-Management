"""
Live portal server.

Serves the portal at http://localhost:<port>/ and watches the Excel workbook.
Every time the workbook is saved, the data is rebuilt and every open portal page
refreshes itself within a few seconds — no manual steps.

Usage:
    python scripts/live_server.py            (settings from portal.config.json)
    python scripts/live_server.py --no-browser
    python scripts/live_server.py --excel "path/to/workbook.xlsx" --port 8765

Endpoints:
    /api/status   {"version", "builtAt", "sourceModified", "error", ...}
    /api/data     the full portal data (same shape as portal/data/vct-data.js)
    /api/attendance          attendance report from the HRMS file + email history
    /api/attendance/send     (POST) email the current attendance report again
    /api/chat/status         AI Chatbot: local model + data sources
    /api/chat                (POST) {"question", "history"} → {"reply", ...}  (scripts/chatbot.py)
"""
import json
import shutil
import sys
import tempfile
import threading
import time
import traceback
import webbrowser
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audit  # noqa: E402
import build_data  # noqa: E402
try:  # attendance alerts (scripts/attendance.py) — optional; the portal runs without it
    import attendance  # noqa: E402
except Exception:  # pragma: no cover
    attendance = None
try:  # AI Chatbot (scripts/chatbot.py) — optional; the portal runs without it
    import chatbot  # noqa: E402
except Exception:  # pragma: no cover
    chatbot = None

ROOT = build_data.ROOT
PORTAL = ROOT / "portal"


def load_config():
    cfg = {"excelPath": str(build_data.default_workbook()), "host": "127.0.0.1", "port": 8765, "checkEverySeconds": 3}
    if build_data.CONFIG.exists():
        cfg.update(json.loads(build_data.CONFIG.read_text(encoding="utf-8")))
    args = sys.argv[1:]
    for flag, key in (("--excel", "excelPath"), ("--port", "port"), ("--host", "host")):
        if flag in args and args.index(flag) + 1 < len(args):
            cfg[key] = args[args.index(flag) + 1]
    return cfg


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


class LiveData:
    """Holds the latest good build; rebuilds when the workbook changes."""

    def __init__(self, excel_path, interval):
        self.path = Path(excel_path)
        self.interval = max(1, float(interval))
        self.lock = threading.Lock()
        self.version = 0
        self.data_json = b"{}"
        self.status = {"version": 0, "builtAt": None, "sourceModified": None, "error": None,
                       "source": self.path.name, "employees": 0}
        self.auditor = None    # change tracking + HR alerts (scripts/audit.py)
        self._seen = None      # (mtime, size) of the last build attempt
        self._pending = None   # change seen once; build when it's stable

    def _signature(self):
        st = self.path.stat()
        return (st.st_mtime_ns, st.st_size)

    def rebuild(self):
        # Copy first: Excel may hold the file open, and a half-written file must not reach viewers.
        with tempfile.TemporaryDirectory() as tmp:
            copy = Path(tmp) / self.path.name
            shutil.copy2(self.path, copy)
            data = build_data.build(copy)
            if self.auditor:
                try:
                    self.auditor.observe(copy)
                except Exception:
                    log("Change tracking failed:\n" + traceback.format_exc())
        data["meta"]["source"] = self.path.name
        data["meta"]["mode"] = "live"
        modified = datetime.fromtimestamp(self.path.stat().st_mtime).isoformat(timespec="seconds")
        data["meta"]["sourceModified"] = modified
        with self.lock:
            self.version += 1
            data["meta"]["version"] = self.version
            self.data_json = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
            self.status.update({
                "version": self.version, "builtAt": data["meta"]["generatedAt"], "sourceModified": modified,
                "error": None, "employees": len(data["employees"]),
            })
        # Keep the double-click snapshot (portal/data/vct-data.js) current too.
        if "--no-snapshot" not in sys.argv:
            try:
                build_data.write_snapshot(data)
            except OSError as e:
                log(f"Could not update snapshot file: {e}")
        log(f"Data updated (v{self.version}) — {len(data['employees'])} employees from {self.path.name}")

    def check(self):
        try:
            sig = self._signature()
        except FileNotFoundError:
            self._set_error(f"Workbook not found: {self.path}")
            return
        if sig == self._seen:
            return
        if self._pending != sig:
            # Wait one more interval so we don't read a file that is still being saved.
            self._pending = sig
            return
        self._seen = sig
        self._pending = None
        try:
            self.rebuild()
        except PermissionError:
            self._seen = None  # file locked mid-save; try again next round
        except Exception as e:  # keep serving the last good data
            self._set_error(f"Could not read the workbook: {e}")
            log(traceback.format_exc())

    def _set_error(self, msg):
        with self.lock:
            if self.status.get("error") != msg:
                log(msg)
            self.status["error"] = msg

    def watch(self):
        while True:
            time.sleep(self.interval)
            self.check()

    def snapshot(self):
        with self.lock:
            return self.data_json, dict(self.status)


class Handler(SimpleHTTPRequestHandler):
    live = None
    attendance = None  # attendance.AttendanceWatcher, when available
    chat = None  # chatbot.ChatService, when available

    def log_message(self, *args):
        pass

    def _send(self, body, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        route = self.path.split("?")[0]
        if route == "/api/status":
            _, status = self.live.snapshot()
            return self._send(json.dumps(status).encode("utf-8"), "application/json; charset=utf-8")
        if route == "/api/changes":
            pending = self.live.auditor.pending() if self.live.auditor else None
            body = json.dumps({"events": audit.read_events(), "alerts": audit.alerts_status(), "pending": pending},
                              ensure_ascii=False, default=str)
            return self._send(body.encode("utf-8"), "application/json; charset=utf-8")
        if route == "/api/attendance":
            body = self.attendance.status() if self.attendance else {"error": "Attendance alerts are not available."}
            return self._send(json.dumps(body, ensure_ascii=False, default=str).encode("utf-8"), "application/json; charset=utf-8")
        if route == "/api/chat/status":
            body = self.chat.status() if self.chat else {"enabled": False, "error": "The AI Chatbot is not available."}
            return self._send(json.dumps(body, ensure_ascii=False, default=str).encode("utf-8"), "application/json; charset=utf-8")
        if route == "/api/data":
            body, status = self.live.snapshot()
            if not status["version"]:
                return self._send(json.dumps({"error": status["error"] or "Data not ready"}).encode(), "application/json", 503)
            return self._send(body, "application/json; charset=utf-8")
        return super().do_GET()

    def do_POST(self):
        route = self.path.split("?")[0]
        if route == "/api/attendance/send" and self.attendance:
            try:
                res = self.attendance.send_now()
            except Exception as e:
                res = {"status": "failed", "detail": f"Email failed: {e}"}
            return self._send(json.dumps(res, default=str).encode("utf-8"), "application/json; charset=utf-8")
        if route == "/api/chat":
            if not self.chat:
                res = {"reply": "The AI Chatbot is not available on this server.", "error": True}
            else:
                try:
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(min(n, 200000)) or b"{}")
                    res = self.chat.ask(str(body.get("question") or ""), body.get("history") or [])
                except Exception as e:
                    res = {"reply": f"Sorry, something went wrong: {e}", "error": True}
            return self._send(json.dumps(res, ensure_ascii=False, default=str).encode("utf-8"), "application/json; charset=utf-8")
        if route == "/api/attendance/settings" and self.attendance:
            # Changing who gets emails is only allowed from this computer, unless "allowRemoteSettings" is true.
            local = self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")
            if not local and not load_config().get("allowRemoteSettings"):
                return self._send(json.dumps({"ok": False, "message": "Email settings can only be changed on the computer running the portal."}).encode("utf-8"),
                                  "application/json; charset=utf-8", 403)
            try:
                n = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(min(n, 65536)) or b"{}")
                ok, msg = self.attendance.update_recipients(body.get("hrEmails"), body.get("ceoEmails"), body.get("ccEmails"))
            except Exception as e:
                ok, msg = False, f"Could not save: {e}"
            return self._send(json.dumps({"ok": ok, "message": msg}).encode("utf-8"), "application/json; charset=utf-8", 200 if ok else 400)
        return self._send(b'{"error":"not found"}', "application/json", 404)


def main():
    cfg = load_config()
    live = LiveData(cfg["excelPath"], cfg.get("checkEverySeconds", 3))
    if "--audit-dir" in sys.argv:  # used by tests so they don't touch the real change log
        audit.set_audit_dir(Path(sys.argv[sys.argv.index("--audit-dir") + 1]))
    live.auditor = audit.Auditor(live.path.name, log=log)
    st = audit.alerts_status()
    log("HR alerts: " + ("email to " + ", ".join(st["hrEmails"]) if st["emailConfigured"] else
                         "email not configured yet — alerts are saved to audit/outbox and shown on the Change Log page"))
    log(f"Reading {live.path}")
    try:
        live.check()
        live.check()  # second call builds immediately on start-up
    except Exception as e:
        log(f"Start-up build failed: {e}")
    threading.Thread(target=live.watch, daemon=True).start()
    if attendance:
        try:
            if "--audit-dir" in sys.argv:
                attendance.set_dir(Path(sys.argv[sys.argv.index("--audit-dir") + 1]) / "attendance")
            att = attendance.AttendanceWatcher(log=log)
            Handler.attendance = att
            threading.Thread(target=att.watch, daemon=True).start()
            log("Attendance alerts: watching " + (str(att.path()) if att.path() else "— no HRMS file set (attendance.hrmsPath)"))
        except Exception as e:
            log(f"Attendance alerts not started: {e}")

    if chatbot:
        try:
            Handler.chat = chatbot.ChatService(log=log)
            llm = Handler.chat.bot.cfg["llm"]
            log(f"AI Chatbot: {llm['model']} via {llm['provider']} at {llm['baseUrl']}")
        except Exception as e:
            log(f"AI Chatbot not started: {e}")

    Handler.live = live
    host, port = cfg.get("host", "127.0.0.1"), int(cfg.get("port", 8765))
    server = ThreadingHTTPServer((host, port), partial(Handler, directory=str(PORTAL)))
    url = f"http://{'localhost' if host in ('127.0.0.1', '0.0.0.0') else host}:{port}/"
    log(f"Portal running at {url}  (watching for saves every {live.interval:g}s — Ctrl+C to stop)")
    if host == "0.0.0.0":
        log("Shared on the network: others can open http://<this-computer's-IP>:%d/" % port)
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("Stopped.")


if __name__ == "__main__":
    main()
