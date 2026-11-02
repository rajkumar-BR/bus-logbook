// Removing (voiding) an entry and editing a bus.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.js';

const TABS = ['Buses', 'Routes', 'Route assignments', 'Daily reports', 'Trips', 'Entries', 'Parts changed', 'Workshops', 'Lists', 'Settings', 'Bus documents', 'Change log'];

function memoryStorage(initial = {}) {
  const tables = Object.fromEntries(TABS.map((tab) => [tab, initial[tab] || []]));
  return {
    tables,
    async read(tab) { return tables[tab].map((row) => ({ ...row })); },
    async saveFile(folder, name) { return `${folder}/${name}`; },
    fileUrl(link) { return link ? `/files/${link}` : ''; },
    async transact(fn) {
      return fn({
        read(tab) { return tables[tab].map((row) => ({ ...row })); },
        append(tab, rows) { tables[tab].push(...rows.map((row) => ({ ...row }))); },
        update(tab, match, patch) {
          return tables[tab].filter(match).map((row) => { Object.assign(row, patch); return { after: { ...row } }; });
        },
      });
    },
  };
}

const bus = (no, extra = {}) => ({ bus_no: no, status: 'On route', active: true, ...extra });
const visit = (extra = {}) => ({ bus_no: '04', kind: 'Repair', system: 'Brakes', date_in: '2026-10-20', date_out: '2026-10-21', total_cost: 1000, ...extra });

function setup(initial) {
  const storage = memoryStorage(initial);
  let now = '2026-11-03';
  const service = createService(storage, { today: () => now, user: 'office@school.test' });
  return { storage, service, setToday: (d) => { now = d; } };
}

// ---------- removing an entry

test('a removed entry leaves the history, costs and parts, but is kept with who, when and why', async () => {
  const { storage, service } = setup({ Buses: [bus('04')] });
  const keep = await service.saveEntry(visit({ kind: 'Scheduled service', system: '', date_in: '2026-09-01', date_out: '2026-09-01', total_cost: 4000 }));
  const wrong = await service.saveEntry({ ...visit({ total_cost: 9999 }), parts: [{ part_name: 'Brake pad', part_cost: 500 }] });
  assert.equal((await service.getBus('04')).facts.spent_since_service, 9999);

  const out = await service.voidEntry(wrong.entry_id, 'Entered against the wrong bus');
  assert.deepEqual(out, { entry_id: wrong.entry_id, bus_no: '04' });

  const d = await service.getBus('04');
  assert.deepEqual(d.entries.map((e) => e.entry_id), [keep.entry_id]);
  assert.equal(d.facts.spent_since_service, 0);
  assert.equal(d.facts.spent_year, 4000);
  assert.equal(d.voided.length, 1);
  assert.equal(d.voided[0].entry_id, wrong.entry_id);
  assert.equal(d.voided[0].reason, 'Entered against the wrong bus');
  assert.equal(d.voided[0].removed_by, 'office@school.test');
  assert.equal(d.voided[0].total_cost, 9999);

  const row = storage.tables.Entries.find((e) => e.entry_id === wrong.entry_id);
  assert.equal(row.record_status, 'Voided'); // still stored
  assert.equal(storage.tables['Parts changed'][0].record_status, 'Voided');
  const log = storage.tables['Change log'].find((l) => l.action === 'Removed');
  assert.equal(log.record_id, wrong.entry_id);
  assert.equal(log.new_value, 'Entered against the wrong bus');
});

test('removing needs a reason, only works once, and the entry can no longer be opened or corrected', async () => {
  const { service } = setup({ Buses: [bus('04')] });
  const { entry_id } = await service.saveEntry(visit());
  await assert.rejects(service.voidEntry(entry_id, ''), /reason/);
  await assert.rejects(service.voidEntry(entry_id, 'oops'), /at least 5/);
  await assert.rejects(service.voidEntry('E-2026-9999', 'does not exist'), /not found/);
  await service.voidEntry(entry_id, 'Duplicate of the other bill');
  await assert.rejects(service.voidEntry(entry_id, 'Duplicate of the other bill'), /already been corrected or removed/);
  await assert.rejects(service.getEntry(entry_id), /not found/);
  await assert.rejects(service.saveEntry(visit({ total_cost: 5 }), {}, { correctsId: entry_id }), /not found/);
});

