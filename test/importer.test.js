import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createService } from '../src/service.js';
import { buildTemplate, parseWorkbook } from '../src/importer.js';

const TABS = ['Buses', 'Routes', 'Route assignments', 'Daily reports', 'Trips', 'Entries', 'Parts changed', 'Workshops', 'Lists', 'Settings', 'Bus documents', 'Change log', 'Trip settings'];

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

// sheets: { 'Sheet name': [[row of cells], ...] }
async function workbook(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    rows.forEach((r) => ws.addRow(r));
  }
  return { originalname: 'old records.xlsx', buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
}

const setup = (initial) => {
  const storage = memoryStorage(initial);
  return { storage, service: createService(storage, { today: () => '2026-11-03', user: 'office@school.test' }) };
};

test('a school\'s own single sheet imports: its headings, day-first dates, rupee amounts, new buses and workshops', async () => {
  const { storage, service } = setup();
  const file = await workbook({
    Sheet1: [
      ['Date', 'Bus No', 'Work Done', 'Garage', 'Amount', 'Km', 'Driver comments'],
      ['28/10/2026', '04', 'Brake pads replaced', 'Sri Murugan Motors', '₹12,500', '83,900', 'ok'],
      ['05-09-2026', '04', 'Oil change', 'Sri Murugan Motors', 3200, '', ''],
      ['01/02/2026', '07', 'Tyre change', 'City Tyres', 8000, 61000, ''],
    ],
  });
  const preview = await service.importWorkbook(file, { commit: false });
  assert.equal(preview.committed, false);
  assert.equal(storage.tables.Entries.length, 0, 'a preview writes nothing');
  assert.equal(preview.tabs[0].tab, 'Entries');
  assert.equal(preview.tabs[0].add, 3);
  assert.deepEqual(preview.tabs[0].unknownColumns, ['Driver comments']);

  const done = await service.importWorkbook(file, { commit: true });
  assert.equal(done.committed, true);
  const entries = storage.tables.Entries;
  assert.equal(entries.length, 3);
  assert.equal(entries[0].date_in, '2026-10-28'); // 28/10 is the 28th of October, not the 10th of a 28th month
  assert.equal(entries[1].date_in, '2026-09-05'); // 05-09 is day-first: 5 September
  assert.equal(entries[0].total_cost, 12500);
  assert.equal(entries[0].odometer_km, 83900);
  assert.equal(entries[0].kind, 'Repair');
  assert.equal(entries[0].system, 'Other');
  assert.deepEqual(entries.map((e) => e.entry_id), ['E-2026-0001', 'E-2026-0002', 'E-2026-0003']);
  assert.equal(entries[0].entered_by, 'office@school.test (import)');
  assert.deepEqual(storage.tables.Buses.map((b) => b.bus_no).sort(), ['04', '07']);
  assert.deepEqual(storage.tables.Workshops.map((w) => w.workshop_name).sort(), ['City Tyres', 'Sri Murugan Motors']);
  assert.equal(storage.tables['Change log'].at(-1).action, 'Imported');
  assert.ok(done.notes.some((n) => /not in your Buses list/.test(n)));
  // the 28 Oct visit is recent and has no date out; the older ones are closed the same day
  assert.equal(entries[2].date_out, '2026-02-01');
  assert.equal(entries[0].date_out, '');
  assert.equal(storage.tables.Buses.find((b) => b.bus_no === '04').status, 'In workshop');
});

test('importing the same file again adds nothing', async () => {
  const { storage, service } = setup();
  const file = await workbook({
    Entries: [['Bus No', 'Date', 'Amount'], ['04', '18/10/2026', 100], ['04', '19/10/2026', 200]],
  });
  await service.importWorkbook(file, { commit: true });
  const again = await service.importWorkbook(file, { commit: true });
  assert.equal(storage.tables.Entries.length, 2);
  assert.equal(again.totals.add, 0);
  assert.equal(again.tabs[0].skipped, 2);
});

