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

## Postgres mode: many schools

With `STORAGE=postgres` the app keeps all data in Postgres and serves many schools from one deployment. Excel and Google Drive modes still work as before, with the single `ADMIN_EMAIL` / `ADMIN_PASSWORD` login.

- Every school has its own buses, entries, settings and files. Users can only ever see their own school.
- Users sign in with email and password. Everyone in a school can see and edit everything in that school (no roles).
- Passwords are stored as scrypt hashes, sessions live in the database (they survive restarts, last 24 hours), and ten wrong tries in 15 minutes block that email from that address.
- Bills and photos are saved under `schools/<school-id>/` and only that school's users can open them. They still live on the server's disk (`DATA_DIR`); object storage is planned.

Set up:

```bash
# 1. a local database
docker run -d --name buslog-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=buslog -p 5432:5432 postgres:16
# 2. in .env:  STORAGE=postgres   DATABASE_URL=postgres://postgres:dev@localhost:5432/buslog

# 3. create a school and a user (the password is asked for, not typed on the command line)
node --env-file=.env scripts/admin.js create-school "Little Flower School"
node --env-file=.env scripts/admin.js create-user school-001 office@school.org

npm start
```

Other `scripts/admin.js` commands: `list`, `set-password <email>`, `disable-user <email>`, `enable-user <email>`.

**Bringing in records from Excel**

Open **Import** in the app, drop in an .xlsx file and check the preview. Nothing is saved until you press the import button. The page reads sheets by their headings (Date, Bus No, Work Done, Garage, Amount and similar), skips title rows above the headings, reads dates day first (18/10/2026), and lists any row it cannot use with its Excel row number. Importing the same file again adds nothing. If a school's sheet looks very different, the page has a template to copy records into. It imports buses, service visits, parts changed, bus documents and workshops.

**Copying a whole app workbook with the script**

```bash
node --env-file=.env scripts/import-xlsx.js school-001 ./data
```

This refuses to run if the school already has history. If you imported with an earlier version that had no school ids, run `node --env-file=.env scripts/admin.js assign-legacy school-001` instead, and set `LEGACY_SCHOOL_ID=school-001` so that school can still open files saved before school folders existed.

Run the database tests with `DATABASE_URL=postgres://postgres:dev@localhost:5432/buslog npm test`. Each test uses its own temporary schema.

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
src/storage/postgres.js   Postgres storage, one school at a time via forSchool()
src/accounts.js           schools, users, passwords and sessions (Postgres mode)
scripts/admin.js          create schools and users
scripts/import-xlsx.js    copy an Excel workbook into a school
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