test('a removed repair no longer counts towards a repeat', async () => {
  const { service } = setup({ Buses: [bus('04')] });
  const a = await service.saveEntry(visit({ date_in: '2026-09-01', date_out: '2026-09-01' }));
  await service.saveEntry(visit({ date_in: '2026-09-10', date_out: '2026-09-10' }));
  assert.equal((await service.checkRepeat({ bus_no: '04', system: 'Brakes', kind: 'Repair', date_in: '2026-10-01' })).count, 2);
  await service.voidEntry(a.entry_id, 'Belongs to another bus');
  assert.equal((await service.checkRepeat({ bus_no: '04', system: 'Brakes', kind: 'Repair', date_in: '2026-10-01' })).count, 1);
});

test('removing the only open visit takes the bus out of "In workshop"', async () => {
  const { storage, service } = setup({ Buses: [bus('04')] });
  const open = await service.saveEntry(visit({ date_in: '2026-11-02', date_out: '' }));
  assert.equal(storage.tables.Buses[0].status, 'In workshop');
  await service.voidEntry(open.entry_id, 'Bus was never in the workshop');
  assert.equal(storage.tables.Buses[0].status, 'On route');
});

test('re-importing a file does not bring back an entry that was removed', async () => {
  const { storage, service } = setup({ Buses: [bus('04')] });
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Entries');
  ws.addRow(['Bus No', 'Date', 'Amount']);
  ws.addRow(['04', '20/10/2026', 700]);
  const file = { originalname: 'x.xlsx', buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
  await service.importWorkbook(file, { commit: true });
  await service.voidEntry(storage.tables.Entries[0].entry_id, 'Imported twice by mistake');
  const again = await service.importWorkbook(file, { commit: true });
  assert.equal(again.totals.add, 0);
  assert.equal(storage.tables.Entries.length, 1);
});

// ---------- editing a bus

test('editing a bus changes only what was sent and logs each change', async () => {
  const { storage, service } = setup({ Buses: [bus('04', { driver_name: 'Ravi', year: 2018, seats: 40, reg_no: 'TN 01' })] });
  const out = await service.updateBus('04', { driver_name: 'Kumar', year: '2019', seats: 42, reg_no: 'TN 01', make_model: 'Tata Starbus' });
  assert.equal(out.changed, 4);
  const b = storage.tables.Buses[0];
  assert.deepEqual([b.driver_name, b.year, b.seats, b.reg_no, b.make_model, b.bus_no], ['Kumar', 2019, 42, 'TN 01', 'Tata Starbus', '04']);
  const log = storage.tables['Change log'].map((l) => [l.field, l.old_value, l.new_value]);
  assert.deepEqual(log.sort(), [['driver_name', 'Ravi', 'Kumar'], ['make_model', '', 'Tata Starbus'], ['seats', '40', '42'], ['year', '2018', '2019']]);
  assert.ok(storage.tables['Change log'].every((l) => l.action === 'Updated' && l.tab === 'Buses' && l.record_id === '04'));
});

test('saving a bus with no changes writes nothing', async () => {
  const { storage, service } = setup({ Buses: [bus('04', { driver_name: 'Ravi' })] });
  assert.equal((await service.updateBus('04', { driver_name: 'Ravi', active: true })).changed, 0);
  assert.equal(storage.tables['Change log'].length, 0);
});

test('the bus number cannot be changed, and bad values or unknown buses are refused', async () => {
  const { storage, service } = setup({ Buses: [bus('04')] });
  await service.updateBus('04', { bus_no: '99', driver_name: 'Kumar' });
  assert.equal(storage.tables.Buses[0].bus_no, '04');
  await assert.rejects(service.updateBus('04', { year: 1950 }), /The year must be/);
  await assert.rejects(service.updateBus('04', { year: 'abc' }), /The year must be/);
  await assert.rejects(service.updateBus('04', { seats: 0 }), /Seats must be/);
  await assert.rejects(service.updateBus('04', { service_every_km: 5 }), /Service every \(km\)/);
  await assert.rejects(service.updateBus('77', { driver_name: 'X' }), /no bus "77"/);
  assert.equal(storage.tables['Change log'].length, 1); // only the driver change above
});

test('a retired bus leaves the fleet and can be brought back', async () => {
  const { storage, service } = setup({ Buses: [bus('04'), bus('05')] });
  await service.updateBus('04', { active: false });
  assert.deepEqual((await service.getFleet()).buses.map((b) => b.bus_no), ['05']);
  assert.equal(storage.tables['Change log'][0].new_value, 'false');
  await service.updateBus('04', { active: true });
  assert.deepEqual((await service.getFleet()).buses.map((b) => b.bus_no).sort(), ['04', '05']);
});

test('changing the route ends the old one yesterday, so past visits keep their route', async () => {
  const { storage, service, setToday } = setup({
    Buses: [bus('04')],
    Routes: [{ route_id: 'R01', route_name: 'North Gate' }],
    'Route assignments': [{ bus_no: '04', route_id: 'R01', from_date: '2026-01-01', to_date: '' }],
  });
  const old = await service.saveEntry(visit({ date_in: '2026-10-20', date_out: '2026-10-20' }));
  assert.equal(storage.tables.Entries[0].route_at_time, 'R01');

  await service.updateBus('04', { route_name: 'Hillside Colony' });
  const [first, second] = storage.tables['Route assignments'];
  assert.equal(first.to_date, '2026-11-02');
  assert.deepEqual([second.route_id, second.from_date, second.to_date], ['R02', '2026-11-03', '']);
  assert.deepEqual(storage.tables.Routes.map((r) => r.route_name), ['North Gate', 'Hillside Colony']);
  assert.equal((await service.getBus('04')).bus.route, 'Hillside Colony');
  assert.equal((await service.getBus('04')).entries.find((e) => e.entry_id === old.entry_id).route_name, 'North Gate');
  assert.deepEqual(storage.tables['Change log'].filter((l) => l.action === 'Updated').map((l) => [l.field, l.old_value, l.new_value]), [['route', 'North Gate', 'Hillside Colony']]);

  // changing it again the same day just repoints today's assignment
  await service.updateBus('04', { route_name: 'North Gate' });
  assert.equal(storage.tables['Route assignments'].length, 2);
  assert.equal(storage.tables['Route assignments'][1].route_id, 'R01');
  assert.equal((await service.getBus('04')).bus.route, 'North Gate');

  // and a later change starts a third assignment
  setToday('2026-11-10');
  await service.updateBus('04', { route_name: 'Hillside Colony' });
  assert.equal(storage.tables['Route assignments'].length, 3);
  assert.equal(storage.tables['Route assignments'][1].to_date, '2026-11-09');
  assert.equal((await service.getBus('04')).bus.route, 'Hillside Colony');
});

test('clearing the route ends it, and leaving the route as it is changes nothing', async () => {
  const { storage, service } = setup({
    Buses: [bus('04')],
    Routes: [{ route_id: 'R01', route_name: 'North Gate' }],
    'Route assignments': [{ bus_no: '04', route_id: 'R01', from_date: '2026-01-01', to_date: '' }],
  });
  assert.equal((await service.updateBus('04', { route_name: 'north gate' })).changed, 0);
  await service.updateBus('04', { route_name: '' });
  assert.equal(storage.tables['Route assignments'][0].to_date, '2026-11-02');
  assert.equal((await service.getBus('04')).bus.route, '');
});

// ---------- the change log

test('the change log lists events newest first, with a correction\'s fields grouped into one event', async () => {
  const { service, setToday } = setup({ Buses: [bus('04')] });
  setToday('2026-11-03');
  await service.updateBus('04', { driver_name: 'Kumar', year: 2019, seats: 42 }); // three rows, one event
  const visit1 = await service.saveEntry(visit());
  await service.voidEntry(visit1.entry_id, 'Entered twice by mistake');

  const log = await service.getChangeLog();
  const summary = log.events.map((e) => `${e.action}:${e.tab}`);
  assert.ok(summary.indexOf('Removed:Entries') < summary.indexOf('Added:Entries'), 'newest first');
  const update = log.events.find((e) => e.action === 'Updated' && e.tab === 'Buses');
  assert.deepEqual(update.changes.map((c) => c.field), ['driver_name', 'year', 'seats']);
  assert.equal(update.record_id, '04');
  assert.equal(update.user, 'office@school.test');
  const removed = log.events.find((e) => e.action === 'Removed');
  assert.equal(removed.changes[0].new_value, 'Entered twice by mistake');
  assert.deepEqual(log.actions, ['Added', 'Removed', 'Updated']);
  assert.equal(log.total, log.events.length);
});

test('the change log can be filtered by action and searched', async () => {
  const { service } = setup({ Buses: [bus('04'), bus('05')] });
  await service.updateBus('04', { driver_name: 'Kumar' });
  await service.updateBus('05', { driver_name: 'Selvi' });
  const v = await service.saveEntry(visit({ bus_no: '05' }));
  await service.voidEntry(v.entry_id, 'Wrong bus entirely');

  assert.deepEqual((await service.getChangeLog({ action: 'removed' })).events.map((e) => e.action), ['Removed']);
  assert.equal((await service.getChangeLog({ q: 'selvi' })).total, 1);
  assert.equal((await service.getChangeLog({ q: 'WRONG BUS' })).total, 1);
  assert.equal((await service.getChangeLog({ q: 'office@school.test' })).total, (await service.getChangeLog()).total);
  assert.equal((await service.getChangeLog({ q: 'nothing like this' })).total, 0);
  assert.equal((await service.getChangeLog({ action: 'Updated', q: 'kumar' })).total, 1);
});

test('the change log is paged, and odd page numbers are tolerated', async () => {
  const { service } = setup({ Buses: Array.from({ length: 60 }, (_, i) => bus(String(i + 1).padStart(2, '0'))) });
  for (let i = 1; i <= 60; i++) await service.updateBus(String(i).padStart(2, '0'), { driver_name: `Driver ${i}` });
  const first = await service.getChangeLog();
  assert.deepEqual([first.total, first.pages, first.page, first.events.length], [60, 2, 1, 50]);
  const second = await service.getChangeLog({ page: 2 });
  assert.equal(second.events.length, 10);
  assert.notEqual(second.events[0].record_id, first.events[0].record_id);
  assert.equal((await service.getChangeLog({ page: 99 })).page, 2);
  assert.equal((await service.getChangeLog({ page: -4 })).page, 1);
  assert.equal((await service.getChangeLog({ page: 'abc' })).page, 1);
});

test('the change log copes with an empty log and with rows that have no record id', async () => {
  const { storage, service } = setup();
  assert.deepEqual(await service.getChangeLog(), { total: 0, page: 1, pages: 1, pageSize: 50, actions: [], events: [] });
  storage.tables['Change log'].push({ timestamp: '2026-10-22 09:00', user: 'demo', action: 'Added', tab: 'All', record_id: '', field: '', old_value: '', new_value: 'Demo data loaded' });
  const log = await service.getChangeLog();
  assert.equal(log.events[0].changes[0].new_value, 'Demo data loaded');
});
