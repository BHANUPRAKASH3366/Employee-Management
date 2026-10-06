"""
Change tracking and HR alerts for the live workbook.

Every time the live server sees a new save of the workbook, it calls
Auditor.observe(). The auditor compares the saved file with the previous
version, field by field, and records what changed (before → after) and who
saved it. Saves that follow each other quickly by the same person are grouped
into one alert. Each alert is written to audit/changes.jsonl, shown on the
portal's Change Log page and emailed to HR.

Who saved the file comes from the workbook's "Last modified by" property,
which desktop Excel fills in with the user's Office name. That name is matched
to the employee roster (or editors.json) to find the employee ID, name and
email. For a verified identity, the workbook should live on OneDrive/SharePoint
or Google Drive, whose version history records the signed-in account.

Usage:
    python scripts/audit.py --test-email     send a test alert to the HR address(es)
"""
import datetime as dt
import hashlib
import html
import json
import os
import smtplib
import ssl
import sys
import threading
import time
import traceback
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from pathlib import Path

import openpyxl

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_data  # noqa: E402

ROOT = build_data.ROOT
AUDIT_DIR = ROOT / "audit"
LOG_FILE = AUDIT_DIR / "changes.jsonl"
SNAPSHOT_FILE = AUDIT_DIR / "last_snapshot.json"
OUTBOX = AUDIT_DIR / "outbox"

# Columns people type into on Headcount Data (helper/formula columns are ignored).
EMPLOYEE_FIELDS = [
    "EMP ID", "Employee Name", "Email", "Sector", "Project", "First Project %", "Level", "Designation", "Domain",
    "Reports To", "Billed Status", "Earning", "YOE", "Baseline Sector", "Baseline Project", "Baseline Level",
    "Second Sector", "Second Project", "Second Billed Status", "Second Project %",
]
EMAIL_HEADERS = ["Email", "Email ID", "Email Address", "Official Email", "Mail ID", "E-mail"]
# Header row per sheet, used to label changed cells ("Services › FLC — Project Lead").
# Every sheet is tracked; sheets not listed are labelled by column letter.
HEADER_ROWS = {"Projects": 1, "Operating Model": 3, "KPI_Master": 1, "Product Development KPI": 2, "Headcount Data": 3,
               "Headcount Summary": 5, "KPI Reviews": 1, "KPI score card": 8}
PEOPLE_MAPPING_HEADER = 7  # Overall / sector sheets: project names are in row 7
SNAPSHOT_FORMAT = 2        # bump when snapshot() changes, so an upgrade doesn't look like a mass edit
FORMULA = "(formula)"      # employee fields that hold a formula
FORMULA_PREFIX = "ƒ:"      # other cells: "ƒ:<hash of the formula>", so an edited formula is detected


def set_audit_dir(path):
    """Keep the change log somewhere else (tests)."""
    global AUDIT_DIR, LOG_FILE, SNAPSHOT_FILE, OUTBOX
    AUDIT_DIR = Path(path)
    LOG_FILE, SNAPSHOT_FILE, OUTBOX = AUDIT_DIR / "changes.jsonl", AUDIT_DIR / "last_snapshot.json", AUDIT_DIR / "outbox"


def now_iso():
    return dt.datetime.now().isoformat(timespec="seconds")


def load_config():
    cfg = json.loads(build_data.CONFIG.read_text(encoding="utf-8")) if build_data.CONFIG.exists() else {}
    a = cfg.get("alerts", {})
    a.setdefault("enabled", True)
    a.setdefault("hrEmails", [])
    a.setdefault("groupChangesWithinSeconds", 20)
    a.setdefault("emailSavesWithoutChanges", False)
    a.setdefault("subjectPrefix", "[VCT Portal]")
    a.setdefault("smtp", {})
    a.setdefault("editorsFile", "editors.json")
    a.setdefault("portalUrl", "")
    return a