test('bad rows are rejected with their Excel row number and the rest still import', async () => {
  const { storage, service } = setup();
  const file = await workbook({
    Entries: [
      ['Bus No', 'Date', 'Amount', 'Type'],
      ['04', '18/10/2026', 100, 'Repair'],
      ['', '18/10/2026', 100, 'Repair'],
      ['05', 'not a date', 100, 'Repair'],
      ['06', '18/10/2026', 'abc', 'Repair'],
      ['07', '18/10/2026', '', 'Repair'],
      ['08', '18/10/2030', 100, 'Repair'],
      ['09', '18/10/2026', 100, 'Spaceflight'],
      ['10', '18/10/2026', 50, 'Scheduled service'],
    ],
  });
  const result = await service.importWorkbook(file, { commit: true });
  const t = result.tabs[0];
  assert.equal(t.add, 2);
  assert.equal(t.errorCount, 6);
  assert.deepEqual(t.errors.map((e) => e.row), [3, 4, 5, 6, 7, 8]);
  assert.match(t.errors[0].message, /Bus number is missing/);
  assert.match(t.errors[1].message, /not a date/);
  assert.match(t.errors[2].message, /not a number/);
  assert.match(t.errors[3].message, /amount is missing/);
  assert.match(t.errors[4].message, /future/);
  assert.match(t.errors[5].message, /not one of/);
  assert.equal(storage.tables.Entries.length, 2);
  assert.equal(storage.tables.Entries[1].kind, 'Scheduled service');
});

test('a title row above the headings is skipped', async () => {
  const { storage, service } = setup();
  const file = await workbook({
    'Service History': [['SCHOOL BUS SERVICE REGISTER 2026'], [], ['Bus No', 'Date', 'Amount'], ['04', '18/10/2026', 100]],
  });
  const r = await service.importWorkbook(file, { commit: true });
  assert.equal(r.tabs[0].add, 1);
  assert.equal(storage.tables.Entries[0].date_in, '2026-10-18');
});

test('real Excel dates and date serial numbers are read', async () => {
  const { storage, service } = setup();
  const file = await workbook({
    Entries: [['Bus No', 'Date', 'Amount'], ['04', new Date(Date.UTC(2026, 9, 18)), 100], ['04', 46283, 100]],
  });
  await service.importWorkbook(file, { commit: true });
  assert.equal(storage.tables.Entries[0].date_in, '2026-10-18');
  assert.equal(storage.tables.Entries[1].date_in, '2026-09-18'); // Excel serial 46283 = 46283 days after 1899-12-30
});

test('a bus written as 4 matches the existing bus 04', async () => {
  const { storage, service } = setup({ Buses: [{ bus_no: '04', status: 'On route', active: true }] });
  const file = await workbook({ Entries: [['Bus No', 'Date', 'Amount'], [4, '18/10/2026', 100]] });
  await service.importWorkbook(file, { commit: true });
  assert.equal(storage.tables.Buses.length, 1);
  assert.equal(storage.tables.Entries[0].bus_no, '04');
});

test('parts link to visits by Entry ID, and a part with no visit is rejected', async () => {
  const { storage, service } = setup();
  const file = await workbook({
    Entries: [['Entry ID', 'Bus No', 'Date', 'Amount', 'Type', 'System'], ['V1', '04', '18/10/2026', 5000, 'Repair', 'Brakes']],
    'Parts changed': [
      ['Entry ID', 'Part', 'Cost', 'Warranty'],
      ['V1', 'Brake pad', 4200, '18/10/2027'],
      ['V9', 'Ghost part', 100, ''],
      ['', 'No id', 100, ''],
    ],
  });
  const r = await service.importWorkbook(file, { commit: true });
  const parts = r.tabs.find((t) => t.tab === 'Parts changed');
  assert.equal(parts.add, 1);
  assert.equal(parts.errorCount, 2);
  assert.equal(storage.tables.Entries[0].entry_id, 'V1');
  assert.deepEqual(storage.tables['Parts changed'].map((p) => [p.entry_id, p.bus_no, p.system, p.warranty_until]), [['V1', '04', 'Brakes', '2027-10-18']]);
});

