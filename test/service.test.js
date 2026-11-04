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

test('expense can be added to an existing bus-day, replaced, or create a new one', async () => {
  const storage = memoryStorage({
    Buses: [{ bus_no: '01', driver_name: 'Driver A', active: true, status: 'On route' }],
    'Daily reports': [{ report_id: 'D-2026-10-22-01', report_date: '2026-10-22', bus_no: '01', driver_name: 'Driver A', income_collected: 5000, expenses: 0 }],
  });
  const service = createService(storage, { today: () => '2026-10-23', user: 'test' });
  assert.equal((await service.saveExpense({ bus_no: '01', report_date: '2026-10-22', amount: 800, note: 'Diesel' })).expenses, 800);
  assert.equal((await service.saveExpense({ bus_no: '01', report_date: '2026-10-22', amount: 150, note: 'Toll' })).expenses, 950);
  assert.equal((await service.saveExpense({ bus_no: '01', report_date: '2026-10-22', amount: 900, mode: 'replace' })).expenses, 900);
  const created = await service.saveExpense({ bus_no: '01', report_date: '2026-10-21', amount: 300 });
  assert.equal(created.created, true);
  const day = await service.getDailyReport('2026-10-22');
  assert.equal(day.summary.income_collected, 5000);
  assert.equal(day.summary.expenses, 900);
  await assert.rejects(service.saveExpense({ bus_no: '99', report_date: '2026-10-22', amount: 5 }), /active bus/);
  await assert.rejects(service.saveExpense({ bus_no: '01', report_date: '2026-10-22', amount: -5 }), /amount/);
  await assert.rejects(service.saveExpense({ bus_no: '01', report_date: '2026-12-01', amount: 5 }), /future/);
});

test('a bus is offered as many trips as it has routes today, and a one-trip day can be saved', async () => {
  const storage = memoryStorage({
    Buses: [
      { bus_no: '01', driver_name: 'Driver A', active: true, status: 'On route' },
      { bus_no: '02', driver_name: 'Driver B', active: true, status: 'On route' },
    ],
    Routes: [{ route_id: 'R01', route_name: 'A' }, { route_id: 'R02', route_name: 'B' }, { route_id: 'R02-T2', route_name: 'C' }],
    'Route assignments': [
      { bus_no: '01', route_id: 'R01', from_date: '2026-06-01' },
      { bus_no: '02', route_id: 'R02', from_date: '2026-06-01' },
      { bus_no: '02', route_id: 'R02-T2', from_date: '2026-06-01' },
    ],
  });
  const service = createService(storage, { today: () => '2026-10-23', user: 'test' });
  const lists = await service.getLists();
  assert.deepEqual(lists.buses.map((b) => [b.bus_no, b.trips]), [['01', 1], ['02', 2]]);
  const saved = await service.saveDailyReport({
    report_date: '2026-10-23', bus_no: '01', driver_name: 'Driver A', income_collected: 0, expenses: 0,
    trips: [{ origin: 'Kurur', destination: 'School', scheduled_start: '07:40', actual_start: '07:40', scheduled_end: '09:00', actual_end: '09:00', planned_km: 29, start_odometer_km: 100, end_odometer_km: 129 }],
  }, [{ originalname: 'a.jpg', mimetype: 'image/jpeg', buffer: Buffer.from('x') }]);
  assert.equal(saved.trip_ids.length, 1);
  const day = await service.getDailyReport('2026-10-23');
  assert.deepEqual(day.buses.map((b) => [b.bus_no, b.trip_count, b.trips_expected]), [['01', 1, 1], ['02', 0, 2]]);
});