# ---------------------------------------------------------------- snapshot & diff
def _formula_sig(text):
    return FORMULA_PREFIX + hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def _norm(v):
    if v is None:
        return None
    if isinstance(v, str):
        if v.startswith("="):
            return FORMULA
        v = v.strip()
        return v or None
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    return v


def snapshot(path):
    """Everything a person can type into the workbook, as plain values."""
    wb = openpyxl.load_workbook(path, data_only=False, read_only=True)
    try:
        props = wb.properties
        snap = {
            "format": SNAPSHOT_FORMAT,
            "meta": {
                "lastModifiedBy": (props.lastModifiedBy or "").strip() or None,
                "modified": props.modified.isoformat() if props.modified else None,
                "fileModified": dt.datetime.fromtimestamp(Path(path).stat().st_mtime).isoformat(timespec="seconds"),
            },
            "employees": {},
            "cells": {},
        }
        ws = build_data.sheet(wb, build_data.HEADCOUNT_SHEET)
        rows = list(ws.iter_rows(values_only=True))
        header = [build_data.clean(h) for h in (rows[2] if len(rows) > 2 else [])]
        cols = {}
        for f in EMPLOYEE_FIELDS:
            names = EMAIL_HEADERS if f == "Email" else [f]
            # Second-assignment headers repeat earlier names ("Project"); take the last block for "Second …".
            idx = [i for i, h in enumerate(header) if h in names]
            if idx:
                cols[f] = idx[0]
        for r_i, row in enumerate(rows[3:], start=4):
            vals = {f: _norm(row[i]) if i < len(row) else None for f, i in cols.items()}
            if not vals.get("Employee Name") and not vals.get("EMP ID"):
                continue
            key = str(vals.get("EMP ID") or f"row {r_i}")
            vals["_row"] = r_i
            snap["employees"][key] = vals
        # Every other cell on every sheet: typed values, plus a fingerprint of each formula.
        # Formula *results* are not compared — they change whenever the data does.
        emp_cols = set(cols.values())
        for ws2 in wb.worksheets:
            name = ws2.title.strip()
            rows2 = rows if name == build_data.HEADCOUNT_SHEET else list(ws2.iter_rows(values_only=True))
            hdr_row = HEADER_ROWS.get(name)
            if hdr_row is None and len(rows2) > 7 and rows2[6] and build_data.clean(rows2[6][0]) == "Project":
                hdr_row = PEOPLE_MAPPING_HEADER
            hdr = [build_data.clean(h) if not (isinstance(h, str) and h.startswith("=")) else None
                   for h in rows2[hdr_row - 1]] if hdr_row and len(rows2) >= hdr_row else []
            row_label = ""
            for r_i, row in enumerate(rows2, start=1):
                labels = [str(x).strip() for x in row[:2]
                          if isinstance(x, (str, int, float)) and str(x).strip() and not str(x).startswith("=")]
                if labels:
                    row_label = " › ".join(labels)[:80]
                for c, raw in enumerate(row):
                    if name == build_data.HEADCOUNT_SHEET and r_i >= 4 and c in emp_cols:
                        continue  # covered by the employee records above
                    v = _formula_sig(raw) if isinstance(raw, str) and raw.startswith("=") else _norm(raw)
                    if v is None:
                        continue
                    letter = openpyxl.utils.get_column_letter(c + 1)
                    col_label = hdr[c] if hdr_row and r_i > hdr_row and c < len(hdr) and hdr[c] else f"column {letter}"
                    is_label_cell = c < 2 and isinstance(raw, (str, int, float)) and not str(raw).startswith("=")
                    if is_label_cell or not row_label or (hdr_row and r_i <= hdr_row):
                        label = f"Row {r_i}, {col_label}"  # the row's own label cell, or above the table
                    else:
                        label = f"{row_label} — {col_label}"
                    snap["cells"][f"{name}!{letter}{r_i}"] = {
                        "v": v if not (isinstance(v, str) and len(v) > 400) else v[:400] + "…", "label": label}
        return snap
    finally:
        wb.close()


