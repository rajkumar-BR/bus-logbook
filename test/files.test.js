// The file store (bills, photos, documents) on local disk, and on S3 when S3_ENDPOINT is set, e.g.
//   FILES_TEST_S3=1 S3_ENDPOINT=http://localhost:9090 S3_BUCKET=buslog-files S3_ACCESS_KEY_ID=x S3_SECRET_ACCESS_KEY=y npm test
// Both backends must behave identically, so the same tests run against each.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createFiles, contentTypeFor, fileUrl, isSafeLink } from '../src/storage/files.js';
import { opts as dbOpts } from './helpers/pg-storage.js';

const s3Env = process.env.S3_ENDPOINT && process.env.S3_BUCKET
  ? { FILES: 's3', S3_ENDPOINT: process.env.S3_ENDPOINT, S3_BUCKET: process.env.S3_BUCKET, S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY }
  : null;

const read = async (store, link) => {
  const file = await store.read(link);
  if (!file) return null;
  const chunks = [];
  for await (const chunk of file.stream) chunks.push(chunk);
  return { body: Buffer.concat(chunks), size: file.size };
};

const backends = [
  ['local disk', () => createFiles({ FILES: 'local', DATA_DIR: path.join(os.tmpdir(), `files_${crypto.randomBytes(4).toString('hex')}`) }), {}],
  ['S3', () => createFiles(s3Env), { skip: s3Env ? false : 'S3_ENDPOINT is not set' }],
];

for (const [name, make, skip] of backends) {
  test(`${name}: a saved file reads back with the same bytes`, skip, async () => {
    const store = make();
    await store.init();
    const folder = `t${crypto.randomBytes(4).toString('hex')}/Bills/Bus 04`;
    const link = await store.save(folder, '2026-10-18 Sri Murugan Motors 2231.pdf', Buffer.from('%PDF-bill'));
    assert.equal(link, `${folder}/2026-10-18 Sri Murugan Motors 2231.pdf`);
    const file = await read(store, link);
    assert.equal(file.body.toString(), '%PDF-bill');
    assert.equal(file.size, 9);
  });

  test(`${name}: saving the same name twice keeps both files`, skip, async () => {
    const store = make();
    await store.init();
    const folder = `t${crypto.randomBytes(4).toString('hex')}/Photos`;
    const first = await store.save(folder, 'engine.jpg', Buffer.from('one'));
    const second = await store.save(folder, 'engine.jpg', Buffer.from('two'));
    assert.notEqual(first, second);
    assert.match(second, /engine \(2\)\.jpg$/);
    assert.equal((await read(store, first)).body.toString(), 'one');
    assert.equal((await read(store, second)).body.toString(), 'two');
  });

  test(`${name}: awkward file names are cleaned and cannot climb out of the folder`, skip, async () => {
    const store = make();
    await store.init();
    const folder = `t${crypto.randomBytes(4).toString('hex')}/Bills`;
    const link = await store.save(folder, '../../evil:name?.PDF', Buffer.from('x'));
    assert.ok(link.startsWith(`${folder}/`));
    assert.ok(!link.slice(folder.length + 1).includes('/'));
    assert.ok(link.endsWith('.pdf'));
    assert.ok(await store.read(link));
  });

  test(`${name}: a missing file, an unsafe link and a folder all read as nothing`, skip, async () => {
    const store = make();
    await store.init();
    await store.save('exists/Bills', 'a.pdf', Buffer.from('x'));
    assert.equal(await store.read('exists/Bills/nope.pdf'), null);
    assert.equal(await store.read('../outside.txt'), null);
    assert.equal(await store.read('exists/../exists/Bills/a.pdf'), null);
    assert.equal(await store.read('exists//Bills/a.pdf'), null);
    assert.equal(await store.read('exists\\Bills\\a.pdf'), null);
    assert.equal(await store.read(''), null);
    assert.equal(await store.read('exists/Bills'), null);
  });
}

test('links: safe-link rules, urls, and which types the browser may display', () => {
  assert.equal(isSafeLink('schools/school-001/Bills/Bus 04/a.pdf'), true);
  for (const bad of ['', '.', '..', '../a', 'a/../b', 'a//b', '/a', 'a/', 'a\\b', 'a\0b']) assert.equal(isSafeLink(bad), false, JSON.stringify(bad));
  assert.equal(fileUrl('schools/s-1/Bills/Bus 04/a b.pdf'), '/files/schools/s-1/Bills/Bus%2004/a%20b.pdf');
  assert.equal(fileUrl(''), '');
  assert.equal(fileUrl('https://example.com/x.pdf'), 'https://example.com/x.pdf');
  assert.equal(contentTypeFor('x/a.PDF'), 'application/pdf');
  assert.equal(contentTypeFor('x/a.jpeg'), 'image/jpeg');
  assert.equal(contentTypeFor('x/a.html'), null);
  assert.equal(contentTypeFor('x/a.svg'), null);
});

test('settings: FILES=s3 needs a bucket, and unknown kinds are refused', () => {
  assert.throws(() => createFiles({ FILES: 's3' }), /S3_BUCKET/);
  assert.throws(() => createFiles({ FILES: 'ftp' }), /Unknown FILES/);
});

test('an organisation\'s files go under its own folder in the bucket and stay readable', { skip: !s3Env ? 'S3_ENDPOINT is not set' : dbOpts.skip }, async () => {
  const { createPostgresStorage } = await import('../src/storage/postgres.js');
  const schema = `test_${crypto.randomBytes(4).toString('hex')}`;
  const storage = createPostgresStorage({ DATABASE_URL: process.env.DATABASE_URL, DB_SCHEMA: schema, DATA_DIR: os.tmpdir(), ...s3Env });
  try {
    await storage.init();
    const name = `bill-${crypto.randomBytes(4).toString('hex')}.pdf`;
    const link = await storage.forSchool('school-001').saveFile('Bills/Bus 04', name, Buffer.from('%PDF'));
    assert.equal(link, `schools/school-001/Bills/Bus 04/${name}`);
    assert.equal((await read(storage.files, link)).body.toString(), '%PDF');
  } finally {
    await storage.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await storage.close();
  }
});