test('visits already in the app are skipped, and so are their parts', async () => {
  const { storage, service } = setup({
    Buses: [{ bus_no: '04', status: 'On route', active: true }],
    Entries: [{ entry_id: 'V1', bus_no: '04', record_status: 'Active', date_in: '2026-10-18' }],
  });
  const file = await workbook({
    Entries: [['Entry ID', 'Bus No', 'Date', 'Amount'], ['V1', '04', '18/10/2026', 5000]],
    'Parts changed': [['Entry ID', 'Part'], ['V1', 'Brake pad']],
  });
  const r = await service.importWorkbook(file, { commit: true });
  assert.equal(r.totals.add, 0);
  assert.equal(r.totals.skipped, 2);
  assert.equal(storage.tables['Parts changed'].length, 0);
});

test('buses, documents and workshops import from their own sheets, and unknown sheets are ignored', async () => {
  const { storage, service } = setup({ Workshops: [{ workshop_name: 'City Tyres' }] });
  const file = await workbook({
    'Read me': [['Some notes']],
    Buses: [['Bus No', 'Registration', 'Make', 'Year', 'Driver'], ['04', 'TN 22 BX 1104', 'Tata Starbus', 2018, 'Ravi']],
    Documents: [['Bus', 'Document', 'Number', 'Expiry'], ['04', 'Insurance', 'P-889', '31/03/2027']],
    Workshops: [['Garage', 'Phone'], ['city tyres', '999'], ['Sri Murugan Motors', '888']],
  });
  const r = await service.importWorkbook(file, { commit: true });
  assert.deepEqual(r.ignoredSheets, ['Read me']);
  assert.deepEqual(storage.tables.Buses.map((b) => [b.bus_no, b.reg_no, b.make_model, b.year, b.driver_name, b.active]), [['04', 'TN 22 BX 1104', 'Tata Starbus', 2018, 'Ravi', true]]);
  assert.deepEqual(storage.tables['Bus documents'].map((d) => [d.bus_no, d.doc_type, d.doc_number, d.valid_until]), [['04', 'Insurance', 'P-889', '2027-03-31']]);
  assert.deepEqual(storage.tables.Workshops.map((w) => w.workshop_name), ['City Tyres', 'Sri Murugan Motors']);
});

test('a file that is not a workbook, or has nothing recognisable, gives a clear message', async () => {
  const { service } = setup();
  await assert.rejects(service.importWorkbook({ originalname: 'x.xlsx', buffer: Buffer.from('not a zip') }), /could not be read/);
  await assert.rejects(service.importWorkbook(undefined), /Choose an Excel file/);
  const r = await service.importWorkbook(await workbook({ Notes: [['hello', 'world']] }), { commit: false });
  assert.equal(r.tabs.length, 0);
  assert.match(r.notes[0], /No sheet in this file looked like/);
});

test('the template has the right sheets and headings and imports cleanly when filled in', async () => {
  const { storage, service } = setup();
  const template = await service.importTemplate();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(template);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Read me', 'Buses', 'Entries', 'Parts changed', 'Bus documents', 'Workshops']);
  wb.getWorksheet('Buses').addRow(['04', 'TN 22 BX 1104', 'Tata', 2018, 40, 'Ravi', 10000, 90]);
  wb.getWorksheet('Entries').addRow(['', '04', 'Scheduled service', new Date(Date.UTC(2026, 8, 12)), '', 80000, '', '', '', 'Sri Murugan Motors', 'B-1', 1000, 4500]);
  const filled = { originalname: 'filled.xlsx', buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
  const r = await service.importWorkbook(filled, { commit: true });
  assert.equal(r.totals.errors, 0);
  assert.equal(storage.tables.Buses[0].seats, 40);
  assert.equal(storage.tables.Entries[0].kind, 'Scheduled service');
  assert.equal(storage.tables.Entries[0].date_in, '2026-09-12');
});

test('parseWorkbook caps nothing silently: a huge sheet is refused with advice', async () => {
  const { service } = setup();
  const rows = [['Bus No', 'Date', 'Amount']];
  for (let i = 0; i < 5100; i++) rows.push(['04', '18/10/2026', i]);
  await assert.rejects(service.importWorkbook(await workbook({ Entries: rows })), /more than 5000 rows/);
});
