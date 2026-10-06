# VConnecTech Systems — Employee Management Portal

An interactive dashboard for VCT's people data: head count, sectors, projects, domains, billing and the KPI framework.

## Open the portal (live, recommended)
Double-click **`start-portal.bat`**. A small window opens. Keep it open; closing it stops the live portal. The portal then opens in your browser at http://localhost:8765/.

From then on, **every time the Excel file is saved, every open portal page refreshes itself** within about 10 seconds. You stay on the same page, with the same filters and the same open profile, and a notice shows what changed (for example "Billed 60 → 59"). You never have to rebuild anything by hand.

- The sidebar shows **● LIVE** while this is working. **● OFFLINE** means the window running `start-portal.bat` was closed.
- Which Excel file is watched is set in `portal.config.json` (`excelPath`). If the live workbook moves, change it there, for example to a OneDrive/SharePoint folder synced to this PC.
- If the Excel file is saved in a broken or half-written state, the portal keeps showing the last good data and says so in the sidebar.
- To let colleagues on the office network open it, set `"host": "0.0.0.0"` in `portal.config.json`. They then open `http://<this PC's IP>:8765/`. This shares employee data with anyone on the network.

## Open without the live server
Double-click `portal/index.html`. It shows the data as of the last time the live server ran or `update-data.bat` was run (**● SNAPSHOT** in the sidebar).

## Accuracy
The portal calculates every number from the raw employee rows in **Headcount Data**. It doesn't use the workbook's formula results. The workbook was built in Google Sheets, and some of its formulas (allocation %, project totals, project leads) only recalculate in Google Sheets; desktop Excel keeps their old values. Calculating from the rows keeps the portal correct whichever program saves the file.

As a cross-check, the portal compares its totals with those saved in the **Headcount Summary** sheet (the green "Matches Excel" badge, with details on the **Data Health** page). `node scripts/verify.js` runs the same check from the command line.

## Edit alerts to HR
While the live portal is running, **every edit to the Excel file is recorded and emailed to HR**:
- **Who edited:** the employee's name, employee ID and email, found by matching the name Excel records when the file is saved ("Last modified by") against Headcount Data.
- **What changed:** each change, before → after. For example `VC_150 Mani Gopi Nalajala — Billed Status: Billed → UnBilled`, `Projects › Services › FLC — Project Lead: … → …`, and employees added or removed.
- Saves by the same person within `groupChangesWithinSeconds` (default 60) are grouped into one email, so Excel's AutoSave doesn't flood HR.
- Every edit also appears under the **🔔 bell** (top-right corner of the portal) (the number in brackets is how many you haven't seen yet). A copy of every alert email is kept in `audit/outbox/`, and the full history is in `audit/changes.jsonl`.
- Edits made while the portal was off are detected the next time it starts. The editor shown is then the last person who saved.

### Setting up the emails
In `portal.config.json`, under `alerts`:
```json
"hrEmails": ["hr@yourcompany.com"],
"smtp": { "host": "smtp.office365.com", "port": 587, "security": "starttls",
          "username": "portal@yourcompany.com", "from": "portal@yourcompany.com",
          "passwordEnv": "VCT_SMTP_PASSWORD" }
```
Put the mailbox password in an environment variable, not in the file. Run this once in a command prompt, then restart the portal:
`setx VCT_SMTP_PASSWORD "the-password"`

For Gmail or Google Workspace, use `smtp.gmail.com`, port 587, and an **app password**. To check the settings, run `python scripts/audit.py --test-email`.

### Making "who edited" accurate
- Each person's Office name (File → Options → General → User name in Excel) should match their name in Headcount Data. If it doesn't, map it in `editors.json`, for example `"kauth": "VC_242"`.
- To include the editor's email in the alert, add an **Email** column to Headcount Data.
- The Office name is typed by each user, so it's a good indicator but not a verified login. For a verified identity, keep the live workbook on **OneDrive/SharePoint or Google Drive**. Their version history records the signed-in account, and the portal can be connected to it.

## Pages
The **Dashboard** has every number, chart and filter. Each other menu shows only what is unique to it:

| Page | What it shows |
|---|---|
| Dashboard | All key numbers, charts and filters (sector, project, domain, level, billing, search). Click anything for details on the same page. |
| Sectors | One card per sector. A sector page shows its head and ownership, and who works where (project × level, with each project's lead). Click a project name for its people. |
| Domains | Pick a domain to see its project-wise head count and its people, plus the domain × project matrix. |
| Reporting Hierarchy | Org chart from the "Reports To" column. Click a manager to open their team. |
| KPI Framework | Draft KPIs in three tabs: by role, lead scorecards, Product Development. |
| 🔔 Alerts (top-right) | Every edit to the Excel file, with who edited and before → after. The red number counts alerts you haven't seen yet. |

**Style:** the portal uses the "Pulse" style (slim icon menu, logo in a blue header). To preview other styles add `?ui=midnight`, `?ui=cloud` or `?ui=horizon` to the address, e.g. `http://localhost:8765/?ui=cloud#/dashboard`. The default is `DEFAULT_UI` in `portal/js/app.js`.

**Clicking any number, chart, legend or table row opens a details panel on the same page**, right below what you clicked. It shows the people behind the number with breakdowns, lets you narrow the list (with ← Back inside the panel) and exports CSV. Click the same thing again, press ✕ or press Esc to close it.

**Navigation:** every page except the home dashboard has a **← Back** button and clickable breadcrumbs (for example *Home › Projects › Services › NPI*). The browser's Back button works too.

Filters for sector, project, domain, level, billing status and search apply on every page. They're stored in the URL, so any view can be bookmarked or shared.

## Counting rules (same as the workbook)
- **Head count** counts each person once, by primary sector and project.
- **Project counts** are assignments. A person on two projects counts in both.
- **Billable** = Billed + Buffer Billed. **Bench** = Buffer + UnBilled.
- **Weighted head count** adds up the allocation % for each assignment (100% = 1). A blank % means the allocation is pending and adds 0.

## How live updates work
`scripts/live_server.py` serves the portal and checks the workbook every 3 seconds (`checkEverySeconds`). When the file changes, it waits until saving has finished, then reads a copy of it. Excel can keep the file open. It rebuilds the data, publishes it at `/api/data`, and updates `portal/data/vct-data.js`. Open pages check `/api/status` every 4 seconds and redraw when the version changes (`portal/js/data-source.js`).

## Files
```
portal/index.html          the portal
portal/css/styles.css      styling
portal/js/app.js           pages, charts, filters
portal/js/metrics.js       all calculations (shared with verify.js)
portal/js/data-source.js   data loading (live server or snapshot) and auto-refresh
portal/data/vct-data.js    generated data — do not edit by hand
portal/assets/vct-logo.png company logo
portal/vendor/             Chart.js 4.4.4 (bundled for offline use)
scripts/live_server.py     live server: watches the Excel file, serves the portal
scripts/build_data.py      Excel → portal data
portal.config.json         which Excel file to watch, port, check interval
start-portal.bat           start the live portal
update-data.bat            rebuild the snapshot by hand
scripts/verify.js          accuracy check against the Excel totals
scripts/audit.py           edit tracking (before → after) and HR alert emails
editors.json               Office name → employee ID, for editors whose names differ
audit/                     change history, last snapshot, copies of alert emails
```
