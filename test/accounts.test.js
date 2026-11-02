// Schools, users and sessions. The database tests run only when DATABASE_URL is set (see test/helpers/pg-storage.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ExcelJS from 'exceljs';
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

test('an Excel import lands in the importing school only, and importing twice adds nothing', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    const a = await accounts.createSchool({ name: 'School A' });
    const b = await accounts.createSchool({ name: 'School B' });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Entries');
    ws.addRow(['Bus No', 'Date', 'Amount', 'Garage']);
    ws.addRow(['04', '28/10/2026', 5000, 'Sri Murugan Motors']);
    ws.addRow(['04', '12/09/2026', 3000, 'Sri Murugan Motors']);
    const file = { originalname: 'old.xlsx', buffer: Buffer.from(await wb.xlsx.writeBuffer()) };

    const sa = createService(storage.forSchool(a), { today: () => '2026-11-03', user: 'a@a.test' });
    const first = await sa.importWorkbook(file, { commit: true });
    assert.equal(first.totals.errors, 0);
    assert.equal((await storage.forSchool(a).read('Entries')).length, 2);
    assert.equal((await storage.forSchool(a).read('Buses'))[0].status, 'In workshop');
    assert.equal((await storage.forSchool(b).read('Entries')).length, 0);
    assert.equal((await storage.forSchool(b).read('Buses')).length, 0);

    const again = await sa.importWorkbook(file, { commit: true });
    assert.equal(again.totals.add, 0);
    assert.equal((await storage.forSchool(a).read('Entries')).length, 2);

    // the other school can import the same file; its records are its own
    const sb = createService(storage.forSchool(b), { today: () => '2026-11-03', user: 'b@b.test' });
    assert.equal((await sb.importWorkbook(file, { commit: true })).totals.add > 0, true);
    assert.equal((await storage.forSchool(b).read('Entries')).length, 2);
  } finally { await storage.drop(); }
});

test('signup creates a school and its first user, who can sign in and sees only that school', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    const one = await accounts.signUp({ organisationName: '  Little   Flower School ', email: 'Office@LF.test', password: 'long enough pw' });
    const two = await accounts.signUp({ organisationName: 'St Mary School', email: 'office@stmary.test', password: 'another long pw' });
    assert.notEqual(one.school_id, two.school_id);
    assert.match(one.school_id, /^school-[0-9a-f]{8}$/);
    assert.equal((await storage.forSchool(one.school_id).read('Schools'))[0].school_name, 'Little Flower School');
    assert.ok((await storage.forSchool(one.school_id).read('Lists')).length > 0);
    const user = await accounts.login('office@lf.test', 'long enough pw');
    assert.equal(user.school_id, one.school_id);

    await storage.forSchool(one.school_id).transact((tx) => tx.append('Buses', [{ bus_no: '01' }]));
    assert.equal((await storage.forSchool(two.school_id).read('Buses')).length, 0);
  } finally { await storage.drop(); }
});

test('a signup that fails leaves no school behind', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    await accounts.signUp({ organisationName: 'School A', email: 'a@a.test', password: 'long enough pw' });
    const before = (await storage.read('Schools')).length;

    await assert.rejects(accounts.signUp({ organisationName: 'School B', email: 'A@A.test', password: 'long enough pw' }), /already has an account/);
    await assert.rejects(accounts.signUp({ organisationName: 'School B', email: 'b@b.test', password: 'short' }), /at least 8/);
    await assert.rejects(accounts.signUp({ organisationName: 'School B', email: 'not-an-email', password: 'long enough pw' }), /valid email/);
    await assert.rejects(accounts.signUp({ organisationName: 'x', email: 'b@b.test', password: 'long enough pw' }), /organisation name/);
    await assert.rejects(accounts.signUp({ organisationName: 'School B', email: 'b@b.test', password: 'x'.repeat(201) }), /at most 200/);
    assert.equal((await storage.read('Schools')).length, before);
  } finally { await storage.drop(); }
});

test('two signups at the same moment both succeed, with separate schools', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => accounts.signUp({ organisationName: `School ${i}`, email: `u${i}@s.test`, password: 'long enough pw' })));
    assert.equal(new Set(results.map((r) => r.school_id)).size, 6);
    assert.equal((await storage.read('Schools')).length, 6);
  } finally { await storage.drop(); }
});

test('the same email signing up twice at once creates one account and no stray school', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    const attempts = await Promise.allSettled(Array.from({ length: 3 }, (_, i) => accounts.signUp({ organisationName: `School ${i}`, email: 'same@s.test', password: 'long enough pw' })));
    assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 1);
    assert.equal((await storage.read('Schools')).length, 1);
    assert.equal((await accounts.listUsers()).length, 1);
  } finally { await storage.drop(); }
});

