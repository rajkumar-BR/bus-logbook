// Bus Logbook: local web server.
// Serves the screens in public/ and a small JSON API on top of the storage folder.

import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { google } from 'googleapis';
import { createStorage } from './src/storage/index.js';
import { createService } from './src/service.js';
import { createAccounts } from './src/accounts.js';
import { createBillReader, UserError } from './src/ai.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_FILE_MB = 10;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'application/pdf'];
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@school.local').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'change-this-password').trim();
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';
const GOOGLE_DRIVE_FOLDER_NAME = process.env.GOOGLE_DRIVE_FOLDER_NAME || 'Transportation';
const SESSION_COOKIE = 'buslogbook_session';
const sessions = new Map();
const googleOAuthEnabled = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
const googleOAuthClient = googleOAuthEnabled ? new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI) : null;

// `npm run demo` passes --demo to use the sample data folder instead of the real one.
const storage = createStorage(process.argv.includes('--demo') ? { ...process.env, DATA_DIR: './demo-data' } : process.env);
await storage.init();
// Postgres storage serves many schools: users and sessions live in the database and each request
// gets a service limited to the signed-in user's school. Other storage keeps the single admin login.
const multi = typeof storage.forSchool === 'function';
const accounts = multi ? createAccounts(storage) : null;
// New schools can sign themselves up (Postgres mode). Set SIGNUP_CODE to require a code, or ALLOW_SIGNUP=false to close signup.
const SIGNUP_ENABLED = multi && String(process.env.ALLOW_SIGNUP ?? 'true').toLowerCase() !== 'false';
const SIGNUP_CODE = (process.env.SIGNUP_CODE || '').trim();
if (accounts) await accounts.init();
const readBill = createBillReader(process.env.ANTHROPIC_API_KEY);
const service = multi ? null : createService(storage, { readBill });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 11 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new UserError(`"${file.originalname}" is not a supported file. Upload a JPG, PNG or PDF.`));
  },
});
// Excel files for the import page: .xlsx only (the older .xls format cannot be read safely).
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (/\.xlsx$/i.test(file.originalname)) cb(null, true);
    else cb(new UserError(`"${file.originalname}" is not an .xlsx workbook. In Excel, use File > Save As > Excel Workbook (.xlsx).`));
  },
});
const entryFiles = upload.fields([{ name: 'bill', maxCount: 1 }, { name: 'photos', maxCount: 10 }]);
const tripPhotos = upload.array('photos', 3);

const app = express();
app.set('trust proxy', 1); // behind Render/Railway so req.secure and req.ip are right
app.use(express.json({ limit: '1mb' }));

function getSessionToken(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)) : null;
}

async function currentUser(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  return multi ? accounts.getSession(token) : (sessions.get(token) || null);
}

function sessionCookie(req, token, maxAge) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;
}

// Slows down password guessing: 10 wrong tries per address and email in 15 minutes.
const failedLogins = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
function loginBlocked(key) {
  const f = failedLogins.get(key);
  if (f && Date.now() - f.since > LOGIN_WINDOW_MS) failedLogins.delete(key);
  return (failedLogins.get(key)?.count || 0) >= LOGIN_MAX_FAILS;
}
function loginFailed(key) {
  const f = failedLogins.get(key) || { count: 0, since: Date.now() };
  failedLogins.set(key, { ...f, count: f.count + 1 });
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Please log in.' });
  }
  next();
}

app.get('/auth/google', (req, res) => {
  if (!googleOAuthClient || multi) {
    return res.status(503).json({ error: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env file.' });
  }
  const scopes = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/drive.readonly',
  ];
  return res.redirect(googleOAuthClient.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: scopes,
  }));
});

