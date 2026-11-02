// Schools, users and sessions. The database tests run only when DATABASE_URL is set (see test/helpers/pg-storage.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAccounts, hashPassword, verifyPassword } from '../src/accounts.js';
import { createService } from '../src/service.js';
import { opts, freshStorage } from './helpers/pg-storage.js';

test('password hashes verify only the right password and are salted', async () => {
  const a = await hashPassword('correct horse');
  const b = await hashPassword('correct horse');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('correct horse', a), true);
  assert.equal(await verifyPassword('wrong horse', a), false);
  assert.equal(await verifyPassword('anything', 'not-a-hash'), false);
});

async function setup() {
  const storage = await freshStorage();
  const accounts = createAccounts(storage);
  await accounts.init();
  return { storage, accounts };
}

test('a school sees only its own rows, and its rows are stamped with its id', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    const a = await accounts.createSchool({ name: 'School A' });
    const b = await accounts.createSchool({ name: 'School B' });
    assert.deepEqual([a, b], ['school-001', 'school-002']);

    await storage.forSchool(a).transact((tx) => tx.append('Buses', [{ bus_no: '01', school_id: 'school-002' }]));
    const mine = await storage.forSchool(a).read('Buses');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].school_id, a); // a school cannot write into another school
    assert.equal((await storage.forSchool(b).read('Buses')).length, 0);
  } finally { await storage.drop(); }
});

test('a school cannot update another school\'s rows or change a row\'s school', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    const a = await accounts.createSchool({ name: 'School A' });
    const b = await accounts.createSchool({ name: 'School B' });
    await storage.forSchool(a).transact((tx) => tx.append('Buses', [{ bus_no: '01', status: 'On route' }]));
    await storage.forSchool(b).transact((tx) => tx.append('Buses', [{ bus_no: '01', status: 'On route' }]));

    const changes = await storage.forSchool(b).transact((tx) => tx.update('Buses', () => true, { status: 'In workshop', school_id: a }));
    assert.equal(changes.length, 1);
    assert.equal((await storage.forSchool(a).read('Buses'))[0].status, 'On route');
    const [theirs] = await storage.forSchool(b).read('Buses');
    assert.equal(theirs.status, 'In workshop');
    assert.equal(theirs.school_id, b);
  } finally { await storage.drop(); }
});

test('two schools can use the same bus number through the real service', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    const a = await accounts.createSchool({ name: 'School A' });
    const b = await accounts.createSchool({ name: 'School B' });
    const sa = createService(storage.forSchool(a), { today: () => '2026-10-23', user: 'a@a.test' });
    const sb = createService(storage.forSchool(b), { today: () => '2026-10-23', user: 'b@b.test' });
    await sa.addBus({ bus_no: '04', make_model: 'Tata' });
    await sb.addBus({ bus_no: '04', make_model: 'Ashok Leyland' });
    await assert.rejects(sa.addBus({ bus_no: '04' }), /already exists/);
    assert.equal((await sa.listBuses())[0].make_model, 'Tata');
    assert.equal((await sb.listBuses())[0].make_model, 'Ashok Leyland');
    const log = await storage.forSchool(a).read('Change log');
    assert.deepEqual(log.map((l) => l.user), ['a@a.test']);
  } finally { await storage.drop(); }
});

test('a new school starts with the default lists and settings', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    const a = await accounts.createSchool({ name: 'School A', shortName: 'A', region: 'Kerala' });
    const own = storage.forSchool(a);
    assert.equal((await own.read('Schools'))[0].school_name, 'School A');
    assert.ok((await own.read('Lists')).length > 0);
    assert.ok((await own.read('Settings')).some((s) => s.key === 'default_service_km'));
    await assert.rejects(accounts.createSchool({ name: 'Again', id: a }), /already exists/);
  } finally { await storage.drop(); }
});

