# Bus Logbook

A logbook for school and transport organisations. It records every service, repair and part change for each bus, and shows:

- **Fleet:** status, next service due, and how much each bus has cost since its last service
- **Bus history:** a timeline of every visit with what changed, why, the bill, and spending between services
- **Repeat repairs:** which buses keep coming back for the same fault, and likely reasons
- **Enter a bill:** upload the driver's bill, optionally let AI read it, check the details and save
- **Daily report:** income, expenses and trips per bus per day
- **Import:** bring in records from an Excel file you already keep
- **Change log:** everything that was added, corrected, edited or removed, and by whom

Many organisations can use one deployment. Each sees only its own data.

## Quick start

You need **Node.js 22 or newer** and **Docker** (for a local database).

```bash
npm install
cp .env.example .env
docker run -d --name buslog-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=buslog -p 5432:5432 postgres:16

# create an organisation and its first user (the password is asked for, not typed on the command line)
node --env-file=.env scripts/admin.js create-org "Little Flower School"
node --env-file=.env scripts/admin.js create-user school-001 you@example.com

npm start
```

Open http://localhost:3000 and log in. The tables are created on first start.

## Organisations, signup and approval

- Each organisation has users who sign in with email and password. Everyone in an organisation can see and edit everything in it (there are no roles).
- New organisations can sign up at `/signup.html`. They are **pending**: they can log in but only see a "waiting for payment and approval" page, and the whole app and API are blocked. Approve them once they have paid:

```bash
node --env-file=.env scripts/admin.js list              # waiting organisations are listed first
node --env-file=.env scripts/admin.js approve <org-id>  # takes effect at once
node --env-file=.env scripts/admin.js suspend <org-id>  # blocks an organisation immediately
```

- Organisations you create yourself with `create-org` are approved straight away.
- `SIGNUP_CODE` makes signup ask for a code, `ALLOW_SIGNUP=false` closes it. At most 5 signups an hour per address; wrong passwords and codes are rate limited.
- `PAYMENT_URL`, `PAYMENT_NOTE` and `SUPPORT_EMAIL` are shown to waiting organisations. Payment is checked by you; there is no automatic confirmation yet.
- Emails are not verified and there is no password reset by email yet. Reset a password with `scripts/admin.js set-password <email>`.

Other admin commands: `create-user`, `disable-user`, `enable-user`. Passwords are stored as scrypt hashes and sessions live in the database for 24 hours.

## Working with records