def diff(a, b):
    """What changed from snapshot a to snapshot b."""
    ea, eb = a["employees"], b["employees"]
    out = {"added": [], "removed": [], "modified": [], "cells": []}
    for k, rec in eb.items():
        if k not in ea:
            out["added"].append(_public(rec))
    for k, rec in ea.items():
        if k not in eb:
            out["removed"].append(_public(rec))
    for k in eb:
        if k in ea:
            fields = [{"field": f, "before": ea[k].get(f), "after": eb[k].get(f)}
                      for f in EMPLOYEE_FIELDS if ea[k].get(f) != eb[k].get(f)]
            if fields:
                out["modified"].append({"empId": eb[k].get("EMP ID") or k, "name": eb[k].get("Employee Name") or ea[k].get("Employee Name"),
                                        "row": eb[k].get("_row"), "fields": fields})
    ca, cb = a["cells"], b["cells"]
    for key in sorted(set(ca) | set(cb), key=_cell_sort):
        va, vb = ca.get(key, {}).get("v"), cb.get(key, {}).get("v")
        if va != vb:
            out["cells"].append({"cell": key, "label": (cb.get(key) or ca.get(key))["label"], "before": va, "after": vb})
    return out


def _cell_sort(key):
    sheet, ref = key.split("!")
    letters = "".join(ch for ch in ref if ch.isalpha())
    digits = "".join(ch for ch in ref if ch.isdigit()) or "0"
    return (sheet, int(digits), len(letters), letters)


def _public(rec):
    return {k: v for k, v in rec.items() if not k.startswith("_") and v is not None}


def change_count(d):
    return len(d["added"]) + len(d["removed"]) + sum(len(m["fields"]) for m in d["modified"]) + len(d["cells"])


# ---------------------------------------------------------------- who edited
def load_editors(cfg):
    """editors.json maps an Office name / login / email to an employee ID, for names that
    don't match the roster exactly, e.g. {"kauth": "VC_242", "priya.k@vconnectech.in": "VC_050"}."""
    p = ROOT / cfg.get("editorsFile", "editors.json")
    if not p.exists():
        return {}
    data = json.loads(p.read_text(encoding="utf-8"))
    return {str(k).strip().lower(): v for k, v in data.items() if not str(k).startswith("_")}


def resolve_editor(recorded, snap, editors):
    """Find the employee behind the 'Last modified by' name."""
    result = {"recorded": recorded, "matched": False, "empId": None, "name": None, "email": None, "how": None}
    if not recorded:
        result["how"] = "The file does not record who saved it (saved by a program that doesn't stamp the author)."
        return result
    roster = list(snap["employees"].values())
    key = recorded.strip().lower()
    squash = lambda s: "".join(ch for ch in str(s).lower() if ch.isalnum())
    emp, how = None, None
    target = editors.get(key)
    if target:
        emp = next((e for e in roster if str(e.get("EMP ID", "")).lower() == str(target).lower()), None)
        how = "editors.json"
        if not emp and isinstance(target, dict):
            result.update({"matched": True, "empId": target.get("empId"), "name": target.get("name"),
                           "email": target.get("email"), "how": "editors.json"})
            return result
    if not emp:
        emp = next((e for e in roster if e.get("Email") and str(e["Email"]).lower() == key), None)
        how = "email" if emp else how
    if not emp:
        emp = next((e for e in roster if str(e.get("EMP ID", "")).lower() == key), None)
        how = "employee ID" if emp else how
    if not emp:
        emp = next((e for e in roster if e.get("Employee Name") and squash(e["Employee Name"]) == squash(recorded)), None)
        how = "name" if emp else how
    if emp:
        result.update({"matched": True, "empId": emp.get("EMP ID"), "name": emp.get("Employee Name"),
                       "email": emp.get("Email"), "how": f"matched by {how}"})
    else:
        result["how"] = "Name not found in the employee roster or editors.json."
    return result