test('users sign in with email and password, in any letter case', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    const a = await accounts.createSchool({ name: 'School A' });
    await accounts.createUser({ schoolId: a, email: 'Office@School-A.test', password: 'long enough pw' });
    const user = await accounts.login('office@school-a.test', 'long enough pw');
    assert.equal(user.school_id, a);
    assert.equal(await accounts.login('office@school-a.test', 'wrong password'), null);
    assert.equal(await accounts.login('nobody@school-a.test', 'long enough pw'), null);
    await assert.rejects(accounts.createUser({ schoolId: a, email: 'OFFICE@school-a.test', password: 'long enough pw' }), /already exists/);
    await assert.rejects(accounts.createUser({ schoolId: a, email: 'x@y.test', password: 'short' }), /at least 8/);
    await assert.rejects(accounts.createUser({ schoolId: 'school-404', email: 'x@y.test', password: 'long enough pw' }), /does not exist/);
  } finally { await storage.drop(); }
});

test('sessions identify the user, expire, and end on logout, password change or disabling', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    const a = await accounts.createSchool({ name: 'School A' });
    await accounts.createUser({ schoolId: a, email: 'u@a.test', password: 'long enough pw' });
    const user = await accounts.login('u@a.test', 'long enough pw');

    const token = await accounts.createSession(user.user_id);
    assert.equal((await accounts.getSession(token)).email, 'u@a.test');
    assert.equal(await accounts.getSession('made-up-token'), null);
    await accounts.deleteSession(token);
    assert.equal(await accounts.getSession(token), null);

    const expiring = await accounts.createSession(user.user_id);
    await storage.pool.query(`UPDATE app_sessions SET expires_at = now() - interval '1 minute'`);
    assert.equal(await accounts.getSession(expiring), null);

    const t2 = await accounts.createSession(user.user_id);
    await accounts.setPassword('u@a.test', 'a brand new password');
    assert.equal(await accounts.getSession(t2), null);
    assert.equal(await accounts.login('u@a.test', 'long enough pw'), null);
    const again = await accounts.login('u@a.test', 'a brand new password');
    assert.ok(again);

    const t3 = await accounts.createSession(again.user_id);
    await accounts.setActive('u@a.test', false);
    assert.equal(await accounts.getSession(t3), null);
    assert.equal(await accounts.login('u@a.test', 'a brand new password'), null);
  } finally { await storage.drop(); }
});

test('tokens are stored hashed, never as given', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    const a = await accounts.createSchool({ name: 'School A' });
    const id = await accounts.createUser({ schoolId: a, email: 'u@a.test', password: 'long enough pw' });
    const token = await accounts.createSession(id);
    const { rows } = await storage.pool.query('SELECT token_hash FROM app_sessions');
    assert.notEqual(rows[0].token_hash, token);
    assert.equal(rows[0].token_hash.length, 64);
  } finally { await storage.drop(); }
});

test('rows saved before schools existed can be given to a school', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    await storage.transact((tx) => {
      tx.append('Buses', [{ bus_no: '01' }, { bus_no: '02' }]);
      tx.append('Settings', [{ key: 'default_service_km', value: '12000' }]);
    });
    const a = await accounts.createSchool({ name: 'School A' });
    const moved = await accounts.assignLegacyData(a);
    assert.equal(moved.Buses, 2);
    assert.equal((await storage.forSchool(a).read('Buses')).length, 2);
    const settings = await storage.forSchool(a).read('Settings');
    assert.deepEqual(settings.map((s) => s.value), ['12000']); // the old settings replaced the defaults
    assert.equal((await storage.read('Buses')).filter((b) => !b.school_id).length, 0);
  } finally { await storage.drop(); }
});

test('uploaded files are kept under the school\'s own folder', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    const a = await accounts.createSchool({ name: 'School A' });
    const link = await storage.forSchool(a).saveFile('Bills/Bus 04', 'bill.pdf', Buffer.from('x'));
    assert.equal(link, `schools/${a}/Bills/Bus 04/bill.pdf`);
    assert.equal(storage.forSchool(a).fileUrl(link), `/files/schools/${a}/Bills/Bus%2004/bill.pdf`);
    await fs.access(path.join(storage.dataDir, link));
    assert.throws(() => storage.forSchool('../etc'), /not a valid school id/);
  } finally { await storage.drop(); }
});
