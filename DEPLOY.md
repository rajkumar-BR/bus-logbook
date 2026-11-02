# Deploying Bus Logbook

The app server keeps no data of its own: records are in Postgres and bills and photos are in an S3-compatible bucket. That lets it run on any host and redeploy safely. These steps use **Supabase** (database and files) and **Render** (the app).

> Not yet tried against the real Supabase and Render services. The app was tested against local Postgres and a local S3 server. Expect to adjust a setting or two on the first deploy.

## 1. Supabase: database and file bucket

1. Create a project at supabase.com. Pick a region close to your users (Mumbai for India) and save the **database password** somewhere safe.
2. **Database URL:** click **Connect** at the top of the project page, choose **Session pooler**, and copy the URI. It looks like `postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`. Replace `[YOUR-PASSWORD]` with your password; if it contains characters like `@ # ? & /` or spaces, replace each with its percent code (`@` is `%40`, `#` is `%23`), or pick a simpler password. This is `DATABASE_URL`.
   - Use the **session pooler**, not the transaction pooler (port 6543): the app keeps connections open and holds locks during saves.
   - The direct connection only works over IPv6 unless you buy an add-on, and Render may not reach it. The session pooler works over IPv4.
3. **Bucket:** *Storage* → *New bucket* → name it `bus-logbook-files` and leave **Public bucket OFF**. This is `S3_BUCKET`.
4. **S3 keys:** *Storage* → *Settings* (or the S3 connection section) → create a new access key. Copy the **Access Key ID** and **Secret Access Key** now, because the secret is shown only once. These are `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. These keys can read and write every file in the project, so treat them like a password.
5. On the same page, copy the **endpoint** and **region** shown there. The endpoint looks like `https://<project-ref>.storage.supabase.co/storage/v1/s3`. These are `S3_ENDPOINT` and `S3_REGION`.

## 2. Render: the app

1. In Render: *New* → *Blueprint*, connect your GitHub account, pick the `bus-logbook` repo and the **`main`** branch. [render.yaml](render.yaml) sets everything except the secrets.
2. Fill in the values it asks for:

   | Setting | Value |
   |---|---|
   | `DATABASE_URL`, `S3_*` | from step 1 |
   | `SIGNUP_CODE` | a code you give only to organisations you want to sign up. Leave it empty and anyone can sign up |
   | `PAYMENT_URL` | an https payment link, such as a Razorpay Payment Link |
   | `PAYMENT_NOTE`, `SUPPORT_EMAIL` | shown to organisations waiting for approval |
   | `ANTHROPIC_API_KEY` | optional, turns on AI bill reading |

   Render asks for these only when you first create the Blueprint. To add or change one later, open the service → *Environment*. Leave optional ones blank if you don't need them. Render sets `PORT` itself.
3. Deploy. The first build takes a few minutes. The tables are created on first start. Open `https://<your-service>.onrender.com/healthz`: it should say `{"ok":true}`.

## 3. Create your first organisation

Run these on your own computer, pointed at the production database. The password is asked for, not typed on the command line.

```bash
export DATABASE_URL='<the same Supabase session pooler URL>' DATABASE_SSL=require
node scripts/admin.js create-org "Little Flower School"
node scripts/admin.js create-user school-001 you@yourschool.org
node scripts/admin.js list
```

Organisations you create this way are approved straight away. Ones that sign up themselves wait: approve each with `node scripts/admin.js approve <org-id>` after they have paid. To bring in old records, sign in and use the **Import** page.

## 4. Check it works

- [ ] Log in at your Render URL.
- [ ] Add a bus, then enter a bill with a photo. Open the photo again from the bus history.
- [ ] See the file in the Supabase bucket under `schools/<org-id>/`.
- [ ] Sign up a test organisation (with the code), confirm it only sees the "waiting" page, approve it, and confirm it can then use the app and cannot see your data.

## Costs and limits

- **Render free plan** sleeps after 15 minutes without traffic, and the first request then takes about a minute. It has 750 free hours a month and no shell access, which is why step 3 runs the admin commands from your own computer. Use the Starter plan for real use.
- **Do not use Render's free Postgres:** it is deleted 30 days after creation, with no backups. Use Supabase for the database.
- **Supabase free projects** pause after a week of inactivity and have no automatic backups. Use a paid plan for real schools.
- **Backups:** if you stay on a plan without backups, take your own with `pg_dump "$DATABASE_URL" > backup.sql`, and copy the bucket now and then.

## Before real customers

- Set a strong `SIGNUP_CODE`, or `ALLOW_SIGNUP=false` and create organisations yourself.
- Email addresses are not verified and there is no password reset by email yet. Reset passwords with `node scripts/admin.js set-password <email>`.
- Payment is confirmed by you, not automatically.