# ---------------------------------------------------------------- email
def _fmt(v):
    if v is None:
        return "(empty)"
    if v == FORMULA or (isinstance(v, str) and v.startswith(FORMULA_PREFIX)):
        return "(formula)"
    if isinstance(v, float):
        return f"{v:g}"
    return str(v)


def build_email(event, cfg):
    """Alert email — "colour banner + change list" layout (blue = edits, green = employees added, red = rows removed)."""
    ed = event["editor"]
    d = event["changes"]
    n = event["count"]
    saved = dt.datetime.fromisoformat(event["savedAt"])
    when = saved.strftime("%d %b %Y, %I:%M %p")
    who = ed["name"] or ed["recorded"] or "Unknown person"
    who_full = (f"{ed['name']} ({ed['empId']})" if ed["empId"] else ed["name"]) if ed["matched"] and ed["name"] \
        else (f"{ed['recorded']} (Excel name)" if ed["recorded"] else "an unknown person")
    is_save = event.get("type") == "save"
    people = len({m["empId"] for m in d["modified"]}) + len(d["added"]) + len(d["removed"])

    # Banner colour + wording by what happened.
    if is_save:
        tone, icon, kind = ("#64748b", "#94a3b8"), "💾", "Save"
        head = "Workbook saved — no data changed"
    elif d["removed"]:
        tone, icon, kind = ("#9f1239", "#e11d48"), "⚠️", "Removed"
        head = f"{len(d['removed'])} employee row{'s' if len(d['removed']) != 1 else ''} removed" + \
               (f" · {n} change{'s' if n != 1 else ''} in total" if n != len(d["removed"]) else "")
    elif d["added"] and not d["modified"] and not d["cells"]:
        tone, icon, kind = ("#14532d", "#16a34a"), "➕", "Added"
        head = f"{len(d['added'])} new employee{'s' if len(d['added']) != 1 else ''} added"
    else:
        tone, icon, kind = ("#0b3d91", "#006edb"), "✏️", "Edit"
        head = f"{n} change{'s' if n != 1 else ''} in the employee workbook"

    # Subject: what + who it's about + when, so the inbox line alone tells the story.
    if len(d["modified"]) == 1 and not d["added"] and not d["removed"]:
        m = d["modified"][0]
        about = f"{m['name']} ({m['empId']})"
    elif people == 1 and d["added"]:
        about = f"{d['added'][0].get('Employee Name', '')} ({d['added'][0].get('EMP ID', '')})"
    elif people == 1 and d["removed"]:
        about = f"{d['removed'][0].get('Employee Name', '')} ({d['removed'][0].get('EMP ID', '')})"
    elif people:
        about = f"{people} employees"
    else:
        about = "workbook cells"
    subject = f"{cfg['subjectPrefix']} [{kind}] {n} change{'s' if n != 1 else ''} · {about} · {saved:%d %b %I:%M %p}" if not is_save \
        else f"{cfg['subjectPrefix']} [Save] Workbook saved by {who} — no data changes"

    # ---- plain-text part (shown by mail apps that don't display HTML)
    lines = [head, f"{when} · by {who_full}", ""]
    for m in d["modified"]:
        lines.append(f"{m['name']} ({m['empId']})")
        for f in m["fields"]:
            lines.append(f"    {f['field']}: {_fmt(f['before'])}  →  {_fmt(f['after'])}")
    for a in d["added"]:
        lines.append(f"NEW EMPLOYEE  {a.get('Employee Name', '')} ({a.get('EMP ID', '')})")
        lines.append("    " + ", ".join(f"{k}: {_fmt(v)}" for k, v in a.items() if k not in ("EMP ID", "Employee Name")))
    for r in d["removed"]:
        lines.append(f"REMOVED       {r.get('Employee Name', '')} ({r.get('EMP ID', '')})")
        lines.append("    was: " + ", ".join(f"{k}: {_fmt(v)}" for k, v in r.items() if k not in ("EMP ID", "Employee Name")))
    for c in d["cells"]:
        lines.append(f"CELL {c['cell']} ({c['label']}): {_fmt(c['before'])}  →  {_fmt(c['after'])}")
    lines += ["", f"File: {event['source']}"]
    if not ed["matched"]:
        lines.append("Editor not linked to an employee (Excel name shown) — add it to editors.json once.")
    if event.get("offline"):
        lines.append("Edited while the portal was not running; the editor shown is the last person who saved.")
    if cfg.get("portalUrl"):
        lines.append(f"Open alerts: {cfg['portalUrl'].rstrip('/')}/#/changes")
    text = "\n".join(lines)

    # ---- HTML part (tables + inline styles so Gmail / Outlook / phones all render it the same)
    e = html.escape
    pill = lambda label, bg, fg: f'<span style="display:inline-block;background:{bg};color:{fg};font-size:12px;font-weight:700;padding:2px 9px;border-radius:99px">{e(label)}</span>'
    old_new = lambda b, a: (f'<span style="color:#be123c;text-decoration:line-through">{e(_fmt(b))}</span> '
                            f'<span style="color:#9aa6b8">&rarr;</span> <b style="color:#15803d">{e(_fmt(a))}</b>')
    who_cell = lambda name, eid: f'<b style="font-size:14px">{e(name or "")}</b><div style="font-size:12px;color:#7b879b">{e(eid or "")}</div>'
    td_l = 'style="padding:12px 12px 12px 0;border-bottom:1px solid #eef1f6;width:36%;vertical-align:top"'
    td_r = 'style="padding:12px 0;border-bottom:1px solid #eef1f6;vertical-align:top;font-size:14px;line-height:1.5"'
    rows, shown = [], 0
    for m in d["modified"]:
        if shown >= 300:
            break
        changes = "".join(f'<div style="margin:0 0 8px">{pill(f["field"], "#e8f2fd", "#0058b0")}<br>{old_new(f["before"], f["after"])}</div>'
                          for f in m["fields"])
        rows.append(f"<tr><td {td_l}>{who_cell(m['name'], m['empId'])}</td><td {td_r}>{changes}</td></tr>")
        shown += len(m["fields"])
    for a in d["added"]:
        details = " · ".join(f"{e(k)}: <b>{e(_fmt(v))}</b>" for k, v in a.items() if k not in ("EMP ID", "Employee Name") and v not in (None, ""))
        rows.append(f"<tr><td {td_l}>{who_cell(a.get('Employee Name'), a.get('EMP ID'))}</td><td {td_r}>{pill('New employee', '#dcfce7', '#15803d')}"
                    f'<div style="font-size:13px;color:#44526a;margin-top:4px">{details}</div></td></tr>')
    for r in d["removed"]:
        details = " · ".join(f"{e(k)}: {e(_fmt(v))}" for k, v in r.items() if k not in ("EMP ID", "Employee Name") and v not in (None, ""))
        rows.append(f"<tr><td {td_l}>{who_cell(r.get('Employee Name'), r.get('EMP ID'))}</td><td {td_r}>{pill('Removed', '#fde8ec', '#be123c')}"
                    f'<div style="font-size:13px;color:#7b879b;margin-top:4px;text-decoration:line-through">{details}</div></td></tr>')
    for c in d["cells"][:max(0, 300 - shown)]:
        rows.append(f"<tr><td {td_l}><b style=\"font-size:14px\">{e(c['label'])}</b><div style=\"font-size:12px;color:#7b879b\">Cell {e(c['cell'])}</div></td>"
                    f"<td {td_r}>{pill('Cell', '#eef1f5', '#44526a')}<br>{old_new(c['before'], c['after'])}</td></tr>")
    more = n - shown - len(d["added"]) - len(d["removed"]) - min(len(d["cells"]), max(0, 300 - shown))
    notes = []
    if not ed["matched"]:
        notes.append("Editor not linked to an employee (Excel name shown) — add it to editors.json once.")
    if event.get("offline"):
        notes.append("Edited while the portal was not running; the editor shown is the last person who saved.")
    url = (cfg.get("portalUrl") or "").rstrip("/")
    button = f'<a href="{e(url)}/#/changes" style="display:inline-block;background:{tone[1]};color:#ffffff;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:9px;font-size:13.5px;white-space:nowrap">Open alerts</a>' if url else ""

    html_body = f"""<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;padding:18px 0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:Segoe UI,Arial,sans-serif;color:#0f1b2d;border:1px solid #dfe5ee">
  <tr><td style="background:{tone[1]};background-image:linear-gradient(90deg,{tone[0]},{tone[1]});padding:18px 24px;color:#ffffff">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:28px;width:46px;vertical-align:middle">{icon}</td>
      <td style="vertical-align:middle"><div style="font-size:18px;font-weight:800;color:#ffffff">{e(head)}</div>
        <div style="font-size:13px;color:#e6eefb;margin-top:2px">{e(when)} &middot; by {e(who_full)}</div></td>
    </tr></table>
  </td></tr>
  {f'<tr><td style="padding:14px 24px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">{"".join(rows)}</table></td></tr>' if rows else
   '<tr><td style="padding:18px 24px;font-size:14px;color:#44526a">The file was saved, but no employee data changed.</td></tr>'}
  {f'<tr><td style="padding:0 24px 6px;font-size:13px;color:#7b879b">…and {more} more change{"s" if more != 1 else ""} — see Alerts in the portal.</td></tr>' if more > 0 else ''}
  <tr><td style="padding:12px 24px 22px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:12px;color:#7b879b;line-height:1.5;vertical-align:middle">File: {e(event['source'])}{''.join('<br>' + e(x) for x in notes)}</td>
      <td align="right" style="vertical-align:middle;padding-left:12px">{button}</td>
    </tr></table>
  </td></tr>
</table>
<div style="font-family:Segoe UI,Arial,sans-serif;font-size:11px;color:#9aa6b8;margin-top:10px">VConnecTech Systems &middot; Employee Portal alert</div>
</td></tr></table>"""
    return subject, text, html_body


