# Bus Logbook

Bus Logbook is a small school transport operations tool for tracking bus maintenance, servicing, costs, repeat repairs, and uploaded documents. The app stores records in an Excel workbook and related folders, and it now includes a login screen plus optional Google sign-in for the school admin.

## What it does

- Keeps a fleet overview with service status and recent cost history
- Tracks every service entry, repair and part change on each bus
- Shows repeat-fault warnings for recurring issues
- Stores supporting files such as bills, photos and bus documents
- Lets staff review and correct prior entries without deleting history
- Optionally reads bill details with Claude AI before saving
- Supports local Excel storage and a Google Drive-based deployment mode

## Recent changes

The app has been updated to include:

- School admin login with `ADMIN_EMAIL` and `ADMIN_PASSWORD`
- Optional Google OAuth login for the school Google account
- A real login page at `/login.html` before any app data is accessible
- Google Drive integration via `STORAGE=google` and `GOOGLE_DRIVE_FOLDER_NAME`
- Demo data support via `npm run demo` without touching the real workbook
- A safer local setup for single-school deployment and future multi-school extension

## Requirements

- Node.js 22 or newer
- A writable local folder for the Excel workbook and uploaded files

## Setup

From the project root:

```bash
npm install
cp .env.example .env
```

Edit `.env` and set the values you need:

```env
DATA_DIR=./data
STORAGE=local
PORT=3000
ADMIN_EMAIL=admin@school.local
ADMIN_PASSWORD=change-this-password
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
GOOGLE_DRIVE_FOLDER_NAME=Transportation
ANTHROPIC_API_KEY=
```

Notes:

- `ADMIN_EMAIL` and `ADMIN_PASSWORD` are used for the local admin login.
- If you want Google sign-in, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- If you want AI bill reading, add your Anthropic API key.
- Leave `ANTHROPIC_API_KEY` blank to disable AI reading.

## Run locally

Start the app:

```bash
npm start
```

Open:

```text
http://localhost:3000
```

The app redirects unauthenticated users to `/login.html`. Sign in with the school admin account or use the Google sign-in button when configured.

## Demo data

To load the built-in sample data without touching your real workbook:

```bash
npm run demo
```

This seeds `demo-data/` and runs the app in demo mode. The sample data is reset each time you run the command.

## Data layout

By default, the app stores data in the `data/` directory:

```text
data/
├── Bus Logbook Data.xlsx
├── Bills/
├── Photos/
├── Bus documents/
├── Excel exports/
├── .backups/
└── ...
```

The workbook has tabs such as:

- Schools
- Buses
- Routes
- Route assignments
- Entries
- Parts changed
- Bus documents
- Workshops
- Lists
- Settings
- Change log
- AI summaries

The app expects the workbook to be closed in Excel before entering records in the web app, or the files may overwrite each other.

## Cloud and Google Drive deployment

This app is a Node + Express service and is designed for a persistent server environment, not a purely static host.

For Google Drive deployment:

```env
STORAGE=google
GOOGLE_DRIVE_FOLDER_ID=your_shared_folder_id
GOOGLE_DRIVE_FOLDER_NAME=Transportation
GOOGLE_SERVICE_ACCOUNT_JSON=
```

This mode targets a shared Google Drive folder and keeps the workbook and uploaded files in that folder instead of the local `data/` directory.

Good deployment options include:

- Render
- Railway
- Fly.io

Use a host that keeps a persistent volume or drive-backed storage; the app writes Excel files and uploaded files on disk.

## AI bill reading

To enable AI-assisted bill entry:

1. Get an API key from https://console.anthropic.com
2. Put it in `.env` as `ANTHROPIC_API_KEY=...`
3. Restart the app

Then on the entry form, upload a bill and click `Read bill with AI`. The fields it fills are highlighted for review before saving. Nothing is saved until you click Save.

## Multi-school-ready design

The code is structured so it can grow beyond a single school later without replacing the whole app:

- `src/schema.js` is the source of truth for workbook tabs and columns
- `src/service.js` contains business logic and app operations
- `src/storage/index.js` isolates the storage backend
- `src/logic.js` contains reusable filtering helpers such as `recordsForSchool()`

The future path is to add a `school_id` model and scope reads/writes by school while keeping current single-school data working with legacy rows.

## Developer notes

Key files:

```text
server.js                  HTTP routes, auth, uploads, Excel storage
src/schema.js             workbook schema and columns
src/logic.js              rules for fleet, costs, service due, repeat repairs
src/service.js            app operations and business workflows
src/ai.js                 AI bill reading integration
src/storage/index.js      storage adapter selection
src/storage/local-xlsx.js  local Excel workbook storage
public/                   web UI and login flow
scripts/seed-demo.js      demo data generator
test/                     automated tests
```

Run tests with:

```bash
npm test
```

## Important rules

- Entries are never deleted or overwritten. Correction creates a new corrected record and logs the change.
- Keep the workbook closed in Excel while the app is writing to it.
- Back up `data/` regularly, especially before making major changes.
- Never commit secrets such as API keys or passwords into the repository.
