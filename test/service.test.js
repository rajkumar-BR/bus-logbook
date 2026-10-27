import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.js';

function memoryStorage(initial = {}) {
  const tables = Object.fromEntries([
    'Buses', 'Routes', 'Route assignments', 'Daily reports', 'Trips', 'Entries', 'Parts changed',
    'Workshops', 'Lists', 'Settings', 'Bus documents', 'Change log',
  ].map((tab) => [tab, initial[tab] || []]));
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
          return tables[tab].filter(match).map((row) => {
            Object.assign(row, patch);
            return { after: { ...row } };
          });
        },
      });
    },
  };
}

test('daily report groups daily income and expense with three photographed odometer-linked trips', async () => {
  const storage = memoryStorage({
    Buses: [
      { bus_no: '01', driver_name: 'Driver A', active: true, status: 'On route' },
      { bus_no: '02', driver_name: 'Driver B', active: true, status: 'On route' },
    ],
  });
  const service = createService(storage, { today: () => '2026-10-23', user: 'test' });

  const saved = await service.saveDailyReport({
    report_date: '2026-10-23',
    bus_no: '01',
    driver_name: 'Driver A',
    income_collected: 4500,
    expenses: 1200,
    trips: [
      { origin: 'School', destination: 'Destination 1', scheduled_start: '07:00', actual_start: '07:02', scheduled_end: '08:00', actual_end: '07:58', planned_km: 42, start_odometer_km: 1000, end_odometer_km: 1047 },
      { origin: 'Destination 1', destination: 'Destination 2', scheduled_start: '10:00', actual_start: '10:00', scheduled_end: '11:00', actual_end: '11:05', planned_km: 30, start_odometer_km: 1047, end_odometer_km: 1082 },
      { origin: 'Destination 2', destination: 'Destination 3', scheduled_start: '13:00', actual_start: '13:00', scheduled_end: '14:00', actual_end: '14:00', planned_km: 35, start_odometer_km: 1082, end_odometer_km: 1115 },
    ],
  }, [1, 2, 3].map((number) => ({ originalname: `trip-${number}.jpg`, mimetype: 'image/jpeg', buffer: Buffer.from(`image-${number}`) })));

  const report = await service.getDailyReport('2026-10-23');
  assert.equal(saved.bus_no, '01');
  assert.equal(report.summary.reported_bus_days, 1);
  assert.equal(report.summary.missing_report_days, 1);
  assert.equal(report.summary.late_buses, 1);
  assert.equal(report.summary.trips, 3);
  assert.equal(report.summary.extra_km, 10);
  assert.equal(report.summary.income_collected, 4500);
  assert.equal(report.summary.expenses, 1200);
  assert.equal(report.buses[0].income_collected, 4500);
  assert.equal(report.buses[0].expenses, 1200);
  assert.equal(report.buses[0].net_collection, 3300);
  assert.equal(report.buses[0].trips[0].origin, 'School');
  assert.equal(report.buses[0].trips[0].photo_url, '/files/Photos/Bus 01/Daily trips/2026-10-23 Trip 1 trip-1.jpg');
  assert.equal(report.buses[0].trips[0].timing_status, 'Late by 2 min');
  assert.equal(report.buses[1].status, 'Not reported');
});

test('date-range report includes both endpoints and sums each bus-day once', async () => {
  const storage = memoryStorage({
    Buses: [{ bus_no: '01', driver_name: 'Driver A', active: true }],
    'Daily reports': [
      { report_id: 'D1', report_date: '2026-10-22', bus_no: '01', driver_name: 'Driver A', income_collected: 100, expenses: 40 },
      { report_id: 'D2', report_date: '2026-10-23', bus_no: '01', driver_name: 'Driver A', income_collected: 200, expenses: 60 },
    ],
    Trips: [
      { trip_id: 'T1', trip_date: '2026-10-22', bus_no: '01', trip_number: 1, actual_start: '07:00', actual_km: 12, extra_km: 2, on_time: false },
      { trip_id: 'T2', trip_date: '2026-10-23', bus_no: '01', trip_number: 1, actual_start: '07:00', actual_km: 10, extra_km: 0, on_time: true },
    ],
  });
  const service = createService(storage, { today: () => '2026-10-23' });
  const report = await service.getDailyReport('2026-10-22', '2026-10-23');
  assert.equal(report.days, 2);
  assert.equal(report.summary.total_bus_days, 2);
  assert.equal(report.summary.reported_bus_days, 2);
  assert.equal(report.summary.income_collected, 300);
  assert.equal(report.summary.expenses, 100);
  assert.equal(report.summary.net_collection, 200);
  assert.deepEqual(report.buses.map((row) => row.report_date), ['2026-10-22', '2026-10-23']);
  await assert.rejects(service.getDailyReport('2026-10-23', '2026-10-22'), /start date must be on or before/);
});

test('daily report can be filtered to one bus without including other buses', async () => {
  const storage = memoryStorage({
    Buses: [
      { bus_no: '01', driver_name: 'Driver A', active: true },
      { bus_no: '02', driver_name: 'Driver B', active: true },
    ],
    'Daily reports': [
      { report_id: 'D1', report_date: '2026-10-23', bus_no: '01', driver_name: 'Driver A', income_collected: 100, expenses: 25 },
      { report_id: 'D2', report_date: '2026-10-23', bus_no: '02', driver_name: 'Driver B', income_collected: 300, expenses: 75 },
    ],
  });
  const service = createService(storage, { today: () => '2026-10-23' });
  const report = await service.getDailyReport('2026-10-23', '2026-10-23', '02');
  assert.equal(report.bus_no, '02');
  assert.equal(report.bus_count, 1);
  assert.equal(report.buses.length, 1);
  assert.equal(report.buses[0].bus_no, '02');
  assert.equal(report.summary.income_collected, 300);
  assert.equal(report.summary.expenses, 75);
  await assert.rejects(service.getDailyReport('2026-10-23', '2026-10-23', '99'), /not active or does not exist/);
});

test('daily report rejects discontinuous odometer readings between legs', async () => {
  const storage = memoryStorage({ Buses: [{ bus_no: '01', active: true }] });
  const service = createService(storage, { today: () => '2026-10-23', user: 'test' });
  const trips = [1, 2, 3].map((trip_number) => ({
    origin: `Stop ${trip_number}`,
    destination: `Stop ${trip_number + 1}`,
    scheduled_start: '07:00', actual_start: '07:00', scheduled_end: '08:00', actual_end: '08:00',
    planned_km: 10, start_odometer_km: trip_number === 2 ? 111 : (trip_number - 1) * 100,
    end_odometer_km: trip_number * 100,
  }));
  const photos = trips.map((_, index) => ({ originalname: `trip-${index}.jpg`, mimetype: 'image/jpeg', buffer: Buffer.from('image') }));
  await assert.rejects(service.saveDailyReport({
    report_date: '2026-10-23', bus_no: '01', driver_name: 'Driver', income_collected: 0, expenses: 0, trips,
  }, photos), /Trip 2 must start at the odometer reading where Trip 1 ended/);
});