app.get('/auth/google/callback', async (req, res) => {
  if (!googleOAuthClient || multi) {
    return res.status(503).send('Google OAuth is not configured.');
  }
  const code = String(req.query.code || '');
  if (!code) return res.status(400).send('Missing Google OAuth code.');

  try {
    const { tokens } = await googleOAuthClient.getToken(code);
    googleOAuthClient.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: googleOAuthClient });
    const info = await oauth2.userinfo.get();
    const email = String(info.data.email || '').trim();

    let folderId = null;
    if (tokens.access_token) {
      const drive = google.drive({ version: 'v3', auth: googleOAuthClient });
      const folders = await drive.files.list({
        q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
        fields: 'files(id,name,webViewLink)',
        pageSize: 1000,
      });
      const folder = (folders.data.files || []).find((f) => String(f.name || '').trim() === GOOGLE_DRIVE_FOLDER_NAME);
      folderId = folder?.id || null;
    }

    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, {
      email,
      provider: 'google',
      folderId,
      folderName: GOOGLE_DRIVE_FOLDER_NAME,
      at: Date.now(),
    });

    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
    if (folderId) {
      process.env.GOOGLE_DRIVE_FOLDER_ID = folderId;
    }
    return res.redirect('/');
  } catch (err) {
    console.error('Google OAuth callback failed:', err);
    return res.status(500).send('Google sign-in failed. Check the OAuth configuration and Google Drive folder access.');
  }
});

const SIGNUPS_PER_HOUR = 5;
const signups = new Map(); // ip -> times of recent signups
function signupsBlocked(ip) {
  const recent = (signups.get(ip) || []).filter((at) => Date.now() - at < 3600000);
  signups.set(ip, recent);
  return recent.length >= SIGNUPS_PER_HOUR;
}
const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();

// What the login and signup pages may show. Nothing secret.
app.get('/api/public-config', (req, res) => {
  res.json({ signup: SIGNUP_ENABLED, needsCode: SIGNUP_ENABLED && Boolean(SIGNUP_CODE), google: googleOAuthEnabled && !multi });
});

app.post('/api/signup', async (req, res, next) => {
  try {
    if (!SIGNUP_ENABLED) return res.status(404).json({ error: 'Signup is not available here. Ask your administrator for an account.' });
    if (SIGNUP_CODE) {
      const key = `${req.ip}|signup-code`;
      if (loginBlocked(key)) return res.status(429).json({ error: 'Too many wrong codes. Try again in 15 minutes.' });
      if (!crypto.timingSafeEqual(digest(req.body?.code ?? ''), digest(SIGNUP_CODE))) {
        loginFailed(key);
        return res.status(403).json({ error: 'That signup code is not right. Ask the person who gave you this link.' });
      }
    }
    if (signupsBlocked(req.ip)) return res.status(429).json({ error: 'Too many accounts were created from this connection. Try again in an hour.' });
    const user = await accounts.signUp({ schoolName: req.body?.schoolName, email: req.body?.email, password: req.body?.password });
    signups.get(req.ip).push(Date.now());
    const token = await accounts.createSession(user.user_id);
    res.setHeader('Set-Cookie', sessionCookie(req, token, 86400));
    return res.status(201).json({ ok: true, email: user.email });
  } catch (err) {
    return next(err);
  }
});

app.post('/api/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (multi) {
      const key = `${req.ip}|${email}`;
      if (loginBlocked(key)) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
      const user = await accounts.login(email, password);
      if (!user) {
        loginFailed(key);
        return res.status(401).json({ error: 'Wrong email or password.' });
      }
      failedLogins.delete(key);
      const token = await accounts.createSession(user.user_id);
      res.setHeader('Set-Cookie', sessionCookie(req, token, 86400));
      return res.json({ ok: true, email: user.email });
    }
    if (email !== ADMIN_EMAIL.toLowerCase() || password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid school admin credentials.' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { email, provider: 'admin', at: Date.now() });
    res.setHeader('Set-Cookie', sessionCookie(req, token, 86400));
    return res.json({ ok: true, email });
  } catch (err) {
    return next(err);
  }
});

