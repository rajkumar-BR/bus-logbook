// Postgres storage: one table per tab in schema.js, same adapter interface as
// local-xlsx.js (init, read, transact, saveFile, fileUrl), so service.js is unchanged.
//
// Many schools share these tables. storage.forSchool(id) returns the same interface
// limited to one school: reads only see that school's rows, appended rows are stamped
// with its id, updates can only touch its rows, and uploaded files go under
// schools/<id>/. The plain storage object (no school) sees every row; only scripts use it.
//
// Values come back exactly as the Excel adapter returns them: empty is '', dates
// and datetimes are strings, numbers are numbers, bools are booleans.
//
// service.js calls tx.read / tx.append / tx.update synchronously, so transact()
// loads the school's tables into memory inside a database transaction, runs the
// function against that snapshot, then writes the differences back before committing.
// A transaction-level advisory lock serialises writers within one school.
//
// Bills and photos still live on local disk for now (borrowed from the local
// adapter); they move to object storage in a later step.

import pg from 'pg';
import { TABS, columnsOf, typeOf } from '../schema.js';
import { createLocalStorage } from './local-xlsx.js';

// Dates stay as 'YYYY-MM-DD' strings instead of JS Date objects.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

const SQL_TYPE = { text: 'text', datetime: 'text', date: 'date', number: 'double precision', bool: 'boolean' };
const WRITE_LOCK = 727001;
export const SCHOOL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;

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
      await pool.query(`CREATE INDEX IF NOT EXISTS ${ident(`${tableName(tab)}_school`)} ON ${table(tab)} (school_id)`);
    }
    await files.init();
  }

  // The data operations for one school, or for all rows when schoolId is null.
  function operations(schoolId) {
    const scoped = schoolId !== null;
    const filter = scoped ? ' WHERE school_id = $1' : '';
    const params = scoped ? [schoolId] : [];
    const select = (client, tab) => client.query(`SELECT * FROM ${table(tab)}${filter} ORDER BY _id`, params);

    async function read(tab) {
      const { rows } = await select(pool, tab);
      return rows.map((r) => fromRow(tab, r));
    }

    async function transact(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [WRITE_LOCK, scoped ? schoolId : '']);

        const mem = {};
        for (const tab of Object.keys(TABS)) {
          const { rows } = await select(client, tab);
          mem[tab] = rows.map((r) => tracked(fromRow(tab, r), r._id));
        }
        const snapshot = (tab) => mem[tab].map((r) => ({ ...r }));

        const tx = {
          read: snapshot,
          append(tab, rows) {
            for (const obj of rows) {
              const row = fromObject(tab, obj);
              if (scoped) row.school_id = schoolId;
              mem[tab].push(tracked(row, null));
            }
          },
          // patch is applied to every row where match(row) is true; returns [{before, after}]
          update(tab, match, patch) {
            const cols = columnsOf(tab);
            const changes = [];
            for (const row of mem[tab]) {
              const before = { ...row };
              if (!match(before)) continue;
              for (const [k, v] of Object.entries(patch)) {
                if (cols.includes(k) && !(scoped && k === 'school_id')) row[k] = normalise(tab, k, v);
              }
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

    return { read, transact };
  }

  const base = operations(null);

  function forSchool(schoolId) {
    if (!SCHOOL_ID_PATTERN.test(String(schoolId))) throw new Error(`"${schoolId}" is not a valid school id.`);
    const own = operations(schoolId);
    return {
      kind: 'postgres',
      root: files.root,
      schoolId,
      read: own.read,
      transact: own.transact,
      saveFile: (folder, fileName, buffer) => files.saveFile(`schools/${schoolId}/${folder}`, fileName, buffer),
      fileUrl: files.fileUrl,
    };
  }

  const close = () => pool.end();

  return {
    kind: 'postgres', root: files.root, schema, pool,
    init, close, forSchool,
    read: base.read, transact: base.transact,
    saveFile: files.saveFile, fileUrl: files.fileUrl,
  };
}

// ---------- helpers

// Bookkeeping lives under symbols, non-enumerable, so it never shows up when rows are spread or serialised.
const ROW_ID = Symbol('rowId');
const DIRTY = Symbol('dirty');

function tracked(obj, id) {
  Object.defineProperty(obj, ROW_ID, { value: id, writable: true });
  Object.defineProperty(obj, DIRTY, { value: false, writable: true });
  return obj;
}

async function insertRow(client, tab, row) {
  const cols = columnsOf(tab);
  const values = cols.map((c) => toDb(row[c]));
  const marks = cols.map((_, i) => `$${i + 1}`);
  await client.query(`INSERT INTO ${ident(tableName(tab))} (${cols.map(ident).join(', ')}) VALUES (${marks.join(', ')})`, values);
}

async function updateRow(client, tab, row) {
  const cols = columnsOf(tab);
  const sets = cols.map((c, i) => `${ident(c)} = $${i + 1}`);
  const values = cols.map((c) => toDb(row[c]));
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

function toDb(v) {
  return v === '' || v === undefined ? null : v;
}
