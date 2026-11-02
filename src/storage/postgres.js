// Postgres storage: one table per tab in schema.js, same adapter interface as
// local-xlsx.js (init, read, transact, saveFile, fileUrl), so service.js is unchanged.
//
// Values come back exactly as the Excel adapter returns them: empty is '', dates
// and datetimes are strings, numbers are numbers, bools are booleans.
//
// service.js calls tx.read / tx.append / tx.update synchronously, so transact()
// loads every table into memory inside a database transaction, runs the function
// against that snapshot, then writes the differences back before committing.
// A transaction-level advisory lock serialises writers.
//
// Bills and photos still live on local disk for now (borrowed from the local
// adapter); they move to object storage in a later step.

import pg from 'pg';
import { TABS, DEFAULT_LISTS, DEFAULT_SETTINGS, columnsOf, typeOf } from '../schema.js';
import { createLocalStorage } from './local-xlsx.js';

// Dates stay as 'YYYY-MM-DD' strings instead of JS Date objects.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

const SQL_TYPE = { text: 'text', datetime: 'text', date: 'date', number: 'double precision', bool: 'boolean' };
const WRITE_LOCK = 727001;

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
export const tableName = (tab) => tab.toLowerCase().replace(/[^a-z0-9]+/g, '_');

export function createPostgresStorage(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('STORAGE=postgres needs DATABASE_URL, for example postgres://user:password@localhost:5432/buslog');
  const schema = env.DB_SCHEMA || 'public';
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, options: `-c search_path=${schema}` });
  const files = createLocalStorage(env.DATA_DIR || './data'); // bills and photos, until object storage

  const table = (tab) => `${ident(schema)}.${ident(tableName(tab))}`;

  async function init() {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`);
    for (const tab of Object.keys(TABS)) {
      const cols = TABS[tab].map(([name, type]) => `${ident(name)} ${SQL_TYPE[type]}`);
      await pool.query(`CREATE TABLE IF NOT EXISTS ${table(tab)} (_id bigserial PRIMARY KEY, ${cols.join(', ')})`);
      // Safe schema upgrades: add columns that schema.js gained since the table was made.
      for (const [name, type] of TABS[tab]) {
        await pool.query(`ALTER TABLE ${table(tab)} ADD COLUMN IF NOT EXISTS ${ident(name)} ${SQL_TYPE[type]}`);
      }
    }
    await seed('Lists', () => {
      const longest = Math.max(...Object.values(DEFAULT_LISTS).map((l) => l.length));
      return Array.from({ length: longest }, (_, i) => Object.fromEntries(columnsOf('Lists').map((c) => [c, DEFAULT_LISTS[c][i] ?? ''])));
    });
    await seed('Settings', () => DEFAULT_SETTINGS.map(([key, value]) => ({ key, value })));
    await files.init();
  }

  async function seed(tab, makeRows) {
    const { rows } = await pool.query(`SELECT 1 FROM ${table(tab)} LIMIT 1`);
    if (rows.length) return;
    await transact((tx) => tx.append(tab, makeRows()));
  }

  async function read(tab) {
    const { rows } = await pool.query(`SELECT * FROM ${table(tab)} ORDER BY _id`);
    return rows.map((r) => fromRow(tab, r));
  }

  async function transact(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [WRITE_LOCK]);

      const mem = {};
      for (const tab of Object.keys(TABS)) {
        const { rows } = await client.query(`SELECT * FROM ${table(tab)} ORDER BY _id`);
        mem[tab] = rows.map((r) => tracked(fromRow(tab, r), r._id));
      }
      const snapshot = (tab) => mem[tab].map((r) => ({ ...r }));

      const tx = {
        read: snapshot,
        append(tab, rows) {
          for (const obj of rows) mem[tab].push(tracked(fromObject(tab, obj), null));
        },
        // patch is applied to every row where match(row) is true; returns [{before, after}]
        update(tab, match, patch) {
          const cols = columnsOf(tab);
          const changes = [];
          for (const row of mem[tab]) {
            const before = { ...row };
            if (!match(before)) continue;
            for (const [k, v] of Object.entries(patch)) if (cols.includes(k)) row[k] = normalise(tab, k, v);
            row[DIRTY] = true;
            changes.push({ before, after: { ...before, ...patch } });
          }
          return changes;
        },
      };

      const result = await fn(tx);

      for (const tab of Object.keys(TABS)) {
        for (const row of mem[tab]) {
          if (row[ROW_ID] === null) await insertRow(client, tab, row);
          else if (row[DIRTY]) await updateRow(client, tab, row);
        }
      }
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const close = () => pool.end();

  return { kind: 'postgres', root: files.root, pool, init, read, transact, close, saveFile: files.saveFile, fileUrl: files.fileUrl };
}

// ---------- helpers

// Bookkeeping lives under symbols so it never shows up when rows are spread or serialised.
const ROW_ID = Symbol('rowId');
const DIRTY = Symbol('dirty');

function tracked(obj, id) {
  Object.defineProperty(obj, ROW_ID, { value: id, writable: true });
  Object.defineProperty(obj, DIRTY, { value: false, writable: true });
  return obj;
}

async function insertRow(client, tab, row) {
  const cols = columnsOf(tab);
  const values = cols.map((c) => toDb(tab, c, row[c]));
  const marks = cols.map((_, i) => `$${i + 1}`);
  await client.query(`INSERT INTO ${ident(tableName(tab))} (${cols.map(ident).join(', ')}) VALUES (${marks.join(', ')})`, values);
}

async function updateRow(client, tab, row) {
  const cols = columnsOf(tab);
  const sets = cols.map((c, i) => `${ident(c)} = $${i + 1}`);
  const values = cols.map((c) => toDb(tab, c, row[c]));
  await client.query(`UPDATE ${ident(tableName(tab))} SET ${sets.join(', ')} WHERE _id = $${cols.length + 1}`, [...values, row[ROW_ID]]);
}

// database row -> app row ('' for empty, like the Excel adapter)
function fromRow(tab, r) {
  const obj = {};
  for (const col of columnsOf(tab)) obj[col] = r[col] === null || r[col] === undefined ? '' : r[col];
  return obj;
}

// app row -> in-memory row, with the same cleaning the Excel adapter applies on write
function fromObject(tab, obj) {
  const out = {};
  for (const col of columnsOf(tab)) out[col] = normalise(tab, col, obj[col]);
  return out;
}

function normalise(tab, col, v) {
  const type = typeOf(tab, col);
  if (v === null || v === undefined || v === '') return '';
  if (type === 'number') { const n = Number(v); return Number.isFinite(n) ? n : ''; }
  if (type === 'bool') return Boolean(v);
  if (type === 'date') return String(v).slice(0, 10);
  return String(v);
}

function toDb(tab, col, v) {
  return v === '' || v === undefined ? null : v;
}
