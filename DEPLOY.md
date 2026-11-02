# Deploying Bus Logbook

The app server keeps no data of its own: records are in Postgres and bills and photos are in an S3-compatible bucket. That lets it run on any host and redeploy safely. These steps use **Supabase** (database and files) and **Render** (the app).

> Not yet tried against the real Supabase and Render services. The app was tested against local Postgres and a local S3 server. Expect to adjust a setting or two on the first deploy.

## 1. Supabase: database and file bucket

1. Create a project. Pick a region close to your users (Mumbai for India). Save the database password.
2. **Database URL:** *Connect* → *Session pooler* → copy the URI and put your password in it. Use the session pooler, not the direct connection, because the direct one is IPv6-only on some plans. This is `DATABASE_URL`.
3. **Bucket:** *Storage* → *New bucket* → name it `bus-logbook-files`, leave it **private**. This is `S3_BUCKET`.
4. **S3 keys:** *Storage* → *S3 connection*. Copy the endpoint (`https://<project>.supabase.co/storage/v1/s3`) and region, and create an access key. These are `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.

## 2. Render: the app

1. *New* → *Blueprint*, connect the GitHub repo, and choose the branch to deploy. [render.yaml](render.yaml) sets everything except the secrets.
2. Fill in the values it asks for:

   | Setting | Value |
   |---|---|
   | `DATABASE_URL`, `S3_*` | from step 1 |
   | `SIGNUP_CODE` | a code you give only to organisations you want to sign up. Leave it empty and anyone can sign up |
   | `PAYMENT_URL` | an https payment link, such as a Razorpay Payment Link |
   | `PAYMENT_NOTE`, `SUPPORT_EMAIL` | shown to organisations waiting for approval |
   | `ANTHROPIC_API_KEY` | optional, turns on AI bill reading |

3. Deploy. The tables are created on first start. Open `https://<your-service>.onrender.com/healthz`: it should say `{"ok":true}`.

## 3. Create your first organisation

Run these on your own computer, pointed at the production database. The password is asked for, not typed on the command line.

```bash
export DATABASE_URL='<the same Supabase URL>' DATABASE_SSL=require FILES=s3 \
  S3_BUCKET=... S3_ENDPOINT=... S3_REGION=... S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...
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

- **Render free plan** sleeps after 15 minutes without traffic, so the first request takes about a minute. Use the Starter plan for real use.
- **Supabase free projects** pause after a week of inactivity and have no automatic backups. Use a paid plan for real schools.
- **Backups:** if you stay on a plan without backups, take your own with `pg_dump "$DATABASE_URL" > backup.sql`, and copy the bucket now and then.

## Before real customers

- Set a strong `SIGNUP_CODE`, or `ALLOW_SIGNUP=false` and create organisations yourself.
- Email addresses are not verified and there is no password reset by email yet. Reset passwords with `node scripts/admin.js set-password <email>`.
- Payment is confirmed by you, not automatically.