test('organisations that sign up start pending; admin-created and older ones are approved', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    const signedUp = await accounts.signUp({ organisationName: 'New Org', email: 'new@org.test', password: 'long enough pw' });
    const made = await accounts.createSchool({ name: 'Made By Admin' });
    await accounts.createUser({ schoolId: made, email: 'admin@made.test', password: 'long enough pw' });
    // an organisation from before approval existed has a blank status
    await storage.transact((tx) => tx.append('Schools', [{ school_id: 'school-old', school_name: 'Old School' }]));
    await accounts.createUser({ schoolId: 'school-old', email: 'old@old.test', password: 'long enough pw' });

    const status = async (email, password) => (await accounts.getSession(await accounts.createSession((await accounts.login(email, password)).user_id))).org_status;
    assert.equal(await status('new@org.test', 'long enough pw'), 'pending');
    assert.equal(await status('admin@made.test', 'long enough pw'), 'approved');
    assert.equal(await status('old@old.test', 'long enough pw'), 'approved');
    assert.equal((await storage.forSchool(signedUp.school_id).read('Schools'))[0].status, 'pending');
  } finally { await storage.drop(); }
});

test('approving and suspending change what an existing session sees, immediately', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    const { user_id, school_id } = await accounts.signUp({ organisationName: 'New Org', email: 'new@org.test', password: 'long enough pw' });
    const token = await accounts.createSession(user_id);
    assert.equal((await accounts.getSession(token)).org_status, 'pending');
    await accounts.setStatus(school_id, 'approved');
    assert.equal((await accounts.getSession(token)).org_status, 'approved');
    await accounts.setStatus(school_id, 'suspended');
    assert.equal((await accounts.getSession(token)).org_status, 'suspended');
    await assert.rejects(accounts.setStatus(school_id, 'free'), /Status must be one of/);
    await assert.rejects(accounts.setStatus('school-404', 'approved'), /does not exist/);
    const list = await accounts.listSchools();
    assert.equal(list[0].status, 'suspended');
  } finally { await storage.drop(); }
});

test('removing an entry and editing a bus work in Postgres, and only within the organisation', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    const a = await accounts.createSchool({ name: 'School A' });
    const b = await accounts.createSchool({ name: 'School B' });
    const sa = createService(storage.forSchool(a), { today: () => '2026-11-03', user: 'a@a.test' });
    const sb = createService(storage.forSchool(b), { today: () => '2026-11-03', user: 'b@b.test' });
    await sa.addBus({ bus_no: '04', route_name: 'North Gate' });
    await sb.addBus({ bus_no: '04' });
    const visit = await sa.saveEntry({ bus_no: '04', kind: 'Repair', system: 'Brakes', date_in: '2026-10-20', date_out: '2026-10-20', total_cost: 500 });

    await assert.rejects(sb.voidEntry(visit.entry_id, 'Not my entry at all'), /not found/);
    await sa.voidEntry(visit.entry_id, 'Entered twice by mistake');
    const row = (await storage.forSchool(a).read('Entries'))[0];
    assert.deepEqual([row.record_status, row.voided_reason, row.voided_by, row.voided_at.length], ['Voided', 'Entered twice by mistake', 'a@a.test', 16]);
    assert.equal((await sa.getBus('04')).voided.length, 1);

    await sa.updateBus('04', { driver_name: 'Kumar', route_name: 'Hillside', active: false });
    assert.equal((await storage.forSchool(a).read('Buses'))[0].driver_name, 'Kumar');
    assert.equal((await storage.forSchool(a).read('Buses'))[0].active, false);
    assert.equal((await storage.forSchool(b).read('Buses'))[0].driver_name, '');
    assert.equal((await storage.forSchool(b).read('Buses'))[0].active, true);
    // the route was set today, so changing it today repoints that assignment instead of adding one
    const assignments = await storage.forSchool(a).read('Route assignments');
    assert.deepEqual(assignments.map((r) => r.route_id), ['R02']);
    assert.equal((await storage.forSchool(b).read('Route assignments')).length, 0);
  } finally { await storage.drop(); }
});

test('the change log shows an organisation only its own events', opts, async () => {
  const { storage, accounts } = await setup();
  try {
    const a = await accounts.createSchool({ name: 'School A' });
    const b = await accounts.createSchool({ name: 'School B' });
    const sa = createService(storage.forSchool(a), { today: () => '2026-11-03', user: 'a@a.test' });
    const sb = createService(storage.forSchool(b), { today: () => '2026-11-03', user: 'b@b.test' });
    await sa.addBus({ bus_no: '04' });
    await sa.updateBus('04', { driver_name: 'Kumar' });
    await sb.addBus({ bus_no: '09' });

    const logA = await sa.getChangeLog();
    const logB = await sb.getChangeLog();
    assert.deepEqual(logA.events.map((e) => e.record_id).sort(), ['04', '04']);
    assert.deepEqual(logB.events.map((e) => e.record_id), ['09']);
    assert.ok(logA.events.every((e) => e.user === 'a@a.test'));
    assert.equal((await sb.getChangeLog({ q: 'kumar' })).total, 0);
  } finally { await storage.drop(); }
});
