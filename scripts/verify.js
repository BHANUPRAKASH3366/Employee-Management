// Checks that every number the portal calculates matches the totals saved in the Excel workbook.
// Usage: node scripts/verify.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const portal = path.join(__dirname, "..", "portal");
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(portal, "data", "vct-data.js"), "utf8"), ctx);
const data = ctx.window.VCT_DATA;
const M = require(path.join(portal, "js", "metrics.js"));

const checks = M.reconcile(data);
const failed = checks.filter((c) => !c.ok && !c.soft);
const stale = checks.filter((c) => c.soft);
if (stale.length) console.log(`${stale.length} workbook cells use Google-Sheets-only formulas and are out of date (portal values are recalculated from the rows).`);
failed.forEach((c) => console.log(`MISMATCH  [${c.group}] ${c.label}: Excel=${c.expected} portal=${c.actual}`));
console.log(`${checks.length - failed.length}/${checks.length} checks match the workbook.`);
M.dataQuality(data).forEach((i) => console.log(`[${i.severity}] ${i.title} — ${i.detail}`));
process.exit(failed.length ? 1 : 0);
