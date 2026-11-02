// A Postgres storage in its own throw-away schema, so tests never touch real data.
// Needs DATABASE_URL, e.g. postgres://postgres:dev@localhost:5432/buslog

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createPostgresStorage } from '../../src/storage/postgres.js';

export const url = process.env.DATABASE_URL;
export const opts = { skip: url ? false : 'DATABASE_URL is not set' };

export async function freshStorage() {
  const schema = `test_${crypto.randomBytes(4).toString('hex')}`;
  const dataDir = path.join(os.tmpdir(), schema);
  const storage = createPostgresStorage({ DATABASE_URL: url, DB_SCHEMA: schema, DATA_DIR: dataDir });
  await storage.init();
  storage.dataDir = dataDir;
  storage.drop = async () => { await storage.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await storage.close(); };
  return storage;
}
