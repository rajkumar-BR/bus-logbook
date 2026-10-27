import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/logic.js';

const E = (o) => ({ record_status: 'Active', entered_at: '', ...o });

test('recordsForSchool filters by school_id while preserving legacy rows without school_id', () => {
  const rows = [
    E({ school_id: 'school-a', bus_no: '04', entry_id: '1' }),
    E({ school_id: 'school-b', bus_no: '05', entry_id: '2' }),
    E({ bus_no: '06', entry_id: '3' }),
  ];
  assert.deepEqual(L.recordsForSchool(rows, 'school-a').map((r) => r.entry_id), ['1', '3']);
  assert.deepEqual(L.recordsForSchool(rows, 'school-c').map((r) => r.entry_id), ['3']);
  assert.deepEqual(L.recordsForSchool(rows).map((r) => r.entry_id), ['1', '2', '3']);
});

test('cost periods split at scheduled services and exclude the service cost', () => {
  const entries = [
    E({ entry_id: 'a', kind: 'Repair', date_in: '2026-01-10', total_cost: 500 }),
    E({ entry_id: 's1', kind: 'Scheduled service', date_in: '2026-02-01', total_cost: 9000 }),
    E({ entry_id: 'b', kind: 'Repair', date_in: '2026-03-01', total_cost: 1000 }),
    E({ entry_id: 'c', kind: 'Inspection', date_in: '2026-04-01', total_cost: 1500 }),
    E({ entry_id: 's2', kind: 'Scheduled service', date_in: '2026-07-01', total_cost: 9000 }),
    E({ entry_id: 'd', kind: 'Breakdown', date_in: '2026-09-01', total_cost: 2000 }),
  ];
  const p = L.costPeriods(entries);
  assert.equal(p.length, 3);
  assert.deepEqual(p.map((x) => x.total), [500, 2500, 2000]);
  assert.equal(p[0].start, null);
  assert.equal(p[2].end, null);
  assert.equal(L.spentSinceLastService(entries).total, 2000);
});

test('spent since last service is 0 right after a service', () => {
  const entries = [E({ entry_id: 's', kind: 'Scheduled service', date_in: '2026-05-01', total_cost: 9000 })];
  assert.equal(L.spentSinceLastService(entries).total, 0);
});

test('service status uses whichever limit (km or days) is closer', () => {
  const bus = { service_every_km: 10000, service_every_days: 90 };
  const entries = [
    E({ kind: 'Scheduled service', date_in: '2026-09-01', odometer_km: 100000 }),
    E({ kind: 'Repair', date_in: '2026-09-20', odometer_km: 109000 }),
  ];
  const s = L.serviceStatus(bus, entries, {}, '2026-09-21');
  assert.equal(s.state, 'due'); // 9,000 of 10,000 km
  assert.equal(s.kmLeft, 1000);
  const late = L.serviceStatus(bus, entries, {}, '2026-12-15');
  assert.equal(late.state, 'overdue'); // over 90 days
  assert.equal(L.serviceStatus(bus, [], {}, '2026-09-21').state, 'unknown');
});

test('repeat check needs 2 earlier repairs on the same bus and system within the window', () => {
  const entries = [
    E({ entry_id: '1', bus_no: '04', kind: 'Repair', system: 'Brakes', date_in: '2026-04-15' }),
    E({ entry_id: '2', bus_no: '04', kind: 'Repair', system: 'Brakes', date_in: '2026-09-07' }),
    E({ entry_id: '3', bus_no: '05', kind: 'Repair', system: 'Brakes', date_in: '2026-09-07' }),
    E({ entry_id: '4', bus_no: '04', kind: 'Scheduled service', system: 'Brakes', date_in: '2026-08-01' }),
  ];
  assert.equal(L.repeatCheck(entries, { bus_no: '04', system: 'Brakes', date_in: '2026-10-18' }, 200).isRepeat, true);
  assert.equal(L.repeatCheck(entries, { bus_no: '04', system: 'Brakes', date_in: '2026-10-18' }, 100).isRepeat, false);
  assert.equal(L.repeatCheck(entries, { bus_no: '04', system: 'Brakes', date_in: '2026-10-18', exclude_entry_id: '2' }, 200).isRepeat, false);
});

test('findings flag repeated, shrinking and refitted parts', () => {
  const entries = [
    E({ entry_id: 'a', bus_no: '04', kind: 'Repair', system: 'Brakes', date_in: '2026-01-19', odometer_km: 110180, route_at_time: 'R04', root_cause: 'Worn.' }),
    E({ entry_id: 'b', bus_no: '04', kind: 'Repair', system: 'Brakes', date_in: '2026-04-15', odometer_km: 114280, route_at_time: 'R04', root_cause: 'Worn.' }),
    E({ entry_id: 'c', bus_no: '04', kind: 'Repair', system: 'Brakes', date_in: '2026-09-07', odometer_km: 116980, route_at_time: 'R04', root_cause: 'Pads glazed from overheating.' }),
  ];
  const parts = entries.map((e) => ({ entry_id: e.entry_id, bus_no: '04', part_name: 'Front brake pads', position: 'Front axle', removed_part_no: 'BP-1', fitted_part_no: 'BP-1', record_status: 'Active' }));
  const f = L.findings({ bus: { bus_no: '04' }, busEntries: entries, busParts: parts, allEntries: entries, allParts: parts, activeBusCount: 10, routes: [{ route_id: 'R04', route_name: 'Hillside', notes: 'Steep descent' }], today: '2026-10-22' });
  const titles = f.findings.map((x) => x.title).join(' | ');
  assert.match(titles, /Brakes repaired 3 times/);
  assert.match(titles, /Runs Hillside all year/);
  assert.match(titles, /lasting less each time/);
  assert.match(titles, /same part was fitted 3 times/);
  assert.match(titles, /Root cause missing on 2/);
  assert.deepEqual(f.lifeChart.intervals.map((i) => i.km), [4100, 2700]);
  assert.equal(f.watch[0].system, 'Brakes');
});

test('trip metrics calculate extra kilometres and lateness against both schedule times', () => {
  const trip = {
    planned_km: 42,
    start_odometer_km: 1000,
    end_odometer_km: 1048,
    scheduled_start: '07:00',
    actual_start: '06:58',
    scheduled_end: '08:00',
    actual_end: '08:07',
  };
  assert.deepEqual(L.tripMetrics(trip), { actual_km: 48, extra_km: 6, late_by_minutes: 7, on_time: false });
  assert.deepEqual(L.tripMetrics({ ...trip, actual_start: '07:00', actual_end: '08:00', end_odometer_km: 1042 }), {
    actual_km: 42, extra_km: 0, late_by_minutes: 0, on_time: true,
  });
});