def send_email(subject, text, html_body, cfg, event_id):
    """Send to HR. Without SMTP settings the message is saved to audit/outbox instead."""
    smtp = cfg.get("smtp", {})
    to = [a for a in cfg.get("hrEmails", []) if a]
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = smtp.get("from") or smtp.get("username") or "vct-portal@localhost"
    msg["To"] = ", ".join(to) or "hr (not configured)"
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain="vct-portal")
    msg.set_content(text)
    msg.add_alternative(html_body, subtype="html")

    OUTBOX.mkdir(parents=True, exist_ok=True)
    eml = OUTBOX / f"{event_id}.eml"
    eml.write_bytes(bytes(msg))
    if not cfg.get("enabled", True):
        return {"status": "off", "detail": "Alerts are switched off in portal.config.json.", "file": eml.name}
    if not to:
        return {"status": "not-configured", "detail": "No HR email address set (alerts.hrEmails). Saved to audit/outbox.", "file": eml.name}
    if not smtp.get("host"):
        return {"status": "not-configured", "detail": "No email server set (alerts.smtp). Saved to audit/outbox.", "file": eml.name}
    password = os.environ.get(smtp.get("passwordEnv", "VCT_SMTP_PASSWORD"), "") or smtp.get("password", "")
    security = (smtp.get("security") or "starttls").lower()
    port = int(smtp.get("port") or (465 if security == "ssl" else 587))
    last_err = None
    for attempt in range(3):
        try:
            ctx = ssl.create_default_context()
            if security == "ssl":
                server = smtplib.SMTP_SSL(smtp["host"], port, context=ctx, timeout=30)
            else:
                server = smtplib.SMTP(smtp["host"], port, timeout=30)
                if security == "starttls":
                    server.starttls(context=ctx)
            with server:
                if smtp.get("username"):
                    server.login(smtp["username"], password)
                server.send_message(msg)
            return {"status": "sent", "detail": "Sent to " + ", ".join(to), "file": eml.name}
        except Exception as e:  # network hiccup or bad settings — retry, then report
            last_err = e
            time.sleep(2 * (attempt + 1))
    return {"status": "failed", "detail": f"Email failed: {last_err}", "file": eml.name}


