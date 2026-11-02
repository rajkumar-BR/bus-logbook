// Runs only when DATABASE_URL points at a Postgres you can write to, e.g.
//   DATABASE_URL=postgres://postgres:dev@localhost:5432/buslog npm test
// Each run uses its own throw-away schema, so real data is never touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.js';
import { opts, freshStorage } from './helpers/pg-storage.js';

test('postgres: appended rows read back with the same shapes as the Excel adapter', opts, async () => {
  const storage = await freshStorage();
  try {
    await storage.transact((tx) => tx.append('Buses', [{ bus_no: '07', year: '2019', active: true, driver_name: 'Ravi' }]));
    const [bus] = await storage.read('Buses');
    assert.equal(bus.bus_no, '07');
    assert.equal(bus.year, 2019);
    assert.equal(bus.active, true);
    assert.equal(bus.reg_no, '');
    assert.equal(bus.seats, '');
  } finally { await storage.drop(); }
});

test('postgres: dates stay as YYYY-MM-DD strings', opts, async () => {
  const storage = await freshStorage();
  try {
    await storage.transact((tx) => tx.append('Entries', [{ entry_id: 'E1', bus_no: '07', date_in: '2026-10-18', record_status: 'Active' }]));
    const [e] = await storage.read('Entries');
    assert.equal(e.date_in, '2026-10-18');
  } finally { await storage.drop(); }
});

test('postgres: update patches matching rows and returns before/after', opts, async () => {
  const storage = await freshStorage();
  try {
    await storage.transact((tx) => tx.append('Entries', [
      { entry_id: 'E1', record_status: 'Active' }, { entry_id: 'E2', record_status: 'Active' },
    ]));
    const changes = await storage.transact((tx) => tx.update('Entries', (r) => r.entry_id === 'E1', { record_status: 'Corrected' }));
    assert.equal(changes.length, 1);
    assert.equal(changes[0].before.record_status, 'Active');
    assert.equal(changes[0].after.record_status, 'Corrected');
    const rows = await storage.read('Entries');
    assert.deepEqual(rows.map((r) => r.record_status), ['Corrected', 'Active']);
  } finally { await storage.drop(); }
});

test('postgres: a transaction that throws changes nothing', opts, async () => {
  const storage = await freshStorage();
  try {
    await assert.rejects(storage.transact((tx) => {
      tx.append('Workshops', [{ workshop_name: 'Sri Murugan Motors' }]);
      throw new Error('boom');
    }), /boom/);
    assert.equal((await storage.read('Workshops')).length, 0);
  } finally { await storage.drop(); }
});

test('postgres: tx.read inside a transaction sees rows appended earlier in it', opts, async () => {
  const storage = await freshStorage();
  try {
    const seen = await storage.transact((tx) => {
      tx.append('Workshops', [{ workshop_name: 'A' }]);
      tx.update('Workshops', (w) => w.workshop_name === 'A', { phone: '123' });
      return tx.read('Workshops');
    });
    assert.equal(seen[0].phone, '123');
    assert.equal((await storage.read('Workshops'))[0].phone, '123');
  } finally { await storage.drop(); }
});

test('postgres: simultaneous saves do not lose rows', opts, async () => {
  const storage = await freshStorage();
  try {
    await Promise.all(Array.from({ length: 10 }, (_, i) => storage.transact((tx) => tx.append('Workshops', [{ workshop_name: `W${i}` }]))));
    assert.equal((await storage.read('Workshops')).length, 10);
  } finally { await storage.drop(); }
});

test('postgres: the real service adds a bus and saves a repair entry', opts, async () => {
  const storage = await freshStorage();
  try {
    const service = createService(storage, { today: () => '2026-10-23', user: 'test' });
    await service.addBus({ bus_no: '04', reg_no: 'TN 01 AB 1234', make_model: 'Tata Starbus' });
    await assert.rejects(service.addBus({ bus_no: '04' }), /already exists/);
    const buses = await service.listBuses();
    assert.equal(buses.length, 1);
    const log = await storage.read('Change log');
    assert.equal(log.length, 1);
    assert.equal(log[0].action, 'Added');
  } finally { await storage.drop(); }
});