test('expected trip times are set on the trip and apply to every day, past ones included; fee-only days take trips', async () => {
  const storage = memoryStorage({
    Buses: [{ bus_no: '02', driver_name: 'Driver B', active: true, status: 'On route' }],
    Routes: [{ route_id: 'R02', route_name: 'Trip 1: A' }, { route_id: 'R02-T2', route_name: 'Trip 2: B' }],
    'Route assignments': [
      { bus_no: '02', route_id: 'R02', from_date: '2026-06-01' },
      { bus_no: '02', route_id: 'R02-T2', from_date: '2026-06-01' },
    ],
    'Daily reports': [{ report_id: 'D-2026-10-22-02', report_date: '2026-10-22', bus_no: '02', driver_name: 'Driver B', income_collected: 3600, expenses: 0 }],
  });
  const service = createService(storage, { today: () => '2026-10-23', user: 'test' });
  await assert.rejects(service.setTripTimes('R02', { expected_start: '9:00', expected_end: '10:00' }), /hours and minutes/);
  await assert.rejects(service.setTripTimes('R02', { expected_start: '09:00', expected_end: '08:00' }), /after/);
  await service.setTripTimes('R02', { expected_start: '08:10', expected_end: '08:30' });
  await service.setTripTimes('R02-T2', { expected_start: '08:45', expected_end: '09:05' });
  const leg = (o, d, s, e, a, b) => ({ origin: o, destination: d, scheduled_start: '00:00', actual_start: s, scheduled_end: '00:01', actual_end: e, planned_km: 7, start_odometer_km: a, end_odometer_km: b });
  const img = (n) => ({ originalname: `${n}.jpg`, mimetype: 'image/jpeg', buffer: Buffer.from(n) });
  // the day already has fee income and no trips: trips attach to it, income stays
  await service.saveDailyReport({ report_date: '2026-10-22', bus_no: '02', driver_name: 'Driver B', income_collected: 0, expenses: 0, trips: [leg('A', 'School', '08:10', '08:40', 100, 107), leg('B', 'School', '08:45', '09:05', 107, 114)] }, [img('1'), img('2')]);
  let day = await service.getDailyReport('2026-10-22');
  assert.equal(day.summary.income_collected, 3600);
  assert.deepEqual(day.buses[0].trips.map((t) => [t.scheduled_start, t.scheduled_end, t.timing_status]), [['08:10', '08:30', 'Late by 10 min'], ['08:45', '09:05', 'On time']]);
  await assert.rejects(service.saveDailyReport({ report_date: '2026-10-22', bus_no: '02', driver_name: 'x', income_collected: 0, expenses: 0, trips: [leg('A', 'School', '08:10', '08:40', 107, 114)] }, [img('3')]), /already exists/);
  // change the expected drop-off: the past day follows
  await service.setTripTimes('R02', { expected_start: '08:10', expected_end: '08:45' });
  day = await service.getDailyReport('2026-10-22');
  assert.equal(day.buses[0].trips[0].timing_status, 'On time');
  assert.equal(day.buses[0].trips[0].scheduled_end, '08:45');
  // several trips: the route field cannot be used to change them
  await assert.rejects(service.updateBus('02', { route_name: 'Somewhere else' }), /several trips/);
  assert.equal((await service.updateBus('02', { route_name: 'Trip 1: A + Trip 2: B' })).changed, 0);
});

test('trip photos are optional: none at all, or only for some trips', async () => {
  const storage = memoryStorage({
    Buses: [{ bus_no: '02', driver_name: 'Driver B', active: true, status: 'On route' }],
    Routes: [{ route_id: 'R02', route_name: 'A' }, { route_id: 'R02-T2', route_name: 'B' }],
    'Route assignments': [{ bus_no: '02', route_id: 'R02', from_date: '2026-06-01' }, { bus_no: '02', route_id: 'R02-T2', from_date: '2026-06-01' }],
  });
  const service = createService(storage, { today: () => '2026-10-23', user: 'test' });
  const leg = (a, b) => ({ origin: 'A', destination: 'School', scheduled_start: '08:00', actual_start: '08:00', scheduled_end: '09:00', actual_end: '09:00', planned_km: 7, start_odometer_km: a, end_odometer_km: b });
  const base = { bus_no: '02', driver_name: 'Driver B', income_collected: 0, expenses: 0, trips: [leg(100, 107), leg(107, 114)] };
  await service.saveDailyReport({ ...base, report_date: '2026-10-21' }, []);
  await service.saveDailyReport({ ...base, report_date: '2026-10-22', photo_for: [1] }, [{ originalname: 'b.jpg', mimetype: 'image/jpeg', buffer: Buffer.from('b') }]);
  const none = (await service.getDailyReport('2026-10-21')).buses[0].trips;
  assert.deepEqual(none.map((t) => t.photo_url), ['', '']);
  const some = (await service.getDailyReport('2026-10-22')).buses[0].trips;
  assert.equal(some[0].photo_url, '');
  assert.ok(some[1].photo_url);
  await assert.rejects(service.saveDailyReport({ ...base, report_date: '2026-10-20', photo_for: [5] }, [{ originalname: 'b.jpg', mimetype: 'image/jpeg', buffer: Buffer.from('b') }]), /do not match/);
});