# ---------------------------------------------------------------- auditor
class Auditor:
    def __init__(self, source_name, log=print):
        self.source_name = source_name
        self.log = log
        self.lock = threading.Lock()
        self.current = None
        self.batch = None
        AUDIT_DIR.mkdir(parents=True, exist_ok=True)
        threading.Thread(target=self._timer, daemon=True).start()

    # Called by the live server with a stable copy of the workbook after every save.
    def observe(self, path):
        snap = snapshot(path)
        cfg = load_config()
        with self.lock:
            if self.current is None:
                prev = self._load_saved()
                self.current = snap
                self._save(snap)
                # A snapshot from an older portal version isn't comparable: start a fresh baseline.
                if prev and prev.get("format") == SNAPSHOT_FORMAT and change_count(diff(prev, snap)):
                    self.batch = {"baseline": prev, "latest": snap, "editor": snap["meta"]["lastModifiedBy"],
                                  "first": time.time(), "last": time.time(), "offline": True}
                    self._finalize_locked()
                return
            before = self.current
            d = diff(before, snap)
            self.current = snap
            self._save(snap)
            if not change_count(d):
                # Saved, but no data changed (opened and saved, formatting only, or changed back).
                if not self.batch:
                    self._record_save_locked(snap)
                return
            editor = snap["meta"]["lastModifiedBy"]
            if self.batch and self.batch["editor"] != editor:
                self._finalize_locked()  # a different person saved: close the previous alert first
            if not self.batch:
                self.batch = {"baseline": before, "latest": snap, "editor": editor,
                              "first": time.time(), "last": time.time(), "offline": False}
            self.batch["latest"] = snap
            self.batch["last"] = time.time()
            if cfg.get("groupChangesWithinSeconds", 60) <= 0:
                self._finalize_locked()

    def pending(self):
        """The alert currently being collected (edits not yet grouped into an alert)."""
        with self.lock:
            b = self.batch
            if not b:
                return None
            wait = load_config().get("groupChangesWithinSeconds", 20)
            return {"editor": b["editor"], "since": dt.datetime.fromtimestamp(b["first"]).isoformat(timespec="seconds"),
                    "changes": change_count(diff(b["baseline"], b["latest"])),
                    "alertInSeconds": max(0, int(wait - (time.time() - b["last"])))}

    def _record_save_locked(self, snap):
        cfg = load_config()
        event = {
            "id": dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f"),
            "type": "save",
            "detectedAt": now_iso(),
            "savedAt": snap["meta"]["fileModified"],
            "source": self.source_name,
            "offline": False,
            "editor": resolve_editor(snap["meta"]["lastModifiedBy"], snap, load_editors(cfg)),
            "count": 0,
            "changes": {"added": [], "removed": [], "modified": [], "cells": []},
        }
        if cfg.get("emailSavesWithoutChanges"):
            threading.Thread(target=self._deliver, args=(event, cfg), daemon=True).start()
        else:
            event["email"] = {"status": "skipped", "detail": "No data changed, so HR is not emailed."}
            self._write_event(event)

    def flush(self):
        with self.lock:
            if self.batch:
                self._finalize_locked()

    def _timer(self):
        while True:
            time.sleep(1)
            try:
                wait = load_config().get("groupChangesWithinSeconds", 60)
                with self.lock:
                    if self.batch and time.time() - self.batch["last"] >= wait:
                        self._finalize_locked()
            except Exception:
                self.log("Change alert error:\n" + traceback.format_exc())

    def _finalize_locked(self):
        b, self.batch = self.batch, None
        d = diff(b["baseline"], b["latest"])
        n = change_count(d)
        if not n:
            return  # edited and changed back
        cfg = load_config()
        editor = resolve_editor(b["editor"], b["latest"], load_editors(cfg))
        event = {
            "id": dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f"),
            "type": "edit",
            "detectedAt": now_iso(),
            "savedAt": b["latest"]["meta"]["fileModified"],
            "source": self.source_name,
            "offline": b["offline"],
            "editor": editor,
            "count": n,
            "changes": d,
        }
        # Email delivery can take a while (retries); don't hold up live portal updates.
        threading.Thread(target=self._deliver, args=(event, cfg), daemon=True).start()

    _log_lock = threading.Lock()

    def _deliver(self, event, cfg):
        event["email"] = {"status": "sending", "detail": ""}
        try:
            subject, text, html_body = build_email(event, cfg)
            event["email"]["subject"] = subject
            event["email"].update(send_email(subject, text, html_body, cfg, event["id"]))
        except Exception as e:  # never lose the record because of an email problem
            event["email"].update({"status": "failed", "detail": f"Email failed: {e}"})
            self.log("Alert email error:\n" + traceback.format_exc())
        self._write_event(event)

    def _write_event(self, event):
        with self._log_lock, LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
        ed = event["editor"]
        who = ed["name"] or ed["recorded"] or "unknown"
        what = "saved with no data changes" if event.get("type") == "save" else f"{event['count']} change(s)"
        self.log(f"Alert: {what} by {who} — email {event['email']['status']}: {event['email']['detail']}")

    def _load_saved(self):
        try:
            return json.loads(SNAPSHOT_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def _save(self, snap):
        tmp = SNAPSHOT_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(snap, ensure_ascii=False, default=str), encoding="utf-8")
        tmp.replace(SNAPSHOT_FILE)


