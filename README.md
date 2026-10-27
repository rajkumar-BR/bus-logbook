# Bus Logbook

A small app for the school transport office. It records every service, repair and part change for the school's buses, and shows:

- **Fleet today:** status, next service due, and how much each bus has cost since its last service
- **Bus history:** a timeline of every visit with what changed, why, the bill, and spending between services
- **Repeat repairs:** which buses keep coming back for the same fault, and likely reasons
- **Enter a bill:** the office uploads the driver's bill, optionally lets AI read it, checks the details and saves

For now everything is stored **on this computer**, in one Excel workbook plus folders for bills and photos. The folder layout matches the planned Google Drive layout, so it can be moved there later (see the last section).

## 1. One-time setup

You need **Node.js 22 or newer** (check with `node --version`).

```bash
cd bus-logbook
npm install
cp .env.example .env      # Windows: copy .env.example .env
                          # then edit .env if you want AI bill reading
```

## 2. Try it with sample data

```bash
npm run demo
```

Open http://localhost:3000. This loads the 10 sample buses from the mockup into a separate `demo-data/` folder. Your real data is never touched, and running the command again resets the demo.

## 3. Use it for real

```bash
npm start
```

Open http://localhost:3000, go to **Buses** and add your buses, then use **Enter a bill** for each bill the drivers hand in. Keep the terminal window open while you use the app; press `Ctrl+C` to stop it.

To enter older records in bulk, paste them into the `Entries` and `Parts changed` tabs of the workbook (with the app stopped), keeping the same columns.

## Multi-school-ready architecture

This app is already structured so it can be extended to multiple schools later without replacing the whole application:

- `src/schema.js` is the single source of truth for workbook tabs and columns.
- `src/service.js` holds business logic and is the place to add tenant scoping.
- `src/storage/index.js` isolates the storage backend so a future Google Sheets or database adapter can replace the local Excel workbook.
- `src/logic.js` now includes `recordsForSchool()` as a reusable helper for filtering by `school_id` while preserving legacy data rows without a school tag.

Recommended future layout:

```
/data/
├── schools/
│   ├── school-001/
│   │   ├── Bus Logbook Data.xlsx
│   │   ├── Bills/
│   │   ├── Photos/
│   │   └── Bus documents/
│   └── school-002/
│       ├── Bus Logbook Data.xlsx
│       ├── Bills/
│       ├── Photos/
│       └── Bus documents/
└── global/
    └── schools.xlsx
```

Migration path for a multi-school release:

1. Add a `Schools` table and a `school_id` column to all school-scoped tables.
2. Scope every read/write by `school_id` in the service layer.
3. Add user roles and school access checks before saving any record.
4. Keep the current single-school app working by treating a blank `school_id` as "legacy/default school".

## Cloud deployment

This app is a Node + Express service with local file storage, so the best cloud hosts are those that provide a persistent volume or disk. Free or low-cost options can work for trials, but not all are suitable for long-term production use.

### Good options

- Render
- Railway
- Fly.io

These are better than purely static hosts because the app writes Excel files and stores uploaded PDFs/photos locally.

### What to set up in production

- `HOST=0.0.0.0`
- `PORT=3000`
- a persistent volume for `/data` or a configured `DATA_DIR`
- `npm start` as the start command

### AppDeploy.ai and free deployment

AppDeploy.ai can work for a demo or quick test if it supports a Node app with persistent storage, but for this project it is not the best free default. The app is not a simple frontend-only static site; it has:

- a web server
- uploaded file handling
- Excel workbook writes
- local file storage

That means a free plan without persistent storage is usually not reliable for real use. For a real deployment, prefer Render or Railway.

## Where the data is

```
data/
├── Bus Logbook Data.xlsx     ← all records, one tab per table
├── Bills/Bus 04/2026-10-18 Sri Murugan Motors 2231.jpg
├── Photos/Bus 04/…
├── Bus documents/
├── Excel exports/
└── .backups/                 ← a copy of the workbook before every save (last 30 kept)
```

Workbook tabs: Schools, Buses, Routes, Route assignments, Entries, Parts changed, Bus documents, Workshops, Lists, Settings, Change log, AI summaries. The columns match the architecture document.

**Rules that keep the history trustworthy**

- Entries are never deleted or overwritten. **Correct this entry** (on a bus's history) saves a corrected copy, marks the old one "Corrected" and writes what changed to the Change log.
- You can open the workbook in Excel to read it or to edit setup tabs (Buses, Routes, Route assignments, Workshops, Lists, Settings, Bus documents). **Close it in Excel before entering bills in the app**, or one may overwrite the other.
- Back up the `data/` folder (e.g. copy it to a USB drive or the school Drive) regularly until the Google Drive move.

## AI bill reading (optional)

1. Create an API key at https://console.anthropic.com and add a small prepaid credit.
2. Put it in `.env` as `ANTHROPIC_API_KEY=...` and restart the app.

On the entry form, upload a bill and click **Read bill with AI**. The fields it fills are highlighted; check them before saving. Nothing is saved until you click Save. Expect roughly ₹3 per bill. To turn it off without removing the key, set `ai_enabled` to `FALSE` in the Settings tab.

## Settings tab

| key | meaning |
|---|---|
| default_service_km / default_service_days | service interval unless set per bus (10,000 km / 90 days) |
| repeat_window_days | how far back the repeat-repair warning looks (180) |
| ai_enabled | TRUE / FALSE |

## For developers

```
server.js                  HTTP routes (Express), uploads, error messages
src/schema.js              tabs and columns (single source of truth)
src/logic.js               rules: cost periods, service due, repeats, findings (no Node APIs)
src/service.js             app operations: fleet, bus history, save/correct entry, add bus
src/ai.js                  bill reading with Claude (structured output)
src/storage/local-xlsx.js  storage adapter: Excel workbook + folders
src/storage/index.js       picks the adapter from STORAGE
public/                    the screens (plain HTML/CSS/JS, no build step)
scripts/seed-demo.js       sample data
test/                      npm test
```

### Moving to Google Drive later

All reads and writes go through the storage adapter (`init`, `read`, `transact`, `saveFile`, `fileUrl`). The plan:

1. Import `Bus Logbook Data.xlsx` into Google Sheets (File → Import). The tabs and columns carry over unchanged.
2. Upload the `Bills/`, `Photos/` and `Bus documents/` folders to the Shared drive.
3. Either add a `google` adapter here (Sheets API + Drive API) and set `STORAGE=google`, or move the app into Apps Script as in the architecture document. `src/logic.js` and the screens in `public/` are plain JavaScript and carry over as they are.
