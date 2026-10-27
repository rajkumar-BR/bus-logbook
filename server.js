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
const service = createService(storage, { readBill: createBillReader(process.env.ANTHROPIC_API_KEY) });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 11 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new UserError(`"${file.originalname}" is not a supported file. Upload a JPG, PNG or PDF.`));
  },
});
const entryFiles = upload.fields([{ name: 'bill', maxCount: 1 }, { name: 'photos', maxCount: 10 }]);
const tripPhotos = upload.array('photos', 3);

const app = express();
app.use(express.json({ limit: '1mb' }));

function getSessionToken(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)) : null;
}

function isAuthenticated(req) {
  const token = getSessionToken(req);
  if (!token) return false;
  return sessions.has(token);
}

function requireAdmin(req, res, next) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: 'Please log in as the school admin.' });
  }
  next();
}

app.get('/auth/google', (req, res) => {
  if (!googleOAuthClient) {
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
  if (!googleOAuthClient) {
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

app.post('/api/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (email !== ADMIN_EMAIL.toLowerCase() || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid school admin credentials.' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { email, provider: 'admin', at: Date.now() });
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  return res.json({ ok: true, email });
});

app.post('/api/logout', (req, res) => {
  const token = getSessionToken(req);
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.use((req, res, next) => {
  const publicPaths = ['/login.html', '/login.js', '/api/login', '/api/logout'];
  if (publicPaths.includes(req.path)) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Please log in as the school admin.' });
    return next();
  }
  if (req.path.startsWith('/files/')) {
    if (!isAuthenticated(req)) return res.redirect('/login.html');
    return next();
  }
  if (!isAuthenticated(req)) {
    return res.redirect('/login.html');
  }
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((out) => res.json(out)).catch(next);
const entryFromForm = (req) => {
  try { return JSON.parse(req.body.entry || '{}'); } catch { throw new UserError('The form data could not be read. Reload the page and try again.'); }
};
const filesFrom = (req) => ({ bill: req.files?.bill?.[0], photos: req.files?.photos || [] });

app.get('/api/lists', wrap(() => service.getLists()));
app.get('/api/fleet', wrap(() => service.getFleet()));
app.get('/api/buses', wrap(() => service.listBuses()));
app.post('/api/buses', requireAdmin, wrap((req) => service.addBus(req.body)));
app.get('/api/buses/:busNo', wrap((req) => service.getBus(req.params.busNo)));
app.get('/api/repeats', wrap(() => service.getRepeats()));
app.get('/api/reports/daily', wrap((req) => service.getDailyReport(String(req.query.start_date || ''), String(req.query.end_date || req.query.start_date || ''), String(req.query.bus_no || ''))));
app.post('/api/reports/daily', tripPhotos, wrap((req) => service.saveDailyReport(JSON.parse(req.body.report || '{}'), req.files || [])));
app.get('/api/entries/:id', wrap((req) => service.getEntry(req.params.id)));
app.post('/api/check-repeat', wrap((req) => service.checkRepeat(req.body)));
app.post('/api/bills/read', upload.single('bill'), wrap((req) => service.readBillFields(req.file)));
app.post('/api/entries', entryFiles, wrap((req) => service.saveEntry(entryFromForm(req), filesFrom(req))));
app.post('/api/entries/:id/correct', entryFiles, wrap((req) => service.saveEntry(entryFromForm(req), filesFrom(req), { correctsId: req.params.id })));

// Uploaded bills, photos and documents (only these folders are served).
for (const folder of ['Bills', 'Photos', 'Bus documents']) {
  app.use(`/files/${encodeURIComponent(folder)}`, express.static(path.join(storage.root, folder), { dotfiles: 'deny', index: false }));
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
  console.log(`  Admin login:             ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}`);
  console.log(`  Google OAuth:           ${googleOAuthEnabled ? 'enabled' : 'disabled'}`);
  console.log(`  AI bill reading:         ${process.env.ANTHROPIC_API_KEY ? 'on' : 'off (add ANTHROPIC_API_KEY to .env)'}`);
  console.log('\n  Keep this window open while using the app. Press Ctrl+C to stop.\n');
});