app.post('/api/logout', async (req, res, next) => {
  try {
    const token = getSessionToken(req);
    if (token) {
      if (multi) await accounts.deleteSession(token);
      else sessions.delete(token);
    }
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.use(async (req, res, next) => {
  try {
    const publicPaths = ['/login.html', '/login.js', '/signup.html', '/signup.js', '/api/login', '/api/logout', '/api/signup', '/api/public-config'];
    if (publicPaths.includes(req.path)) return next();
    req.user = await currentUser(req);
    if (!req.user) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please log in.' });
      return res.redirect('/login.html');
    }
    req.service = multi
      ? createService(storage.forSchool(req.user.school_id), { readBill, user: req.user.email })
      : service;
    return next();
  } catch (err) {
    return next(err);
  }
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => res.json(out)).catch(next);
const entryFromForm = (req) => {
  try { return JSON.parse(req.body.entry || '{}'); } catch { throw new UserError('The form data could not be read. Reload the page and try again.'); }
};
const filesFrom = (req) => ({ bill: req.files?.bill?.[0], photos: req.files?.photos || [] });

app.get('/api/lists', wrap((req) => req.service.getLists()));
app.get('/api/fleet', wrap((req) => req.service.getFleet()));
app.get('/api/buses', wrap((req) => req.service.listBuses()));
app.post('/api/buses', requireAdmin, wrap((req) => req.service.addBus(req.body)));
app.get('/api/buses/:busNo', wrap((req) => req.service.getBus(req.params.busNo)));
app.get('/api/repeats', wrap((req) => req.service.getRepeats()));
app.get('/api/reports/daily', wrap((req) => req.service.getDailyReport(String(req.query.start_date || ''), String(req.query.end_date || req.query.start_date || ''), String(req.query.bus_no || ''))));
app.post('/api/reports/daily', tripPhotos, wrap((req) => req.service.saveDailyReport(JSON.parse(req.body.report || '{}'), req.files || [])));
app.get('/api/import/template', async (req, res, next) => {
  try {
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="Bus Logbook import template.xlsx"',
    });
    res.send(await req.service.importTemplate());
  } catch (err) {
    next(err);
  }
});
app.post('/api/import', importUpload.single('file'), wrap((req) => req.service.importWorkbook(req.file, { commit: req.body.commit === '1' })));
app.get('/api/entries/:id', wrap((req) => req.service.getEntry(req.params.id)));
app.post('/api/check-repeat', wrap((req) => req.service.checkRepeat(req.body)));
app.post('/api/bills/read', upload.single('bill'), wrap((req) => req.service.readBillFields(req.file)));
app.post('/api/entries', entryFiles, wrap((req) => req.service.saveEntry(entryFromForm(req), filesFrom(req))));
app.post('/api/entries/:id/correct', entryFiles, wrap((req) => req.service.saveEntry(entryFromForm(req), filesFrom(req), { correctsId: req.params.id })));

// Uploaded bills, photos and documents (only these folders are served).
// Files saved before schools existed sit in un-prefixed folders; they belong to LEGACY_SCHOOL_ID, if set.
const mayReadLegacyFiles = (req, res, next) => (!multi || req.user.school_id === process.env.LEGACY_SCHOOL_ID ? next() : res.status(403).send('Not available.'));
for (const folder of ['Bills', 'Photos', 'Bus documents']) {
  app.use(`/files/${encodeURIComponent(folder)}`, mayReadLegacyFiles, express.static(path.join(storage.root, folder), { dotfiles: 'deny', index: false }));
}
if (multi) {
  // Each school's files live under schools/<its id>/ and only that school's users can open them.
  app.use(
    '/files/schools/:schoolId',
    (req, res, next) => (req.params.schoolId === req.user.school_id ? next() : res.status(403).send('Not available.')),
    (req, res, next) => express.static(path.join(storage.root, 'schools', req.params.schoolId), { dotfiles: 'deny', index: false })(req, res, next),
  );
}
app.use(express.static(path.join(here, 'public')));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `Files must be ${MAX_FILE_MB} MB or smaller. Take a smaller photo or compress the PDF.` : 'The upload could not be read. Try again.';
    return res.status(400).json({ error: msg });
  }
  if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
  if (err?.status && err?.error) { // Anthropic API error
    console.error('AI error:', err.status, err.message);
    return res.status(502).json({ error: `AI bill reading failed (${err.status}). You can still type the details in.` });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Check the terminal window for details.' });
});

app.listen(PORT, HOST, () => {
  console.log(`\n  Bus Logbook is running:  http://localhost:${PORT}`);
  console.log(`  Storage backend:         ${storage.kind || 'local'}`);
  console.log(`  Data folder:             ${storage.root || 'Google Drive folder'}`);
  console.log(multi ? '  Sign-in:                 school users from the database (see scripts/admin.js)' : `  Admin login:             ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  console.log(`  Google OAuth:           ${googleOAuthEnabled ? 'enabled' : 'disabled'}`);
  console.log(`  AI bill reading:         ${process.env.ANTHROPIC_API_KEY ? 'on' : 'off (add ANTHROPIC_API_KEY to .env)'}`);
  console.log('\n  Keep this window open while using the app. Press Ctrl+C to stop.\n');
});
