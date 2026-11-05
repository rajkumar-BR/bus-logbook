import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../src/service.js';

function memoryStorage(initial = {}) {
  const tables = Object.fromEntries([
    'Buses', 'Routes', 'Route assignments', 'Daily reports', 'Trips', 'Entries', 'Parts changed',
    'Workshops', 'Lists', 'Settings', 'Bus documents', 'Change log', 'Tyres', 'Tyre fitments', 'Tyre retreads', 'Trip settings',
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

test('daily report rejects overlapping odometer readings between legs', async () => {
  const storage = memoryStorage({ Buses: [{ bus_no: '01', active: true }] });
  const service = createService(storage, { today: () => '2026-10-23', user: 'test' });
  const trips = [1, 2, 3].map((trip_number) => ({
    origin: `Stop ${trip_number}`,
    destination: `Stop ${trip_number + 1}`,
    scheduled_start: '07:00', actual_start: '07:00', scheduled_end: '08:00', actual_end: '08:00',
    planned_km: 10, start_odometer_km: trip_number === 2 ? 50 : (trip_number - 1) * 100,
    end_odometer_km: trip_number * 100,
  }));
  const photos = trips.map((_, index) => ({ originalname: `trip-${index}.jpg`, mimetype: 'image/jpeg', buffer: Buffer.from('image') }));
  await assert.rejects(service.saveDailyReport({
    report_date: '2026-10-23', bus_no: '01', driver_name: 'Driver', income_collected: 0, expenses: 0, trips,
  }, photos), /odometer readings of Trip 2 morning overlap Trip 1 morning/);
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

test('a saved trip can be corrected and lateness follows', async () => {
  const storage = memoryStorage({
    Buses: [{ bus_no: '01', driver_name: 'A', active: true, status: 'On route' }],
    Routes: [{ route_id: 'R01', route_name: 'A', expected_start: '07:40', expected_end: '09:00' }],
    'Route assignments': [{ bus_no: '01', route_id: 'R01', from_date: '2026-06-01' }],
    'Daily reports': [{ report_id: 'D1', report_date: '2026-10-22', bus_no: '01', income_collected: 0, expenses: 0 }],
    Trips: [{ trip_id: 'D1-T1', report_id: 'D1', trip_date: '2026-10-22', bus_no: '01', trip_number: 1, origin: 'A', destination: 'School', scheduled_start: '07:40', actual_start: '07:40', scheduled_end: '09:00', actual_end: '09:00', planned_km: 29, start_odometer_km: 100, end_odometer_km: 129, actual_km: 29, extra_km: 0, late_by_minutes: 0, on_time: true }],
  });
  const service = createService(storage, { today: () => '2026-10-23', user: 'test' });
  await assert.rejects(service.updateTrip('D1-T1', { actual_start: '7:40', actual_end: '09:10' }), /hours and minutes/);
  assert.equal((await service.updateTrip('D1-T1', { actual_start: '07:40', actual_end: '09:15', start_odometer_km: 100, end_odometer_km: 131 })).changed, 2);
  const t = (await service.getDailyReport('2026-10-22')).buses[0].trips[0];
  assert.equal(t.timing_status, 'Late by 15 min');
  assert.equal(t.extra_km, 2);
  assert.equal((await service.updateTrip('D1-T1', { actual_start: '07:40', actual_end: '09:15' })).changed, 0);
  await assert.rejects(service.updateTrip('nope', {}), /no such trip/);
});

test('daily report can be filtered by status, late trips and extra km', async () => {
  const trip = (id, bus, start, end, km) => ({ trip_id: id, report_id: `D-${bus}`, trip_date: '2026-10-22', bus_no: bus, trip_number: 1, origin: 'A', destination: 'School', scheduled_start: '08:00', actual_start: start, scheduled_end: '09:00', actual_end: end, planned_km: 10, start_odometer_km: 100, end_odometer_km: 100 + km, actual_km: km, extra_km: km - 10, late_by_minutes: 0, on_time: true });
  const storage = memoryStorage({
    Buses: ['01', '02', '03'].map((bus_no) => ({ bus_no, driver_name: 'D', active: true, status: 'On route' })),
    'Daily reports': ['01', '02'].map((bus_no) => ({ report_id: `D-${bus_no}`, report_date: '2026-10-22', bus_no, income_collected: 0, expenses: 0 })),
    Trips: [trip('T1', '01', '08:00', '09:00', 10), trip('T2', '02', '08:10', '09:20', 13)],
  });
  const service = createService(storage, { today: () => '2026-10-23', user: 'test' });
  const nos = async (f) => (await service.getDailyReport('2026-10-22', '2026-10-22', '', f)).buses.map((b) => b.bus_no);
  assert.deepEqual(await nos({}), ['01', '02', '03']);
  assert.deepEqual(await nos({ status: 'Late' }), ['02']);
  assert.deepEqual(await nos({ status: 'Not reported' }), ['03']);
  assert.deepEqual(await nos({ late: 'with' }), ['02']);
  assert.deepEqual(await nos({ late: 'none' }), ['01', '03']);
  assert.deepEqual(await nos({ extra: 'over' }), ['02']);
  assert.deepEqual(await nos({ status: 'Late', extra: 'within' }), []);
  assert.equal((await service.getDailyReport('2026-10-22', '2026-10-22', '', { late: 'with' })).summary.total_bus_days, 1);
});

test('tyres stay on their bus; retreads come back to stock and can go to any bus', async () => {
  const trip = (id, bus, date, n, km) => ({ trip_id: id, report_id: `D-${bus}-${date}`, trip_date: date, bus_no: bus, trip_number: n, actual_km: km, extra_km: 0, on_time: true, scheduled_start: '08:00', actual_start: '08:00', scheduled_end: '09:00', actual_end: '09:00', planned_km: km, start_odometer_km: 0, end_odometer_km: km });
  const storage = memoryStorage({
    Buses: [{ bus_no: '01', active: true }, { bus_no: '02', active: true }],
    Routes: [{ route_id: 'R01', route_name: 'Kurur' }, { route_id: 'R02', route_name: 'Perahambi' }],
    'Route assignments': [{ bus_no: '01', route_id: 'R01', from_date: '2026-06-01' }, { bus_no: '02', route_id: 'R02', from_date: '2026-06-01' }],
    Trips: [trip('a', '01', '2026-10-05', 1, 30), trip('b', '01', '2026-10-12', 1, 30), trip('c', '02', '2026-10-20', 1, 20), trip('d', '01', '2026-10-21', 1, 15)],
    Tyres: [{ tyre_no: 'A', status: 'In stock' }, { tyre_no: 'B', status: 'In stock' }, { tyre_no: 'C', status: 'In stock' }],
    'Tyre fitments': [
      { fitment_id: 'F1', tyre_no: 'A', bus_no: '02', position: 'Back right outer', fitted_date: '2026-10-01', fitted_km: 1000 },
      { fitment_id: 'F2', tyre_no: 'B', bus_no: '01', position: 'Back left outer', fitted_date: '2026-10-01', fitted_km: 5000 },
    ],
  });
  const service = createService(storage, { today: () => '2026-10-23', user: 'test' });
  const move = (date, odometers, moves) => service.moveTyres({ date, odometers, moves });
  // a tyre on a bus cannot be lent to another bus, or put in stock
  await assert.rejects(move('2026-10-13', { '01': 5100, '02': 1200 }, [{ tyre_no: 'B', to: 'bus', bus_no: '02', position: 'Front left' }]), /belongs to Bus 01/);
  await assert.rejects(move('2026-10-13', { '01': 5100 }, [{ tyre_no: 'B', to: 'In stock' }]), /belongs to Bus 01/);
  // a new tyre cannot take a place that is still occupied
  await assert.rejects(move('2026-10-13', { '01': 5100 }, [{ tyre_no: 'C', to: 'bus', bus_no: '01', position: 'Back left outer' }]), /already has tyre B/);
  await assert.rejects(move('2026-10-13', { '01': 4000 }, [{ tyre_no: 'B', to: 'At retreader' }]), /cannot be less than 5,000/);
  // B goes to the retreader and stock tyre C replaces it on bus 1
  await move('2026-10-13', { '01': 5100 }, [{ tyre_no: 'B', to: 'At retreader' }, { tyre_no: 'C', to: 'bus', bus_no: '01', position: 'Back left outer' }]);
  await assert.rejects(move('2026-10-14', { '02': 1300 }, [{ tyre_no: 'B', to: 'bus', bus_no: '02', position: 'Front left' }]), /at the retreader/);
  await assert.rejects(service.returnRetread({ tyre_no: 'A', date: '2026-10-18' }), /not at the retreader/);
  await assert.rejects(service.returnRetread({ tyre_no: 'B', date: '2026-10-12' }), /cannot be earlier/);
  const back = await service.returnRetread({ tyre_no: 'B', date: '2026-10-18', company: 'Green Retreads', cost: 4500 });
  assert.deepEqual(back, { tyre_no: 'B', bus_no: '01', expense_saved: true });
  // the cost is an expense of bus 1 on the return date
  const rep = await service.getDailyReport('2026-10-18', '2026-10-18', '01');
  assert.equal(rep.summary.expenses, 4500);
  // the retreaded tyre B now goes on bus 2, the other bus
  await move('2026-10-19', { '02': 1500 }, [{ tyre_no: 'B', to: 'bus', bus_no: '02', position: 'Front left' }]);
  // tyre A, on bus 2, is sent for a puncture repair and must come back to bus 2
  await move('2026-10-20', { '02': 1600 }, [{ tyre_no: 'A', to: 'In repair' }]);
  await assert.rejects(move('2026-10-21', { '01': 5200 }, [{ tyre_no: 'A', to: 'bus', bus_no: '01', position: 'Front left' }]), /must go back to that bus/);
  const { tyres } = await service.getTyres();
  const by = Object.fromEntries(tyres.map((x) => [x.tyre_no, x]));
  assert.equal(by.B.status, 'Fitted');
  assert.equal(by.B.bus_no, '02');
  assert.equal(by.B.condition, 'Retreaded');
  assert.equal(by.B.retread_count, 1);
  assert.deepEqual(by.B.retreads, [{ returned_date: '2026-10-18', company: 'Green Retreads', cost: 4500, bus_no: '01' }]);
  assert.deepEqual(by.B.lives.map((l) => [l.label, l.km]), [['Original', 100], ['Retread 1', 20]]); // 100 km by odometer on bus 1, then 20 logged km on bus 2
  assert.deepEqual(by.B.by_route, [{ route: 'Kurur', km: 60 }, { route: 'Perahambi', km: 20 }]);
  assert.equal(by.A.status, 'In repair');
  assert.equal(by.C.bus_no, '01');
  assert.equal(by.C.total_km, 15);
});

test('new tyres are added as spares or fitted straight onto a bus', async () => {
  const service = createService(memoryStorage({ Buses: [{ bus_no: '01', active: true }] }), { today: () => '2026-10-23', user: 'test' });
  await assert.rejects(service.addTyres({ tyre_nos: '' }), /at least one/);
  await assert.rejects(service.addTyres({ fitted: { bus_no: '01', date: '2026-10-20', odometer: '', positions: { 'Front left': 'X1' } } }), /odometer/);
  const r = await service.addTyres({ tyre_nos: 'S1\nS2', condition: 'New', fitted: { bus_no: '01', date: '2026-10-20', odometer: 5000, positions: { 'Front left': 'X1', 'Front right': 'X2' } } });
  assert.deepEqual(r, { added: 4, fitted: 2, spares: 2 });
  await assert.rejects(service.addTyres({ fitted: { bus_no: '01', date: '2026-10-20', odometer: 5000, positions: { 'Front left': 'X9' } } }), /already has a tyre/);
  await assert.rejects(service.addTyres({ tyre_nos: 'S1' }), /Already in the tyre list/);
  const by = Object.fromEntries((await service.getTyres()).tyres.map((x) => [x.tyre_no, x]));
  assert.equal(by.X1.status, 'Fitted');
  assert.equal(by.X1.position, 'Front left');
  assert.equal(by.S1.status, 'In stock');
});

test('a trip has a morning and an evening leg with their own expected times', async () => {
  const leg = (trip_number, session, o, d, s, e, a, b) => ({ trip_number, session, origin: o, destination: d, planned_km: 20, start_odometer_km: s, end_odometer_km: e, scheduled_start: '00:00', scheduled_end: '23:59', actual_start: a, actual_end: b });
  const storage = memoryStorage({
    Buses: [{ bus_no: '01', active: true }],
    Routes: [{ route_id: 'R01', route_name: 'Kurur', expected_start: '07:00', expected_end: '08:00' }],
    'Route assignments': [{ bus_no: '01', route_id: 'R01', from_date: '2026-06-01' }],
  });
  const service = createService(storage, { today: () => '2026-10-23', user: 'test' });
  await service.setTripTimes('R01', { expected_start: '07:00', expected_end: '08:00', expected_evening_start: '15:30', expected_evening_end: '16:30' });
  await assert.rejects(service.saveDailyReport({ report_date: '2026-10-23', bus_no: '01', driver_name: 'D', income_collected: 0, expenses: 0, trips: [leg(1, 'Morning', 'A', 'School', 0, 20, '07:00', '08:00'), leg(1, 'Morning', 'A', 'School', 20, 40, '07:00', '08:00')] }), /entered twice/);
  const saved = await service.saveDailyReport({ report_date: '2026-10-23', bus_no: '01', driver_name: 'D', income_collected: 0, expenses: 0, trips: [leg(1, 'Morning', 'Kurur', 'School', 100, 120, '07:00', '08:00'), leg(1, 'Evening', 'School', 'Kurur', 120, 140, '15:30', '16:50')] });
  assert.equal(saved.trip_ids.length, 2);
  const row = (await service.getDailyReport('2026-10-23', '2026-10-23')).buses[0];
  assert.equal(row.trip_count, 1); // one trip, two legs
  assert.equal(row.trips_expected, 1);
  assert.deepEqual(row.trips.map((t) => [t.session, t.scheduled_start, t.scheduled_end, t.on_time]), [['Morning', '07:00', '08:00', true], ['Evening', '15:30', '16:30', true]]);
  assert.equal(row.late_trips, 0); // the evening leg ran 20 minutes late but lateness is judged on the morning only
  assert.equal(row.status, 'On time');
  assert.equal(row.trips[1].timing_status, 'Lateness not checked');
});

test('planned km is set once per trip and applied to every day', async () => {
  const storage = memoryStorage({
    Buses: [{ bus_no: '01', active: true }],
    Routes: [{ route_id: 'R01', route_name: 'Kurur', expected_start: '07:00', expected_end: '08:00' }],
    'Route assignments': [{ bus_no: '01', route_id: 'R01', from_date: '2026-06-01' }],
  });
  const service = createService(storage, { today: () => '2026-10-23', user: 'test' });
  await assert.rejects(service.setTripTimes('R01', { planned_km: '-5' }), /more than zero/);
  await service.setTripTimes('R01', { expected_start: '07:00', expected_end: '08:00', planned_km: 20, planned_evening_km: 22 });
  const leg = (session, s, e) => ({ trip_number: 1, session, origin: 'A', destination: 'B', planned_km: 5, start_odometer_km: s, end_odometer_km: e, scheduled_start: '07:00', scheduled_end: '08:00', actual_start: '07:00', actual_end: '08:00' });
  await service.saveDailyReport({ report_date: '2026-10-23', bus_no: '01', driver_name: 'D', income_collected: 0, expenses: 0, trips: [leg('Morning', 100, 125), leg('Evening', 200, 222)] });
  const km = async () => (await service.getDailyReport('2026-10-23', '2026-10-23')).buses[0].trips.map((t) => [t.planned_km, t.extra_km]);
  assert.deepEqual(await km(), [[20, 5], [22, 0]]); // the typed 5 km is ignored
  await service.setTripTimes('R01', { planned_km: 25, planned_evening_km: 22 });
  assert.deepEqual(await km(), [[25, 0], [22, 0]]); // changing the setting changes every day
});

test('stops come from the trip setting, not from the daily form', async () => {
  const storage = memoryStorage({
    Buses: [{ bus_no: '01', active: true }],
    Routes: [{ route_id: 'R01', route_name: 'Kurur', notes: 'Starts 7.40 AM at Valaiyur, reaches school 9.00 AM', expected_start: '07:40', expected_end: '09:00', planned_km: 20, planned_evening_km: 20 }],
    'Route assignments': [{ bus_no: '01', route_id: 'R01', from_date: '2026-06-01' }],
  });
  const service = createService(storage, { today: () => '2026-10-23', user: 'test' });
  const leg = (session, s, e) => ({ trip_number: 1, session, origin: 'typed', destination: 'typed', planned_km: 1, start_odometer_km: s, end_odometer_km: e, scheduled_start: '07:40', scheduled_end: '09:00', actual_start: '07:40', actual_end: '09:00' });
  await service.saveDailyReport({ report_date: '2026-10-23', bus_no: '01', driver_name: 'D', income_collected: 0, expenses: 0, trips: [leg('Morning', 10, 30), leg('Evening', 50, 70)] });
  const stops = async () => (await service.getDailyReport('2026-10-23', '2026-10-23')).buses[0].trips.map((t) => `${t.origin} > ${t.destination}`);
  assert.deepEqual(await stops(), ['Valaiyur > School', 'School > Valaiyur']); // first stop read from the route notes
  await service.setTripTimes('R01', { start_stop: 'Valaiyur', end_stop: 'Kannapadi' });
  assert.deepEqual(await stops(), ['Valaiyur > School', 'School > Kannapadi']); // changes every day
});

test('a change to a trip applies from its start date; earlier days keep the old stops, times and planned km', async () => {
  const storage = memoryStorage({
    Buses: [{ bus_no: '01', active: true }],
    Routes: [{ route_id: 'R01', route_name: 'Kurur', start_stop: 'Valaiyur', expected_start: '07:00', expected_end: '08:00', planned_km: 20 }],
    'Route assignments': [{ bus_no: '01', route_id: 'R01', from_date: '2026-06-01' }],
  });
  const service = createService(storage, { today: () => '2026-10-23', user: 'test' });
  const day = (date, o) => ({ report_date: date, bus_no: '01', driver_name: 'D', income_collected: 0, expenses: 0, trips: [{ trip_number: 1, session: 'Morning', origin: '', destination: '', planned_km: 1, start_odometer_km: o, end_odometer_km: o + 30, scheduled_start: '07:00', scheduled_end: '08:00', actual_start: '07:00', actual_end: '08:00' }] });
  await service.saveDailyReport(day('2026-10-10', 100));
  await assert.rejects(service.setTripTimes('R01', { effective_from: '15/10', start_stop: 'X' }), /valid date/);
  const r = await service.setTripTimes('R01', { effective_from: '2026-10-15', start_stop: 'Pudhur', expected_start: '07:30', expected_end: '08:30', planned_km: 30 });
  assert.equal(r.effective_from, '2026-10-15');
  await service.saveDailyReport(day('2026-10-20', 200));
  const t = async (date) => { const x = (await service.getDailyReport(date, date)).buses[0].trips[0]; return [x.origin, x.scheduled_start, x.planned_km, x.extra_km]; };
  assert.deepEqual(await t('2026-10-10'), ['Valaiyur', '07:00', 20, 10]);
  assert.deepEqual(await t('2026-10-20'), ['Pudhur', '07:30', 30, 0]);
  assert.deepEqual((await service.getTripPlans('01', '2026-10-12')).plans[0].start_stop, 'Valaiyur');
  assert.deepEqual((await service.getTripPlans('01', '2026-10-15')).plans[0].start_stop, 'Pudhur');
  // editing the same date again replaces that change; "all days" changes the base
  await service.setTripTimes('R01', { effective_from: '2026-10-15', start_stop: 'Pudhur', expected_start: '07:30', expected_end: '08:30', planned_km: 28 });
  assert.equal((await service.getTripPlans('01', '2026-10-16')).plans[0].planned_km, 28);
  assert.equal(storage.tables['Trip settings'].length, 1);
  await service.setTripTimes('R01', { all_days: true, planned_km: 21 });
  assert.equal((await service.getTripPlans('01', '2026-10-12')).plans[0].planned_km, 21);
  assert.equal((await service.getTripPlans('01', '2026-10-16')).plans[0].planned_km, 28);
});

test('Sundays are not listed, and the evening planned km follows the morning one when not set', async () => {
  const storage = memoryStorage({
    Buses: [{ bus_no: '01', active: true }],
    Routes: [{ route_id: 'R01', route_name: 'Kurur', start_stop: 'Valaiyur', planned_km: 20 }],
    'Route assignments': [{ bus_no: '01', route_id: 'R01', from_date: '2026-06-01' }],
  });
  const service = createService(storage, { today: () => '2026-10-23', user: 'test' });
  // 2026-10-18 is a Sunday
  const rows = (await service.getDailyReport('2026-10-17', '2026-10-19')).buses.map((r) => r.report_date);
  assert.deepEqual(rows, ['2026-10-17', '2026-10-19']);
  assert.equal((await service.getTripPlans('01', '2026-10-19')).plans.length, 1);
  await service.saveDailyReport({ report_date: '2026-10-18', bus_no: '01', driver_name: 'D', income_collected: 0, expenses: 0, trips: [{ trip_number: 1, session: 'Evening', origin: '', destination: '', planned_km: 1, start_odometer_km: 10, end_odometer_km: 40, scheduled_start: '15:00', scheduled_end: '16:00', actual_start: '15:00', actual_end: '16:00' }] });
  const sunday = (await service.getDailyReport('2026-10-17', '2026-10-19')).buses.map((r) => r.report_date);
  assert.deepEqual(sunday, ['2026-10-17', '2026-10-18', '2026-10-19']); // a Sunday with a report is shown
  const eve = (await service.getDailyReport('2026-10-18', '2026-10-18')).buses[0].trips[0];
  assert.equal(eve.planned_km, 20); // no evening km set: same as the morning
  assert.equal(eve.extra_km, 10);
});

test('on Saturdays a two-trip bus runs one combined trip with its own stops, times and planned km', async () => {
  const storage = memoryStorage({
    Buses: [{ bus_no: '02', active: true }, { bus_no: '01', active: true }],
    Routes: [
      { route_id: 'R02', route_name: 'Kurur', start_stop: 'Nakkaselam', expected_start: '08:10', expected_end: '08:30', planned_km: 7 },
      { route_id: 'R02-T2', route_name: 'Perahambi', start_stop: 'Perahambi', expected_start: '08:45', expected_end: '09:05', planned_km: 14 },
      { route_id: 'R01', route_name: 'Valaiyur', start_stop: 'Valaiyur', expected_start: '07:40', expected_end: '09:00', planned_km: 29 },
    ],
    'Route assignments': [{ bus_no: '02', route_id: 'R02', from_date: '2026-06-01' }, { bus_no: '02', route_id: 'R02-T2', from_date: '2026-06-01' }, { bus_no: '01', route_id: 'R01', from_date: '2026-06-01' }],
  });
  const service = createService(storage, { today: () => '2026-10-30', user: 'test' });
  const plans = async (bus, date) => (await service.getTripPlans(bus, date)).plans;
  assert.equal((await plans('02', '2026-10-24')).length, 2); // Saturday plan not set yet: normal trips
  await service.setTripTimes('R02', { day_type: 'Saturday', start_stop: 'Nakkaselam', end_stop: 'Perahambi', expected_start: '07:50', expected_end: '09:00', expected_evening_start: '12:30', expected_evening_end: '13:40', planned_km: 25 });
  const sat = await plans('02', '2026-10-24');
  assert.equal(sat.length, 1);
  assert.deepEqual([sat[0].start_stop, sat[0].expected_start, sat[0].planned_km], ['Nakkaselam', '07:50', 25]);
  assert.equal((await plans('02', '2026-10-23')).length, 2); // Friday: two trips
  assert.equal((await plans('01', '2026-10-24')).length, 1); // one-trip buses are not affected
  const row = (await service.getDailyReport('2026-10-24', '2026-10-24', '02')).buses[0];
  assert.equal(row.trips_expected, 1);
  const leg = (session, s, e) => ({ trip_number: 1, session, origin: '', destination: '', planned_km: 1, start_odometer_km: s, end_odometer_km: e, scheduled_start: '07:00', scheduled_end: '08:00', actual_start: '07:50', actual_end: '09:00' });
  await service.saveDailyReport({ report_date: '2026-10-24', bus_no: '02', driver_name: 'D', income_collected: 0, expenses: 0, trips: [leg('Morning', 10, 35), leg('Evening', 40, 66)] });
  const saved = (await service.getDailyReport('2026-10-24', '2026-10-24', '02')).buses[0];
  assert.deepEqual(saved.trips.map((t) => [t.origin, t.destination, t.planned_km, t.extra_km]), [['Nakkaselam', 'School', 25, 0], ['School', 'Perahambi', 25, 1]]);
  assert.equal(saved.trip_count, 1);
  // a change from a date: later Saturdays use the new plan, earlier ones the old
  await service.setTripTimes('R02', { day_type: 'Saturday', effective_from: '2026-10-31', planned_km: 30 });
  assert.equal((await plans('02', '2026-10-24'))[0].planned_km, 25);
  assert.equal((await plans('02', '2026-10-31'))[0].planned_km, 30);
  assert.equal((await plans('02', '2026-10-31'))[0].expected_start, '07:50'); // fields not sent keep what was in force
  assert.equal((await service.getBus('02')).bus.trip_plans.length, 2); // Edit bus still shows the two weekday trips
});
