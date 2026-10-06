/*
 * VCT portal — calculation layer.
 * Pure functions over the data file; no DOM access. Runs in the browser
 * (window.VCTMetrics) and in Node (require) so the numbers can be tested
 * against the Excel workbook's own totals (see scripts/verify.js).
 *
 * Counting rules (same as the workbook):
 *  - Head count counts each employee once, by PRIMARY sector/project.
 *  - Project counts are ASSIGNMENTS: a person on two projects counts in both.
 *    A second entry only counts when it differs from the primary sector/project.
 *  - Billable = Billed + Buffer Billed. Bench = Buffer + UnBilled.
 *  - Weighted head count sums the allocation % (100% = 1); blank % = pending (0).
 */
(function (root) {
  "use strict";

  const BILLING = ["Billed", "Buffer Billed", "Buffer", "UnBilled", "Not set"];
  const BILLABLE = ["Billed", "Buffer Billed"];
  const BENCH = ["Buffer", "UnBilled"];
  const LEVELS = ["Staff Engineer", "Senior Engineer", "Engineer 2", "Engineer 1", "Trainee", "Intern", "Others"];

  /** All project assignments held by one employee (primary first). */
  function assignmentsOf(e) {
    const list = [{
      emp: e, sector: e.sector, project: e.project, billing: e.billing,
      pct: e.firstPct, primary: true, role: null,
    }];
    const s = e.second;
    if (s && s.isSeparateAssignment) {
      list.push({
        emp: e, sector: s.sector, project: s.project, billing: s.billing,
        pct: s.pct, primary: false, role: s.role,
      });
    }
    return list;
  }

  function allAssignments(emps) {
    const out = [];
    emps.forEach((e) => out.push(...assignmentsOf(e)));
    return out;
  }

  function textMatch(e, q) {
    if (!q) return true;
    const hay = [e.id, e.name, e.designation, e.domain, e.reportsTo, e.project, e.projectRaw, e.sector]
      .filter(Boolean).join(" ").toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
  }

  /** Employee-level checks that don't depend on the sector/project scope. */
  function personMatch(e, f) {
    if (f.domain && e.domain !== f.domain) return false;
    if (f.level && e.level !== f.level) return false;
    if (f.earning && e.earning !== f.earning) return false;
    if (f.moved === "yes" && !e.moved) return false;
    if (f.moved === "no" && e.moved) return false;
    if (f.reportsTo && e.reportsTo !== f.reportsTo) return false;
    return textMatch(e, f.q);
  }

  /** Assignments that match the filter (scope is checked on the assignment itself). */
  function filterAssignments(emps, f) {
    f = f || {};
    return allAssignments(emps).filter((a) =>
      (!f.sector || a.sector === f.sector) &&
      (!f.project || a.project === f.project) &&
      (!f.billing || a.billing === f.billing) &&
      personMatch(a.emp, f));
  }

  /**
   * Employees that match the filter, each once.
   * Without a project filter the sector is the employee's primary sector (head-count rule).
   * With a project filter, anyone assigned to that project matches (incl. second projects),
   * and `ctxBilling` is the billing status for that assignment.
   */
  function filterEmployees(emps, f) {
    f = f || {};
    const out = [];
    emps.forEach((e) => {
      if (!personMatch(e, f)) return;
      if (f.project) {
        const a = assignmentsOf(e).find((x) =>
          x.project === f.project && (!f.sector || x.sector === f.sector));
        if (!a || (f.billing && a.billing !== f.billing)) return;
        out.push({ emp: e, ctxBilling: a.billing, ctxAssignment: a });
      } else {
        if (f.sector && e.sector !== f.sector) return;
        if (f.billing && e.billing !== f.billing) return;
        out.push({ emp: e, ctxBilling: e.billing, ctxAssignment: assignmentsOf(e)[0] });
      }
    });
    return out;
  }

  function countBy(items, keyFn, order) {
    const m = new Map();
    (order || []).forEach((k) => m.set(k, 0));
    items.forEach((it) => {
      const k = keyFn(it);
      m.set(k, (m.get(k) || 0) + 1);
    });
    return m;
  }

  function billingCounts(items, keyFn) {
    const c = countBy(items, keyFn || ((x) => x.ctxBilling || x.billing), BILLING);
    const o = {};
    BILLING.forEach((b) => (o[b] = c.get(b) || 0));
    o.total = items.length;
    o.billable = BILLABLE.reduce((s, b) => s + o[b], 0);
    o.bench = BENCH.reduce((s, b) => s + o[b], 0);
    o.billablePct = o.total ? o.billable / o.total : null;
    o.benchPct = o.total ? o.bench / o.total : null;
    return o;
  }

  function weighted(assigns) {
    let w = 0, pending = 0;
    assigns.forEach((a) => {
      if (a.pct == null) pending += 1;
      else w += a.pct;
    });
    return { weighted: Math.round(w * 100) / 100, pending };
  }

  /** Summary numbers for the current filter. */
  function summary(data, f) {
    const people = filterEmployees(data.employees, f);
    const assigns = filterAssignments(data.employees, f);
    const b = billingCounts(people);
    const w = weighted(assigns);
    const projects = new Set(assigns.map((a) => a.sector + "|" + a.project));
    return {
      headcount: people.length,
      billing: b,
      earning: people.filter((p) => p.emp.earning === "Earning").length,
      notEarning: people.filter((p) => p.emp.earning !== "Earning").length,
      moved: people.filter((p) => p.emp.moved).length,
      assignments: assigns.length,
      weighted: w.weighted,
      pending: w.pending,
      projectsStaffed: projects.size,
      people,
      assigns,
    };
  }

  /** Per-project stats (assignment-based), in the Overall sheet's column order. */
  function projectStats(data, f) {
    const assigns = filterAssignments(data.employees, f);
    const byKey = new Map();
    data.projects.filter((p) => p.status !== "Deleted").forEach((p) => {
      if (f && f.sector && p.sector !== f.sector) return;
      if (f && f.project && p.name !== f.project) return;
      byKey.set(p.sector + "|" + p.name, { project: p, assigns: [] });
    });
    assigns.forEach((a) => {
      const k = a.sector + "|" + a.project;
      if (!byKey.has(k)) {
        // A project used in Headcount Data but missing from the Projects sheet — still show it.
        byKey.set(k, { project: { sector: a.sector, name: a.project, lead: null, status: "Not in Projects sheet", order: 9999 }, assigns: [] });
      }
      byKey.get(k).assigns.push(a);
    });
    return [...byKey.values()]
      .map((r) => Object.assign({
        sector: r.project.sector, name: r.project.name, lead: r.project.lead, status: r.project.status,
        order: r.project.order, assigns: r.assigns,
        billing: billingCounts(r.assigns, (a) => a.billing),
      }, weighted(r.assigns)))
      .sort((a, b) => a.order - b.order);
  }

  /** Head count per sector (primary), every sector in Operating Model order. */
  function sectorStats(data, f) {
    const g = Object.assign({}, f || {}, { sector: null, project: null });
    return data.sectors.concat(extraSectors(data)).map((s) => {
      const people = filterEmployees(data.employees, Object.assign({}, g, { sector: s.name }));
      const assigns = filterAssignments(data.employees, Object.assign({}, g, { sector: s.name }));
      const projects = data.projects.filter((p) => p.sector === s.name && p.status !== "Deleted");
      return Object.assign({
        name: s.name, head: s.head, ownership: s.ownership, domains: s.domains,
        headcount: people.length, people, assigns,
        billing: billingCounts(people),
        projectCount: projects.length,
        staffedProjects: new Set(assigns.map((a) => a.project)).size,
        levels: countBy(people, (p) => p.emp.level, LEVELS),
      }, weighted(assigns));
    });
  }

  /** Sectors used in the data or project list but missing from the Operating Model sheet. */
  function extraSectors(data) {
    const known = new Set(data.sectors.map((s) => s.name));
    const extra = new Set();
    data.projects.forEach((p) => !known.has(p.sector) && extra.add(p.sector));
    data.employees.forEach((e) => !known.has(e.sector) && extra.add(e.sector));
    return [...extra].map((name) => ({ name, head: null, ownership: null, domains: null }));
  }

  /** Domain × project matrix (assignment-based). */
  function domainProjectMatrix(data, f) {
    const assigns = filterAssignments(data.employees, f);
    const domains = countBy(assigns, (a) => a.emp.domain);
    const projects = projectStats(data, f).filter((p) => p.assigns.length);
    const cell = new Map();
    assigns.forEach((a) => {
      const k = a.emp.domain + "||" + a.sector + "|" + a.project;
      cell.set(k, (cell.get(k) || 0) + 1);
    });
    return {
      domains: [...domains.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d),
      projects,
      get: (d, p) => cell.get(d + "||" + p.sector + "|" + p.name) || 0,
    };
  }

  /** Direct reports per manager name. */
  function reportsIndex(emps) {
    const m = new Map();
    emps.forEach((e) => {
      if (!e.reportsTo) return;
      if (!m.has(e.reportsTo)) m.set(e.reportsTo, []);
      m.get(e.reportsTo).push(e);
    });
    return m;
  }

  /**
   * Reporting hierarchy from the "Reports To" column.
   * Managers are matched to employees by name (case/space-insensitive).
   * tops    = people with no manager recorded (top of the organisation)
   * outside = people whose manager isn't an employee in the roster (e.g. customer-managed)
   */
  function hierarchy(emps) {
    const key = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
    const byName = new Map(emps.map((e) => [key(e.name), e]));
    const parent = new Map();
    const children = new Map(emps.map((e) => [e.id, []]));
    const tops = [];
    const outside = [];
    emps.forEach((e) => {
      const m = byName.get(key(e.reportsTo));
      if (m && m.id !== e.id) {
        parent.set(e.id, m);
        children.get(m.id).push(e);
      } else if (!e.reportsTo) {
        tops.push(e);
      } else {
        outside.push({ emp: e, reason: /customer-managed/i.test(e.reportsTo) ? "Customer-managed (on site)" : "Manager not in roster: " + e.reportsTo.replace(/\s*\(not in roster\)/i, "") });
      }
    });
    // Guard against loops (A reports to B, B reports to A): break them at the first repeat.
    emps.forEach((e) => {
      const seen = new Set();
      let x = e;
      while (x && parent.has(x.id)) {
        if (seen.has(x.id)) {
          const p = parent.get(x.id);
          children.set(p.id, children.get(p.id).filter((c) => c.id !== x.id));
          parent.delete(x.id);
          tops.push(x);
          break;
        }
        seen.add(x.id);
        x = parent.get(x.id);
      }
    });
    const teamSize = new Map();
    const depth = new Map();
    const size = (e) => {
      if (teamSize.has(e.id)) return teamSize.get(e.id);
      const n = children.get(e.id).reduce((a, c) => a + 1 + size(c), 0);
      teamSize.set(e.id, n);
      return n;
    };
    const walk = (e, d) => { depth.set(e.id, d); children.get(e.id).forEach((c) => walk(c, d + 1)); };
    tops.forEach((t) => { size(t); walk(t, 0); });
    outside.forEach((o) => { size(o.emp); walk(o.emp, 0); });
    const order = (a, b) => (teamSize.get(b.id) || 0) - (teamSize.get(a.id) || 0) || LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || a.name.localeCompare(b.name);
    children.forEach((list) => list.sort(order));
    tops.sort(order);
    const chain = (e) => { const out = []; let p = parent.get(e.id); while (p) { out.unshift(p); p = parent.get(p.id); } return out; };
    const team = (e) => { const out = []; const add = (x) => children.get(x.id).forEach((c) => { out.push(c); add(c); }); add(e); return out; };
    const levels = Math.max(0, ...[...depth.values()]) + 1;
    const managers = emps.filter((e) => children.get(e.id).length);
    return { tops, outside, parent, children, teamSize, depth, chain, team, levels, managers };
  }

  /** "4.11" → "4 yrs 11 mos" (the sheet stores years.months). Raw text kept when not in that form. */
  function formatYoe(v) {
    if (v == null || v === "") return null;
    const s = String(v).trim();
    const m = s.match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (!m) return s.replace(/\+$/, "+ yrs");
    const y = +m[1], mo = m[2] ? +m[2] : 0;
    if (mo > 11) return s + " yrs";
    const parts = [];
    if (y) parts.push(y + (y === 1 ? " yr" : " yrs"));
    if (mo) parts.push(mo + (mo === 1 ? " mo" : " mos"));
    return parts.join(" ") || "< 1 mo";
  }

  /** Experience in years as a number (years.months), or null. "11+" → 11. */
  function yoeYears(v) {
    if (v == null || v === "") return null;
    const m = String(v).trim().match(/^(\d+)(?:\.(\d{1,2}))?\+?$/);
    if (!m) return null;
    const mo = m[2] ? +m[2] : 0;
    return +m[1] + (mo <= 11 ? mo / 12 : 0);
  }

  /** Compare the portal's calculations with the totals saved in the workbook. */
  function reconcile(data) {
    const xs = data.excelSummary;
    const checks = [];
    // soft = the workbook cell uses a Google-Sheets-only formula, which desktop Excel
    // does not recalculate; a difference there means the workbook is stale, not the portal.
    const add = (group, label, expected, actual, soft) => {
      // No saved value in the workbook (e.g. a file saved without recalculating) — nothing to compare.
      if (expected == null || expected === "") return;
      const e = Number(expected);
      const a = actual == null ? null : Number(actual);
      const ok = e === a || (a != null && Math.abs(e - a) < 0.001);
      checks.push({ group, label, expected: e, actual: a, ok, soft: !!soft && !ok });
    };
    const soft = !!xs.projectsGoogleOnly;
    if (!xs) return checks;
    const sectors = sectorStats(data, {});
    const byName = new Map(sectors.map((s) => [s.name, s]));
    Object.entries(xs.bySectorLevel).forEach(([sec, row]) => {
      if (sec === "Total") {
        add("Head count", "Total employees", row.Total, data.employees.length);
        return;
      }
      const s = byName.get(sec);
      add("Head count", sec + " — total", row.Total, s ? s.headcount : 0);
      LEVELS.forEach((l) => add("Head count by level", sec + " — " + l, row[l], s ? s.levels.get(l) || 0 : 0));
    });
    const all = billingCounts(filterEmployees(data.employees, {}));
    Object.entries(xs.billing).forEach(([k, v]) => {
      if (k !== "Total") add("Billing status", k, v, all[k]);
    });
    add("Earning", "Earning", xs.earning.Earning, data.employees.filter((e) => e.earning === "Earning").length);
    add("Earning", "Not earning", xs.earning["Not earning"], data.employees.filter((e) => e.earning !== "Earning").length);
    add("Movement", "People moved from baseline", xs.movedSoFar, data.employees.filter((e) => e.moved).length);
    Object.entries(xs.sectorBilling).forEach(([sec, row]) => {
      if (sec === "Total") return;
      const s = byName.get(sec);
      BILLING.forEach((b) => add("Billing by sector", sec + " — " + b, row[b], s ? s.billing[b] : 0));
    });
    const ps = projectStats(data, {});
    const pByKey = new Map(ps.map((p) => [p.sector + "|" + p.name, p]));
    xs.projects.forEach((row) => {
      const p = pByKey.get(row.sector + "|" + row.project);
      const label = row.sector + " › " + row.project;
      add("Projects", label + " — assigned", row.assigned, p ? p.assigns.length : 0, soft);
      BILLING.forEach((b) => add("Projects", label + " — " + b, row[b], p ? p.billing[b] : 0, soft));
      add("Projects", label + " — weighted", row.weighted, p ? p.weighted : 0, soft);
    });
    const assigns = allAssignments(data.employees);
    add("Totals", "Project assignments", xs.totalAssignments, assigns.length, soft);
    add("Totals", "Weighted head count", xs.totalWeighted, weighted(assigns).weighted, soft);
    return checks;
  }

  /** Data-quality findings shown on the Data Health page. */
  function dataQuality(data) {
    const emps = data.employees;
    const names = new Set(emps.map((e) => e.name.trim().toLowerCase()));
    const issues = [];
    const push = (severity, title, detail, people) => issues.push({ severity, title, detail, people: people || [] });

    const noBilling = emps.filter((e) => e.billing === "Not set");
    if (noBilling.length) push("warn", "Billing status not set", noBilling.length + " employees have no billed status.", noBilling);

    const pending = allAssignments(emps).filter((a) => a.pct == null);
    if (pending.length) push("warn", "Allocation % pending", pending.length + " project assignments have no allocation %, so they add 0 to weighted head count.", pending.map((a) => a.emp));

    const noYoe = emps.filter((e) => !e.yoe);
    if (noYoe.length) push("info", "Experience (YOE) missing", noYoe.length + " employees have no years of experience recorded.", noYoe);

    const noDomain = emps.filter((e) => e.domain === "Not specified");
    if (noDomain.length) push("info", "Domain not specified", noDomain.length + " employees have no domain.", noDomain);

    const unknownMgr = emps.filter((e) => e.reportsTo && !names.has(e.reportsTo.trim().toLowerCase()) && !/customer-managed/i.test(e.reportsTo));
    if (unknownMgr.length) push("warn", "Manager not in roster", "“Reports To” names someone who is not in Headcount Data.", unknownMgr);

    const noLead = data.projects.filter((p) => p.status !== "Deleted" && !p.lead && !/^Unassigned|^Sector Leadership$|^NEW-project/.test(p.name));
    if (noLead.length) push("info", "Projects without a project lead", noLead.map((p) => p.sector + " › " + p.name).join(", "));

    const noHead = data.sectors.filter((s) => !s.head);
    if (noHead.length) push("info", "Sectors without a sector head", noHead.map((s) => s.name).join(", "));

    const pd = data.kpi && data.kpi.productDevelopment;
    if (pd) {
      Object.entries(pd.totals || {}).forEach(([role, t]) => {
        if (t != null && Math.abs(Number(t) - 1) > 0.001) push("warn", "KPI weights don’t add up to 100%", "Product Development KPI — " + role + " weights total " + Math.round(t * 100) + "%.");
      });
    }
    return issues;
  }

  const api = {
    BILLING, BILLABLE, BENCH, LEVELS,
    assignmentsOf, allAssignments, filterAssignments, filterEmployees,
    countBy, billingCounts, weighted, summary, projectStats, sectorStats,
    domainProjectMatrix, reportsIndex, hierarchy, formatYoe, yoeYears, reconcile, dataQuality,
  };
  root.VCTMetrics = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
