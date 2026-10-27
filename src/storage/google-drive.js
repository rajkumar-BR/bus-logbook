import path from 'node:path';
import ExcelJS from 'exceljs';
import { google } from 'googleapis';
import { TABS, WORKBOOK_NAME, DEFAULT_LISTS, DEFAULT_SETTINGS, columnsOf } from '../schema.js';

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function parseServiceAccount(env) {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_SERVICE_ACCOUNT || env.GOOGLE_CREDENTIALS;
  if (!raw) return null;
  try {
    if (raw.trim().startsWith('{')) return JSON.parse(raw);
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function createGoogleDriveStorage(env = process.env) {
  const folderId = env.GOOGLE_DRIVE_FOLDER_ID || env.GOOGLE_DRIVE_ROOT_ID;
  if (!folderId) throw new Error('GOOGLE_DRIVE_FOLDER_ID is required when STORAGE=google.');

  const serviceAccount = parseServiceAccount(env);
  if (!serviceAccount) {
    throw new Error('Google Drive auth is missing. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS to a valid service account JSON.');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const drive = google.drive({ version: 'v3', auth });
  const root = { folderId };
  let cache = null;

  async function listFilesInFolder(parentId, name) {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and name='${name.replace(/'/g, "\\'")}' and trashed=false`,
      fields: 'files(id,name,mimeType,webViewLink,webContentLink)',
      pageSize: 10,
    });
    return res.data.files || [];
  }

  async function ensureFolder(parentId, folderName) {
    const existing = await listFilesInFolder(parentId, folderName);
    if (existing.length) return existing[0].id;
    const created = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id',
    });
    return created.data.id;
  }

  async function getWorkbookFile() {
    const files = await listFilesInFolder(root.folderId, WORKBOOK_NAME);
    if (files.length) return files[0];
    const created = await drive.files.create({
      requestBody: {
        name: WORKBOOK_NAME,
        mimeType: MIME_XLSX,
        parents: [root.folderId],
      },
      media: {
        mimeType: MIME_XLSX,
        body: Buffer.from([]),
      },
      fields: 'id,name',
    });
    return created.data;
  }

  async function loadWorkbook() {
    const file = await getWorkbookFile();
    const res = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' });
    const wb = new ExcelJS.Workbook();
    const buf = Buffer.from(res.data);
    try {
      await wb.xlsx.load(buf);
    } catch {
      const blank = new ExcelJS.Workbook();
      for (const tab of Object.keys(TABS)) {
        blank.addWorksheet(tab);
      }
      await blank.xlsx.load(buf).catch(() => {});
      return blank;
    }
    return wb;
  }

  async function saveWorkbook(wb) {
    const file = await getWorkbookFile();
    const buffer = await wb.xlsx.writeBuffer();
    await drive.files.update({
      fileId: file.id,
      media: {
        mimeType: MIME_XLSX,
        body: buffer,
      },
      fields: 'id',
    });
    cache = null;
  }

  async function allTables() {
    const wb = await loadWorkbook();
    const tables = {};
    for (const tab of Object.keys(TABS)) tables[tab] = sheetToObjects(wb.getWorksheet(tab), tab);
    return tables;
  }

  async function read(tab) {
    const tables = await allTables();
    return tables[tab].map((r) => ({ ...r }));
  }

  function sheetToObjects(ws, tab) {
    if (!ws) return [];
    const headers = headerRow(ws);
    const out = [];
    ws.eachRow((row, n) => {
      if (n === 1 || !row.hasValues) return;
      const obj = {};
      headers.forEach((h, i) => { if (h) obj[h] = fromCell(tab, h, row.getCell(i + 1).value); });
      out.push(obj);
    });
    return out;
  }

  function headerRow(ws) {
    const headers = [];
    ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => { headers[col - 1] = String(cell.value).trim(); });
    return Array.from(headers, (h) => h ?? '');
  }

  function fromCell(tab, key, value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'string') return value.trim();
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return value;
  }

  async function init() {
    await drive.files.get({ fileId: root.folderId, fields: 'id,name' }).catch(() => {
      throw new Error(`Google Drive folder ${root.folderId} could not be reached. Check GOOGLE_DRIVE_FOLDER_ID and the service account access.`);
    });
    const wb = await loadWorkbook();
    let changed = false;
    for (const tab of Object.keys(TABS)) {
      let ws = wb.getWorksheet(tab);
      if (!ws) {
        ws = wb.addWorksheet(tab, { views: [{ state: 'frozen', ySplit: 1 }] });
        changed = true;
      }
      const headers = headerRow(ws);
      for (const col of columnsOf(tab)) {
        if (!headers.includes(col)) {
          ws.getRow(1).getCell(headers.length + 1).value = col;
          changed = true;
        }
      }
    }
    if (rowCount(wb.getWorksheet('Lists')) === 0) {
      const ws = wb.getWorksheet('Lists');
      const longest = Math.max(...Object.values(DEFAULT_LISTS).map((l) => l.length));
      for (let i = 0; i < longest; i++) {
        ws.addRow(columnsOf('Lists').map((c) => DEFAULT_LISTS[c][i] ?? null));
      }
      changed = true;
    }
    if (rowCount(wb.getWorksheet('Settings')) === 0) {
      const ws = wb.getWorksheet('Settings');
      DEFAULT_SETTINGS.forEach((r) => ws.addRow(r));
      changed = true;
    }
    if (changed) await saveWorkbook(wb);
    return true;
  }

  function rowCount(ws) {
    if (!ws) return 0;
    let n = 0;
    ws.eachRow((row, i) => { if (i > 1 && row.hasValues) n++; });
    return n;
  }

  function transact(fn) {
    return (async () => {
      const wb = await loadWorkbook();
      const tx = {
        read: (tab) => sheetToObjects(wb.getWorksheet(tab), tab),
        append: (tab, rows) => {
          const ws = wb.getWorksheet(tab) || wb.addWorksheet(tab);
          const headers = headerRow(ws);
          for (const obj of rows) {
            const row = ws.addRow(headers.map((h) => obj[h] ?? ''));
            row.font = row.font || {};
          }
        },
        update: (tab, match, patch) => {
          const ws = wb.getWorksheet(tab);
          if (!ws) return [];
          const headers = headerRow(ws);
          const changes = [];
          ws.eachRow((row, n) => {
            if (n === 1) return;
            const before = {};
            headers.forEach((h, i) => { if (h) before[h] = row.getCell(i + 1).value; });
            if (!match(before)) return;
            for (const [k, v] of Object.entries(patch)) {
              const idx = headers.indexOf(k);
              if (idx >= 0) row.getCell(idx + 1).value = v;
            }
            changes.push({ before, after: { ...before, ...patch } });
          });
          return changes;
        },
      };
      const result = await fn(tx);
      await saveWorkbook(wb);
      return result;
    })();
  }

  async function saveFile(folder, fileName, buffer) {
    const cleanFolder = folder.split('/').map((part) => String(part).replace(/[\\/:*?"<>|]/g, ' ').trim()).filter(Boolean).join('/');
    let parentId = root.folderId;
    if (cleanFolder) {
      const parts = cleanFolder.split('/');
      for (const part of parts) {
        parentId = await ensureFolder(parentId, part);
      }
    }
    const safeName = String(fileName || 'file').replace(/[\\/:*?"<>|]/g, ' ').trim() || 'file';
    const existing = await listFilesInFolder(parentId, safeName);
    const finalName = existing.length ? `${path.basename(safeName, path.extname(safeName))} (${Date.now()})${path.extname(safeName)}` : safeName;
    const file = await drive.files.create({
      requestBody: { name: finalName, parents: [parentId] },
      media: { mimeType: 'application/octet-stream', body: buffer },
      fields: 'id,webViewLink,webContentLink',
    });
    return file.data.webViewLink || file.data.webContentLink || `https://drive.google.com/file/d/${file.data.id}/view`;
  }

  function fileUrl(link) {
    if (!link) return '';
    if (/^https?:\/\//.test(link)) return link;
    return link;
  }

  return { kind: 'google', root, init, read, transact, saveFile, fileUrl };
}