def read_events(limit=200):
    if not LOG_FILE.exists():
        return []
    lines = LOG_FILE.read_text(encoding="utf-8").splitlines()
    out = []
    for line in reversed(lines[-limit:]):
        try:
            out.append(json.loads(line))
        except ValueError:
            pass
    return out


def alerts_status():
    cfg = load_config()
    smtp = cfg.get("smtp", {})
    return {
        "enabled": cfg.get("enabled", True),
        "hrEmails": cfg.get("hrEmails", []),
        "emailConfigured": bool(cfg.get("hrEmails")) and bool(smtp.get("host")),
        "groupChangesWithinSeconds": cfg.get("groupChangesWithinSeconds", 20),
    }


if __name__ == "__main__":
    if "--test-email" in sys.argv:
        cfg = load_config()
        event = {"id": "test-" + dt.datetime.now().strftime("%Y%m%d-%H%M%S"), "savedAt": now_iso(), "source": "test", "count": 1,
                 "offline": False,
                 "editor": {"recorded": "Test", "matched": True, "empId": "VC_000", "name": "Test Person", "email": "test@example.com", "how": "test"},
                 "changes": {"added": [], "removed": [], "cells": [],
                             "modified": [{"empId": "VC_000", "name": "Test Person", "fields": [{"field": "Billed Status", "before": "Billed", "after": "UnBilled"}]}]}}
        s, t, h = build_email(event, cfg)
        print(send_email("TEST — " + s, t, h, cfg, event["id"]))
    else:
        print(__doc__)
