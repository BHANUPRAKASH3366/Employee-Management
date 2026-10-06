/* VCT Employee Portal — views, routing, filters and charts. */
(function () {
  "use strict";
  const M = window.VCTMetrics;
  let DATA = null;
  let charts = [];

  // ---------------------------------------------------------------- constants
  const BILL_COLORS = {
    "Billed": "#15803d", "Buffer Billed": "#4ade80", "Buffer": "#f59e0b", "UnBilled": "#e11d48", "Not set": "#a3adbd",
  };
  const PALETTE = ["#006edb", "#7c3aed", "#0d9488", "#ea580c", "#db2777", "#0891b2", "#ca8a04", "#64748b", "#16a34a", "#9333ea", "#dc2626", "#2563eb"];
  const LEVEL_COLORS = ["#0b3d91", "#1d5fc4", "#3b82f6", "#60a5fa", "#93c5fd", "#c7dcfb", "#94a3b8"];
  const ROUTES = {
    dashboard: "Dashboard", sectors: "Sectors", domains: "Domains", hierarchy: "Reporting Hierarchy", kpi: "KPI Framework",
    changes: "Alerts",
  };
  const FILTER_KEYS = ["sector", "project", "domain", "level", "billing", "earning", "moved", "reportsTo", "q"];
  const FILTER_LABELS = { earning: "Earning", moved: "Moved", reportsTo: "Reports to", q: "Search" };

  const state = { route: "dashboard", f: emptyFilter(), sort: {}, kpiSector: "", kpiRole: "" };
  function emptyFilter() { const f = {}; FILTER_KEYS.forEach((k) => (f[k] = "")); return f; }

  // ---------------------------------------------------------------- helpers
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (x, d) => (x == null || isNaN(x) ? "—" : (Math.round(x * 1000) / 10).toFixed(d == null ? 1 : d).replace(/\.0$/, "") + "%");
  const num = (n) => (n == null ? "—" : Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
  const bcls = (b) => String(b).replace(/\s+/g, "-");
  const badge = (b) => `<span class="badge b-${bcls(b)}">${esc(b)}</span>`;
  const initials = (n) => n.split(/[\s.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  const sectorColor = (name) => {
    const all = sectorList().map((s) => s.name);
    const i = all.indexOf(name);
    return PALETTE[(i < 0 ? all.length : i) % PALETTE.length];
  };
  const sectorList = () => M.sectorStats(DATA, {});
  const zero = (n) => (n ? num(n) : `<span class="zero">0</span>`);
  const allocText = (a) => {
    if (a.pct == null) return "% pending";
    return pct(a.pct, 0);
  };
  const employeeById = (id) => DATA.employees.find((e) => e.id === id);
  const employeeByName = (name) => name && DATA.employees.find((e) => e.name.trim().toLowerCase() === name.trim().toLowerCase());

  // ---------------------------------------------------------------- routing
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, "");
    const [path, query] = h.split("?");
    const route = ROUTES[path] ? path : "dashboard";
    const f = emptyFilter();
    new URLSearchParams(query || "").forEach((v, k) => { if (k in f) f[k] = v; });
    return { route, f };
  }
  function hashFor(route, f) {
    const p = new URLSearchParams();
    FILTER_KEYS.forEach((k) => f[k] && p.set(k, f[k]));
    const q = p.toString();
    return "#/" + route + (q ? "?" + q : "");
  }
  function go(route, patch, keep) {
    const f = Object.assign({}, keep === false ? emptyFilter() : state.f, patch || {});
    // A project only makes sense inside its sector.
    if (f.project && f.sector && !DATA.projects.some((p) => p.sector === f.sector && p.name === f.project)) f.project = "";
    const h = hashFor(route || state.route, f);
    const onlySearch = patch && Object.keys(patch).length === 1 && "q" in patch && (!route || route === state.route);
    if (location.hash === h) render();
    else if (onlySearch) { history.replaceState(null, "", h); render(); }
    else location.hash = h;
  }
  window.addEventListener("hashchange", () => render());

  // ---------------------------------------------------------------- charts
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.font.size = 12;
  Chart.defaults.color = "#44526a";
  Chart.defaults.plugins.legend.display = false;
  Chart.defaults.plugins.tooltip.backgroundColor = "#0f1b2d";
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 6;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.animation.duration = 350;

  function destroyCharts() { charts.forEach((c) => c.destroy()); charts = []; }
  function clickable(onClick) {
    return {
      onHover: (e, els) => { e.native.target.style.cursor = els.length && onClick ? "pointer" : "default"; },
      onClick: (e, els, chart) => { if (els.length && onClick) onClick(els[0].index, els[0].datasetIndex, chart.canvas); },
    };
  }
  function bar(id, cfg) {
    const el = $(id);
    if (!el) return;
    const horizontal = !!cfg.horizontal;
    const valueAxis = {
      beginAtZero: true, stacked: !!cfg.stacked, grid: { color: "#eef1f6" }, border: { display: false },
      ticks: { precision: 0, callback: cfg.percent ? (v) => v + "%" : undefined },
      max: cfg.percent ? 100 : undefined,
    };
    const catAxis = { stacked: !!cfg.stacked, grid: { display: false }, border: { display: false }, ticks: { autoSkip: false } };
    if (cfg.wrapLabels !== false) catAxis.ticks.callback = function (v) { const l = this.getLabelForValue(v); return l.length > 26 ? l.slice(0, 25) + "…" : l; };
    charts.push(new Chart(el, {
      type: "bar",
      data: { labels: cfg.labels, datasets: cfg.datasets.map((d) => Object.assign({ borderRadius: 4, maxBarThickness: 34, borderSkipped: false }, d)) },
      options: Object.assign({
        indexAxis: horizontal ? "y" : "x",
        scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
        plugins: {
          legend: { display: !!cfg.legend, position: "bottom", labels: { boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 3 } },
          tooltip: { callbacks: cfg.tooltip || (cfg.percent ? { label: (c) => " " + c.dataset.label + ": " + c.parsed[horizontal ? "x" : "y"] + "%" } : {}) },
        },
      }, clickable(cfg.onClick)),
    }));
  }
  function donut(id, labels, values, colors, onClick) {
    const el = $(id);
    if (!el) return;
    const total = values.reduce((a, b) => a + b, 0);
    charts.push(new Chart(el, {
      type: "doughnut",
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: "#fff", borderWidth: 2, hoverOffset: 6 }] },
      options: Object.assign({
        cutout: "64%",
        plugins: { tooltip: { callbacks: { label: (c) => ` ${c.label}: ${c.parsed} (${pct(total ? c.parsed / total : 0)})` } } },
      }, clickable(onClick)),
      plugins: [{
        id: "center",
        afterDraw(chart) {
          const { ctx, chartArea: a } = chart;
          ctx.save();
          ctx.textAlign = "center";
          ctx.fillStyle = "#0f1b2d";
          ctx.font = "700 24px " + Chart.defaults.font.family;
          ctx.fillText(total, (a.left + a.right) / 2, (a.top + a.bottom) / 2 + 4);
          ctx.fillStyle = "#7b879b";
          ctx.font = "600 11px " + Chart.defaults.font.family;
          ctx.fillText("TOTAL", (a.left + a.right) / 2, (a.top + a.bottom) / 2 + 22);
          ctx.restore();
        },
      }],
    }));
  }
  function legendHtml(items, row) {
    const total = items.reduce((a, b) => a + b.n, 0);
    return `<div class="legend${row ? " row" : ""}">` + items.map((it, i) =>
      `<div class="lg" data-lg="${i}"><span class="sw" style="background:${it.color}"></span>${esc(it.label)}<span class="n">${it.n}</span>${row ? "" : `<span class="p">${pct(total ? it.n / total : 0)}</span>`}</div>`
    ).join("") + "</div>";
  }
  function bindLegend(container, items) {
    container.querySelectorAll("[data-lg]").forEach((el) => {
      const it = items[+el.dataset.lg];
      if (it && it.onClick) el.addEventListener("click", () => it.onClick(el));
    });
  }
  const hBarHeight = (n) => Math.max(200, n * 26 + 50);
  function stackDatasets(rows, getBilling) {
    return M.BILLING.map((b) => ({ label: b, data: rows.map((r) => getBilling(r)[b]), backgroundColor: BILL_COLORS[b] }));
  }

  // ---------------------------------------------------------------- tables
  /**
   * Sortable table. cols: {key, label, num, html(row), val(row), cls}
   * Re-renders itself on header click.
   */
  function mountTable(container, cfg) {
    const id = cfg.id;
    const s = state.sort[id] || cfg.defaultSort || {};
    function draw() {
      const cur = state.sort[id] || s;
      let rows = cfg.rows.slice();
      const col = cfg.cols.find((c) => c.key === cur.key);
      if (col) {
        const v = col.val || ((r) => r[col.key]);
        rows.sort((a, b) => {
          const x = v(a), y = v(b);
          if (x == null && y == null) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * (cur.dir === "desc" ? -1 : 1);
        });
      }
      const head = cfg.cols.map((c) => {
        const on = cur.key === c.key;
        return `<th class="${c.num ? "num " : ""}${c.sort === false ? "" : "sort"}" data-k="${c.key}">${esc(c.label)}${on ? `<span class="arr">${cur.dir === "desc" ? "▼" : "▲"}</span>` : ""}</th>`;
      }).join("");
      const body = rows.length ? rows.map((r, i) => `<tr class="${cfg.onRow ? "click" : ""}" data-i="${i}">` + cfg.cols.map((c) =>
        `<td class="${c.num ? "num " : ""}${c.cls || ""}">${c.html ? c.html(r) : esc(r[c.key] == null ? "—" : r[c.key])}</td>`).join("") + "</tr>").join("")
        : `<tr><td colspan="${cfg.cols.length}" class="empty">${esc(cfg.empty || "No records match the current filters.")}</td></tr>`;
      const foot = cfg.foot ? `<tfoot><tr>${cfg.foot(rows).map((v, i) => `<td class="${cfg.cols[i] && cfg.cols[i].num ? "num" : ""}">${v}</td>`).join("")}</tr></tfoot>` : "";
      container.innerHTML = `<div class="table-wrap${cfg.tall ? " tall" : ""}"><table class="t"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table></div>`;
      container.querySelectorAll("th.sort").forEach((th) => th.addEventListener("click", () => {
        const k = th.dataset.k;
        const c = state.sort[id] || s;
        state.sort[id] = { key: k, dir: c.key === k && c.dir === "asc" ? "desc" : c.key === k ? "asc" : (cfg.cols.find((x) => x.key === k).num ? "desc" : "asc") };
        draw();
      }));
      if (cfg.onRow) container.querySelectorAll("tbody tr[data-i]").forEach((tr) => tr.addEventListener("click", () => cfg.onRow(rows[+tr.dataset.i], tr)));
      cfg.rowsSorted = rows;
    }
    draw();
    return cfg;
  }

  const pctCell = (x) => x == null ? `<span class="muted">—</span>` : `<div class="pct-cell">${pct(x)}<span class="bar"><i style="width:${Math.round(x * 100)}%"></i></span></div>`;
  const stackBar = (b) => `<div class="stack">${M.BILLING.map((k) => b[k] ? `<span title="${esc(k)}: ${b[k]}" style="width:${(b[k] / b.total) * 100}%;background:${BILL_COLORS[k]}"></span>` : "").join("")}</div>`;

  // People tables (shared columns).
  function peopleCols(opts) {
    opts = opts || {};
    const cols = [
      { key: "id", label: "Emp ID", val: (r) => r.emp.id, html: (r) => `<span class="muted">${esc(r.emp.id)}</span>` },
      { key: "name", label: "Name", val: (r) => r.emp.name, html: (r) => `<b>${esc(r.emp.name)}</b>` },
    ];
    if (!opts.noSector) cols.push({ key: "sector", label: "Sector", val: (r) => r.emp.sector, html: (r) => esc(r.emp.sector) });
    if (!opts.noProject) cols.push({ key: "project", label: "Project", val: (r) => r.emp.project, html: (r) => esc(r.emp.project) + (r.emp.projectRaw && r.emp.projectRaw !== r.emp.project ? ` <span class="muted">(${esc(r.emp.projectRaw)})</span>` : "") });
    if (opts.alloc) cols.push({ key: "alloc", label: "Allocation", num: true, val: (r) => r.ctxAssignment.pct, html: (r) => {
      const a = r.ctxAssignment;
      return (a.primary ? "" : `<span class="tag blue">2nd project</span> `) + (a.pct == null ? `<span class="tag amber">pending</span>` : pct(a.pct, 0));
    } });
    cols.push(
      { key: "level", label: "Level", val: (r) => M.LEVELS.indexOf(r.emp.level), html: (r) => esc(r.emp.level) },
      { key: "designation", label: "Designation", val: (r) => r.emp.designation, html: (r) => esc(r.emp.designation || "—") },
      ...(opts.noDomain ? [] : [{ key: "domain", label: "Domain", val: (r) => r.emp.domain, html: (r) => esc(r.emp.domain) }]),
      { key: "billing", label: "Billing", val: (r) => M.BILLING.indexOf(r.ctxBilling), html: (r) => badge(r.ctxBilling) },
    );
    if (!opts.short) cols.push(
      { key: "earning", label: "Earning", val: (r) => r.emp.earning, html: (r) => esc(r.emp.earning || "—") },
      { key: "yoe", label: "Experience", num: true, val: (r) => M.yoeYears(r.emp.yoe), html: (r) => esc(M.formatYoe(r.emp.yoe) || "—") },
      { key: "reportsTo", label: "Reports to", val: (r) => r.emp.reportsTo, html: (r) => esc(r.emp.reportsTo || "—") },
    );
    return cols;
  }
  function peopleTable(container, id, rows, opts) {
    return mountTable(container, Object.assign({
      id, rows, cols: peopleCols(opts), onRow: (r) => openEmployee(r.emp.id), tall: true,
      defaultSort: { key: "level", dir: "asc" },
    }, opts && opts.table));
  }

  // ---------------------------------------------------------------- filter bar
  function optionList(sel, items, value, allLabel) {
    sel.innerHTML = `<option value="">${esc(allLabel)}</option>` + items.map((it) =>
      `<option value="${esc(it.value)}"${it.value === value ? " selected" : ""}>${esc(it.label)}</option>`).join("");
    sel.classList.toggle("on", !!value);
  }
  function renderFilters() {
    const f = state.f;
    const without = (k) => Object.assign({}, f, { [k]: "" }, k === "sector" ? { project: "" } : {});
    // Sector (counts = head count, primary)
    const secCounts = M.countBy(M.filterEmployees(DATA.employees, without("sector")), (p) => p.emp.sector);
    optionList($("fSector"), sectorList().map((s) => ({ value: s.name, label: `${s.name} (${secCounts.get(s.name) || 0})` })), f.sector, "All sectors");
    // Project (counts = assignments)
    const pf = without("project");
    const pCounts = M.countBy(M.filterAssignments(DATA.employees, pf), (a) => a.sector + "|" + a.project);
    const projs = DATA.projects.filter((p) => p.status !== "Deleted" && (!f.sector || p.sector === f.sector))
      .sort((a, b) => a.order - b.order);
    optionList($("fProject"), projs.map((p) => ({
      value: p.sector + "|" + p.name,
      label: `${p.name}${f.sector ? "" : " — " + p.sector} (${pCounts.get(p.sector + "|" + p.name) || 0})`,
    })), f.project ? (f.sector || (projs.find((p) => p.name === f.project) || {}).sector) + "|" + f.project : "", "All projects");
    // Domain / level / billing (counts = people)
    const cnt = (k, fn) => M.countBy(M.filterEmployees(DATA.employees, without(k)), fn);
    const dCounts = cnt("domain", (p) => p.emp.domain);
    const domains = [...new Set(DATA.employees.map((e) => e.domain))].sort((a, b) => (dCounts.get(b) || 0) - (dCounts.get(a) || 0) || a.localeCompare(b));
    optionList($("fDomain"), domains.map((d) => ({ value: d, label: `${d} (${dCounts.get(d) || 0})` })), f.domain, "All domains");
    const lCounts = cnt("level", (p) => p.emp.level);
    optionList($("fLevel"), M.LEVELS.map((l) => ({ value: l, label: `${l} (${lCounts.get(l) || 0})` })), f.level, "All levels");
    const bCounts = cnt("billing", (p) => p.ctxBilling);
    optionList($("fBilling"), M.BILLING.map((b) => ({ value: b, label: `${b} (${bCounts.get(b) || 0})` })), f.billing, "All statuses");
    if ($("fQ") !== document.activeElement) $("fQ").value = f.q;
    // Chips for filters that have no dropdown.
    $("fChips").innerHTML = ["earning", "moved", "reportsTo"].filter((k) => f[k]).map((k) =>
      `<span class="chip">${esc(FILTER_LABELS[k])}: ${esc(k === "moved" ? (f[k] === "yes" ? "Moved from baseline" : "Not moved") : f[k])}<button data-clear="${k}" aria-label="Remove">×</button></span>`).join("");
    $("fChips").querySelectorAll("[data-clear]").forEach((b) => b.addEventListener("click", () => go(null, { [b.dataset.clear]: "" })));
    $("filters").style.display = state.route === "dashboard" ? "" : "none";
  }
  function bindFilters() {
    $("fSector").addEventListener("change", (e) => go(null, { sector: e.target.value, project: "" }));
    $("fProject").addEventListener("change", (e) => {
      const v = e.target.value;
      if (!v) return go(null, { project: "" });
      const i = v.indexOf("|");
      go(null, { sector: v.slice(0, i), project: v.slice(i + 1) });
    });
    $("fDomain").addEventListener("change", (e) => go(null, { domain: e.target.value }));
    $("fLevel").addEventListener("change", (e) => go(null, { level: e.target.value }));
    $("fBilling").addEventListener("change", (e) => go(null, { billing: e.target.value }));
    let t;
    $("fQ").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => go(null, { q: e.target.value.trim() }), 220); });
    $("fReset").addEventListener("click", () => go(null, emptyFilter()));
  }

  // ---------------------------------------------------------------- shared blocks
  function tile(label, value, note, opts) {
    opts = opts || {};
    const action = opts.panel ? `data-panel='${esc(JSON.stringify(opts.panel))}' title="Click to see the people behind this number"` : opts.go ? `data-go='${esc(JSON.stringify(opts.go))}'` : "";
    return `<div class="card tile${opts.go || opts.panel ? " click" : ""}" ${action} style="--accent:${opts.color || "var(--brand)"}">
      <span class="lbl">${esc(label)}</span><span class="val">${value}</span>${note ? `<span class="note">${note}</span>` : ""}</div>`;
  }
  function bindGo(root) {
    root.querySelectorAll("[data-go]").forEach((el) => el.addEventListener("click", () => {
      const g = JSON.parse(el.dataset.go);
      go(g.route, g.patch);
    }));
    root.querySelectorAll("[data-panel]").forEach((el) => el.addEventListener("click", () => showPanel(JSON.parse(el.dataset.panel), el)));
  }
  function summaryTiles(s, extra) {
    const b = s.billing;
    return `<div class="grid g-tiles">
      ${tile("Head count", s.headcount, `${s.assignments} project assignments`, { color: "#006edb", panel: { title: "Head count", patch: {} } })}
      ${tile("Billable", pct(b.billablePct), `${b.billable} people · Billed + Buffer Billed`, { color: BILL_COLORS.Billed, panel: { title: "Billable — Billed + Buffer Billed", special: "billable" } })}
      ${tile("Billed", b.Billed, pct(b.total ? b.Billed / b.total : null) + " of head count", { color: BILL_COLORS.Billed, panel: { title: "Billed", patch: { billing: "Billed" } } })}
      ${tile("Buffer Billed", b["Buffer Billed"], pct(b.total ? b["Buffer Billed"] / b.total : null) + " of head count", { color: BILL_COLORS["Buffer Billed"], panel: { title: "Buffer Billed", patch: { billing: "Buffer Billed" } } })}
      ${tile("Bench", b.bench, `${pct(b.benchPct)} · Buffer ${b.Buffer} + UnBilled ${b.UnBilled}`, { color: BILL_COLORS.UnBilled, panel: { title: "Bench — Buffer + UnBilled", special: "bench" } })}
      ${tile("Billing not set", b["Not set"], "No billed status recorded", { color: BILL_COLORS["Not set"], panel: { title: "Billing not set", patch: { billing: "Not set" } } })}
      ${tile("Weighted head count", num(s.weighted), s.pending ? `${s.pending} allocation${s.pending > 1 ? "s" : ""} pending · click to see` : "All allocations entered", { color: "#7c3aed", panel: s.pending ? { title: "Allocation % pending", special: "pending" } : null })}
      ${extra || ""}
    </div>`;
  }
  function billingDonutCard(id, b, onPick, title) {
    return {
      html: `<div class="card"><div class="card-h"><h3>${esc(title || "Billing status")}</h3><span class="right">Click to drill down</span></div>
        <div class="chart-box sm"><canvas id="${id}"></canvas></div><div id="${id}-lg"></div></div>`,
      mount() {
        const items = M.BILLING.map((k) => ({ label: k, n: b[k], color: BILL_COLORS[k], onClick: (el) => onPick(k, el) }));
        donut(id, M.BILLING, M.BILLING.map((k) => b[k]), M.BILLING.map((k) => BILL_COLORS[k]), (i, d, el) => onPick(M.BILLING[i], el));
        const lg = $(id + "-lg");
        lg.innerHTML = legendHtml(items);
        bindLegend(lg, items);
      },
    };
  }
  function levelBar(id, people, onPick) {
    const c = M.countBy(people, (p) => p.emp.level, M.LEVELS);
    bar(id, {
      labels: M.LEVELS, datasets: [{ label: "People", data: M.LEVELS.map((l) => c.get(l) || 0), backgroundColor: LEVEL_COLORS }],
      onClick: (i, d, el) => onPick(M.LEVELS[i], el),
    });
  }
  const pickBilling = (b, el) => showPanel({ title: b, patch: { billing: b } }, el);
  const pickLevel = (l, el) => showPanel({ title: l, patch: { level: l } }, el);
  const pickDomain = (d, el) => showPanel({ title: "Domain · " + d, patch: { domain: d } }, el);
  const pickSector = (name, el) => showPanel({ title: name, patch: { sector: name } }, el);
  const pickProject = (p, el) => showPanel({ title: p.name + " · " + p.sector, patch: { sector: p.sector, project: p.name } }, el);

  function domainCounts(people) {
    return [...M.countBy(people, (p) => p.emp.domain).entries()].sort((a, b) => b[1] - a[1]);
  }


  // ---------------------------------------------------------------- in-place details panel
  /*
   * Clicking a tile, chart, legend or table row opens this panel on the same page,
   * directly below what was clicked: the people behind the number, broken down
   * three ways, with drill-down inside the panel. Nothing navigates away.
   * spec = { title, patch: {filter overrides}, special: "billable"|"bench"|"pending", list: [domains] }
   */
  const DIMS = {
    billing: { label: "Billing status", key: (p) => p.ctxBilling, order: M.BILLING, color: (k) => BILL_COLORS[k] },
    sector: { label: "Sector", key: (p) => p.ctxAssignment.sector, color: (k) => sectorColor(k) },
    level: { label: "Level", key: (p) => p.emp.level, order: M.LEVELS },
    domain: { label: "Domain", key: (p) => p.emp.domain },
    project: { label: "Project", key: (p) => p.ctxAssignment.sector + "|||" + p.ctxAssignment.project, fmt: (k) => k.split("|||")[1] },
  };

  function panelPeople(spec) {
    const patch = spec.patch || {};
    const f = Object.assign({}, state.f, patch);
    if ("sector" in patch && !("project" in patch)) f.project = "";
    let rows;
    if (spec.special === "pending") {
      const seen = new Map();
      M.filterAssignments(DATA.employees, f).filter((a) => a.pct == null).forEach((a) => {
        if (!seen.has(a.emp.id)) seen.set(a.emp.id, { emp: a.emp, ctxBilling: a.billing, ctxAssignment: a });
      });
      rows = [...seen.values()];
    } else {
      rows = M.filterEmployees(DATA.employees, f);
    }
    if (spec.special === "billable") rows = rows.filter((r) => M.BILLABLE.includes(r.ctxBilling));
    if (spec.special === "bench") rows = rows.filter((r) => M.BENCH.includes(r.ctxBilling));
    if (spec.list) rows = rows.filter((r) => spec.list.includes(r.emp.domain));
    return { rows, f };
  }

  function panelDims(spec, f) {
    const fixed = new Set(["sector", "project", "domain", "level", "billing"].filter((k) => f[k]));
    if (f.project) fixed.add("sector");
    if (spec.list) fixed.add("domain");
    const order = ["billing", "sector", "level", "domain", "project"];
    return order.filter((k) => !fixed.has(k)).slice(0, 3);
  }

  function breakdownHtml(dim, rows) {
    const d = DIMS[dim];
    const counts = M.countBy(rows, d.key, d.order);
    let entries = [...counts.entries()];
    if (!d.order) entries.sort((a, b) => b[1] - a[1]);
    entries = entries.filter((e) => e[1] > 0);
    const max = Math.max(1, ...entries.map((e) => e[1]));
    const shown = entries.slice(0, 8);
    const more = entries.length - shown.length;
    return `<div class="bd"><h4>By ${esc(d.label.toLowerCase())}</h4>${shown.map(([k, n]) => `
      <div class="bd-row" data-dim="${dim}" data-val="${esc(k)}" title="Show only ${esc(d.fmt ? d.fmt(k) : k)}">
        <span class="bd-l">${esc(d.fmt ? d.fmt(k) : k)}</span>
        <span class="bd-bar"><i style="width:${(n / max) * 100}%;background:${d.color ? d.color(k) : "var(--brand)"}"></i></span>
        <span class="bd-n">${n}</span></div>`).join("")}
      ${more > 0 ? `<div class="muted" style="font-size:12px;margin-top:4px">+ ${more} more</div>` : ""}
      ${!shown.length ? `<div class="muted">—</div>` : ""}</div>`;
  }

  function scopeText(f) {
    const parts = ["sector", "project", "domain", "level", "billing"].filter((k) => state.f[k]).map((k) => state.f[k]);
    if (state.f.q) parts.push(`“${state.f.q}”`);
    return parts.length ? ` · within current filters: ${parts.map(esc).join(", ")}` : "";
  }

  function topBlock(el) {
    const view = $("view");
    while (el && el.parentElement && el.parentElement !== view) el = el.parentElement;
    return el && el.parentElement === view && el.id !== "detailPanel" ? el : null;
  }

  function showPanel(spec, anchor) {
    if (!spec) return;
    const key = JSON.stringify(spec);
    if (state.panel && state.panel.key === key) return closePanel(); // second click closes
    const kids = [...$("view").children].filter((c) => c.id !== "detailPanel");
    const block = topBlock(anchor);
    state.panel = { spec, key, after: block ? kids.indexOf(block) : 0, back: [], hash: location.hash };
    renderPanel(true);
  }

  function closePanel() {
    state.panel = null;
    const el = $("detailPanel");
    if (el) el.remove();
    markActivePanel();
  }

  function markActivePanel() {
    document.querySelectorAll("[data-panel]").forEach((el) =>
      el.classList.toggle("active", !!state.panel && JSON.stringify(JSON.parse(el.dataset.panel)) === state.panel.key));
  }

  function renderPanel(scroll) {
    const old = $("detailPanel");
    if (old) old.remove();
    if (!state.panel) return markActivePanel();
    const P = state.panel;
    const spec = P.spec;
    const { rows, f } = panelPeople(spec);
    const b = M.billingCounts(rows);
    const dims = panelDims(spec, f);
    const el = document.createElement("section");
    el.id = "detailPanel";
    el.className = "card detail-panel";
    el.innerHTML = `
      <div class="dp-head">
        <div>${P.back.length ? `<button class="dp-back" data-dp="back">← Back</button>` : ""}
          <h3>${esc(spec.title)}</h3>
          <div class="sub"><b>${rows.length}</b> ${rows.length === 1 ? "person" : "people"}${spec.special === "pending" ? ` with ${M.filterAssignments(DATA.employees, f).filter((a) => a.pct == null).length} project allocations still to be entered` : rows.length ? ` · billable ${pct(b.billablePct)}` : ""}${scopeText(f)}</div></div>
        <div class="dp-actions"><button class="btn-ghost" data-dp="csv">Export CSV</button><button class="dp-close" data-dp="close" aria-label="Close" title="Close">✕</button></div>
      </div>
      ${rows.length ? stackBar(b) + `<div class="legend row" style="margin-top:8px">${M.BILLING.filter((k) => b[k]).map((k) => `<span class="lg" style="cursor:default"><span class="sw" style="background:${BILL_COLORS[k]}"></span>${esc(k)}<span class="n">${b[k]}</span></span>`).join("")}</div>` : ""}
      ${rows.length && dims.length ? `<div class="grid g-3 mt">${dims.map((d) => breakdownHtml(d, rows)).join("")}</div><div class="hint">Click any line above to narrow this list.</div>` : ""}
      <div class="mt" id="dpTable"></div>`;
    const kids = [...$("view").children];
    const after = kids[Math.min(P.after, kids.length - 1)];
    if (after) after.after(el); else $("view").prepend(el);

    el.querySelector('[data-dp="close"]').addEventListener("click", closePanel);
    el.querySelector('[data-dp="csv"]').addEventListener("click", () => exportCsv(tbl.rowsSorted || rows));
    const backBtn = el.querySelector('[data-dp="back"]');
    if (backBtn) backBtn.addEventListener("click", () => {
      P.spec = P.back.pop();
      P.key = JSON.stringify(P.spec);
      renderPanel(false);
    });
    el.querySelectorAll(".bd-row").forEach((row) => row.addEventListener("click", () => {
      const dim = row.dataset.dim, val = row.dataset.val;
      const patch = Object.assign({}, spec.patch || {});
      let label = val;
      if (dim === "project") {
        const [sec, name] = val.split("|||");
        Object.assign(patch, { sector: sec, project: name });
        label = name;
      } else {
        patch[dim] = val;
      }
      P.back.push(spec);
      P.spec = Object.assign({}, spec, { title: spec.title + " › " + label, patch });
      P.key = JSON.stringify(P.spec);
      renderPanel(false);
    }));
    const tbl = peopleTable($("dpTable"), "panelTable", rows, { alloc: !!f.project, table: { empty: "No one matches." } });
    markActivePanel();
    if (scroll) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---------------------------------------------------------------- views
  const views = {};

  views.dashboard = function (v) {
    const f = state.f;
    const s = M.summary(DATA, f);
    const sectors = M.sectorStats(DATA, f).filter((x) => (!f.sector || x.name === f.sector) && (x.headcount || !f.sector));
    const projects = M.projectStats(DATA, f).filter((p) => p.assigns.length).sort((a, b) => b.assigns.length - a.assigns.length);
    const topProjects = projects.slice(0, 12);
    const doms = domainCounts(s.people);
    const topDoms = doms.slice(0, 12);
    if (doms.length > 12) topDoms.push(["Other (" + (doms.length - 12) + " domains)", doms.slice(12).reduce((a, d) => a + d[1], 0)]);
    const donutCard = billingDonutCard("cBill", s.billing, pickBilling);

    v.innerHTML = `
      ${summaryTiles(s, tile("Earning", s.earning, `${s.notEarning} not earning`, { color: "#0d9488", panel: { title: "Earning", patch: { earning: "Earning" } } }) +
        tile("Moved from baseline", s.moved, "Sector, project or level changed", { color: "#ea580c", panel: { title: "Moved from baseline", patch: { moved: "yes" } } }))}
      <div class="grid g-21 mt">
        <div class="card"><div class="card-h"><h3>Head count by sector</h3><span class="sub">split by billing status</span><span class="right">Click a sector for details</span></div>
          <div class="chart-box" style="height:${hBarHeight(sectors.length)}px"><canvas id="cSector"></canvas></div></div>
        ${donutCard.html}
      </div>
      <div class="grid g-2 mt">
        <div class="card"><div class="card-h"><h3>Head count by level</h3><span class="right">Click for details</span></div><div class="chart-box sm"><canvas id="cLevel"></canvas></div></div>
        <div class="card"><div class="card-h"><h3>Billable % by sector</h3><span class="sub">(Billed + Buffer Billed) ÷ head count</span></div><div class="chart-box sm"><canvas id="cBillable"></canvas></div></div>
      </div>
      <div class="grid g-2 mt">
        <div class="card"><div class="card-h"><h3>Head count by domain</h3><span class="right">Click for details</span></div>
          <div class="chart-box" style="height:${hBarHeight(topDoms.length)}px"><canvas id="cDomain"></canvas></div></div>
        <div class="card"><div class="card-h"><h3>Largest projects</h3><span class="sub">assignments by billing status</span><span class="right">Click for details</span></div>
          <div class="chart-box" style="height:${hBarHeight(topProjects.length)}px"><canvas id="cProj"></canvas></div></div>
      </div>
      <div class="section-title"><h2>Sector summary</h2><span class="sub">Head count by primary sector · click a row for details</span></div>
      <div id="tSectors"></div>`;
    bindGo(v);

    bar("cSector", {
      labels: sectors.map((x) => x.name), horizontal: true, stacked: true, legend: true,
      datasets: stackDatasets(sectors, (x) => x.billing),
      onClick: (i, d, el) => pickSector(sectors[i].name, el),
    });
    donutCard.mount();
    levelBar("cLevel", s.people, pickLevel);
    const withHc = sectors.filter((x) => x.headcount);
    bar("cBillable", {
      labels: withHc.map((x) => x.name), percent: true,
      datasets: [{ label: "Billable", data: withHc.map((x) => Math.round((x.billing.billablePct || 0) * 1000) / 10), backgroundColor: withHc.map((x) => sectorColor(x.name)) }],
      onClick: (i, d, el) => pickSector(withHc[i].name, el),
    });
    bar("cDomain", {
      labels: topDoms.map((d) => d[0]), horizontal: true,
      datasets: [{ label: "People", data: topDoms.map((d) => d[1]), backgroundColor: "#006edb" }],
      onClick: (i, d, el) => i < 12 ? pickDomain(topDoms[i][0], el) : showPanel({ title: "Other domains", list: doms.slice(12).map((x) => x[0]) }, el),
    });
    bar("cProj", {
      labels: topProjects.map((p) => p.name + (f.sector ? "" : " · " + p.sector)), horizontal: true, stacked: true,
      datasets: stackDatasets(topProjects, (p) => p.billing),
      onClick: (i, d, el) => pickProject(topProjects[i], el),
    });
    sectorSummaryTable($("tSectors"), sectors);
  };

  function sectorSummaryTable(el, sectors, onRow) {
    mountTable(el, {
      id: "sectorSummary", rows: sectors,
      cols: [
        { key: "name", label: "Sector", html: (r) => `<span class="badge" style="background:transparent;color:${sectorColor(r.name)}"></span><b>${esc(r.name)}</b>` },
        { key: "head", label: "Sector head", html: (r) => esc(r.head || "—") },
        { key: "headcount", label: "Head count", num: true },
        { key: "billed", label: "Billed", num: true, val: (r) => r.billing.Billed, html: (r) => zero(r.billing.Billed) },
        { key: "bb", label: "Buffer Billed", num: true, val: (r) => r.billing["Buffer Billed"], html: (r) => zero(r.billing["Buffer Billed"]) },
        { key: "buffer", label: "Buffer", num: true, val: (r) => r.billing.Buffer, html: (r) => zero(r.billing.Buffer) },
        { key: "unbilled", label: "UnBilled", num: true, val: (r) => r.billing.UnBilled, html: (r) => zero(r.billing.UnBilled) },
        { key: "notset", label: "Not set", num: true, val: (r) => r.billing["Not set"], html: (r) => zero(r.billing["Not set"]) },
        { key: "billable", label: "Billable %", num: true, val: (r) => r.billing.billablePct, html: (r) => pctCell(r.billing.billablePct) },
        { key: "weighted", label: "Weighted HC", num: true, html: (r) => num(r.weighted) },
        { key: "staffed", label: "Projects staffed", num: true, val: (r) => r.staffedProjects, html: (r) => `${r.staffedProjects} <span class="muted">/ ${r.projectCount}</span>` },
      ],
      foot: (rows) => {
        const t = (fn) => rows.reduce((a, r) => a + fn(r), 0);
        const hc = t((r) => r.headcount), bl = t((r) => r.billing.billable);
        return ["Total", "", hc, t((r) => r.billing.Billed), t((r) => r.billing["Buffer Billed"]), t((r) => r.billing.Buffer), t((r) => r.billing.UnBilled), t((r) => r.billing["Not set"]), pct(hc ? bl / hc : null), num(t((r) => r.weighted)), ""];
      },
      onRow: onRow || ((r, tr) => pickSector(r.name, tr)),
    });
  }

  // ---- Sectors (unique: what each sector is, its projects and who works where)
  views.sectors = function (v) {
    if (state.f.sector) return sectorDetail(v, state.f.sector);
    const sectors = M.sectorStats(DATA, {});
    v.innerHTML = `<div class="grid g-3">${sectors.map((s) => `
      <div class="card sector-card" data-sector="${esc(s.name)}">
        <div class="top"><span class="dot" style="background:${sectorColor(s.name)}"></span>
          <div><h3>${esc(s.name)}</h3><div class="muted">${s.head ? "Head: " + esc(s.head) : "No sector head assigned"}</div></div></div>
        <div class="own">${esc(s.ownership || "—")}</div>
        <div class="nums">
          <div><b>${s.headcount}</b><span>People</span></div>
          <div><b>${s.staffedProjects}</b><span>Projects</span></div>
        </div>
      </div>`).join("")}</div>`;
    v.querySelectorAll("[data-sector]").forEach((el) => el.addEventListener("click", () => go("sectors", { sector: el.dataset.sector }, false)));
  };

  function sectorDetail(v, name) {
    const f = state.f;
    const st = M.sectorStats(DATA, f).find((s) => s.name === name);
    if (!st) { v.innerHTML = `<div class="empty">Sector “${esc(name)}” not found.</div>`; return; }
    const projects = M.projectStats(DATA, f);
    const staffed = projects.filter((p) => p.assigns.length);
    v.innerHTML = `
      <div class="card sector-head" style="border-left:4px solid ${sectorColor(name)}">
        <dl class="kv">
          <dt>Sector head</dt><dd><b>${esc(st.head || "Not assigned")}</b></dd>
          <dt>Who owns the outcome</dt><dd>${esc(st.ownership || "—")}</dd>
          <dt>Domains involved</dt><dd>${esc(st.domains || "—")}</dd>
        </dl>
        <div class="sh-nums"><div><b>${st.headcount}</b><span>People</span></div><div><b>${staffed.length}</b><span>Projects staffed</span></div></div>
      </div>
      <div class="section-title"><h2>Who works where</h2><span class="sub">project × level · colour = billing status · click a project for its people, a name for the profile</span></div>
      <div class="pg-legend">${M.BILLING.map((b) => `<span class="pg-key ${bcls(b)}">${esc(b)}</span>`).join("")}<span class="pg-key dual">Working on 2 projects (left half = billing)</span></div>
      ${peopleGrid(staffed, projects)}`;
    bindPeopleGrid(v);
    v.querySelectorAll("[data-proj]").forEach((el) => el.addEventListener("click", () => {
      const [sec, pname] = el.dataset.proj.split("|||");
      pickProject({ sector: sec, name: pname }, el);
    }));
  }

  function peopleGrid(staffed, all) {
    if (!staffed.length) return `<div class="card empty">No one is assigned to projects in this view.</div>`;
    const empty = all.length - staffed.length;
    const rows = M.LEVELS.map((lvl) => {
      const cells = staffed.map((p) => {
        const list = p.assigns.filter((a) => a.emp.level === lvl);
        return `<td>${list.map((a) => {
          const dual = a.emp.second && a.emp.second.isSeparateAssignment;
          const pctNote = a.pct == null ? "% pending" : a.pct !== 1 ? pct(a.pct, 0) : "";
          return `<span class="person ${bcls(a.billing)}${dual ? " dual" : ""}" data-emp="${esc(a.emp.id)}" title="${esc(a.emp.name)} — ${esc(a.billing)}${dual ? " · two projects" : ""}">${esc(a.emp.name)}<small>${esc([a.emp.domain !== "Not specified" ? a.emp.domain : a.emp.designation, pctNote, a.primary ? (dual ? "2 projects" : "") : "2nd project"].filter(Boolean).join(" · "))}</small></span>`;
        }).join("")}</td>`;
      }).join("");
      return `<tr><td class="lvl">${esc(lvl)}</td>${cells}</tr>`;
    }).join("");
    // Project lead in their billing colour (their billing on this project if they're assigned to it, else their main one).
    const leads = staffed.map((p) => {
      const le = employeeByName(p.lead);
      if (!le) return `<td><b>${esc(p.lead || "—")}</b></td>`;
      const own = p.assigns.find((a) => a.emp === le);
      const bill = own ? own.billing : le.billing;
      const dual = le.second && le.second.isSeparateAssignment;
      return `<td><span class="person ${bcls(bill)}${dual ? " dual" : ""}" data-emp="${esc(le.id)}" title="${esc(le.name)} — project lead · ${esc(bill)}${dual ? " · two projects" : ""}">${esc(le.name)}<small>${esc(["Project lead", le.designation, dual ? "2 projects" : ""].filter(Boolean).join(" · "))}</small></span></td>`;
    }).join("");
    return `<div class="table-wrap tall"><table class="t pgrid"><thead><tr><th class="first">Level</th>${staffed.map((p) =>
      `<th><span class="th-link" data-proj="${esc(p.sector)}|||${esc(p.name)}">${esc(p.name)}</span> <span class="muted">(${p.assigns.length})</span></th>`).join("")}</tr></thead>
      <tbody><tr><td class="lvl">Project lead</td>${leads}</tr>${rows}</tbody></table></div>
      ${empty ? `<div class="hint">Projects with no one assigned: ${all.filter((p) => !p.assigns.length).map((p) => esc(p.name)).join(", ")}.</div>` : ""}`;
  }
  function bindPeopleGrid(root) {
    root.querySelectorAll("[data-emp]").forEach((el) => el.addEventListener("click", () => openEmployee(el.dataset.emp)));
  }

  // ---- Domains (unique: project-wise head count per domain)
  views.domains = function (v) {
    const all = M.filterEmployees(DATA.employees, {});
    const doms = domainCounts(all);
    const sel = state.f.domain && doms.some((d) => d[0] === state.f.domain) ? state.f.domain : (doms[0] && doms[0][0]);
    const f = Object.assign(emptyFilter(), { domain: sel });
    const selPeople = M.filterEmployees(DATA.employees, f);
    const selProjects = M.projectStats(DATA, f).filter((p) => p.assigns.length).sort((a, b) => b.assigns.length - a.assigns.length);
    const maxD = Math.max(1, ...doms.map((d) => d[1]));
    const maxP = Math.max(1, ...selProjects.map((p) => p.assigns.length));
    const mx = M.domainProjectMatrix(DATA, {});
    // Billing mix behind each matrix cell (assignment-based, same as the counts).
    const mxBill = new Map();
    M.filterAssignments(DATA.employees, {}).forEach((a) => {
      const k = a.emp.domain + "||" + a.sector + "|" + a.project;
      const c = mxBill.get(k) || { dual: 0 };
      c[a.billing] = (c[a.billing] || 0) + 1;
      if (a.emp.second && a.emp.second.isSeparateAssignment) c.dual++;
      mxBill.set(k, c);
    });
    const mxCell = (d, pr, n) => {
      const c = mxBill.get(d + "||" + pr.sector + "|" + pr.name) || {};
      const parts = M.BILLING.filter((b) => c[b]).map((b) => [b, c[b]]);
      const tot = parts.reduce((x, y) => x + y[1], 0) || n;
      let at = 0;
      const bg = parts.length === 1 ? BILL_COLORS[parts[0][0]]
        : `linear-gradient(90deg, ${parts.map(([b, k]) => { const from = (at / tot) * 100; at += k; return `${BILL_COLORS[b]} ${from}% ${(at / tot) * 100}%`; }).join(", ")})`;
      const light = parts.length === 1 && ["Buffer Billed", "Buffer"].includes(parts[0][0]);
      const tip = parts.map(([b, k]) => `${b}: ${k}`).join(" · ") + (c.dual ? ` · ${c.dual} on 2 projects` : "");
      return `<td class="h mxb" data-cell="${esc(d)}|||${esc(pr.sector)}|||${esc(pr.name)}" title="${esc(d)} · ${esc(pr.name)} — ${esc(tip)}"><span class="mxc${light ? " lt" : ""}${c.dual ? " dual" : ""}" style="background:${bg}">${n}</span></td>`;
    };

    v.innerHTML = `
      <div class="dom">
        <div class="card dom-list">
          <div class="card-h"><h3>Domains</h3><span class="sub">people per domain</span></div>
          ${doms.map(([d, n]) => `<div class="dl-row${d === sel ? " on" : ""}" data-domain="${esc(d)}">
            <span class="dl-name">${esc(d)}</span><span class="dl-bar"><i style="width:${(n / maxD) * 100}%"></i></span><span class="dl-n">${n}</span></div>`).join("")}
        </div>
        <div class="card dom-detail">
          <div class="card-h"><h3>${esc(sel || "—")}</h3><span class="sub">${selPeople.length} people · ${selProjects.length} project${selProjects.length === 1 ? "" : "s"}</span></div>
          <h4 class="dd-h">Project-wise head count</h4>
          ${selProjects.map((pr) => `<div class="dl-row" data-proj="${esc(pr.sector)}|||${esc(pr.name)}">
            <span class="dl-name">${esc(pr.name)} <span class="muted">· ${esc(pr.sector)}</span></span><span class="dl-bar"><i style="width:${(pr.assigns.length / maxP) * 100}%;background:${sectorColor(pr.sector)}"></i></span><span class="dl-n">${pr.assigns.length}</span></div>`).join("") || `<div class="muted">No project assignments.</div>`}
          <h4 class="dd-h">People</h4>
          <div id="tPeople"></div>
        </div>
      </div>
      <div class="section-title"><h2>Domain × project</h2><span class="sub">people from each domain on each project · colour = billing status · click a number to list them</span></div>
      <div class="pg-legend">${M.BILLING.map((b) => `<span class="pg-key ${bcls(b)}">${esc(b)}</span>`).join("")}<span class="pg-key mx-mix">Mixed statuses = split colours</span><span class="pg-key mx-dualkey">Violet corner = someone on 2 projects</span></div>
      ${mx.projects.length ? `<div class="table-wrap tall"><table class="t matrix"><thead><tr><th class="first">Domain</th>${mx.projects.map((pr) => `<th class="rot" title="${esc(pr.sector)}">${esc(pr.name)}</th>`).join("")}</tr></thead><tbody>
        ${mx.domains.map((d) => `<tr${d === sel ? ' class="mx-on"' : ""}><td class="first">${esc(d)}</td>${mx.projects.map((pr) => {
          const n = mx.get(d, pr);
          return n ? mxCell(d, pr, n) : `<td class="h zero">·</td>`;
        }).join("")}</tr>`).join("")}</tbody></table></div>` : ""}`;
    v.querySelectorAll("[data-domain]").forEach((el) => el.addEventListener("click", () => go("domains", { domain: el.dataset.domain }, false)));
    v.querySelectorAll(".dom-detail [data-proj]").forEach((el) => el.addEventListener("click", () => {
      const [sec, pname] = el.dataset.proj.split("|||");
      showPanel({ title: sel + " · " + pname, patch: { domain: sel, sector: sec, project: pname } }, el);
    }));
    peopleTable($("tPeople"), "domainPeople", selPeople, { short: true, noSector: true, noDomain: true });
    v.querySelectorAll("[data-cell]").forEach((td) => td.addEventListener("click", () => {
      const [d, sec, pname] = td.dataset.cell.split("|||");
      showPanel({ title: d + " · " + pname, patch: { domain: d, sector: sec, project: pname } }, td);
    }));
  };

  function exportCsv(rows) {
    const head = ["Emp ID", "Name", "Sector", "Project", "Project (as entered)", "Allocation %", "Second sector", "Second project", "Second allocation %", "Level", "Designation", "Domain", "Billing status", "Earning", "Experience (YOE)", "Reports to", "Moved from baseline", "Baseline"];
    const q = (x) => { const s = x == null ? "" : String(x); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [head.map(q).join(",")].concat(rows.map((r) => {
      const e = r.emp, s2 = e.second && e.second.isSeparateAssignment ? e.second : null;
      return [e.id, e.name, e.sector, e.project, e.projectRaw, e.firstPct == null ? "pending" : Math.round(e.firstPct * 100),
        s2 ? s2.sector : "", s2 ? s2.project : "", s2 ? (s2.pct == null ? "pending" : Math.round(s2.pct * 100)) : "",
        e.level, e.designation, e.domain, r.ctxBilling, e.earning, e.yoe, e.reportsTo, e.moved ? "Yes" : "No",
        [e.baseline.sector, e.baseline.project, e.baseline.level].filter(Boolean).join(" › ")].map(q).join(",");
    }));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "VCT-employees-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }


  // ---- Reporting hierarchy — top-down org chart, every person coloured by billing status
  // Three views (switch in the top-left corner):
  //   line    = reporting line from the "Reports To" column; click a manager to open their team below
  //   domain  = people grouped by domain; click a domain to see its people
  //   billing = people grouped by billing status only
  // state.hierPath = ids of the managers opened at each level (reporting line view).
  views.hierarchy = function (v) {
    const H = M.hierarchy(DATA.employees);
    const kids = (e) => H.children.get(e.id);
    const isMgr = (e) => kids(e).length > 0;
    const ROLLUP = 8; // with this many or more people without a team, show them as one "N others" box
    const mode = ["line", "sector", "domain", "billing"].includes(state.hierMode) ? state.hierMode : "line";
    const isDual = (e) => !!(e.second && e.second.isSeparateAssignment);
    const billOf = (e) => e.billing || "Not set";
    const domOf = (e) => e.domain || "Not specified";

    // A person's box: filled with their billing colour; two-project people are half billing colour, half violet.
    const box = (e, opts) => {
      opts = opts || {};
      const n = opts.n !== undefined ? opts.n : mode === "line" ? kids(e).length : 0;
      const b = billOf(e), dual = isDual(e);
      const cls = ["ocb", "bx", "bx-" + bcls(b), dual ? "dual" : "", opts.root ? "root" : "", opts.sel ? "sel" : "", n ? "mgr" : "", e.id === state.hierFocus ? "hl" : ""].join(" ");
      const tip = esc(e.name) + " — " + esc(b) + (dual ? " · two projects" : "") + (n ? " · click to show the team" : " · click for profile");
      return `<div class="${cls}" data-${n && !opts.root ? (opts.openAttr || "open") : "emp"}="${esc(e.id)}" title="${tip}">
        <b>${esc(e.name)}</b><small>${esc(opts.sub || e.designation || e.level || "")}</small>
        ${n ? `<span class="ocn">${opts.root ? n + " direct reports" : n}</span>` : ""}
        ${opts.note ? `<em>${esc(opts.note)}</em>` : ""}</div>`;
    };

    const legend = `<div class="pg-legend hm-legend">${M.BILLING.map((b) => `<span class="pg-key ${bcls(b)}">${esc(b)}</span>`).join("")}<span class="pg-key dual">Working on 2 projects (left half = billing)</span></div>`;
    const switcher = `<div class="hm-tabs" role="tablist">
      ${[["line", "Reporting line"], ["sector", "Sector-wise"], ["domain", "Domain × billing"], ["billing", "Billing only"]].map(([k, l]) =>
        `<button type="button" class="hm-tab${mode === k ? " on" : ""}" data-hmode="${k}">${l}</button>`).join("")}</div>`;

    // Billing mix of a group as a thin stacked bar.
    const bar = (list) => {
      const n = list.length || 1;
      return `<span class="hb-bar">${M.BILLING.map((b) => {
        const c = list.filter((e) => billOf(e) === b).length;
        return c ? `<i class="bx-${bcls(b)}" style="width:${(c / n) * 100}%" title="${esc(b)}: ${c}"></i>` : "";
      }).join("")}</span>`;
    };

    let html = "", path = [];
    if (mode === "line") {
      // Coming from a profile ("Show in reporting hierarchy"): open the path down to that person.
      if (state.hierFocus) {
        const t = employeeById(state.hierFocus);
        if (t) state.hierPath = H.chain(t).slice(1).map((e) => e.id).concat(isMgr(t) && H.chain(t).length ? [t.id] : []);
        if (t && !H.chain(t).length && isMgr(t)) state.hierPath = [];
      }
      if (!state.hierPath) {
        const first = H.tops[0] && kids(H.tops[0]).find(isMgr);
        state.hierPath = first ? [first.id] : [];
      }
      // Drop anything in the path that no longer fits (data changed).
      for (const id of state.hierPath) {
        const e = employeeById(id);
        const top = H.tops.length === 1 ? H.tops[0] : null;
        const allowed = path.length === 0 ? (top ? kids(top) : H.tops) : kids(path[path.length - 1]);
        if (!e || !allowed.includes(e) || !isMgr(e)) break;
        path.push(e);
      }
      state.hierPath = path.map((e) => e.id);

      const group = (list, selected, levelKey, cur) => {
        const mgrs = list.filter(isMgr);
        const others = list.filter((e) => !isMgr(e));
        const rollup = mgrs.length && others.length >= ROLLUP && !(state.hierShowOthers || new Set()).has(levelKey);
        return `<div class="ocw${cur || ""}"><div class="ocr">
          ${mgrs.map((e) => box(e, { sel: selected === e })).join("")}
          ${rollup ? `<div class="ocb more" data-others="${esc(levelKey)}"><b>${others.length} others</b><small>no team · click to show</small></div>`
                   : others.map((e) => box(e)).join("")}
        </div></div>`;
      };
      if (H.tops.length === 1) {
        const t = H.tops[0];
        html += `<div class="ocl">${box(t, { root: true })}</div><div class="ocv"></div>`;
        html += group(kids(t), path[0], t.id);
      } else {
        html += group(H.tops, path[0], "__tops");
      }
      path.forEach((m, i) => {
        const cur = i === path.length - 1 ? " cur" : "";
        html += `<div class="ocv sel${cur}"></div><div class="oct${cur}">Team of <b>${esc(m.name)}</b> · ${kids(m).length}</div>`;
        html += group(kids(m), path[i + 1], m.id, cur);
      });
    } else if (mode === "sector") {
      // Sector-wise: company → sectors → reporting line inside the selected sector (primary sector).
      // Top of a sector = people whose manager is in another sector (or who have none).
      const emps = DATA.employees;
      const secOf = (e) => e.sector || "Not specified";
      const counts = new Map();
      emps.forEach((e) => counts.set(secOf(e), (counts.get(secOf(e)) || 0) + 1));
      const info = new Map(sectorList().map((s) => [s.name, s]));
      const keys = sectorList().map((s) => s.name).filter((k) => counts.get(k))
        .concat([...counts.keys()].filter((k) => !info.has(k)));
      state.hierGroup = state.hierGroup || {};
      state.hierSecPath = state.hierSecPath || {};
      if (state.hierFocus) { const t = employeeById(state.hierFocus); if (t) state.hierGroup.sector = secOf(t); }
      if (!keys.includes(state.hierGroup.sector)) state.hierGroup.sector = keys[0];
      const sel = state.hierGroup.sector;

      const members = emps.filter((e) => secOf(e) === sel);
      const inSec = new Set(members.map((e) => e.id));
      const skids = (e) => kids(e).filter((k) => inSec.has(k.id));
      const sMgr = (e) => skids(e).length > 0;
      const outParent = (e) => { const p = H.parent.get(e.id); return p && !inSec.has(p.id) ? p : null; };
      const byTeam = (a, b) => skids(b).length - skids(a).length || a.name.localeCompare(b.name);
      const roots = members.filter((e) => { const p = H.parent.get(e.id); return !p || !inSec.has(p.id); }).sort(byTeam);

      // Coming from search / a profile: open the in-sector path down to that person.
      if (state.hierFocus && inSec.has(state.hierFocus)) {
        const t = employeeById(state.hierFocus), up = [];
        for (let x = H.parent.get(t.id); x && inSec.has(x.id); x = H.parent.get(x.id)) up.unshift(x.id);
        state.hierSecPath[sel] = up.concat(sMgr(t) ? [t.id] : []);
      }
      for (const id of state.hierSecPath[sel] || []) {
        const e = employeeById(id);
        const allowed = path.length ? skids(path[path.length - 1]) : roots;
        if (!e || !allowed.includes(e) || !sMgr(e)) break;
        path.push(e);
      }
      state.hierSecPath[sel] = path.map((e) => e.id);

      const sbox = (e, opts) => box(e, Object.assign({ n: skids(e).length, openAttr: "sopen" }, opts));
      const sgroup = (list, selected, levelKey, cur, top) => {
        const mgrs = list.filter(sMgr);
        const others = list.filter((e) => !sMgr(e));
        const rollup = mgrs.length && others.length >= ROLLUP && !(state.hierShowOthers || new Set()).has(levelKey);
        const note = (e) => (top && outParent(e) ? "Reports to " + outParent(e).name + " (" + secOf(outParent(e)) + ")" : "");
        return `<div class="ocw${cur || ""}"><div class="ocr">
          ${mgrs.map((e) => sbox(e, { sel: selected === e, note: note(e) })).join("")}
          ${rollup ? `<div class="ocb more" data-others="${esc(levelKey)}"><b>${others.length} others</b><small>no team · click to show</small></div>`
                   : others.map((e) => sbox(e, { note: note(e) })).join("")}
        </div></div>`;
      };
      const head = (k) => String((info.get(k) || {}).head || "").replace(/\s*\(.*\)\s*$/, "");
      const gbox = (k) => {
        const list = emps.filter((e) => secOf(e) === k);
        return `<div class="ocb grp${k === sel ? " sel" : ""}" data-grp="${esc(k)}" title="Show the reporting line inside ${esc(k)}" style="border-top:4px solid ${sectorColor(k)}">
          <b>${esc(k)}</b><small>${head(k) ? "Head: " + esc(head(k)) : "No sector head"}</small>${bar(list)}<span class="ocn">${list.length}</span></div>`;
      };
      const summary = M.BILLING.map((b) => [b, members.filter((e) => billOf(e) === b).length]).filter((x) => x[1]).map(([b, c]) => `${esc(b)} ${c}`).join(" · ");

      html += `<div class="ocl"><div class="ocb root"><b>${esc((DATA.meta && DATA.meta.company) || "All employees")}</b><small>by sector, then reporting line</small><span class="ocn">${emps.length} people</span></div></div><div class="ocv"></div>`;
      html += `<div class="ocw"><div class="ocr">${keys.map(gbox).join("")}</div></div>`;
      if (sel) {
        const cur0 = path.length ? "" : " cur";
        html += `<div class="ocv sel${cur0}"></div><div class="oct${cur0}"><b>${esc(sel)}</b> · ${members.length} people${summary ? ` <span class="${cur0 ? "" : "muted"}">— ${summary}</span>` : ""}</div>`;
        html += sgroup(roots, path[0], "sec:" + sel + ":root", cur0, true);
        path.forEach((m, i) => {
          const cur = i === path.length - 1 ? " cur" : "";
          html += `<div class="ocv sel${cur}"></div><div class="oct${cur}">Team of <b>${esc(m.name)}</b> in ${esc(sel)} · ${skids(m).length}</div>`;
          html += sgroup(skids(m), path[i + 1], "sec:" + sel + ":" + m.id, cur);
        });
      }
    } else {
      // Grouped views: company → groups → people of the selected group.
      const emps = DATA.employees;
      const keyOf = mode === "domain" ? domOf : billOf;
      const counts = new Map();
      emps.forEach((e) => counts.set(keyOf(e), (counts.get(keyOf(e)) || 0) + 1));
      const keys = mode === "billing" ? M.BILLING.filter((k) => counts.get(k))
        : [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
      state.hierGroup = state.hierGroup || {};
      if (state.hierFocus) { const t = employeeById(state.hierFocus); if (t) state.hierGroup[mode] = keyOf(t); }
      if (!keys.includes(state.hierGroup[mode])) state.hierGroup[mode] = keys[0];
      const sel = state.hierGroup[mode];

      const gbox = (k) => {
        const list = emps.filter((e) => keyOf(e) === k);
        const on = k === sel ? " sel" : "";
        if (mode === "billing") {
          return `<div class="ocb bx bx-${bcls(k)} grp${on}" data-grp="${esc(k)}" title="Show everyone who is ${esc(k)}">
            <b>${esc(k)}</b><small>${Math.round((list.length / emps.length) * 100)}% of people</small><span class="ocn">${list.length}</span></div>`;
        }
        return `<div class="ocb grp${on}" data-grp="${esc(k)}" title="Show the people in ${esc(k)}">
          <b>${esc(k)}</b>${bar(list)}<span class="ocn">${list.length}</span></div>`;
      };
      html += `<div class="ocl"><div class="ocb root"><b>${esc((DATA.meta && DATA.meta.company) || "All employees")}</b><small>${mode === "domain" ? "by domain, coloured by billing" : "by billing status"}</small><span class="ocn">${emps.length} people</span></div></div><div class="ocv"></div>`;
      html += `<div class="ocw"><div class="ocr">${keys.map(gbox).join("")}</div></div>`;
      if (sel) {
        const order = (a, b) => mode === "domain"
          ? M.BILLING.indexOf(billOf(a)) - M.BILLING.indexOf(billOf(b)) || a.name.localeCompare(b.name)
          : domOf(a).localeCompare(domOf(b)) || a.name.localeCompare(b.name);
        const people = emps.filter((e) => keyOf(e) === sel).sort(order);
        const summary = mode === "domain"
          ? M.BILLING.map((b) => [b, people.filter((e) => billOf(e) === b).length]).filter((x) => x[1]).map(([b, c]) => `${esc(b)} ${c}`).join(" · ")
          : "";
        html += `<div class="ocv"></div><div class="oct"><b>${esc(sel)}</b> · ${people.length}${summary ? ` <span class="muted">— ${summary}</span>` : ""}</div>`;
        html += `<div class="ocw"><div class="ocr">${people.map((e) => box(e, {
          sub: mode === "domain" ? (e.designation || e.level || "") : [e.designation || e.level, domOf(e)].filter(Boolean).join(" · "),
        })).join("")}</div></div>`;
      }
    }

    const outsideOpen = state.hierOutside;
    v.innerHTML = `
      <div class="card ocard">
        <div class="org-bar">
          ${switcher}
          <input type="search" id="hSearch" placeholder="Find a person…" autocomplete="off" list="hNames">
          <datalist id="hNames">${DATA.employees.map((e) => `<option value="${esc(e.name)}">`).join("")}</datalist>
          ${(mode === "line" || mode === "sector") && path.length ? `<a href="javascript:void 0" id="hReset" class="org-links">↑ Back to top</a>` : ""}
        </div>
        ${legend}
        <div class="oc">${html}</div>
      </div>
      ${mode === "line" && H.outside.length ? `<div class="card ocard mt">
        <div class="ocx" id="hOutside"><span>${outsideOpen ? "▾" : "▸"}</span> <b>Not in the reporting line</b> <span class="ocn">${H.outside.length}</span> <span class="muted">— their manager isn’t an employee in Headcount Data</span></div>
        ${outsideOpen ? `<div class="ocw" style="margin-top:12px"><div class="ocr">${H.outside.map((o) => box(o.emp, { note: o.reason })).join("")}</div></div>` : ""}
      </div>` : ""}`;

    v.querySelectorAll("[data-hmode]").forEach((el) => el.addEventListener("click", () => {
      state.hierMode = el.dataset.hmode;
      state.hierFocus = null;
      render({ keepView: true });
    }));
    v.querySelectorAll("[data-grp]").forEach((el) => el.addEventListener("click", () => {
      state.hierGroup[mode] = el.dataset.grp;
      state.hierFocus = null;
      render({ keepView: true });
    }));
    v.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => {
      const e = employeeById(el.dataset.open);
      const chain = H.chain(e);
      const depth = H.tops.length === 1 ? chain.length - 1 : chain.length;
      const cur = state.hierPath.slice(0, depth);
      state.hierPath = state.hierPath[depth] === e.id ? cur : cur.concat([e.id]); // click again to close
      state.hierFocus = null;
      render({ keepView: true });
    }));
    v.querySelectorAll("[data-sopen]").forEach((el) => el.addEventListener("click", () => {
      // Sector-wise: depth = how many in-sector managers sit above this person.
      const e = employeeById(el.dataset.sopen), sec = state.hierGroup.sector;
      const sp = state.hierSecPath[sec] || [];
      let depth = 0;
      for (let x = H.parent.get(e.id); x && (x.sector || "Not specified") === sec; x = H.parent.get(x.id)) depth++;
      state.hierSecPath[sec] = sp[depth] === e.id ? sp.slice(0, depth) : sp.slice(0, depth).concat([e.id]); // click again to close
      state.hierFocus = null;
      render({ keepView: true });
    }));
    v.querySelectorAll("[data-emp]").forEach((el) => el.addEventListener("click", () => openEmployee(el.dataset.emp)));
    v.querySelectorAll("[data-others]").forEach((el) => el.addEventListener("click", () => {
      state.hierShowOthers = state.hierShowOthers || new Set();
      state.hierShowOthers.add(el.dataset.others);
      render({ keepView: true });
    }));
    const reset = $("hReset");
    if (reset) reset.addEventListener("click", () => {
      if (mode === "sector") state.hierSecPath[state.hierGroup.sector] = [];
      else state.hierPath = [];
      state.hierFocus = null;
      render({ keepView: true });
    });
    const out = $("hOutside");
    if (out) out.addEventListener("click", () => { state.hierOutside = !state.hierOutside; render({ keepView: true }); });
    $("hSearch").addEventListener("change", (ev) => {
      const q = ev.target.value.trim().toLowerCase();
      if (!q) return;
      const e = DATA.employees.find((x) => x.name.toLowerCase() === q) || DATA.employees.find((x) => x.name.toLowerCase().includes(q));
      if (!e) return;
      if (mode === "line") {
        if (H.outside.some((o) => o.emp.id === e.id)) state.hierOutside = true;
        // Show all of the team the person sits in, so they're visible even when grouped under "N others".
        const parent = H.parent.get(e.id);
        if (parent) { state.hierShowOthers = state.hierShowOthers || new Set(); state.hierShowOthers.add(parent.id); }
      } else if (mode === "sector") {
        // Unfold the "N others" box the person may be hidden in (top of sector or their manager's team).
        const sec = e.sector || "Not specified", parent = H.parent.get(e.id);
        state.hierShowOthers = state.hierShowOthers || new Set();
        state.hierShowOthers.add("sec:" + sec + ":root");
        if (parent) state.hierShowOthers.add("sec:" + sec + ":" + parent.id);
      }
      state.hierFocus = e.id;
      render({ keepView: true });
    });
    if (state.hierFocus) {
      const hl = v.querySelector(".ocb.hl");
      if (hl) setTimeout(() => hl.scrollIntoView({ block: "center" }), 0);
    }
  };

  // ---- KPI framework (three tabs)
  views.kpi = function (v) {
    const K = DATA.kpi || {};
    const master = K.master || [];
    const pd = K.productDevelopment;
    const tabs = [["role", "KPIs by role"], ["matrix", "Lead scorecards"]].concat(pd ? [["pd", "Product Development"]] : []);
    if (!tabs.some((t) => t[0] === state.kpiTab)) state.kpiTab = "role";
    let body = "";
    if (state.kpiTab === "role") {
      const sectors = [...new Set(master.map((r) => r.sector))];
      const roles = [...new Set(master.map((r) => r.role))];
      if (!sectors.includes(state.kpiSector)) state.kpiSector = sectors[0] || "";
      if (!roles.includes(state.kpiRole)) state.kpiRole = roles[0] || "";
      const rows = master.filter((r) => r.sector === state.kpiSector && r.role === state.kpiRole).sort((a, b) => a.no - b.no);
      body = `<div class="kpi-pick">
          <div class="f-item"><label>Sector</label><select id="kSector">${sectors.map((x) => `<option${x === state.kpiSector ? " selected" : ""}>${esc(x)}</option>`).join("")}</select></div>
          <div class="f-item"><label>Role</label><select id="kRole">${roles.map((x) => `<option${x === state.kpiRole ? " selected" : ""}>${esc(x)}</option>`).join("")}</select></div>
        </div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Category</th><th>KPI</th><th>How it is measured</th><th class="num">Target</th><th class="num">Weight</th></tr></thead><tbody>
          ${rows.map((r) => `<tr><td class="kpi-cat">${esc(r.category)}</td><td><b>${esc(r.kpi)}</b></td><td class="wrap">${esc(r.measure)}</td>
            <td class="num">${r.unit === "%" && r.target != null ? (r.better === "Lower" ? "≤ " : "≥ ") + pct(r.target, 0) : esc(r.target)}</td><td class="num">${pct(r.weight, 0)}</td></tr>`).join("")}
        </tbody></table></div>`;
    } else if (state.kpiTab === "matrix") {
      body = (K.matrix || []).map((blk) => `<h4 class="dd-h">${esc(blk.title)}</h4><div class="table-wrap" style="margin-bottom:16px"><table class="t"><thead><tr><th>Area</th><th class="num">Weight</th><th>Metric</th><th class="num">Weight</th><th>Target</th><th>How it is measured</th></tr></thead><tbody>
        ${blk.areas.map((a) => a.metrics.map((m, i) => `<tr>${i === 0 ? `<td rowspan="${a.metrics.length}" style="vertical-align:top"><b>${esc(a.area)}</b></td><td rowspan="${a.metrics.length}" class="num" style="vertical-align:top">${esc(a.weight)}</td>` : ""}<td>${esc(m.metric)}</td><td class="num">${esc(m.weight)}</td><td>${esc(m.target)}</td><td class="wrap">${esc(m.measure)}</td></tr>`).join("")).join("")}
      </tbody></table></div>`).join("");
    } else {
      body = `<div class="table-wrap"><table class="t"><thead><tr><th>Area</th><th>KPI / metric</th><th>How it is measured</th>${pd.roles.map((r) => `<th>${esc(r)}</th>`).join("")}</tr></thead><tbody>
        ${pd.rows.map((r) => `<tr><td><b>${esc(r.area)}</b></td><td>${esc(r.metric)}</td><td class="wrap">${esc(r.measure)}</td>${pd.roles.map((role) => {
          const c = r.roles[role] || {};
          return `<td class="wrap" style="min-width:170px">${esc(c.target || "—")}${c.weight != null ? `<br><span class="tag blue">weight ${pct(c.weight, 0)}</span>` : ""}</td>`;
        }).join("")}</tr>`).join("")}
      </tbody><tfoot><tr><td colspan="3">Total weight</td>${pd.roles.map((r) => {
        const t = pd.totals[r];
        return `<td>${t == null ? "—" : pct(t, 0)}${t != null && Math.abs(t - 1) > 0.001 ? ` <span class="tag amber">should be 100%</span>` : ""}</td>`;
      }).join("")}</tr></tfoot></table></div>`;
    }
    v.innerHTML = `
      <div class="card">
        <div class="tabs">${tabs.map(([k, l]) => `<button class="tab${k === state.kpiTab ? " on" : ""}" data-tab="${k}">${esc(l)}</button>`).join("")}<span class="tag draft" style="margin-left:auto;align-self:center">Draft targets</span></div>
        ${body}
      </div>`;
    v.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { state.kpiTab = b.dataset.tab; render({ keepView: true }); }));
    if ($("kSector")) $("kSector").addEventListener("change", (e) => { state.kpiSector = e.target.value; render({ keepView: true }); });
    if ($("kRole")) $("kRole").addEventListener("change", (e) => { state.kpiRole = e.target.value; render({ keepView: true }); });
  };


  // ---- Alerts (edits to the live workbook, emailed to HR)
  let changesTimer = null;
  const EMAIL_BADGE = {
    sent: ["b-Billed", "Emailed to HR"],
    sending: ["b-Buffer", "Sending…"],
    "not-configured": ["b-Buffer", "Not emailed — email not set up"],
    failed: ["b-UnBilled", "Email failed"],
    off: ["b-Not-set", "Alerts off"],
    skipped: ["b-Not-set", "No email (nothing changed)"],
  };
  const fmtVal = (v) => v == null || v === "" ? `<span class="muted">(empty)</span>`
    : v === "(formula)" || (typeof v === "string" && v.startsWith("ƒ:")) ? `<span class="muted">(formula)</span>` : esc(v);
  const isEdit = (ev) => ev.type !== "save";

  views.changes = function (page) {
    if (window.VCTDataSource.state.mode !== "live") {
      page.innerHTML = `<div class="note-box">Alerts work when the portal runs live. Start it with <b>start-portal.bat</b> and open <b>http://localhost:8765/</b>.</div>`;
      return;
    }
    // Two separate alert types: edits to the employee Excel file, and attendance from the HRMS file.
    // "#/changes?tab=attendance" (the link in attendance emails) opens the Attendance tab.
    const qTab = new URLSearchParams(location.hash.split("?")[1] || "").get("tab");
    if (qTab) state.alertsTab = qTab === "attendance" ? "attendance" : "edits";
    const tab = state.alertsTab === "attendance" ? "attendance" : "edits";
    page.innerHTML = `<div class="tabs al-tabs">
        <button class="tab${tab === "edits" ? " on" : ""}" data-altab="edits">Excel edits</button>
        <button class="tab${tab === "attendance" ? " on" : ""}" data-altab="attendance">Attendance</button>
      </div><div id="alBody"></div>`;
    page.querySelectorAll("[data-altab]").forEach((b) => b.addEventListener("click", () => {
      if (state.alertsTab === b.dataset.altab || (!state.alertsTab && b.dataset.altab === "edits")) return;
      state.alertsTab = b.dataset.altab;
      history.replaceState(null, "", "#/changes" + (state.alertsTab === "attendance" ? "?tab=attendance" : ""));
      if (changesTimer) { clearInterval(changesTimer); changesTimer = null; }
      views.changes(page);
    }));
    const v = $("alBody");
    if (tab === "attendance") { attendanceView(v); return; }
    v.innerHTML = `<div class="card empty">Loading alerts…</div>`;
    // What was unseen when the page opened stays marked "NEW" while you're here.
    const newIds = new Set();
    let first = true, lastSig = "";
    const load = async () => {
      const res = await Alerts.fetch();
      if (!res || state.route !== "changes") return;
      res.events.filter((e) => isEdit(e) && Alerts.isUnseen(e)).forEach((e) => newIds.add(e.id));
      // Auto-refresh: redraw only when something changed, and keep the reader's place in scrolled tables.
      const sig = JSON.stringify(res);
      if (!first && sig === lastSig) { Alerts.markAllSeen(res.events); return; }
      lastSig = sig;
      const restore = keepInnerScroll(v);
      drawChanges(v, res, newIds, first);
      if (!first) restore();
      first = false;
      Alerts.markAllSeen(res.events);
    };
    load();
    changesTimer = setInterval(load, 4000);
  };

  // Remember the scroll position of each scrollable table in `root`; call the result after a redraw to restore it.
  function keepInnerScroll(root) {
    const pos = [...root.querySelectorAll(".table-wrap")].map((el) => [el.scrollTop, el.scrollLeft]);
    return () => root.querySelectorAll(".table-wrap").forEach((el, i) => { if (pos[i]) { el.scrollTop = pos[i][0]; el.scrollLeft = pos[i][1]; } });
  }

  // ---- Attendance alerts (HRMS file → /api/attendance)
  function attendanceView(v) {
    v.innerHTML = `<div class="card empty">Loading attendance…</div>`;
    let first = true, lastSig = "";
    const load = async () => {
      let res;
      try { res = await (await fetch("api/attendance", { cache: "no-store" })).json(); } catch (e) { res = { error: "Could not reach the live server." }; }
      if (state.route !== "changes" || state.alertsTab !== "attendance" || !document.body.contains(v)) return;
      // Auto-refresh: redraw only when the report changed, and keep the reader's place in the table.
      const sig = JSON.stringify(res);
      if (!first && sig === lastSig) return;
      if (!first && state.attEdit) return;  // editing recipients — don't redraw under the user
      lastSig = sig;
      const restore = keepInnerScroll(v);
      drawAttendance(v, res, first);
      if (!first) restore();
      first = false;
    };
    load();
    changesTimer = setInterval(load, 15000);
  }

  function drawAttendance(v, res, first) {
    const rep = res.report;
    const cfg = res.config || {};
    const sent = res.sent || [];
    if (!rep) {
      v.innerHTML = `<div class="note-box">${esc(res.error || "No attendance report yet.")} Set the HRMS file under <code>attendance.hrmsPath</code> in <code>portal.config.json</code>; the report appears here a few seconds after the file is found.${res.error && /not available/.test(res.error) ? " Restart the portal (start-portal.bat) to switch attendance alerts on." : ""}</div>`;
      return;
    }
    const R = rep.rules;
    const filt = state.attFilter || "flagged";
    const q = (state.attQ || "").toLowerCase();
    const pick = {
      flagged: (p) => p.flagged,
      short: (p) => p.rules.includes("short-hours"),
      few: (p) => p.rules.includes("few-days"),
      all: () => true,
    }[filt] || ((p) => p.flagged);
    const rows = rep.people.filter(pick).filter((p) => !q || (p.id + " " + p.name + " " + p.email).toLowerCase().includes(q));
    const hm = (h) => h == null ? "—" : `${Math.floor(h)}h ${String(Math.round((h - Math.floor(h)) * 60)).padStart(2, "0")}m`;
    const day = (iso) => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { day: "2-digit", month: "short" });
    const nameCell = (p) => employeeById(p.id) ? `<a href="javascript:void 0" data-emp="${esc(p.id)}">${esc(p.name)}</a>` : esc(p.name);
    const ATT_BADGE = { sent: ["b-Billed", "Emailed"], "not-configured": ["b-Buffer", "Not emailed — email not set up"], failed: ["b-UnBilled", "Email failed"], off: ["b-Not-set", "Alerts off"] };
    const badgeOf = (st) => { const b = ATT_BADGE[st] || ["b-Not-set", st || "—"]; return `<span class="badge ${b[0]}">${esc(b[1])}</span>`; };
    const last = sent[0];
    const mon = res.monthly || {};
    const ordinal = (n) => { n = +n; const t = n % 100, o = n % 10; return n + (t >= 11 && t <= 13 ? "th" : o === 1 ? "st" : o === 2 ? "nd" : o === 3 ? "rd" : "th"); };
    const fmtNext = (iso) => iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
    const keepScroll = !first ? window.scrollY : 0;
    const recip = [].concat(cfg.hrEmails || [], cfg.ceoEmails || []);
    const RECIP_LISTS = [["hrEmails", "HR"], ["ceoEmails", "CEO"], ["ccEmails", "CC"]];
    const recipEditor = () => {
      const d = state.attDraft;
      return `<div class="card mt att-edit">
        <div class="att-edit-h"><b>Who receives attendance emails</b><span class="muted">Type an address and press Enter (or comma). Click × to remove.</span></div>
        ${RECIP_LISTS.map(([k, label]) => `<div class="re-row">
          <div class="re-lbl"><b>${label}</b></div>
          <div class="re-box" data-rk="${k}">
            ${d[k].map((em, i) => `<span class="re-chip">${esc(em)}<button type="button" data-rdel="${k}|${i}" title="Remove">×</button></span>`).join("")}
            <input type="email" data-rin="${k}" placeholder="${d[k].length ? "Add another…" : "name@company.com"}" autocomplete="off">
          </div>
        </div>`).join("")}
        <div class="re-msg" id="reMsg">${esc(state.attEditMsg || "")}</div>
        <div class="re-foot">
          <span class="muted">Saved to <code>portal.config.json</code>. Used for new HRMS reports, the monthly report and “Send report again”.</span>
          <span><button class="btn-ghost" id="reCancel">Cancel</button> <button class="btn" id="reSave">Save recipients</button></span>
        </div>
      </div>`;
    };
    const ICON = {
      cal: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`,
      flag: `<svg viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>`,
      clock: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
      days: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M9 15l2 2 4-4"/></svg>`,
      mail: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M4 7l8 6 8-6"/></svg>`,
    };
    // A count card with the share of all employees as a bar; click to filter the table below.
    const statCard = (cls, icon, label, n, note, filter) => {
      const pctV = rep.employees ? Math.round((n / rep.employees) * 100) : 0;
      return `<button type="button" class="att-card att-click ${cls}${filt === filter ? " on" : ""}" data-attf="${filter}" title="Show these employees">
        <div class="att-top"><span class="att-ico">${icon}</span><span class="att-lbl">${esc(label)}</span></div>
        <div class="att-big">${n}<small>/ ${rep.employees}</small></div>
        <div class="att-bar"><i style="width:${pctV}%"></i></div>
        <div class="att-foot"><b>${pctV}%</b> of employees · ${esc(note)}</div>
      </button>`;
    };
    v.innerHTML = `
      <div class="att-cards">
        <div class="att-card c-blue">
          <div class="att-top"><span class="att-ico">${ICON.cal}</span><span class="att-lbl">Period</span></div>
          <div class="att-big">${esc(rep.periodLabel || "—")}</div>
          <div class="att-chips"><span>${rep.employees} employees</span><span>${rep.workingDatesInFile || "—"} dates</span></div>
          <div class="att-foot att-file" title="${esc(rep.source)}"><svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>${esc(rep.source)}</div>
        </div>
        ${statCard("c-red", ICON.flag, "Flagged", rep.flaggedCount, R.match === "all" ? "Break both rules" : "Break at least one rule", "flagged")}
        ${statCard("c-amber", ICON.clock, `Days under ${R.minHoursPerDay} h`, rep.shortHoursCount, `At least one day under ${R.minHoursPerDay} hours`, "short")}
        ${statCard("c-violet", ICON.days, `Under ${R.minDaysPerMonth} days`, rep.fewDaysCount, `Attended fewer than ${R.minDaysPerMonth} days`, "few")}
        <div class="att-card ${cfg.emailConfigured ? "c-green" : "c-grey"}">
          <div class="att-top"><span class="att-ico">${ICON.mail}</span><span class="att-lbl">Email to HR &amp; CEO</span></div>
          <div class="att-status ${cfg.emailConfigured ? "on" : "off"}"><i></i>${cfg.emailConfigured ? "On" : "Not set up"}</div>
          ${cfg.emailConfigured
            ? `<div class="att-recip">${recip.map((r) => `<span>${esc(r)}</span>`).join("")}${(cfg.ccEmails || []).map((r) => `<span class="cc">CC ${esc(r)}</span>`).join("")}</div>`
            : `<div class="att-foot">Add HR &amp; CEO addresses in <code>portal.config.json</code> to start emailing.</div>`}
        </div>
      </div>
      ${res.error ? `<div class="note-box mt">${esc(res.error)} Showing the last report read.</div>` : ""}
      ${cfg.emailConfigured ? "" : `<div class="att-note mt"><span class="att-note-ico"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M4 7l8 6 8-6"/></svg></span><div><b>One step left — add who should get these emails.</b><br>Click <b>✎ Edit recipients</b> below to add the HR and CEO addresses (and any CC). Until then, a copy of each email is kept in <code>audit/attendance/outbox</code>.</div></div>`}
      <div class="card mt att-mail">
        <div><b>Email</b> · ${last ? `${badgeOf(last.status)} <span class="muted">${esc(new Date(last.at).toLocaleString())} — ${esc(last.detail || "")}</span>` : `<span class="muted">Not sent yet — sent automatically when the HRMS file has flagged employees.</span>`}
          ${mon.enabled ? `<div class="att-sched"><span class="att-sched-ico">${ICON.cal}</span> Monthly report to HR &amp; CEO on the <b>${esc(ordinal(mon.day))}</b> of every month at <b>${esc(mon.time)}</b> · next: <b>${esc(mon.dueNow ? "sending now…" : fmtNext(mon.next))}</b>${mon.lastSent ? ` · last sent ${esc(new Date(mon.lastSent).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }))}` : ""}</div>`
            : `<div class="att-sched muted">Monthly report is switched off (attendance → monthlyReport in portal.config.json).</div>`}</div>
        <div class="att-mail-btns">
          <button class="btn-ghost" id="attEdit"${state.attEdit ? " disabled" : ""}>✎ Edit recipients</button>
          <button class="btn" id="attSend"${rep.flaggedCount ? "" : " disabled"}>Send report again</button>
        </div>
      </div>
      ${state.attEdit ? recipEditor() : ""}
      <div class="toolbar">
        <h2 style="font-size:16px">Employees</h2><span class="muted">${rows.length} shown · rule: under ${R.minHoursPerDay} h on a day ${R.match === "all" ? "and" : "or"} under ${R.minDaysPerMonth} days attended</span>
        <input id="attQ" type="search" placeholder="Filter by name, ID or email…" value="${esc(state.attQ || "")}">
      </div>
      <div class="att-filt">${[["flagged", "Flagged", rep.flaggedCount], ["short", `Days < ${R.minHoursPerDay} h`, rep.shortHoursCount], ["few", `< ${R.minDaysPerMonth} days`, rep.fewDaysCount], ["all", "Everyone", rep.employees]]
        .map(([k, l, n]) => `<button class="tab${filt === k ? " on" : ""}" data-attf="${k}">${esc(l)} <span class="att-n">${n}</span></button>`).join("")}</div>
      ${rows.length ? `<div class="table-wrap tall"><table class="t att-table">
        <thead><tr><th>Emp ID</th><th>Name</th><th class="num">Days attended</th><th class="num">Total hours</th><th class="num">Avg / day</th><th class="num">Days &lt; ${R.minHoursPerDay} h</th><th>Short days (date · hours · in–out)</th></tr></thead>
        <tbody>${rows.map((p) => `<tr>
          <td><b>${esc(p.id)}</b></td>
          <td>${nameCell(p)}<div class="muted" style="font-size:12px">${esc(p.email || "")}</div></td>
          <td class="num"><span class="att-pill ${p.daysPresent < R.minDaysPerMonth ? "bad" : "ok"}">${p.daysPresent}</span></td>
          <td class="num">${hm(p.totalHours)}</td>
          <td class="num">${hm(p.avgHours)}</td>
          <td class="num"><span class="att-pill ${p.shortDays.length ? "warn" : "ok"}">${p.shortDays.length}</span></td>
          <td class="wrap">${p.shortDays.length ? p.shortDays.map((d) => `<span class="att-day${d.missedPunch ? " miss" : ""}" title="${d.missedPunch ? "Missed punch — only one of check-in / check-out recorded" : ""}">${esc(day(d.date))} · <b>${d.missedPunch ? "missed punch" : hm(d.hours)}</b> <small>${esc(d.in || "-")}–${esc(d.out || "-")}</small></span>`).join("") : `<span class="muted">—</span>`}</td>
        </tr>`).join("")}</tbody></table></div>` : `<div class="card empty">No employees match.</div>`}
      ${sent.length ? `<h2 class="mt" style="font-size:16px;margin-bottom:8px">Email history</h2>
        <div class="table-wrap"><table class="t"><thead><tr><th>When</th><th>Period</th><th class="num">Flagged</th><th>Status</th><th>To / CC</th></tr></thead><tbody>
        ${sent.map((s) => `<tr><td>${esc(new Date(s.at).toLocaleString())}</td><td>${esc(s.period || "")}</td><td class="num">${s.flagged}</td><td>${badgeOf(s.status)}${s.schedule ? ` <span class="tag blue">Monthly</span>` : s.reason === "sent again from the portal" ? ` <span class="tag">Manual</span>` : ""}</td>
          <td class="wrap">${esc((s.to || []).join(", ") || "—")}${(s.cc || []).length ? `<div class="muted">CC ${esc(s.cc.join(", "))}</div>` : ""}</td></tr>`).join("")}
        </tbody></table></div>` : ""}
      <div class="hint">Read from ${esc(rep.source)} (sheet “${esc(rep.sheet)}”). Hours = Total Hours (first in → last out). The report refreshes by itself when the HRMS file is saved or replaced, and each new result is emailed once.</div>`;
    v.querySelectorAll("[data-attf]").forEach((b) => b.addEventListener("click", () => { state.attFilter = b.dataset.attf; drawAttendance(v, res, false); }));
    const qEl = $("attQ");
    qEl.addEventListener("input", () => {
      state.attQ = qEl.value;
      drawAttendance(v, res, false);
      const n = $("attQ"); n.focus(); n.setSelectionRange(n.value.length, n.value.length);
    });
    v.querySelectorAll("[data-emp]").forEach((el) => el.addEventListener("click", () => openEmployee(el.dataset.emp)));
    // ---- recipients editor
    const EMAIL_OK = /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/;
    const redraw = () => drawAttendance(v, res, false);
    const editBtn = $("attEdit");
    if (editBtn) editBtn.addEventListener("click", () => {
      state.attEdit = true;
      state.attEditMsg = "";
      state.attDraft = { hrEmails: [...(cfg.hrEmails || [])], ceoEmails: [...(cfg.ceoEmails || [])], ccEmails: [...(cfg.ccEmails || [])] };
      redraw();
      const first = v.querySelector("[data-rin]"); if (first) first.focus();
    });
    // Adds what's typed in a box; returns false (and shows why) if it isn't a valid address.
    const addTyped = (inp) => {
      const k = inp.dataset.rin;
      const vals = inp.value.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
      if (!vals.length) return true;
      const bad = vals.find((x) => !EMAIL_OK.test(x));
      if (bad) { state.attEditMsg = `“${bad}” doesn’t look like an email address.`; $("reMsg").textContent = state.attEditMsg; inp.classList.add("bad"); return false; }
      vals.forEach((x) => { if (!state.attDraft[k].some((y) => y.toLowerCase() === x.toLowerCase())) state.attDraft[k].push(x); });
      state.attEditMsg = "";
      return true;
    };
    v.querySelectorAll("[data-rin]").forEach((inp) => {
      inp.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === "," || ev.key === ";") {
          ev.preventDefault();
          if (addTyped(inp)) { const k = inp.dataset.rin; redraw(); v.querySelector(`[data-rin="${k}"]`).focus(); }
        } else if (ev.key === "Backspace" && !inp.value && state.attDraft[inp.dataset.rin].length) {
          state.attDraft[inp.dataset.rin].pop(); const k = inp.dataset.rin; redraw(); v.querySelector(`[data-rin="${k}"]`).focus();
        } else inp.classList.remove("bad");
      });
    });
    v.querySelectorAll(".re-box").forEach((b) => b.addEventListener("click", (ev) => { if (ev.target === b) b.querySelector("input").focus(); }));
    v.querySelectorAll("[data-rdel]").forEach((b) => b.addEventListener("click", () => {
      const [k, i] = b.dataset.rdel.split("|");
      state.attDraft[k].splice(+i, 1);
      redraw();
    }));
    const cancel = $("reCancel");
    if (cancel) cancel.addEventListener("click", () => { state.attEdit = false; state.attEditMsg = ""; redraw(); });
    const save = $("reSave");
    if (save) save.addEventListener("click", async () => {
      // include anything typed but not yet turned into a chip
      for (const inp of v.querySelectorAll("[data-rin]")) if (!addTyped(inp)) return;
      if (!state.attDraft.hrEmails.length && !state.attDraft.ceoEmails.length) { state.attEditMsg = "Add at least one HR or CEO address."; redraw(); return; }
      save.disabled = true; save.textContent = "Saving…";
      let out;
      try { out = await (await fetch("api/attendance/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state.attDraft) })).json(); }
      catch (e) { out = { ok: false, message: "Could not reach the live server. Is the portal running (start-portal.bat)?" }; }
      if (!out.ok) { state.attEditMsg = out.message || "Could not save."; redraw(); return; }
      state.attEdit = false; state.attEditMsg = "";
      try { drawAttendance(v, await (await fetch("api/attendance", { cache: "no-store" })).json(), false); } catch (e) { redraw(); }
      toast("Recipients saved");
    });

    const sendBtn = $("attSend");
    if (sendBtn) sendBtn.addEventListener("click", async () => {
      sendBtn.disabled = true; sendBtn.textContent = "Sending…";
      try { await fetch("api/attendance/send", { method: "POST" }); } catch (e) { /* the result shows in the email history */ }
      try { drawAttendance(v, await (await fetch("api/attendance", { cache: "no-store" })).json(), false); } catch (e) { sendBtn.textContent = "Send report again"; sendBtn.disabled = false; }
    });
    if (!first) window.scrollTo(0, keepScroll);
  }

  function drawChanges(v, res, newIds, first) {
    const all = res.events || [];
    const al = res.alerts || {};
    const pend = res.pending;
    const showSaves = state.showSaves !== false;
    const q = (state.changesQ || "").toLowerCase();
    const matches = (ev) => !q || JSON.stringify([ev.editor, ev.changes]).toLowerCase().includes(q);
    const events = all.filter((e) => (showSaves || isEdit(e)) && matches(e));
    const edits = all.filter(isEdit);
    const today = new Date().toDateString();
    const todayCount = edits.filter((e) => new Date(e.detectedAt).toDateString() === today).length;
    const unidentified = all.filter((e) => !e.editor.matched).length;
    const EI = {
      pen: `<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>`,
      today: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/><circle cx="12" cy="15.5" r="2"/></svg>`,
      who: `<svg viewBox="0 0 24 24"><circle cx="10" cy="8" r="4"/><path d="M3 20c.6-3.8 3.4-6 7-6 1.2 0 2.3.2 3.2.7"/><path d="M17 15.5a2 2 0 1 1 2.6 1.9c-.4.2-.6.5-.6.9v.4M19 21h.01"/></svg>`,
      mail: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M4 7l8 6 8-6"/></svg>`,
    };
    const latest = edits.map((e) => new Date(e.savedAt || e.detectedAt)).sort((x, y) => y - x)[0];
    const lastEdit = latest ? latest.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
    const keepScroll = !first ? window.scrollY : 0;
    v.innerHTML = `
      <div class="att-cards">
        <div class="att-card c-blue">
          <div class="att-top"><span class="att-ico">${EI.pen}</span><span class="att-lbl">Edit alerts</span></div>
          <div class="att-big">${edits.length}</div>
          <div class="att-chips"><span>${all.length} save${all.length === 1 ? "" : "s"} in total</span><span>${all.length - edits.length} with no changes</span></div>
          <div class="att-foot">Every Excel save that changed employee data</div>
        </div>
        <div class="att-card c-teal">
          <div class="att-top"><span class="att-ico">${EI.today}</span><span class="att-lbl">Today</span></div>
          <div class="att-big">${todayCount}<small>edit alert${todayCount === 1 ? "" : "s"}</small></div>
          <div class="att-bar"><i style="width:${edits.length ? Math.round((todayCount / edits.length) * 100) : 0}%"></i></div>
          <div class="att-foot">${lastEdit ? `Last edit <b>${esc(lastEdit)}</b>` : "No edits yet"}</div>
        </div>
        <div class="att-card ${unidentified ? "c-amber" : "c-green"}">
          <div class="att-top"><span class="att-ico">${EI.who}</span><span class="att-lbl">Editor not identified</span></div>
          <div class="att-big">${unidentified}<small>/ ${all.length}</small></div>
          <div class="att-bar"><i style="width:${all.length ? Math.round((unidentified / all.length) * 100) : 0}%"></i></div>
          <div class="att-foot">${unidentified ? "Couldn’t match to an employee — add the name to <code>editors.json</code>" : "Every editor matched to an employee"}</div>
        </div>
        <div class="att-card ${al.emailConfigured ? "c-green" : "c-red"}">
          <div class="att-top"><span class="att-ico">${EI.mail}</span><span class="att-lbl">Email to HR</span></div>
          <div class="att-status ${al.emailConfigured ? "on" : "off"}"><i></i>${al.emailConfigured ? "On" : "Not set up"}</div>
          ${al.emailConfigured
            ? `<div class="att-recip">${(al.hrEmails || []).map((r) => `<span title="${esc(r)}">${esc(r)}</span>`).join("")}</div>`
            : `<div class="att-foot">Alerts are recorded here, not emailed</div>`}
        </div>
      </div>
      ${pend ? `<div class="pending-box mt"><span class="spin"></span><div><b>Edit in progress by ${esc(pend.editor || "someone")}</b> — ${pend.changes} change${pend.changes === 1 ? "" : "s"} so far.
        The alert is created ${pend.alertInSeconds ? `in about ${pend.alertInSeconds} s` : "now"}, once they stop saving (saves within ${esc(al.groupChangesWithinSeconds)} s are grouped).</div></div>` : ""}
      ${al.emailConfigured ? "" : `<div class="note-box mt"><b>Emails to HR are not set up yet.</b> Every alert is still recorded here, and a copy of each email is saved in <code>audit/outbox</code>. To send them, add HR’s address and the sender account under <code>alerts</code> in <code>portal.config.json</code>.</div>`}
      <div class="toolbar">
        <h2 style="font-size:16px">History</h2><span class="muted">${events.length} shown</span>
        <label class="chk"><input type="checkbox" id="chSaves"${showSaves ? " checked" : ""}> Show saves with no data changes</label>
        <input id="chQ" type="search" placeholder="Filter by editor, employee or value…" value="${esc(state.changesQ || "")}">
      </div>
      ${events.length ? events.map((e) => isEdit(e) ? changeCard(e, newIds.has(e.id)) : saveRow(e)).join("")
        : `<div class="card empty">${all.length ? "Nothing matches the filter." : "No alerts yet. When someone saves the Excel file, it appears here within about " + esc(al.groupChangesWithinSeconds) + " seconds."}</div>`}
      <div class="hint">Who edited comes from the name Excel records when the file is saved (“Last modified by”), matched to the employee roster.</div>`;
    const qEl = $("chQ");
    qEl.addEventListener("input", () => {
      state.changesQ = qEl.value;
      drawChanges(v, res, newIds, false);
      const n = $("chQ"); n.focus(); n.setSelectionRange(n.value.length, n.value.length);
    });
    $("chSaves").addEventListener("change", (e) => { state.showSaves = e.target.checked; drawChanges(v, res, newIds, false); });
    v.querySelectorAll("[data-emp]").forEach((el) => el.addEventListener("click", () => openEmployee(el.dataset.emp)));
    if (!first) window.scrollTo(0, keepScroll);
  }

  function editorHtml(ed) {
    const empLink = (id, name) => employeeById(id) ? `<a href="javascript:void 0" data-emp="${esc(id)}">${esc(name || id)}</a>` : esc(name || id);
    return `<div><b>${ed.name ? empLink(ed.empId, ed.name) : "Editor not identified"}</b>${ed.empId ? ` <span class="muted">· ${esc(ed.empId)}</span>` : ""}${ed.email ? ` <span class="muted">· ${esc(ed.email)}</span>` : ""}</div>
      <div class="muted" style="font-size:12.5px">Recorded by Excel as “${esc(ed.recorded || "—")}” · ${esc(ed.how || "")}</div>`;
  }
  const whenText = (ev) => new Date(ev.savedAt || ev.detectedAt).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });

  function saveRow(ev) {
    const ed = ev.editor || {};
    return `<div class="card save-row">
      <span class="save-ico">💾</span>
      <div style="flex:1;min-width:0">${editorHtml(ed)}</div>
      <div class="ch-right"><div>Saved — <b>no data changed</b> · ${esc(whenText(ev))}</div><span class="badge b-Not-set">No email (nothing changed)</span></div>
    </div>`;
  }

  function changeCard(ev, isNew) {
    const ed = ev.editor || {};
    const d = ev.changes;
    const [cls, label] = EMAIL_BADGE[(ev.email || {}).status] || ["b-Not-set", "—"];
    const empLink = (id, name) => employeeById(id) ? `<a href="javascript:void 0" data-emp="${esc(id)}">${esc(name || id)}</a>` : esc(name || id);
    const rows = [];
    d.modified.forEach((m) => m.fields.forEach((f, i) => rows.push(`<tr><td>${i === 0 ? `<b>${esc(m.empId)}</b> · ${empLink(m.empId, m.name)}` : ""}</td><td>${esc(f.field)}</td><td class="before">${fmtVal(f.before)}</td><td class="after">${fmtVal(f.after)}</td></tr>`)));
    d.added.forEach((a) => rows.push(`<tr><td><b>${esc(a["EMP ID"] || "")}</b> · ${esc(a["Employee Name"] || "")}</td><td><span class="tag blue">Employee added</span></td><td class="before"><span class="muted">—</span></td><td class="after">${esc(Object.entries(a).filter(([k]) => !["EMP ID", "Employee Name"].includes(k)).map(([k, x]) => k + ": " + x).join(" · "))}</td></tr>`));
    d.removed.forEach((r) => rows.push(`<tr><td><b>${esc(r["EMP ID"] || "")}</b> · ${esc(r["Employee Name"] || "")}</td><td><span class="tag amber">Employee removed</span></td><td class="before">${esc(Object.entries(r).filter(([k]) => !["EMP ID", "Employee Name"].includes(k)).map(([k, x]) => k + ": " + x).join(" · "))}</td><td class="after"><span class="muted">—</span></td></tr>`));
    d.cells.forEach((c) => {
      const [sheet, ref] = c.cell.split("!");
      const formulaEdit = typeof c.before === "string" && c.before.startsWith("ƒ:") && typeof c.after === "string" && c.after.startsWith("ƒ:");
      rows.push(`<tr><td><b>${esc(sheet)}</b> <span class="muted">· ${esc(ref)}</span></td><td>${esc(c.label)}${formulaEdit ? ` <span class="tag amber">formula edited</span>` : ""}</td><td class="before">${fmtVal(c.before)}</td><td class="after">${fmtVal(c.after)}</td></tr>`);
    });
    const many = rows.length > 15;
    return `<div class="card change-card${isNew ? " is-new" : ""}">
      <div class="ch-head">
        <div class="avatar sm" style="background:${ed.matched ? "#006edb" : "#a3adbd"}">${esc(ed.name ? initials(ed.name) : "?")}</div>
        <div style="min-width:0">${editorHtml(ed)}</div>
        <div class="ch-right"><div>${isNew ? `<span class="new-pill">NEW</span> ` : ""}<b>${ev.count}</b> change${ev.count === 1 ? "" : "s"} · ${esc(whenText(ev))}</div>
          <span class="badge ${cls}" title="${esc((ev.email || {}).detail || "")}">${esc(label)}</span></div>
      </div>
      ${ev.offline ? `<div class="note-box" style="margin:8px 0">Edited while the portal wasn’t running — the editor shown is the last person who saved.</div>` : ""}
      ${many ? `<details><summary class="muted" style="cursor:pointer;margin:6px 0">Show all ${rows.length} changes</summary>` : ""}
      <div class="table-wrap" style="margin-top:8px"><table class="t ch-table"><thead><tr><th>Where</th><th>What</th><th>Before</th><th>After</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>
      ${many ? "</details>" : ""}
    </div>`;
  }

  // ---- unseen-alert badge + pop-up (like phone notifications) -----------------------
  // "Seen" is remembered per browser, so each viewer has their own unread count.
  const Alerts = (function () {
    const KEY = "vct.alerts.seenUpTo";
    let last = null;
    let known = null;
    const read = () => { try { return localStorage.getItem(KEY) || ""; } catch (e) { return ""; } };
    const write = (id) => { try { localStorage.setItem(KEY, id); } catch (e) { /* private mode */ } };
    const api = {
      isUnseen: (ev) => ev.id > read(),
      async fetch() {
        try {
          const res = await (await fetch("api/changes", { cache: "no-store" })).json();
          last = res;
          api.updateBadge(res);
          api.notifyNew(res);
          return res;
        } catch (e) { return null; }
      },
      updateBadge(res) {
        const n = (res.events || []).filter((e) => isEdit(e) && api.isUnseen(e)).length;
        const b = $("alertsBadge");
        if (!b) return;
        b.textContent = n > 99 ? "99+" : String(n);
        b.hidden = !n;
        document.title = (n ? `(${n}) ` : "") + document.title.replace(/^\(\d+\+?\) /, "");
      },
      notifyNew(res) {
        const edits = (res.events || []).filter(isEdit);
        if (known === null) { known = new Set(edits.map((e) => e.id)); return; }
        const fresh = edits.filter((e) => !known.has(e.id));
        fresh.forEach((e) => known.add(e.id));
        if (!fresh.length || state.route === "changes") return;
        const bell = $("alertsBtn");
        bell.classList.remove("ring"); void bell.offsetWidth; bell.classList.add("ring");
        const e = fresh[0];
        const who = e.editor.name || e.editor.recorded || "Someone";
        const first = e.changes.modified[0];
        const detail = first ? `${first.name}: ${first.fields[0].field} ${first.fields[0].before ?? "(empty)"} → ${first.fields[0].after ?? "(empty)"}` : "";
        toast(`<b>🔔 New alert</b> · ${esc(who)} made ${e.count} change${e.count === 1 ? "" : "s"}${fresh.length > 1 ? ` (+${fresh.length - 1} more alerts)` : ""}${detail ? `<br>${esc(detail)}` : ""}<br><a href="#/changes">View alerts →</a>`, 9000);
      },
      markAllSeen(events) {
        const newest = (events || []).filter(isEdit).map((e) => e.id).sort().pop();
        if (newest && newest > read()) write(newest);
        if (last) api.updateBadge(last);
      },
      start() {
        if (window.VCTDataSource.state.mode !== "live") return;
        api.fetch();
        setInterval(() => { if (state.route !== "changes") api.fetch(); }, 6000);
      },
    };
    return api;
  })();

  function fmtDate(s) {
    if (!s) return "—";
    const d = new Date(s);
    return isNaN(d) ? s : d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  // ---------------------------------------------------------------- employee drawer
  let openEmpId = null;
  function openEmployee(id) {
    const e = employeeById(id);
    if (!e) return;
    openEmpId = id;
    const reports = M.reportsIndex(DATA.employees).get(e.name) || [];
    const mgr = employeeByName(e.reportsTo);
    const assigns = M.assignmentsOf(e);
    const leadRole = e.second && !e.second.isSeparateAssignment && e.second.role ? e.second : null;
    const sector = DATA.sectors.find((s) => s.name === e.sector);
    const d = $("drawer");
    d.innerHTML = `
      <div class="d-head"><div class="avatar" style="background:${sectorColor(e.sector)}">${esc(initials(e.name))}</div>
        <div><h2>${esc(e.name)}</h2><div class="sub">${esc(e.designation || e.level)} · ${esc(e.id)}</div>
          <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">${badge(e.billing)}<span class="tag">${esc(e.earning || "—")}</span>${e.moved ? '<span class="tag amber">Moved</span>' : ""}</div></div>
        <button class="close" id="dClose" aria-label="Close">✕</button></div>
      <div class="d-body">
        <div><h4>Project assignments</h4>${assigns.map((a) => `
          <div class="assign" style="margin-bottom:8px"><div class="row1"><b>${esc(a.project)}</b>${a.primary ? '<span class="tag blue">Primary</span>' : '<span class="tag">Second</span>'}${a.role ? `<span class="tag amber">${esc(a.role)}</span>` : ""}<span class="alloc">${a.pct == null ? '<span class="tag amber">% pending</span>' : pct(a.pct, 0)}</span></div>
            <div class="muted">${esc(a.sector)}${a.primary && e.projectRaw && e.projectRaw !== e.project ? " · entered as “" + esc(e.projectRaw) + "”" : ""}</div>
            <div>${badge(a.billing)}</div></div>`).join("")}
          ${leadRole ? `<div class="muted">Also marked as <b>${esc(leadRole.role)}</b> of ${esc(leadRole.project)}.</div>` : ""}
        </div>
        <div><h4>Details</h4><dl class="kv">
          <dt>Sector</dt><dd><a href="${hashFor("sectors", Object.assign(emptyFilter(), { sector: e.sector }))}">${esc(e.sector)}</a>${sector && sector.head ? ` <span class="muted">· head: ${esc(sector.head)}</span>` : ""}</dd>
          ${e.email ? `<dt>Email</dt><dd><a href="mailto:${esc(e.email)}">${esc(e.email)}</a></dd>` : ""}
          <dt>Level</dt><dd>${esc(e.level)}</dd>
          <dt>Designation</dt><dd>${esc(e.designation || "—")}</dd>
          <dt>Domain</dt><dd><a href="${hashFor("domains", Object.assign(emptyFilter(), { domain: e.domain }))}">${esc(e.domain)}</a></dd>
          <dt>Experience</dt><dd>${esc(M.formatYoe(e.yoe) || "Not recorded")}${e.yoe ? ` <span class="muted">(${esc(e.yoe)})</span>` : ""}</dd>
          <dt>Hierarchy</dt><dd><a href="javascript:void 0" data-hier="${esc(e.id)}">Show in reporting hierarchy →</a></dd>
          <dt>Reports to</dt><dd>${mgr ? `<a href="#" data-emp="${esc(mgr.id)}">${esc(mgr.name)}</a>` : esc(e.reportsTo || "—")}</dd>
          <dt>Earning</dt><dd>${esc(e.earning || "—")}</dd>
        </dl></div>
        ${e.moved ? `<div><h4>Movement</h4><div class="move"><div class="muted">From baseline</div><b>${esc([e.baseline.sector, e.baseline.project, e.baseline.level].filter(Boolean).join(" › "))}</b><div class="muted" style="margin-top:6px">To current</div><b>${esc([e.sector, e.projectRaw || e.project, e.level].join(" › "))}</b></div></div>` : ""}
        ${reports.length ? `<div><h4>Direct reports (${reports.length})</h4><div class="table-wrap" style="max-height:300px"><table class="t"><tbody>${reports.map((r) => `<tr class="click" data-emp="${esc(r.id)}"><td><b>${esc(r.name)}</b><br><span class="muted">${esc(r.level)} · ${esc(r.project)}</span></td><td>${badge(r.billing)}</td></tr>`).join("")}</tbody></table></div>
          <div class="hint"><a href="javascript:void 0" data-reports="${esc(e.name)}">Show as a list on this page →</a></div></div>` : ""}
      </div>`;
    d.classList.add("open");
    d.setAttribute("aria-hidden", "false");
    $("drawerBackdrop").classList.add("open");
    $("dClose").addEventListener("click", closeDrawer);
    d.querySelectorAll("[data-emp]").forEach((el) => el.addEventListener("click", (ev) => { ev.preventDefault(); openEmployee(el.dataset.emp); }));
    d.querySelectorAll("a[href^='#/']").forEach((a) => a.addEventListener("click", closeDrawer));
    d.querySelectorAll("[data-hier]").forEach((a) => a.addEventListener("click", () => {
      state.hierFocus = a.dataset.hier;
      closeDrawer();
      if (state.route === "hierarchy") render(); else go("hierarchy", {});
    }));
    d.querySelectorAll("[data-reports]").forEach((a) => a.addEventListener("click", () => {
      const name = a.dataset.reports;
      closeDrawer();
      showPanel({ title: "Direct reports of " + name, patch: { reportsTo: name } }, null);
    }));
  }
  function closeDrawer() {
    openEmpId = null;
    $("drawer").classList.remove("open");
    $("drawer").setAttribute("aria-hidden", "true");
    $("drawerBackdrop").classList.remove("open");
  }
  $("drawerBackdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($("drawer").classList.contains("open")) closeDrawer();
    else if (state.panel) closePanel();
  });

  // ---------------------------------------------------------------- render
  /** Parent page of the current view (used by the Back button when there is no history). */
  function parentHash() {
    const f = state.f;
    if (state.route === "sectors" && f.sector) return hashFor("sectors", Object.assign({}, f, { sector: "", project: "" }));
    if (state.route === "domains" && f.domain) return hashFor("domains", Object.assign({}, f, { domain: "" }));
    if (state.route !== "dashboard") return hashFor("dashboard", emptyFilter());
    return null;
  }

  // Header breadcrumb as chips: ⌂ Home › parent pages › [current page, with its icon].
  const CRUMB_ICONS = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    sectors: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    domains: '<path d="M12 2l9 10-9 10-9-10z"/>',
    hierarchy: '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-4h12v4"/>',
    kpi: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
    changes: '<path d="M18 16V11a6 6 0 1 0-12 0v5l-2 2h16z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  };
  const crumbIcon = (k) => `<svg class="ci" viewBox="0 0 24 24" aria-hidden="true">${CRUMB_ICONS[k] || CRUMB_ICONS.dashboard}</svg>`;
  function crumbs() {
    const f = state.f;
    const keep = (patch) => Object.assign({}, f, patch);
    const chip = (label, h, icon) => `<a class="crumb-chip" href="${h}">${icon ? crumbIcon(icon) : ""}${esc(label)}</a>`;
    const sep = `<span class="sep" aria-hidden="true">›</span>`;
    const parts = [];
    const atHome = state.route === "dashboard" && !FILTER_KEYS.some((k) => f[k]);
    if (!atHome) parts.push(chip("Home", hashFor("dashboard", emptyFilter()), "home"));
    if (state.route === "sectors" && f.sector) parts.push(chip("Sectors", hashFor("sectors", keep({ sector: "", project: "" }))));
    if (state.route === "domains" && f.domain) parts.push(chip("Domains", hashFor("domains", keep({ domain: "" }))));
    parts.push(`<span class="crumb-chip cur" aria-current="page">${crumbIcon(state.route)}${esc(title())}</span>`);
    return parts.join(sep);
  }

  // In-app history, so Back returns to the previous view (falls back to the parent page).
  const navStack = [];
  function trackNav() {
    const h = location.hash || "#/dashboard";
    if (navStack.length > 1 && navStack[navStack.length - 2] === h) navStack.pop();
    else if (navStack[navStack.length - 1] !== h) navStack.push(h);
    else navStack[navStack.length - 1] = h;
    const btn = $("backBtn");
    const atHome = state.route === "dashboard" && !FILTER_KEYS.some((k) => state.f[k]);
    btn.hidden = atHome && navStack.length < 2;
  }
  function goBack() {
    if (navStack.length > 1) history.back();
    else {
      const h = parentHash();
      if (h) location.hash = h;
    }
  }

  function title() {
    const f = state.f;
    if (state.route === "sectors" && f.sector) return f.sector;
    if (state.route === "domains" && f.domain) return "Domain · " + f.domain;
    if (state.route === "dashboard" && (f.sector || f.project)) return "Dashboard · " + (f.project || f.sector);
    return ROUTES[state.route];
  }
  // Sector/project in a hash: opening another sector or project is a different page.
  function parseHashScope(h) {
    const q = new URLSearchParams((h.split("?")[1]) || "");
    return (q.get("sector") || "") + "|" + (q.get("project") || "");
  }

  function render(opts) {
    opts = opts || {};
    const p = parseHash();
    const prevRoute = state.route;
    const scrollY = window.scrollY;
    const reopen = opts.keepView ? openEmpId : null;
    state.route = p.route;
    state.f = p.f;
    // Only the Dashboard is filtered; other pages use just their own selection.
    if (state.route === "sectors") state.f = Object.assign(emptyFilter(), { sector: p.f.sector });
    else if (state.route === "domains") state.f = Object.assign(emptyFilter(), { domain: p.f.domain });
    else if (state.route !== "dashboard") state.f = emptyFilter();
    destroyCharts();
    closeDrawer();
    if (changesTimer) { clearInterval(changesTimer); changesTimer = null; }
    renderFilters();
    document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === state.route));
    $("alertsBtn").classList.toggle("active", state.route === "changes");
    $("pageTitle").textContent = title();
    $("crumbs").innerHTML = crumbs();
    document.title = title() + " · VCT Employee Portal";
    if (!opts.keepView) trackNav();
    // The panel survives live refreshes and filter changes on the same page; navigating closes it.
    if (state.panel && !opts.keepView) {
      const was = state.panel.hash.replace(/\?.*$/, "") + "|" + (parseHashScope(state.panel.hash));
      const now = location.hash.replace(/\?.*$/, "") + "|" + parseHashScope(location.hash);
      if (was !== now) state.panel = null; else state.panel.hash = location.hash;
    }
    const v = $("view");
    try {
      views[state.route](v);
      if (state.panel) renderPanel(false);
    } catch (err) {
      console.error(err);
      v.innerHTML = `<div class="card empty">Something went wrong showing this page: ${esc(err.message)}</div>`;
    }
    if (opts.keepView) {
      Chart.defaults.animation.duration = 350;
      window.scrollTo(0, scrollY);
      if (reopen && employeeById(reopen)) openEmployee(reopen);
    } else {
      if (prevRoute !== state.route) window.scrollTo(0, 0);
      $("sidebar").classList.remove("open");
    }
  }

  function renderShellInfo() {
    const meta = DATA.meta || {};
    const src = window.VCTDataSource.state;
    const live = src.mode === "live";
    const mode = !live ? ["", "● SNAPSHOT"] : !src.connected ? ["off", "● OFFLINE"] : src.error ? ["off", "● LIVE · ERROR"] : ["live", "● LIVE"];
    const time = (s) => { const d = new Date(s); return isNaN(d) ? "—" : d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }); };
    $("sourceInfo").innerHTML = `<span class="mode ${mode[0]}">${mode[1]}</span><br>
      <b>${DATA.employees.length}</b> employees · <b>${DATA.projects.filter((p) => p.status !== "Deleted").length}</b> projects<br>
      Excel saved ${esc(time(meta.sourceModified))}
      ${live && !src.connected ? `<div class="foot-warn">Live server stopped — showing the last data. Run start-portal.bat.</div>` : ""}
      ${live && src.connected && src.error ? `<div class="foot-warn">${esc(src.error)} — showing the last good data.</div>` : ""}
      ${live && src.connected && !src.error ? `<div class="foot-ok">Updates automatically when the Excel file is saved.</div>` : ""}
      ${!live ? `<div class="foot-note">Opened as a file. For automatic updates, use start-portal.bat.</div>` : ""}`;
    const checks = M.reconcile(DATA);
    const bad = checks.filter((c) => !c.ok && !c.soft).length;
    const vb = $("verifyBadge");
    vb.textContent = checks.length ? (bad ? `⚠ ${bad} mismatch${bad > 1 ? "es" : ""} with Excel` : `✓ Matches Excel · ${checks.length} checks`) : "";
    vb.classList.toggle("bad", !!bad);
    vb.style.display = checks.length ? "" : "none";
    vb.onclick = null;
    vb.title = "Every number in the portal is recalculated from the employee rows and matches the totals in the Excel workbook.";
  }

  let toastTimer;
  function toast(msg, ms) {
    let t = $("toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "toast";
      t.className = "toast";
      t.setAttribute("role", "status");
      document.body.appendChild(t);
    }
    t.innerHTML = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), ms || 6000);
  }

  /** Short description of what changed between two data versions. */
  function changeSummary(prev, next) {
    const a = M.billingCounts(M.filterEmployees(prev.employees, {}));
    const b = M.billingCounts(M.filterEmployees(next.employees, {}));
    const parts = [];
    const d = (label, x, y) => { if (x !== y) parts.push(`${label} ${x} → ${y}`); };
    d("Head count", prev.employees.length, next.employees.length);
    M.BILLING.forEach((k) => d(k, a[k], b[k]));
    if (!parts.length) {
      const key = (e) => JSON.stringify(e);
      const before = new Map(prev.employees.map((e) => [e.id, key(e)]));
      const changed = next.employees.filter((e) => before.get(e.id) !== key(e)).length;
      if (changed) parts.push(`${changed} employee record${changed > 1 ? "s" : ""} changed`);
    }
    return parts.slice(0, 3).join(" · ");
  }

  // UI theme: portal.config.json can't reach the browser, so the default lives here.
  const DEFAULT_UI = "pulse";
  document.documentElement.dataset.ui = new URLSearchParams(location.search).get("ui") || DEFAULT_UI;

  async function start() {
    try {
      DATA = await window.VCTDataSource.load();
    } catch (err) {
      $("view").innerHTML = `<div class="card empty">Could not load data: ${esc(err.message)}</div>`;
      return;
    }
    bindFilters();
    $("menuBtn").addEventListener("click", () => $("sidebar").classList.toggle("open"));
    $("backBtn").addEventListener("click", goBack);
    renderShellInfo();
    render();
    Alerts.start();
    // Live mode: redraw in place (same page, filters, scroll and open profile) when Excel is saved.
    window.VCTDataSource.onChange((ev) => {
      if (ev.type === "data") {
        const prev = DATA;
        DATA = ev.data;
        renderShellInfo();
        Chart.defaults.animation.duration = 0;
        if (state.route !== "changes") render({ keepView: true });
        const what = changeSummary(prev, DATA);
        const by = DATA.meta && DATA.meta.lastModifiedBy;
        toast(`<b>Updated from Excel</b> · ${new Date().toLocaleTimeString()}${by ? ` · saved by ${esc(by)}` : ""}${what ? `<br>${esc(what)}` : ""}`);
      } else {
        renderShellInfo();
      }
    });
  }
  start();
})();
