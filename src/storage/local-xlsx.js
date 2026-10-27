// Local storage: one Excel workbook plus a folder tree that mirrors the planned
// Google Drive layout (Bills/, Photos/, Bus documents/, Excel exports/).
//
// Every storage adapter exposes the same interface, so a Google Sheets + Drive
// adapter can replace this one later without touching the rest of the app:
//   init()                         create the workbook/folders if missing
//   read(tab)                      -> array of row objects
//   transact(async tx => ...)      tx.read / tx.append / tx.update, saved once at the end
//   saveFile(folder, name, buffer) -> link stored in the sheet
//   fileUrl(link)                  -> URL the browser can open

import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { TABS, WORKBOOK_NAME, DEFAULT_LISTS, DEFAULT_SETTINGS, columnsOf, typeOf } from '../schema.js';

const FOLDERS = ['Bills', 'Photos', 'Bus documents', 'Excel exports', '.backups'];
const KEEP_BACKUPS = 30;

export function createLocalStorage(dataDir) {
  const root = path.resolve(dataDir);
  const workbookPath = path.join(root, WORKBOOK_NAME);
  let cache = null; // { mtimeMs, tables }
  let queue = Promise.resolve(); // serialises writes

  async function init() {
    await fs.mkdir(root, { recursive: true });
    for (const f of FOLDERS) await fs.mkdir(path.join(root, f), { recursive: true });

    const wb = (await exists(workbookPath)) ? await loadWorkbook() : new ExcelJS.Workbook();
    let changed = false;
    for (const tab of Object.keys(TABS)) {
      let ws = wb.getWorksheet(tab);
      if (!ws) {
        ws = wb.addWorksheet(tab, { views: [{ state: 'frozen', ySplit: 1 }] });
        changed = true;
      }
      // Add any missing header columns at the end (safe schema upgrades).
      const headers = headerRow(ws);
      for (const col of columnsOf(tab)) {
        if (!headers.includes(col)) {
          ws.getRow(1).getCell(headers.length + 1).value = col;
          headers.push(col);
          changed = true;
        }
      }
      styleHeader(ws);
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
  }

  async function loadWorkbook() {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(workbookPath);
    return wb;
  }

  async function saveWorkbook(wb) {
    try {
      await fs.access(workbookPath);
      await backup();
    } catch { /* first save, nothing to back up */ }
    const tmp = workbookPath + '.tmp';
    await wb.xlsx.writeFile(tmp);
    await fs.rename(tmp, workbookPath);
    cache = null;
  }

  async function backup() {
    const dir = path.join(root, '.backups');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    await fs.copyFile(workbookPath, path.join(dir, `Bus Logbook Data ${stamp}.xlsx`));
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.xlsx')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) {
      await fs.unlink(path.join(dir, f));
    }
  }

  async function allTables() {
    const { mtimeMs } = await fs.stat(workbookPath);
    if (cache && cache.mtimeMs === mtimeMs) return cache.tables;
    const wb = await loadWorkbook();
    const tables = {};
    for (const tab of Object.keys(TABS)) tables[tab] = sheetToObjects(wb.getWorksheet(tab), tab);
    cache = { mtimeMs, tables };
    return tables;
  }

  async function read(tab) {
    const tables = await allTables();
    return tables[tab].map((r) => ({ ...r }));
  }

  // Runs fn with a transaction object; all changes are written in one save.
  function transact(fn) {
    const run = queue.then(async () => {
      const wb = await loadWorkbook();
      const tx = {
        read: (tab) => sheetToObjects(wb.getWorksheet(tab), tab),
        append: (tab, rows) => {
          const ws = wb.getWorksheet(tab);
          const headers = headerRow(ws);
          for (const obj of rows) {
            const row = ws.addRow(headers.map((h) => toCell(tab, h, obj[h])));
            formatRow(row, tab, headers);
          }
        },
        // patch is applied to every row where match(row) is true; returns [{before, after}]
        update: (tab, match, patch) => {
          const ws = wb.getWorksheet(tab);
          const headers = headerRow(ws);
          const changes = [];
          ws.eachRow((row, n) => {
            if (n === 1) return;
            const before = rowToObject(row, headers, tab);
            if (!match(before)) return;
            for (const [k, v] of Object.entries(patch)) {
              const idx = headers.indexOf(k);
              if (idx >= 0) row.getCell(idx + 1).value = toCell(tab, k, v);
            }
            formatRow(row, tab, headers);
            changes.push({ before, after: { ...before, ...patch } });
          });
          return changes;
        },
      };
      const result = await fn(tx);
      await saveWorkbook(wb);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  }

  async function saveFile(folder, fileName, buffer) {
    const safeFolder = folder.split('/').map(clean).join('/');
    const dir = path.join(root, safeFolder);
    await fs.mkdir(dir, { recursive: true });
    const ext = path.extname(fileName);
    const base = clean(path.basename(fileName, ext)) || 'file';
    let name = base + ext.toLowerCase();
    for (let i = 2; await exists(path.join(dir, name)); i++) name = `${base} (${i})${ext.toLowerCase()}`;
    await fs.writeFile(path.join(dir, name), buffer);
    return `${safeFolder}/${name}`;
  }

  function fileUrl(link) {
    if (!link) return '';
    if (/^https?:\/\//.test(link)) return link;
    return '/files/' + link.split('/').map(encodeURIComponent).join('/');
  }

  return { kind: 'local', root, workbookPath, init, read, transact, saveFile, fileUrl };
}

// ---------- helpers

function clean(s) {
  return String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function headerRow(ws) {
  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => { headers[col - 1] = String(cell.value).trim(); });
  return Array.from(headers, (h) => h ?? '');
}

function rowCount(ws) {
  let n = 0;
  ws.eachRow((row, i) => { if (i > 1 && row.hasValues) n++; });
  return n;
}

function styleHeader(ws) {
  const row = ws.getRow(1);
  row.font = { bold: true };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2B300' } };
  (ws.columns || []).forEach((c) => { if (!c.width || c.width < 14) c.width = 16; });
}

function sheetToObjects(ws, tab) {
  const headers = headerRow(ws);
  const out = [];
  ws.eachRow((row, n) => {
    if (n === 1 || !row.hasValues) return;
    out.push(rowToObject(row, headers, tab));
  });
  return out;
}

function rowToObject(row, headers, tab) {
  const obj = {};
  headers.forEach((h, i) => { if (h) obj[h] = fromCell(tab, h, row.getCell(i + 1).value); });
  return obj;
}

function plain(v) {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return v.result;                   // formula
    if ('text' in v) return v.text;                        // hyperlink
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
  }
  return v;
}

function fromCell(tab, col, raw) {
  const v = plain(raw);
  const type = typeOf(tab, col);
  if (v === null || v === undefined || v === '') return '';
  if (type === 'date') return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  if (type === 'datetime') return v instanceof Date ? v.toISOString().slice(0, 16).replace('T', ' ') : String(v);
  if (type === 'number') { const n = Number(String(v).replace(/[,₹\s]/g, '')); return Number.isFinite(n) ? n : ''; }
  if (type === 'bool') return v === true || /^(true|yes|1)$/i.test(String(v));
  return String(v);
}

function toCell(tab, col, v) {
  const type = typeOf(tab, col);
  if (v === null || v === undefined || v === '') return null;
  if (type === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : String(v);
  }
  if (type === 'number') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (type === 'bool') return Boolean(v);
  return String(v);
}

function formatRow(row, tab, headers) {
  headers.forEach((h, i) => {
    const t = typeOf(tab, h);
    if (t === 'date') row.getCell(i + 1).numFmt = 'yyyy-mm-dd';
    if (h.endsWith('_cost')) row.getCell(i + 1).numFmt = '#,##0';
  });
}