- **Correct this entry** saves a corrected copy, marks the old one "Corrected" and logs what changed. Nothing is overwritten.
- **Remove entry** is for an entry that should not exist (wrong bus, entered twice). It asks for a reason, stops the entry counting in costs and repeat checks, and keeps it on the bus page under "Removed entries" with who removed it, when and why.
- **Edit bus** (on a bus's page) changes the driver, registration, make, year, seats, service interval and route, and retires or brings back a bus. The bus number never changes. A new route starts today and the old one ends yesterday, so past visits keep the route they had.
- **Change log** (in the menu) lists every change, newest first, with who made it and the old and new values. Filter by kind of change or search for a bus, entry, name or word.
- There is no delete: the history is kept on purpose.

## Importing from Excel

Open **Import**, drop in an .xlsx file and check the preview. Nothing is saved until you press the import button.

- Sheets are read by their headings (Date, Bus No, Work Done, Garage, Amount and similar). Title rows above the headings are skipped, dates are read day first (18/10/2026), and amounts such as `₹12,500` work.
- Rows that break the rules of "Enter a bill" are left out and listed with their Excel row number and the reason. The others still import.
- Importing the same file again adds nothing.
- It imports buses, service visits, parts changed, bus documents and workshops. If a sheet looks very different, the page offers a template to copy records into.

## Bills and photos

By default they are saved in folders under `DATA_DIR`. For a hosted deployment, keep them in any S3-compatible private bucket (Supabase Storage, Cloudflare R2, AWS S3) so the app server holds no data of its own:

```
FILES=s3
S3_BUCKET=bus-logbook-files
S3_ENDPOINT=https://<project-ref>.storage.supabase.co/storage/v1/s3   # not needed for AWS S3
S3_REGION=<region>
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

Files are saved under `schools/<org-id>/`, and the app checks who is asking before it streams a file, so the bucket stays private. Only images and PDFs are shown in the browser; any other file type downloads.

## AI bill reading (optional)

Create an API key at https://console.anthropic.com, put it in `.env` as `ANTHROPIC_API_KEY=...` and restart. On the entry form, upload a bill and click **Read bill with AI**. The fields it fills are highlighted; check them before saving. Nothing is saved until you click Save. Expect roughly ₹3 per bill.

## Settings

Each organisation has a few settings in its `settings` table: `default_service_km` (10000), `default_service_days` (90), `repeat_window_days` (180) and `ai_enabled` (`TRUE`/`FALSE`). There is no screen for them yet; change them with SQL.

## Configuration

Settings are environment variables: in a `.env` file locally (copy `.env.example`), or in the host's Environment page when deployed.

| Setting | Meaning |
|---|---|
| `DATABASE_URL` | **Required.** Postgres connection string |
| `DATABASE_SSL` | `require` for hosted databases such as Supabase |
| `PORT`, `HOST` | Where the app listens. Set `HOST=0.0.0.0` on a host such as Render (`render.yaml` does) |
| `FILES` | `local` (default) or `s3`, see below |
| `DATA_DIR` | Folder for bills and photos when `FILES=local` (default `./data`) |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | The bucket when `FILES=s3` |
| `SIGNUP_CODE` | If set, signup asks for this code |
| `ALLOW_SIGNUP` | `false` closes signup |
| `PAYMENT_URL`, `PAYMENT_NOTE`, `SUPPORT_EMAIL` | Shown to organisations waiting for approval |
| `ANTHROPIC_API_KEY` | Turns on AI bill reading |

## Deploying

The app keeps no data of its own: records are in Postgres and bills and photos are in an S3-compatible bucket. That means it can run on any host and be restarted or redeployed safely. [DEPLOY.md](DEPLOY.md) is a step-by-step guide for **Supabase** (database and bucket) and **Render** (the app). [render.yaml](render.yaml) is a ready-made Render blueprint, and `/healthz` is the health-check URL (it answers only when the database does).

**Running the live site**

- **Updating:** push to `main` and Render redeploys. New database columns are added automatically on start, so most updates need nothing else.
- **Admin commands on the live database:** Render's free plan has no shell, so run them from your own computer with the production settings in front of the command (the password is asked for when creating users):

  ```bash
  DATABASE_URL='<Supabase session pooler URL>' DATABASE_SSL=require node scripts/admin.js list
  ```

  Use the **session pooler** URL from Supabase's *Connect* panel (host ends in `.pooler.supabase.com`, port 5432), with your database password in it. Keep that URL private.
- **Backups:** `pg_dump "$DATABASE_URL" > backup.sql` backs up the records. The bucket holds the files. Free Supabase projects have no automatic backups and pause after a week of inactivity, so use a paid plan for real customers.
- **Render's free plan** sleeps after 15 minutes without traffic (the first request then takes about a minute). Use a paid plan for real use. Do not use Render's free Postgres: it is deleted after 30 days.
- **Before real customers:** set a strong `SIGNUP_CODE` (or `ALLOW_SIGNUP=false`), and remember emails are not verified and there is no password reset by email yet.

## After the initial data migration

While the existing records are being loaded, some details are left optional. Once the migration is finished, tighten these:

- **Tyre cost must be made mandatory.** "Cost per tyre" (and ideally "Bought on") on the Tyres page → Add tyres is optional today so old tyres can be entered without a price. After the migration it should be required for every new tyre, so each tyre's cost is charged to a bus and shows in that bus's spending and the Tyre report. The same applies to the retread cost and bill on Enter a bill → Tyre repair bill (the bill is optional for now).
- Planned km, expected times and stops are set per trip under Edit bus → Trip times. Fill them in for every bus; Record a bus day will not save without them. Use "Apply to all days" while filling in past data.
- Trip photos are optional for now.

## For developers

```
server.js                   routes, login, approval gate, file serving
src/schema.js               tables and columns (single source of truth)
src/logic.js                rules: cost periods, service due, repeats, findings (no I/O)
src/service.js              what the app does: save/correct/remove entries, buses, change log, import
src/importer.js             Excel import: read, match columns, validate, plan
src/accounts.js             organisations, users, passwords, sessions
src/ai.js                   bill reading with Claude
src/storage/postgres.js     Postgres storage; forSchool(id) limits everything to one organisation
src/storage/files.js        bills and photos: local folders or an S3 bucket
public/                     the screens (plain HTML/CSS/JS, no build step)
scripts/admin.js            create organisations and users, approve, suspend
test/                       tests
```

How it fits together: every request runs as a signed-in user, and `createService(storage.forSchool(user.school_id))` gives it a view of its own organisation's rows only, so a mistake in a route cannot leak another organisation's data. (The code and database still call an organisation a "school" internally.)

```bash
npm test
```

Without a database the Postgres tests are skipped. (`DB_SCHEMA` is an advanced setting used by the tests to keep each run in its own temporary schema.) To run them, set `DATABASE_URL` (each test uses its own temporary schema). To also run the S3 tests, start a local S3 server (`docker run -d --name buslog-s3 -p 9090:9090 adobe/s3mock`), create a bucket in it, and set `S3_ENDPOINT=http://localhost:9090 S3_BUCKET=<bucket> S3_ACCESS_KEY_ID=x S3_SECRET_ACCESS_KEY=x`.
