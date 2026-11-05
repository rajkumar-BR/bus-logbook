// What the app can do. Each function reads from / writes to storage and applies
// the rules in logic.js. The HTTP layer (server.js) only translates requests.

import os from 'node:os';
import path from 'node:path';
import { KINDS, STATUS, DEFAULT_LISTS } from './schema.js';
import * as L from './logic.js';
import * as I from './importer.js';
import { UserError } from './ai.js';

export function localToday() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
}

function localNow() {
  const d = new Date();
  return `${d.toLocaleDateString('en-CA')} ${d.toTimeString().slice(0, 5)}`;
}

export function createService(storage, { readBill = null, today = localToday, user = process.env.OFFICE_USER || os.userInfo().username } = {}) {
  async function load() {
    const t = {};
    for (const tab of ['Buses', 'Routes', 'Route assignments', 'Daily reports', 'Trips', 'Entries', 'Parts changed', 'Workshops', 'Lists', 'Settings', 'Bus documents', 'Trip settings']) {
      t[tab] = await storage.read(tab);
    }
    const lists = { ...DEFAULT_LISTS, ...L.listsFrom(t.Lists) };
    return {
      buses: t.Buses.filter((b) => b.bus_no),
      routes: t.Routes,
      assignments: t['Route assignments'],
      dailyReports: t['Daily reports'].filter((report) => report.report_id && L.isActive(report)),
      trips: t.Trips.filter((trip) => trip.trip_id && L.isActive(trip)),
      entries: t.Entries.filter((e) => e.entry_id && L.isActive(e)),
      voided: t.Entries.filter((e) => e.entry_id && e.record_status === 'Voided'),
      parts: t['Parts changed'].filter(L.isActive),
      workshops: t.Workshops.map((w) => w.workshop_name).filter(Boolean),
      docs: t['Bus documents'],
      tripSettings: t['Trip settings'],
      lists,
      settings: L.settingsMap(t.Settings),
    };
  }

  // Written by "Retread came back" so the cost shows in the bus's history and spending. Not a kind that can be chosen on the bill form.
  const TYRE_RETREAD = 'Tyre retread';
  const activeBuses = (d) => d.buses.filter((b) => b.active !== false); // blank counts as active
  const routeName = (d, id) => (d.routes.find((r) => r.route_id === id) || {}).route_name || id || '';
  // A bus can run several trips to different places: show every route it is on today.
  const currentRoute = (d, busNo) => {
    const t = today();
    return d.assignments
      .filter((a) => a.bus_no === busNo && a.from_date && a.from_date <= t && (!a.to_date || a.to_date >= t))
      .map((a) => routeName(d, a.route_id)).join(' + ');
  };
  const busLabel = (d, b) => `Bus ${b.bus_no}${currentRoute(d, b.bus_no) ? ` · ${currentRoute(d, b.bus_no)}` : ''}`;

  function entryTitle(e, parts) {
    if (e.kind === KINDS.SERVICE) return 'Scheduled service';
    if (e.kind === KINDS.INSPECTION) return 'Inspection';
    if (e.kind === TYRE_RETREAD) return 'Tyre retread';
    if (parts.length) return parts.map((p) => p.part_name).slice(0, 3).join(', ');
    return e.system || e.kind;
  }

  // One trip is a run that ends at the school; a bus that goes out again after reaching it has another route and so another trip.
  const tripsPerDay = (d, busNo) => {
    const t = today();
    return Math.max(1, d.assignments.filter((a) => a.bus_no === busNo && a.from_date && a.from_date <= t && (!a.to_date || a.to_date >= t)).length);
  };

  // The trips a bus runs today, in order, with the expected pick-up and drop-off time set on each trip's route.
  // The settings in force on a date: the latest dated change on or before it, else the trip's base settings.
  // Until a planned km is set for a trip, the distance written in its route details ("... · 29 km · ...") is used.
  const kmFromNotes = (route) => Number(String(route?.notes || '').match(/(\d+(?:\.\d+)?) km/i)?.[1]) || '';
  const weekdayPlans = (d, busNo, date) => {
    const t = date;
    return d.assignments
      .filter((a) => a.bus_no === busNo && a.from_date && a.from_date <= t && (!a.to_date || a.to_date >= t))
      .map((a, i) => {
        const base = d.routes.find((x) => x.route_id === a.route_id) || {};
        const history = (d.tripSettings || []).filter((x) => x.route_id === a.route_id && x.effective_from && !x.day_type).sort((x, y) => String(x.effective_from).localeCompare(String(y.effective_from)));
        const r = { ...base, ...([...history].reverse().find((x) => x.effective_from <= t) || {}), route_name: base.route_name, notes: base.notes };
        // first stop: the one set for the trip, else read from the route's notes ("Starts 7.40 AM at X, ..." or "Trip 1: X 7.40 AM ...")
        const first = String(r.start_stop || '').trim()
          || (String(r.notes || '').match(/Starts [\d.: ]*(?:AM|PM)? ?at (.+?), reaches school/i)?.[1]
          || String(r.notes || '').match(/^Trip \d+: (.+?) \d+\.\d+ ?[AP]M/i)?.[1] || '').trim();
        return { trip_number: i + 1, route_id: a.route_id, start_stop: first, end_stop: String(r.end_stop || '').trim() || first, route_name: r.route_name || a.route_id, expected_start: r.expected_start || '', expected_end: r.expected_end || '', expected_evening_start: r.expected_evening_start || '', expected_evening_end: r.expected_evening_end || '', planned_km: hasKm(r.planned_km) ? r.planned_km : kmFromNotes(base), planned_evening_km: r.planned_evening_km ?? '',
          history: history.map((x) => ({ effective_from: x.effective_from, start_stop: x.start_stop || '', end_stop: x.end_stop || '', expected_start: x.expected_start || '', expected_end: x.expected_end || '', expected_evening_start: x.expected_evening_start || '', expected_evening_end: x.expected_evening_end || '', planned_km: x.planned_km ?? '', planned_evening_km: x.planned_evening_km ?? '' })) };
      });
  };
  // First stop of a route when none is set: read from its notes ("Starts 7.40 AM at X, ..." or "Trip 1: X 7.40 AM ...").
  const firstStopOf = (route) => String(route?.notes || '').match(/Starts [\d.: ]*(?:AM|PM)? ?at (.+?), reaches school/i)?.[1] || String(route?.notes || '').match(/^Trip \d+: (.+?) \d+\.\d+ ?[AP]M/i)?.[1] || '';
  // On Saturdays a bus that runs two or more trips runs one combined trip instead (same first stop, straight to school), with its own times and planned km.
  // The Saturday plan is kept on the bus's first trip with day_type 'Saturday'.
  const saturdayPlan = (d, busNo, date) => {
    const list = d.assignments.filter((a) => a.bus_no === busNo && a.from_date && a.from_date <= date && (!a.to_date || a.to_date >= date));
    if (list.length < 2) return null;
    const route = d.routes.find((x) => x.route_id === list[0].route_id) || {};
    const history = (d.tripSettings || []).filter((x) => x.route_id === list[0].route_id && x.day_type === 'Saturday' && x.effective_from).sort((x, y) => String(x.effective_from).localeCompare(String(y.effective_from)));
    const r = [...history].reverse().find((x) => x.effective_from <= date);
    const first = String(r?.start_stop || '').trim() || firstStopOf(route).trim();
    return {
      trip_number: 1, route_id: list[0].route_id, set: Boolean(r), route_name: `${route.route_name || list[0].route_id} (Saturday, combined)`,
      start_stop: first, end_stop: String(r?.end_stop || '').trim() || first,
      expected_start: r?.expected_start || '', expected_end: r?.expected_end || '', expected_evening_start: r?.expected_evening_start || '', expected_evening_end: r?.expected_evening_end || '',
      planned_km: r?.planned_km ?? '', planned_evening_km: r?.planned_evening_km ?? '',
      history: history.map((x) => ({ effective_from: x.effective_from, start_stop: x.start_stop || '', end_stop: x.end_stop || '', expected_start: x.expected_start || '', expected_end: x.expected_end || '', expected_evening_start: x.expected_evening_start || '', expected_evening_end: x.expected_evening_end || '', planned_km: x.planned_km ?? '', planned_evening_km: x.planned_evening_km ?? '' })),
    };
  };
  const tripPlans = (d, busNo, date = today()) => {
    if (new Date(`${date}T00:00:00`).getDay() === 6) {
      const sat = saturdayPlan(d, busNo, date);
      if (sat && sat.set) return [sat];
    }
    return weekdayPlans(d, busNo, date);
  };
  // A trip has a morning leg (first stop to school) and an evening leg (school to the drop-offs). Older records have no session and are morning legs.
  const hasKm = (v) => v !== '' && v != null && Number(v) > 0;
  const SESSIONS = ['Morning', 'Evening'];
  const sessionOf = (t) => (t.session === 'Evening' ? 'Evening' : 'Morning');
  // Lateness is judged on the morning leg only. Extra km counts on both legs.
  const metricsFor = (trip) => (sessionOf(trip) === 'Evening' ? { ...L.tripMetrics(trip), on_time: true, late_by_minutes: 0 } : L.tripMetrics(trip));
  // Expected times and planned km are set once per trip (Edit bus → Trip times) and read for every day.
  // Morning runs from the first stop to the school; evening from the school to the last drop-off.
  const expectedFor = (plan, session) => (plan ? (session === 'Evening'
    ? { start: plan.expected_evening_start, end: plan.expected_evening_end, km: hasKm(plan.planned_evening_km) ? plan.planned_evening_km : plan.planned_km, origin: plan.end_stop ? 'School' : '', destination: plan.end_stop }
    : { start: plan.expected_start, end: plan.expected_end, km: plan.planned_km, origin: plan.start_stop, destination: plan.start_stop ? 'School' : '' }) : {});
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

  // ---------- reads

  async function getLists() {
    const d = await load();
    return {
      ...d.lists,
      workshops: d.workshops,
      buses: activeBuses(d).map((b) => ({ bus_no: b.bus_no, label: busLabel(d, b), trips: tripsPerDay(d, b.bus_no), plans: tripPlans(d, b.bus_no) })),
      aiEnabled: Boolean(readBill) && String(d.settings.ai_enabled ?? 'TRUE').toUpperCase() !== 'FALSE',
      today: today(),
    };
  }

  async function getFleet() {
    const d = await load();
    const t = today();
    const year = t.slice(0, 4);
    // a tyre change is a tyre taken off the bus for repair, retreading or scrap (moving it to another wheel is not one)
    const fitments = await storage.read('Tyre fitments');
    const tyreChanges = (busNo) => fitments.filter((f) => f.bus_no === busNo && f.removed_date && f.removed_to && f.removed_to !== 'Position changed').length;
    const rows = activeBuses(d).map((b) => {
      const be = d.entries.filter((e) => e.bus_no === b.bus_no);
      const svc = L.serviceStatus(b, be, d.settings, t);
      const spent = L.spentSinceLastService(be);
      const spentYear = be.filter((e) => e.date_in.startsWith(year)).reduce((sum, e) => sum + (Number(e.total_cost) || 0), 0);
      const f = L.findings({ bus: b, busEntries: be, busParts: d.parts.filter((p) => p.bus_no === b.bus_no), allEntries: d.entries, allParts: d.parts, activeBusCount: activeBuses(d).length, routes: d.routes, today: t });
      return {
        bus_no: b.bus_no,
        tyre_changes: tyreChanges(b.bus_no),
        route: currentRoute(d, b.bus_no),
        make_model: b.make_model,
        year: b.year,
        status: b.status || STATUS.ON_ROUTE,
        odometer: svc.odometer,
        last_service: svc.last ? svc.last.date_in : '',
        service: { state: svc.state, progress: svc.progress, kmLeft: svc.kmLeft ?? null, daysLeft: svc.daysLeft ?? null },
        spent_since_service: spent.total,
        spent_year: spentYear,
        repairs12: L.repairsInLastYear(be, t).length,
        watch: f.watch.map((w) => `${w.system} ×${w.count}`),
      };
    });
    return {
      today: t,
      summary: {
        onRoute: rows.filter((r) => r.status === STATUS.ON_ROUTE).length,
        inWorkshop: rows.filter((r) => r.status === STATUS.IN_WORKSHOP).length,
        dueSoon: rows.filter((r) => r.service.state === 'due' || r.service.state === 'overdue').length,
        repairs12: rows.reduce((a, r) => a + r.repairs12, 0),
        spendYear: d.entries.filter((e) => e.date_in.startsWith(year)).reduce((a, e) => a + (Number(e.total_cost) || 0), 0),
        year,
      },
      buses: rows,
    };
  }

  async function getBus(busNo) {
    const d = await load();
    const t = today();
    const b = d.buses.find((x) => x.bus_no === busNo);
    if (!b) throw new UserError(`There is no bus "${busNo}".`, 404);
    const be = d.entries.filter((e) => e.bus_no === busNo);
    const bp = d.parts.filter((p) => p.bus_no === busNo);
    const svc = L.serviceStatus(b, be, d.settings, t);
    const periods = L.costPeriods(be);
    const spent = L.spentSinceLastService(be);
    const f = L.findings({ bus: b, busEntries: be, busParts: bp, allEntries: d.entries, allParts: d.parts, activeBusCount: activeBuses(d).length, routes: d.routes, today: t });
    const docs = d.docs.filter((x) => x.bus_no === busNo);
    const docDate = (type) => (docs.filter((x) => x.doc_type === type).sort((a, z) => (a.valid_until < z.valid_until ? 1 : -1))[0] || {}).valid_until || '';

    const entries = [...be].sort(L.byDate).reverse().map((e) => {
      const parts = bp.filter((p) => p.entry_id === e.entry_id);
      const before = periods.find((p) => p.end && p.end.entry_id === e.entry_id);
      return {
        ...e,
        title: entryTitle(e, parts),
        route_name: routeName(d, e.route_at_time),
        parts,
        bill_url: storage.fileUrl(e.bill_link),
        photo_urls: String(e.photo_links || '').split(',').map((s) => s.trim()).filter(Boolean).map(storage.fileUrl),
        between: before ? { since: before.start ? before.start.date_in : null, total: before.total, jobs: before.jobs.length } : null,
      };
    });
    const tyreHistory = L.partHistory(bp.filter((part) => /tyre|tire/i.test(part.part_name)), Object.fromEntries(d.entries.map((entry) => [entry.entry_id, entry])))
      .flatMap((group) => group.items.map((item, index) => ({
        part_name: group.part_name,
        position: group.position,
        date: item.date_in,
        odometer_km: item.odometer_km || null,
        fitted_part_no: item.fitted_part_no,
        km_survived: group.items[index + 1] && item.odometer_km && group.items[index + 1].odometer_km
          ? group.items[index + 1].odometer_km - item.odometer_km
          : null,
        replaced_on: group.items[index + 1]?.date_in || '',
      })))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      today: t,
      bus: { ...b, status: b.status || STATUS.ON_ROUTE, route: currentRoute(d, busNo), trip_plans: weekdayPlans(d, busNo, today()), saturday_plan: saturdayPlan(d, busNo, today()) },
      facts: {
        odometer: svc.odometer,
        last_service: svc.last ? svc.last.date_in : '',
        service: { state: svc.state, kmLeft: svc.kmLeft ?? null, daysLeft: svc.daysLeft ?? null },
        spent_since_service: spent.total,
        spent_since_date: spent.since ? spent.since.date_in : null,
        spent_year: be.filter((e) => e.date_in.startsWith(t.slice(0, 4))).reduce((a, e) => a + (Number(e.total_cost) || 0), 0),
        repairs12: L.repairsInLastYear(be, t).length,
        fitness_until: docDate('Fitness certificate'),
        insurance_until: docDate('Insurance'),
      },
      spending: {
        current: { total: spent.total, since: spent.since ? spent.since.date_in : null, jobs: spent.jobs.map((j) => entryTitle(j, bp.filter((p) => p.entry_id === j.entry_id))) },
        periods: periods.map((p) => ({ from: p.start ? p.start.date_in : null, to: p.end ? p.end.date_in : null, total: p.total, jobs: p.jobs.length })),
      },
      findings: f.findings,
      lifeChart: f.lifeChart,
      tyreHistory,
      entries,
      voided: d.voided.filter((e) => e.bus_no === busNo).sort(L.byDate).reverse().map((e) => ({
        entry_id: e.entry_id, kind: e.kind, title: e.system || e.kind, date_in: e.date_in, total_cost: e.total_cost,
        reason: e.voided_reason, removed_by: e.voided_by, removed_at: e.voided_at,
      })),
    };
  }

  async function getEntry(entryId) {
    const d = await load();
    const e = d.entries.find((x) => x.entry_id === entryId);
    if (!e) throw new UserError(`Entry ${entryId} was not found, or it has already been corrected or removed.`, 404);
    return { ...e, parts: d.parts.filter((p) => p.entry_id === entryId), bill_url: storage.fileUrl(e.bill_link) };
  }

  async function getRepeats() {
    const d = await load();
    const t = today();
    const buses = activeBuses(d);
    const systems = d.lists.systems.filter((s) => s !== 'Other');
    const matrix = L.repeatMatrix(d.entries, buses, systems, t).map((r) => ({ ...r, route: currentRoute(d, r.bus_no) }));
    const patterns = buses.flatMap((b) => {
      const f = L.findings({ bus: b, busEntries: d.entries.filter((e) => e.bus_no === b.bus_no), busParts: d.parts.filter((p) => p.bus_no === b.bus_no), allEntries: d.entries, allParts: d.parts, activeBusCount: buses.length, routes: d.routes, today: t });
      if (!f.watch.length) return [];
      const extra = f.findings.find((x) => x.level === 'crit' && !/ repaired \d+ times/.test(x.title)) || f.findings.find((x) => !/ repaired \d+ times/.test(x.title));
      return [{ bus_no: b.bus_no, headline: `Bus ${b.bus_no} · ${f.watch[0].system} ×${f.watch[0].count}`, count: f.watch[0].count, detail: extra ? extra.title : '' }];
    }).sort((a, b) => b.count - a.count).slice(0, 6);
    return { systems, matrix, patterns, today: t };
  }

  async function getDailyReport(startDate = today(), endDate = startDate, busNo = '', filters = {}) {
    const from = String(startDate || today());
    const to = String(endDate || from);
    const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
    if (!validDate(from) || !validDate(to)) throw new UserError('Choose valid start and end dates.');
    if (from > to) throw new UserError('The start date must be on or before the end date.');
    const dayCount = L.daysBetween(from, to) + 1;
    if (dayCount > 366) throw new UserError('Choose a date range of 366 days or less.');
    const d = await load();
    const active = activeBuses(d);
    const selectedBus = String(busNo || '').trim();
    if (selectedBus && !active.some((bus) => bus.bus_no === selectedBus)) throw new UserError(`Bus ${selectedBus} is not active or does not exist.`, 404);
    const buses = selectedBus ? active.filter((bus) => bus.bus_no === selectedBus) : active;
    // Buses do not run on Sundays, so those days are not listed (unless something was reported on one).
    const isSunday = (date) => new Date(`${date}T00:00:00`).getDay() === 0;
    const days = Array.from({ length: dayCount }, (_, index) => L.addDays(from, index))
      .filter((date) => !isSunday(date) || d.dailyReports.some((r) => r.report_date === date) || d.trips.some((t) => t.trip_date === date));
    const allRows = days.flatMap((reportDate) => {
      const reports = d.dailyReports.filter((report) => report.report_date === reportDate);
      const trips = d.trips.filter((trip) => trip.trip_date === reportDate).sort((a, b) => (Number(a.trip_number) - Number(b.trip_number)) || (SESSIONS.indexOf(sessionOf(a)) - SESSIONS.indexOf(sessionOf(b))) || String(a.actual_start).localeCompare(String(b.actual_start)));
      return buses.map((bus) => {
        const daily = reports.find((report) => report.bus_no === bus.bus_no);
        const plans = tripPlans(d, bus.bus_no, reportDate);
        const busTrips = trips.filter((trip) => trip.bus_no === bus.bus_no).map((saved) => {
          // Expected times are read from the trip's route, so changing them there changes every day (past ones too).
          const plan = plans[Number(saved.trip_number) - 1];
          const trip = { ...saved };
          const exp = expectedFor(plan, sessionOf(saved));
          if (HHMM.test(exp.start)) trip.scheduled_start = exp.start;
          if (HHMM.test(exp.end)) trip.scheduled_end = exp.end;
          trip.session = sessionOf(saved);
          if (exp.origin && exp.destination) { trip.origin = exp.origin; trip.destination = exp.destination; }
          trip.planned_from_plan = hasKm(exp.km);
          if (trip.planned_from_plan) trip.planned_km = Number(exp.km);
          Object.assign(trip, metricsFor(trip), trip.planned_from_plan ? {} : { extra_km: saved.extra_km, actual_km: saved.actual_km });
          return {
            ...trip,
            photo_url: storage.fileUrl(trip.photo_link),
            timing_status: sessionOf(trip) === 'Evening' ? 'Lateness not checked' : trip.on_time ? 'On time' : `Late by ${trip.late_by_minutes} min`,
          };
        });
        const reported = Boolean(daily);
        const lateTrips = busTrips.filter((trip) => !trip.on_time).length;
        return {
          report_date: reportDate,
          bus_no: bus.bus_no,
          driver_name: daily?.driver_name || bus.driver_name || '',
          route: currentRoute(d, bus.bus_no),
          status: !reported ? 'Not reported' : lateTrips ? 'Late' : 'On time',
          trip_count: new Set(busTrips.map((trip) => Number(trip.trip_number))).size,
          trips_expected: Math.max(1, plans.length),
          late_trips: lateTrips,
          income_collected: Number(daily?.income_collected) || 0,
          expenses: Number(daily?.expenses) || 0,
          net_collection: (Number(daily?.income_collected) || 0) - (Number(daily?.expenses) || 0),
          extra_km: busTrips.reduce((sum, trip) => sum + Math.max(0, Number(trip.extra_km) || 0), 0),
          trips: busTrips,
        };
      });
    });
    // Optional filters on the rows (the summary then covers just those rows).
    const { status = '', late = '', extra = '' } = filters || {};
    const rows = allRows.filter((row) => (!status || row.status === status)
      && (late !== 'with' || row.late_trips > 0) && (late !== 'none' || row.late_trips === 0)
      && (extra !== 'over' || row.extra_km > 0) && (extra !== 'within' || row.extra_km === 0));
    return {
      filters: { status, late, extra },
      from,
      to,
      bus_no: selectedBus,
      bus_count: buses.length,
      days: dayCount,
      buses: rows,
      summary: {
        total_bus_days: rows.length,
        reported_bus_days: rows.filter((row) => row.trip_count > 0).length,
        missing_report_days: rows.filter((row) => row.trip_count === 0).length,
        late_buses: rows.filter((row) => row.status === 'Late').length,
        trips: rows.reduce((sum, row) => sum + row.trips.length, 0),
        extra_km: rows.reduce((sum, row) => sum + row.extra_km, 0),
        income_collected: rows.reduce((sum, row) => sum + row.income_collected, 0),
        expenses: rows.reduce((sum, row) => sum + row.expenses, 0),
        net_collection: rows.reduce((sum, row) => sum + row.net_collection, 0),
      },
    };
  }

  async function saveDailyReport(input, photos = []) {
    const report = {
      report_date: String(input.report_date || '').trim(),
      bus_no: String(input.bus_no || '').trim(),
      driver_name: String(input.driver_name || '').trim(),
      income_collected: Number(input.income_collected),
      expenses: Number(input.expenses),
      notes: String(input.notes || '').trim(),
    };
    const tripInputs = Array.isArray(input.trips) ? input.trips : [];
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(report.report_date) && !Number.isNaN(Date.parse(`${report.report_date}T00:00:00`));
    const validTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!validDate || report.report_date > today()) throw new UserError('Choose a valid report date that is not in the future.');
    if (!activeBuses(await load()).some((bus) => bus.bus_no === report.bus_no)) throw new UserError('Choose an active bus.');
    if (!report.driver_name) throw new UserError('Enter the driver name for this daily report.');
    if (![report.income_collected, report.expenses].every(Number.isFinite) || report.income_collected < 0 || report.expenses < 0) throw new UserError('Income and expenses must be zero or a positive amount.');
    if (tripInputs.length < 1 || tripInputs.length > 12) throw new UserError('Enter at least one trip.');
    // Photos are optional. photo_for says which trips (0-based) the uploaded files belong to, in order.
    const photoFor = Array.isArray(input.photo_for) ? input.photo_for.map(Number) : photos.map((_, i) => i);
    if (photoFor.length !== photos.length || new Set(photoFor).size !== photoFor.length || photoFor.some((i) => !Number.isInteger(i) || i < 0 || i >= tripInputs.length)) throw new UserError('The photos do not match the trips.');
    const photoOfTrip = tripInputs.map((_, i) => (photoFor.includes(i) ? photos[photoFor.indexOf(i)] : null));
    const plansNow = tripPlans(await load(), report.bus_no, report.report_date);
    const trips = tripInputs.map((item, index) => ({
      trip_number: item.trip_number === undefined || item.trip_number === '' ? index + 1 : Number(item.trip_number),
      session: item.session === undefined || item.session === '' ? 'Morning' : String(item.session),
      origin: expectedFor(plansNow[Number(item.trip_number || index + 1) - 1], item.session).origin || String(item.origin || '').trim(),
      destination: expectedFor(plansNow[Number(item.trip_number || index + 1) - 1], item.session).destination || String(item.destination || '').trim(),
      scheduled_start: HHMM.test(expectedFor(plansNow[Number(item.trip_number || index + 1) - 1], item.session).start || '') ? expectedFor(plansNow[Number(item.trip_number || index + 1) - 1], item.session).start : String(item.scheduled_start || '').trim(),
      actual_start: String(item.actual_start || '').trim(),
      scheduled_end: HHMM.test(expectedFor(plansNow[Number(item.trip_number || index + 1) - 1], item.session).end || '') ? expectedFor(plansNow[Number(item.trip_number || index + 1) - 1], item.session).end : String(item.scheduled_end || '').trim(),
      actual_end: String(item.actual_end || '').trim(),
      planned_km: hasKm(expectedFor(plansNow[Number(item.trip_number || index + 1) - 1], item.session).km) ? Number(expectedFor(plansNow[Number(item.trip_number || index + 1) - 1], item.session).km) : Number(item.planned_km),
      start_odometer_km: Number(item.start_odometer_km),
      end_odometer_km: Number(item.end_odometer_km),
      notes: String(item.notes || '').trim(),
    }));
    for (let index = 0; index < trips.length; index++) {
      const trip = trips[index];
      const label = `Trip ${trip.trip_number} ${trip.session.toLowerCase()}`;
      if (!Number.isInteger(trip.trip_number) || trip.trip_number < 1 || trip.trip_number > 6 || !SESSIONS.includes(trip.session)) throw new UserError('Each trip must be a morning or evening leg of trip 1 to 6.');
      if (trips.findIndex((x) => x.trip_number === trip.trip_number && x.session === trip.session) !== index) throw new UserError(`${label} is entered twice.`);
      if (!trip.origin || !trip.destination) throw new UserError(`Enter the origin and destination for ${label}.`);
      if (![trip.scheduled_start, trip.actual_start, trip.scheduled_end, trip.actual_end].every(validTime)) throw new UserError(`Enter all scheduled and actual times for ${label}.`);
      if (![trip.planned_km, trip.start_odometer_km, trip.end_odometer_km].every(Number.isFinite) || trip.planned_km <= 0 || trip.start_odometer_km < 0 || trip.end_odometer_km <= trip.start_odometer_km) throw new UserError(`Enter a positive planned distance and increasing odometer readings for ${label}.`);
      if (photoOfTrip[index] && !photoOfTrip[index].mimetype.startsWith('image/')) throw new UserError(`The file for ${label} must be an image.`);
      const clash = trips.slice(0, index).find((x) => trip.start_odometer_km < x.end_odometer_km && x.start_odometer_km < trip.end_odometer_km);
      if (clash) throw new UserError(`The odometer readings of ${label} overlap Trip ${clash.trip_number} ${clash.session.toLowerCase()}.`);
    }
    const d = await load();
    const bus = d.buses.find((item) => item.bus_no === report.bus_no);
    const existingReport = d.dailyReports.find((item) => item.report_date === report.report_date && item.bus_no === report.bus_no);
    // A day that only has fee income (no trips yet) takes the trips and keeps its income, expenses and notes.
    if (existingReport && d.trips.some((t) => t.report_id === existingReport.report_id || (t.trip_date === report.report_date && t.bus_no === report.bus_no))) throw new UserError(`A daily report for Bus ${report.bus_no} already exists on ${report.report_date}.`);
    const photoLinks = await Promise.all(photoOfTrip.map((photo, index) => (photo ? storage.saveFile(
      `Photos/Bus ${report.bus_no}/Daily trips`,
      `${report.report_date} Trip ${trips[index].trip_number}${trips[index].session === 'Evening' ? ' evening' : ''} ${photo.originalname}`,
      photo.buffer,
    ) : '')));
    const now = localNow();
    return storage.transact((tx) => {
      const allReports = tx.read('Daily reports');
      const reportId = existingReport ? existingReport.report_id : `D-${report.report_date}-${report.bus_no}-${String(allReports.length + 1).padStart(3, '0')}`;
      const allTrips = tx.read('Trips');
      const savedTrips = trips.map((trip, index) => {
        const metrics = metricsFor(trip);
        const tripId = `${reportId}-T${trip.trip_number}${trip.session === 'Evening' ? 'E' : ''}`;
        return {
          trip_id: tripId,
          report_id: reportId,
          trip_date: report.report_date,
          bus_no: report.bus_no,
          ...trip,
          ...metrics,
          photo_link: photoLinks[index],
          entered_by: user,
          entered_at: now,
        };
      });
      if (existingReport) tx.update('Daily reports', (r) => r.report_id === reportId, { driver_name: report.driver_name || existingReport.driver_name || bus?.driver_name || '' });
      else tx.append('Daily reports', [{
        report_id: reportId,
        ...report,
        driver_name: report.driver_name || bus?.driver_name || '',
        entered_by: user,
        entered_at: now,
      }]);
      tx.append('Trips', savedTrips);
      tx.append('Change log', [{ timestamp: now, user, action: 'Added', tab: 'Daily reports', record_id: reportId, field: '', old_value: '', new_value: `Bus ${report.bus_no}, income ${report.income_collected}, expenses ${report.expenses}, ${trips.length} trip${trips.length === 1 ? '' : 's'}` }]);
      return { report_id: reportId, bus_no: report.bus_no, driver_name: report.driver_name || bus?.driver_name || '', trip_ids: savedTrips.map((trip) => trip.trip_id) };
    });
  }

  // Expenses for a bus-day without the full trip form. Adds to the day's expenses (or replaces them,
  // to correct a mistake), creating the daily report if the day has none yet.
  async function saveExpense(input) {
    const bus_no = String(input.bus_no || '').trim();
    const report_date = String(input.report_date || '').trim();
    const amount = Number(input.amount);
    const replace = input.mode === 'replace';
    const note = String(input.note || '').trim();
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(report_date) && !Number.isNaN(Date.parse(`${report_date}T00:00:00`));
    if (!validDate || report_date > today()) throw new UserError('Choose a valid date that is not in the future.');
    const d = await load();
    const bus = d.buses.find((item) => item.bus_no === bus_no && item.active !== false);
    if (!bus) throw new UserError('Choose an active bus.');
    if (!Number.isFinite(amount) || amount < 0 || (!replace && amount === 0)) throw new UserError('Enter the expense amount in rupees.');
    const now = localNow();
    return storage.transact((tx) => {
      const existing = tx.read('Daily reports').find((r) => r.report_date === report_date && r.bus_no === bus_no);
      const log = (record_id, action, old_value, new_value) => tx.append('Change log', [{ timestamp: now, user, action, tab: 'Daily reports', record_id, field: 'expenses', old_value, new_value }]);
      if (existing) {
        const before = Number(existing.expenses) || 0;
        const expenses = replace ? amount : before + amount;
        const notes = note ? [existing.notes, note].filter(Boolean).join('; ') : existing.notes;
        tx.update('Daily reports', (r) => r.report_id === existing.report_id, { expenses, notes });
        log(existing.report_id, 'Changed', String(before), String(expenses));
        return { report_id: existing.report_id, bus_no, report_date, expenses, created: false };
      }
      const reportId = `D-${report_date}-${bus_no}-${String(tx.read('Daily reports').length + 1).padStart(3, '0')}`;
      tx.append('Daily reports', [{ report_id: reportId, report_date, bus_no, driver_name: bus.driver_name || '', income_collected: 0, expenses: amount, notes: note, entered_by: user, entered_at: now }]);
      log(reportId, 'Added', '', String(amount));
      return { report_id: reportId, bus_no, report_date, expenses: amount, created: true };
    });
  }

  // Stops, expected times and planned km of a trip. With input.effective_from the change applies from that day onwards
  // and earlier days keep what they had; without it (or with all_days) it replaces the trip's base settings, so every day without a dated change follows.
  async function setTripTimes(routeId, input) {
    const kmOf = (v, label) => { const t = String(v ?? '').trim(); if (t === '') return ''; const n = Number(t); if (!Number.isFinite(n) || n <= 0) throw new UserError(`${label} must be more than zero.`); return n; };
    const given = {
      start_stop: 'start_stop' in input, end_stop: 'end_stop' in input,
      expected_start: 'expected_start' in input, expected_end: 'expected_end' in input,
      expected_evening_start: 'expected_evening_start' in input, expected_evening_end: 'expected_evening_end' in input,
      planned_km: 'planned_km' in input, planned_evening_km: 'planned_evening_km' in input,
    };
    const text = (k) => String(input[k] ?? '').trim();
    const vals = {
      start_stop: text('start_stop'), end_stop: text('end_stop'),
      expected_start: text('expected_start'), expected_end: text('expected_end'),
      expected_evening_start: text('expected_evening_start'), expected_evening_end: text('expected_evening_end'),
      planned_km: kmOf(input.planned_km, 'Morning planned km'), planned_evening_km: kmOf(input.planned_evening_km, 'Evening planned km'),
    };
    for (const k of ['expected_start', 'expected_end', 'expected_evening_start', 'expected_evening_end']) if (vals[k] && !HHMM.test(vals[k])) throw new UserError('Enter times as hours and minutes, like 07:40.');
    if (vals.expected_start && vals.expected_end && vals.expected_start >= vals.expected_end) throw new UserError('The drop-off time must be after the pick-up time.');
    if (vals.expected_evening_start && vals.expected_evening_end && vals.expected_evening_start >= vals.expected_evening_end) throw new UserError('The evening drop-off time must be after the evening pick-up time.');
    const saturday = input.day_type === 'Saturday';
    let from = input.all_days ? '' : String(input.effective_from || '').trim();
    if (saturday && !from) from = '2000-01-01'; // a Saturday plan always has a start date; this one covers every Saturday
    if (from && (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(`${from}T00:00:00`)))) throw new UserError('Choose a valid date for the change to start.');
    const now = localNow();
    return storage.transact((tx) => {
      const route = tx.read('Routes').find((r) => r.route_id === routeId);
      if (!route) throw new UserError('There is no such trip.', 404);
      // the first stop shown when none is set is the one read from the route details, so showing it back is not a change
      const shown = (src, k) => ((src[k] ?? '') === '' && k === 'start_stop' ? firstStopOf(route).trim() : (src[k] ?? ''));
      const log = [];
      if (!from && !saturday) {
        for (const [field, v] of Object.entries(vals)) {
          if (!given[field]) continue;
          if (String(shown(route, field)) !== String(v)) log.push({ timestamp: now, user, action: 'Updated', tab: 'Routes', record_id: routeId, field, old_value: String(shown(route, field)), new_value: String(v) });
        }
        if (!log.length) return { route_id: routeId, changed: 0 };
        tx.update('Routes', (r) => r.route_id === routeId, Object.fromEntries(Object.entries(vals).filter(([k]) => given[k])));
        tx.append('Change log', log);
        return { route_id: routeId, changed: log.length };
      }
      // dated change: a full row of settings; fields not sent keep what was in force on that day
      const kind = saturday ? 'Saturday' : '';
      const rows = tx.read('Trip settings').filter((x) => x.route_id === routeId && x.effective_from && (x.day_type || '') === kind);
      const before = [...rows].sort((x, y) => String(x.effective_from).localeCompare(String(y.effective_from))).reverse().find((x) => x.effective_from <= from) || (saturday ? {} : route);
      const row = { route_id: routeId, effective_from: from, day_type: kind, changed_by: user, changed_at: now };
      for (const k of Object.keys(vals)) row[k] = given[k] ? vals[k] : (before[k] ?? '');
      for (const k of Object.keys(vals)) {
        if (String(shown(before, k)) !== String(row[k])) log.push({ timestamp: now, user, action: 'Updated', tab: 'Trip settings', record_id: `${routeId}${saturday ? ' Saturdays' : ''} from ${from}`, field: k, old_value: String(shown(before, k)), new_value: String(row[k]) });
      }
      const same = rows.find((x) => x.effective_from === from);
      if (!log.length && !same) return { route_id: routeId, changed: 0 };
      if (same) tx.update('Trip settings', (x) => x.route_id === routeId && x.effective_from === from && (x.day_type || '') === kind, row);
      else tx.append('Trip settings', [row]);
      if (!log.length) return { route_id: routeId, changed: 0 };
      tx.append('Change log', log);
      return { route_id: routeId, changed: log.length, effective_from: from };
    });
  }

  // The trips a bus runs on a day, with the stops, times and planned km in force that day.
  async function getTripPlans(busNo, date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || Number.isNaN(Date.parse(`${date}T00:00:00`))) throw new UserError('Choose a valid date.');
    const d = await load();
    if (!activeBuses(d).some((b) => b.bus_no === busNo)) throw new UserError('Choose an active bus.');
    const plans = tripPlans(d, busNo, date);
    return { trips: Math.max(1, plans.length), plans };
  }

  // Correct a saved trip: actual times, odometer readings, planned km. Expected times come from the trip's route.
  async function updateTrip(tripId, input) {
    const now = localNow();
    const num = (v, label) => { const n = Number(v); if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < 0) throw new UserError(`${label} must be zero or more.`); return n; };
    return storage.transact((tx) => {
      const trip = tx.read('Trips').find((t) => t.trip_id === tripId);
      if (!trip) throw new UserError('There is no such trip.', 404);
      const next = { actual_start: String(input.actual_start ?? trip.actual_start).trim(), actual_end: String(input.actual_end ?? trip.actual_end).trim() };
      if (!HHMM.test(next.actual_start) || !HHMM.test(next.actual_end)) throw new UserError('Enter the actual pick-up and drop-off as hours and minutes, like 07:40.');
      next.start_odometer_km = num(input.start_odometer_km ?? trip.start_odometer_km, 'Start km');
      next.end_odometer_km = num(input.end_odometer_km ?? trip.end_odometer_km, 'End km');
      next.planned_km = num(input.planned_km ?? trip.planned_km, 'Planned km');
      const planKm = expectedFor(tripPlans({ assignments: tx.read('Route assignments'), routes: tx.read('Routes'), tripSettings: tx.read('Trip settings') }, trip.bus_no, trip.trip_date)[Number(trip.trip_number) - 1], sessionOf(trip)).km;
      if (hasKm(planKm)) next.planned_km = Number(planKm);
      if (next.end_odometer_km <= next.start_odometer_km) throw new UserError('End km must be more than start km.');
      if ('notes' in input) next.notes = String(input.notes ?? '').trim();
      const plan = tripPlans({ assignments: tx.read('Route assignments'), routes: tx.read('Routes'), tripSettings: tx.read('Trip settings') }, trip.bus_no, trip.trip_date)[Number(trip.trip_number) - 1];
      const merged = { ...trip, ...next };
      const exp = expectedFor(plan, sessionOf(trip));
      if (HHMM.test(exp.start)) merged.scheduled_start = exp.start;
      if (HHMM.test(exp.end)) merged.scheduled_end = exp.end;
      const patch = { ...next, scheduled_start: merged.scheduled_start, scheduled_end: merged.scheduled_end, ...metricsFor(merged) };
      const log = [];
      for (const [field, v] of Object.entries(next)) {
        if (String(trip[field] ?? '') !== String(v ?? '')) log.push({ timestamp: now, user, action: 'Updated', tab: 'Trips', record_id: tripId, field, old_value: String(trip[field] ?? ''), new_value: String(v ?? '') });
      }
      if (!log.length) return { trip_id: tripId, changed: 0 };
      tx.update('Trips', (t) => t.trip_id === tripId, patch);
      tx.append('Change log', log);
      return { trip_id: tripId, changed: log.length };
    });
  }


  // ---------- tyres: each tyre is tracked on its own, with where it has been fitted and for how long

  // Spares are not per bus: unfitted tyres sit in the common "In stock" pool.
  // A tyre stays on its bus (it may change wheel position there) until it goes to repair, the retreader or scrap.
  // A retreaded tyre keeps its serial number and may be fitted to any bus when it comes back.
  const TYRE_POSITIONS = ['Front left', 'Front right', 'Back left outer', 'Back left inner', 'Back right outer', 'Back right inner'];
  const TYRE_PLACES = ['In stock', 'In repair', 'At retreader', 'Scrapped'];
  const routeOfTrip = (d, trip) => {
    const on = d.assignments.filter((a) => a.bus_no === trip.bus_no && a.from_date && a.from_date <= trip.trip_date && (!a.to_date || a.to_date >= trip.trip_date));
    const a = on[Number(trip.trip_number) - 1] || on[0];
    return a ? routeName(d, a.route_id) : 'No route set';
  };

  async function getTyres() {
    const d = await load();
    const [tyres, fitments, retreads] = await Promise.all([storage.read('Tyres'), storage.read('Tyre fitments'), storage.read('Tyre retreads')]);
    const t = today();
    const kmByRoute = (f) => {
      const out = new Map();
      for (const trip of d.trips) {
        if (trip.bus_no !== f.bus_no || !f.fitted_date || trip.trip_date < f.fitted_date || trip.trip_date > (f.removed_date || t)) continue;
        const r = routeOfTrip(d, trip);
        out.set(r, (out.get(r) || 0) + (Number(trip.actual_km) || 0));
      }
      return out;
    };
    const rows = tyres.filter((x) => x.tyre_no).map((tyre) => {
      const spells = fitments.filter((f) => f.tyre_no === tyre.tyre_no).sort((a, b) => String(a.fitted_date).localeCompare(String(b.fitted_date)) || String(a.fitment_id).localeCompare(String(b.fitment_id)))
        .map((f) => {
          const routes = kmByRoute(f);
          const open = !f.removed_date;
          const odoKm = !open && Number.isFinite(Number(f.removed_km)) && f.removed_km !== '' && f.removed_km !== null ? Number(f.removed_km) - Number(f.fitted_km) : null;
          const logged = [...routes.values()].reduce((a, b) => a + b, 0);
          // a stretch still running is measured to the bus's last logged odometer reading, like a finished one is measured to the odometer at removal
          const lastOdo = open ? Math.max(0, ...d.trips.filter((x) => x.bus_no === f.bus_no && f.fitted_date && x.trip_date >= f.fitted_date).map((x) => Number(x.end_odometer_km) || 0)) : 0;
          const openKm = open && lastOdo > Number(f.fitted_km) ? lastOdo - Number(f.fitted_km) : null;
          return {
            fitment_id: f.fitment_id, bus_no: f.bus_no, position: f.position, fitted_date: f.fitted_date, fitted_km: f.fitted_km,
            removed_date: f.removed_date || '', removed_km: f.removed_km ?? '', removed_to: f.removed_to || '',
            km: odoKm ?? openKm ?? logged, km_from: odoKm !== null ? 'odometer at removal' : openKm !== null ? 'odometer at last logged trip' : 'logged trips', logged_km: logged,
            by_route: [...routes].map(([route, km]) => ({ route, km })).sort((a, b) => b.km - a.km),
          };
        });
      const open = spells.find((x) => !x.removed_date);
      const mine = retreads.filter((r) => r.tyre_no === tyre.tyre_no).sort((a, b) => String(a.returned_date).localeCompare(String(b.returned_date)));
      // a spell belongs to life n when n retreads had come back before it was fitted (life 0 = original)
      for (const sp of spells) sp.life = mine.filter((r) => r.returned_date <= sp.fitted_date).length;
      const lives = [];
      for (let n = 0; n <= mine.length; n++) {
        const inLife = spells.filter((x) => x.life === n);
        lives.push({ life: n, label: n === 0 ? 'Original' : `Retread ${n}`, km: (n === 0 ? Number(tyre.km_before) || 0 : 0) + inLife.reduce((a, x) => a + x.km, 0) });
      }
      // the whole journey: each stretch on a bus, and the time spent in stock, repair or at the retreader between them
      const journey = [];
      spells.forEach((sp, i) => {
        journey.push({ kind: 'bus', ...sp });
        if (!sp.removed_date || sp.removed_to === 'Position changed') return;
        const end = spells[i + 1] ? spells[i + 1].fitted_date : '';
        const place = (name, from, to) => journey.push({ kind: 'place', place: name, from, to });
        const back = sp.removed_to === 'At retreader' ? mine.find((r) => r.returned_date >= sp.removed_date) : null;
        if (back) { place('At retreader', sp.removed_date, back.returned_date); place('In stock', back.returned_date, end); } else place(sp.removed_to, sp.removed_date, end);
      });
      const byRoute = new Map();
      for (const sp of spells) for (const r of sp.by_route) byRoute.set(r.route, (byRoute.get(r.route) || 0) + r.km);
      const before = Number(tyre.km_before) || 0;
      return {
        tyre_no: tyre.tyre_no, make: tyre.make || '', condition: tyre.condition || '', notes: tyre.notes || '',
        km_before: before,
        status: open ? 'Fitted' : (tyre.status || 'In stock'),
        retread_count: mine.length, lives, journey,
        retreads: mine.map((r) => ({ returned_date: r.returned_date, company: r.company || '', cost: Number(r.cost) || 0, bus_no: r.bus_no || '' })),
        bus_no: open ? open.bus_no : '', position: open ? open.position : '',
        total_km: before + spells.reduce((a, x) => a + x.km, 0),
        by_route: [...byRoute].map(([route, km]) => ({ route, km })).sort((a, b) => b.km - a.km),
        spells,
      };
    }).sort((a, b) => a.tyre_no.localeCompare(b.tyre_no));
    return { today: t, positions: TYRE_POSITIONS, places: TYRE_PLACES, buses: activeBuses(d).map((b) => b.bus_no), tyres: rows };
  }

  // A tyre sent to the retreader (status 'At retreader') comes back with the same serial number, into the common stock.
  // The cost is booked as an expense of the bus it last ran on.
  async function returnRetread(input) {
    const tyre_no = String(input.tyre_no || '').trim();
    const date = String(input.date || '').trim();
    const company = String(input.company || '').trim();
    const cost = input.cost === '' || input.cost == null ? 0 : Number(input.cost);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00`)) || date > today()) throw new UserError('Choose a valid date that is not in the future.');
    if (!Number.isFinite(cost) || cost < 0) throw new UserError('Enter the retread cost in rupees.');
    const now = localNow();
    const result = await storage.transact((tx) => {
      const tyre = tx.read('Tyres').find((x) => x.tyre_no.toLowerCase() === tyre_no.toLowerCase());
      if (!tyre) throw new UserError(`Tyre ${tyre_no} is not in the tyre list.`);
      if (tyre.status !== 'At retreader') throw new UserError(`Tyre ${tyre.tyre_no} is not at the retreader.`);
      const f = tx.read('Tyre fitments').filter((x) => x.tyre_no === tyre.tyre_no).sort((a, b) => String(a.fitted_date).localeCompare(String(b.fitted_date)) || String(a.fitment_id).localeCompare(String(b.fitment_id))).pop();
      if (f && f.removed_date && date < f.removed_date) throw new UserError(`The tyre went to the retreader on ${f.removed_date}. The return date cannot be earlier.`);
      const bus_no = f ? f.bus_no : '';
      const n = tx.read('Tyre retreads').length + 1;
      tx.append('Tyre retreads', [{ retread_id: `RT-${String(n).padStart(4, '0')}-${tyre.tyre_no}`, tyre_no: tyre.tyre_no, returned_date: date, company, cost, bus_no, notes: '' }]);
      tx.update('Tyres', (x) => x.tyre_no === tyre.tyre_no, { status: 'In stock', condition: 'Retreaded' });
      if (bus_no && cost > 0) {
        const entryId = `E-${date}-${bus_no}-RT${String(n).padStart(4, '0')}`;
        tx.append('Entries', [{
          entry_id: entryId, bus_no, kind: TYRE_RETREAD, date_in: date, date_out: date, days_off_road: 0, system: 'Tyres & alignment',
          problem_reported: `Tyre ${tyre.tyre_no} retreaded`, workshop: company, total_cost: cost, labour_cost: 0, is_repeat: false,
          route_at_time: '', record_status: '', entered_by: user, entered_at: now,
        }]);
      }
      tx.append('Change log', [{ timestamp: now, user, action: 'Retreaded', tab: 'Tyres', record_id: tyre.tyre_no, field: 'status', old_value: 'At retreader', new_value: `In stock${company ? `, ${company}` : ''}${cost ? `, Rs ${cost}` : ''}` }]);
      return { tyre_no: tyre.tyre_no, bus_no };
    });
    let expense_saved = false;
    if (cost > 0 && result.bus_no) {
      await saveExpense({ bus_no: result.bus_no, report_date: date, amount: cost, note: `Retread of tyre ${result.tyre_no}${company ? ` (${company})` : ''}` });
      expense_saved = true;
    }
    return { ...result, expense_saved };
  }

  // New tyres enter the system either as spares (common stock) or fitted straight onto a bus.
  // input: { tyre_nos (spares), make, condition, km_before, fitted?: { bus_no, date, odometer, positions: { 'Front left': 'tyre no', ... } } }
  async function addTyres(input) {
    const split = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\n,;]+/)).map((x) => String(x).trim()).filter(Boolean);
    const spares = split(input.tyre_nos);
    const fit = input.fitted && typeof input.fitted === 'object' ? input.fitted : null;
    const onBus = fit ? TYRE_POSITIONS.map((position) => ({ position, tyre_no: String(fit.positions?.[position] || '').trim() })).filter((x) => x.tyre_no) : [];
    const list = [...spares, ...onBus.map((x) => x.tyre_no)];
    if (!list.length) throw new UserError('Enter at least one tyre number.');
    const condition = ['New', 'Retreaded', 'Unknown'].includes(input.condition) ? input.condition : 'Unknown';
    const kmBefore = input.km_before === '' || input.km_before == null ? '' : Number(input.km_before);
    if (kmBefore !== '' && (!Number.isFinite(kmBefore) || kmBefore < 0)) throw new UserError('Km already run must be zero or more.');
    const make = String(input.make || '').trim();
    const date = fit ? String(fit.date || '').trim() : '';
    const odometer = fit ? Number(fit.odometer) : 0;
    if (onBus.length) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00`)) || date > today()) throw new UserError('Choose a valid fitting date that is not in the future.');
      if (!String(fit.odometer ?? '').trim() || !Number.isFinite(odometer) || odometer < 0) throw new UserError(`Enter Bus ${fit.bus_no || ''}'s odometer reading.`);
      const bus = (await load()).buses.find((b) => b.bus_no === String(fit.bus_no || '').trim() && b.active !== false);
      if (!bus) throw new UserError('Choose an active bus to fit the tyres on.');
      fit.bus_no = bus.bus_no;
    }
    const now = localNow();
    return storage.transact((tx) => {
      const have = new Set(tx.read('Tyres').map((x) => x.tyre_no.toLowerCase()));
      const dupes = list.filter((x, i) => have.has(x.toLowerCase()) || list.findIndex((y) => y.toLowerCase() === x.toLowerCase()) !== i);
      if (dupes.length) throw new UserError(`Already in the tyre list: ${[...new Set(dupes)].join(', ')}.`);
      const fitments = tx.read('Tyre fitments');
      if (onBus.length) {
        const taken = onBus.find((x) => fitments.some((f) => !f.removed_date && f.bus_no === fit.bus_no && f.position === x.position));
        if (taken) throw new UserError(`Bus ${fit.bus_no} ${taken.position.toLowerCase()} already has a tyre. Use "Move or swap tyres" to change it.`);
        const last = Math.max(0, ...fitments.filter((f) => f.bus_no === fit.bus_no).flatMap((f) => [Number(f.fitted_km) || 0, Number(f.removed_km) || 0]));
        if (odometer < last) throw new UserError(`Bus ${fit.bus_no}'s odometer cannot be less than ${last.toLocaleString('en-IN')}, the last reading recorded for it.`);
      }
      tx.append('Tyres', list.map((tyre_no) => ({ tyre_no, make, condition, km_before: kmBefore, status: onBus.some((x) => x.tyre_no === tyre_no) ? 'Fitted' : 'In stock', notes: '' })));
      let n = fitments.length;
      tx.append('Tyre fitments', onBus.map((x) => ({ fitment_id: `F-${String(++n).padStart(4, '0')}-${x.tyre_no}`, tyre_no: x.tyre_no, bus_no: fit.bus_no, position: x.position, fitted_date: date, fitted_km: odometer, removed_date: '', removed_km: '', removed_to: '' })));
      tx.append('Change log', list.map((tyre_no) => {
        const x = onBus.find((y) => y.tyre_no === tyre_no);
        return { timestamp: now, user, action: 'Added', tab: 'Tyres', record_id: tyre_no, field: '', old_value: '', new_value: `${condition}${make ? `, ${make}` : ''}, ${x ? `Bus ${fit.bus_no} ${x.position}` : 'spare'}` };
      }));
      return { added: list.length, fitted: onBus.length, spares: spares.length };
    });
  }

  // One or more tyres change place on a date: fitted to a bus position, or sent to repair / scrap / stock.
  // A swap between two buses is one call with two moves. odometers = { busNo: km } for every bus involved.
  async function moveTyres(input) {
    const date = String(input.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00`)) || date > today()) throw new UserError('Choose a valid date that is not in the future.');
    const moves = (Array.isArray(input.moves) ? input.moves : []).map((m) => ({
      tyre_no: String(m.tyre_no || '').trim(), to: String(m.to || '').trim(), bus_no: String(m.bus_no || '').trim(), position: String(m.position || '').trim(),
    })).filter((m) => m.tyre_no);
    if (!moves.length) throw new UserError('Add at least one tyre to move.');
    const odo = {};
    for (const [bus, km] of Object.entries(input.odometers || {})) if (String(km).trim() !== '') odo[bus] = Number(km);
    const now = localNow();
    const buses = new Set((await load()).buses.filter((b) => b.active !== false).map((b) => b.bus_no));
    return storage.transact((tx) => {
      const tyres = tx.read('Tyres');
      const fitments = tx.read('Tyre fitments');
      const open = fitments.filter((f) => !f.removed_date);
      const seen = new Set();
      const targets = new Set();
      for (const m of moves) {
        if (seen.has(m.tyre_no.toLowerCase())) throw new UserError(`Tyre ${m.tyre_no} is listed twice.`);
        seen.add(m.tyre_no.toLowerCase());
        const tyre = tyres.find((x) => x.tyre_no.toLowerCase() === m.tyre_no.toLowerCase());
        if (!tyre) throw new UserError(`Tyre ${m.tyre_no} is not in the tyre list. Add it first.`);
        m.tyre_no = tyre.tyre_no;
        const cur = open.find((x) => x.tyre_no === m.tyre_no);
        const lastBus = fitments.filter((f) => f.tyre_no === m.tyre_no).sort((a, b) => String(a.fitted_date).localeCompare(String(b.fitted_date)) || String(a.fitment_id).localeCompare(String(b.fitment_id))).pop()?.bus_no || '';
        if (tyre.status === 'Scrapped') throw new UserError(`Tyre ${m.tyre_no} is scrapped.`);
        if (tyre.status === 'At retreader' && !cur) throw new UserError(`Tyre ${m.tyre_no} is at the retreader. Record its return first.`);
        if (m.to === 'bus') {
          if (cur && cur.bus_no !== m.bus_no) throw new UserError(`Tyre ${m.tyre_no} belongs to Bus ${cur.bus_no} and cannot go to another bus. Send it to repair, the retreader or scrap.`);
          if (!cur && tyre.status === 'In repair' && lastBus && lastBus !== m.bus_no) throw new UserError(`Tyre ${m.tyre_no} was taken off Bus ${lastBus} for repair and must go back to that bus.`);
          if (!buses.has(m.bus_no)) throw new UserError(`Choose an active bus for tyre ${m.tyre_no}.`);
          if (!TYRE_POSITIONS.includes(m.position)) throw new UserError(`Choose the wheel position for tyre ${m.tyre_no}.`);
          const slot = `${m.bus_no}|${m.position}`;
          if (targets.has(slot)) throw new UserError(`Bus ${m.bus_no} ${m.position.toLowerCase()} is given to two tyres.`);
          targets.add(slot);
        } else if (!TYRE_PLACES.includes(m.to)) throw new UserError(`Choose where tyre ${m.tyre_no} goes.`);
        else if (m.to === 'In stock' && (cur || (tyre.status === 'In repair' && lastBus))) throw new UserError(`Tyre ${m.tyre_no} belongs to Bus ${cur ? cur.bus_no : lastBus}. Fit it back on that bus, or send it to the retreader or scrap.`);
      }
      // tyres taken off: the ones being moved; a tyre sitting where a moved tyre is going must be moved too
      const closing = new Map(); // fitment_id -> removed_to
      for (const m of moves) {
        const f = open.find((x) => x.tyre_no === m.tyre_no);
        if (f) closing.set(f.fitment_id, m.to === 'bus' ? 'Position changed' : m.to);
      }
      for (const slot of targets) {
        const [bus, pos] = slot.split('|');
        const f = open.find((x) => x.bus_no === bus && x.position === pos);
        if (f && !closing.has(f.fitment_id)) throw new UserError(`Bus ${bus} ${pos.toLowerCase()} already has tyre ${f.tyre_no}. Move that tyre first.`);
      }
      const involved = new Set([...closing.keys()].map((id) => open.find((f) => f.fitment_id === id).bus_no));
      for (const m of moves) if (m.to === 'bus') involved.add(m.bus_no);
      const lastKm = (bus) => Math.max(0, ...fitments.filter((f) => f.bus_no === bus).flatMap((f) => [Number(f.fitted_km) || 0, Number(f.removed_km) || 0]));
      for (const bus of involved) {
        if (!Number.isFinite(odo[bus]) || odo[bus] < 0) throw new UserError(`Enter Bus ${bus}'s odometer reading for this change.`);
        if (odo[bus] < lastKm(bus)) throw new UserError(`Bus ${bus}'s odometer cannot be less than ${lastKm(bus).toLocaleString('en-IN')}, the last reading recorded for it.`);
      }
      const log = [];
      for (const [id, to] of closing) {
        const f = open.find((x) => x.fitment_id === id);
        tx.update('Tyre fitments', (x) => x.fitment_id === id, { removed_date: date, removed_km: odo[f.bus_no], removed_to: to });
        if (to !== 'Position changed') tx.update('Tyres', (x) => x.tyre_no === f.tyre_no, { status: to });
        log.push({ timestamp: now, user, action: 'Removed', tab: 'Tyres', record_id: f.tyre_no, field: 'fitted', old_value: `Bus ${f.bus_no} ${f.position}`, new_value: to });
      }
      let n = fitments.length;
      const fresh = [];
      for (const m of moves) {
        if (m.to === 'bus') {
          n += 1;
          fresh.push({ fitment_id: `F-${String(n).padStart(4, '0')}-${m.tyre_no}`, tyre_no: m.tyre_no, bus_no: m.bus_no, position: m.position, fitted_date: date, fitted_km: odo[m.bus_no], removed_date: '', removed_km: '', removed_to: '' });
          log.push({ timestamp: now, user, action: 'Fitted', tab: 'Tyres', record_id: m.tyre_no, field: 'fitted', old_value: '', new_value: `Bus ${m.bus_no} ${m.position}` });
        } else if (!closing.size || !open.some((x) => x.tyre_no === m.tyre_no)) {
          tx.update('Tyres', (x) => x.tyre_no === m.tyre_no, { status: m.to });
          log.push({ timestamp: now, user, action: 'Moved', tab: 'Tyres', record_id: m.tyre_no, field: 'status', old_value: '', new_value: m.to });
        }
      }
      if (fresh.length) tx.append('Tyre fitments', fresh);
      tx.append('Change log', log);
      return { moved: moves.length, taken_off_unlisted: [...closing].filter(([id]) => !moves.some((m) => open.find((x) => x.fitment_id === id)?.tyre_no === m.tyre_no)).length };
    });
  }

  async function checkRepeat({ bus_no, system, date_in, kind, exclude_entry_id }) {
    if (![KINDS.REPAIR, KINDS.BREAKDOWN].includes(kind)) return { isRepeat: false, count: 0 };
    const d = await load();
    const r = L.repeatCheck(d.entries, { bus_no, system, date_in, exclude_entry_id }, Number(d.settings.repeat_window_days) || 180);
    const months = Math.round(r.windowDays / 30);
    return {
      isRepeat: r.isRepeat,
      count: r.count,
      message: r.isRepeat
        ? `Bus ${bus_no} has already had ${r.count} ${system.toLowerCase()} repairs in the last ${months} months (${r.previous.map((e) => L.shortDate(e.date_in)).join(', ')}). Please fill in the root cause so the pattern can be understood.`
        : '',
    };
  }

  // ---------- AI bill reading

  async function readBillFields(file) {
    if (!readBill) throw new UserError('AI bill reading is off. Add ANTHROPIC_API_KEY to the .env file and restart the app.', 503);
    if (!file) throw new UserError('Upload the bill first.');
    const lists = await getLists();
    if (!lists.aiEnabled) throw new UserError('AI bill reading is turned off in the Settings tab (ai_enabled).', 503);
    const fields = await readBill({
      buffer: file.buffer,
      mimetype: file.mimetype,
      systems: lists.systems,
      kinds: lists.entry_kinds,
      workshops: lists.workshops,
      buses: lists.buses.map((b) => b.label),
    });
    return fields;
  }

  // ---------- writes

  function validate(input, d) {
    const e = {
      bus_no: String(input.bus_no || '').trim(),
      kind: String(input.kind || '').trim(),
      date_in: String(input.date_in || '').trim(),
      date_out: String(input.date_out || '').trim(),
      odometer_km: input.odometer_km === '' || input.odometer_km == null ? '' : Number(String(input.odometer_km).replace(/[,\s]/g, '')),
      system: String(input.system || '').trim(),
      problem_reported: String(input.problem_reported || '').trim(),
      root_cause: String(input.root_cause || '').trim(),
      workshop: String(input.workshop || '').trim(),
      bill_no: String(input.bill_no || '').trim(),
      labour_cost: input.labour_cost === '' || input.labour_cost == null ? '' : Number(String(input.labour_cost).replace(/[,₹\s]/g, '')),
      total_cost: input.total_cost === '' || input.total_cost == null ? '' : Number(String(input.total_cost).replace(/[,₹\s]/g, '')),
      filled_by_ai: Boolean(input.filled_by_ai),
    };
    const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (!d.buses.some((b) => b.bus_no === e.bus_no)) throw new UserError('Choose which bus this is for.');
    if (!d.lists.entry_kinds.includes(e.kind)) throw new UserError('Choose what kind of visit this was.');
    if (!isDate(e.date_in)) throw new UserError('Enter the date the bus went in.');
    if (e.date_in > today()) throw new UserError('The date in cannot be in the future.');
    if (e.date_out && !isDate(e.date_out)) throw new UserError('Enter the date out as a date, or leave it blank if the bus is still in the workshop.');
    if (e.date_out && e.date_out < e.date_in) throw new UserError('The date out is before the date in.');
    if ([KINDS.REPAIR, KINDS.BREAKDOWN].includes(e.kind) && !e.system) throw new UserError('Choose which system was repaired (brakes, tyres…).');
    if (e.odometer_km !== '' && !(Number.isFinite(e.odometer_km) && e.odometer_km >= 0)) throw new UserError('The odometer reading must be a number of kilometres.');
    for (const k of ['labour_cost', 'total_cost']) {
      if (e[k] !== '' && !(Number.isFinite(e[k]) && e[k] >= 0)) throw new UserError('Costs must be amounts in rupees, like 18400.');
    }
    if (e.total_cost === '') throw new UserError('Enter the bill total (use 0 if there was no charge).');
    const parts = (Array.isArray(input.parts) ? input.parts : [])
      .map((p) => ({
        part_name: String(p.part_name || '').trim(),
        position: String(p.position || '').trim(),
        removed_part_no: String(p.removed_part_no || '').trim(),
        fitted_part_no: String(p.fitted_part_no || '').trim(),
        part_cost: p.part_cost === '' || p.part_cost == null ? '' : Number(String(p.part_cost).replace(/[,₹\s]/g, '')),
        warranty_until: String(p.warranty_until || '').trim(),
      }))
      .filter((p) => p.part_name);
    for (const p of parts) {
      if (p.part_cost !== '' && !Number.isFinite(p.part_cost)) throw new UserError(`The cost for "${p.part_name}" must be a number.`);
      if (p.warranty_until && !isDate(p.warranty_until)) throw new UserError(`The warranty date for "${p.part_name}" must be a date.`);
    }
    return { e, parts };
  }

  // Keep the bus status in step: an active visit with no date out means the bus is still in the workshop.
  function syncBusStatus(tx, busNo, now) {
    const open = tx.read('Entries').filter((r) => r.bus_no === busNo && L.isActive(r) && r.entry_id && !r.date_out);
    const bus = tx.read('Buses').find((b) => b.bus_no === busNo);
    if (!bus) return;
    const want = open.length ? STATUS.IN_WORKSHOP : bus.status === STATUS.IN_WORKSHOP ? STATUS.ON_ROUTE : bus.status;
    if (want && want !== bus.status) {
      tx.update('Buses', (b) => b.bus_no === busNo, { status: want });
      tx.append('Change log', [{ timestamp: now, user, action: 'Updated', tab: 'Buses', record_id: busNo, field: 'status', old_value: bus.status || '', new_value: want }]);
    }
  }

  async function saveEntry(input, files = {}, { correctsId = null } = {}) {
    const d = await load();
    const { e, parts } = validate(input, d);
    let old = null;
    if (correctsId) {
      old = d.entries.find((x) => x.entry_id === correctsId);
      if (!old) throw new UserError(`Entry ${correctsId} was not found, or it has already been corrected or removed.`, 404);
      if (old.bus_no !== e.bus_no) throw new UserError('A correction must stay on the same bus. Add a new entry for the other bus instead.');
    }

    const rep = await checkRepeat({ ...e, exclude_entry_id: correctsId });
    if (rep.isRepeat && e.root_cause.length < 12) {
      throw new UserError(`${rep.message} Write at least a short sentence in "Root cause".`);
    }

    // Files are stored first; the sheet then records their links.
    let billLink = old ? old.bill_link : '';
    if (files.bill) {
      const ext = path.extname(files.bill.originalname) || (files.bill.mimetype === 'application/pdf' ? '.pdf' : '.jpg');
      const name = [e.date_in, e.workshop, e.bill_no].filter(Boolean).join(' ') + ext;
      billLink = await storage.saveFile(`Bills/Bus ${e.bus_no}`, name, files.bill.buffer);
    }
    const photoLinks = old ? String(old.photo_links || '').split(',').map((s) => s.trim()).filter(Boolean) : [];
    for (const ph of files.photos || []) {
      photoLinks.push(await storage.saveFile(`Photos/Bus ${e.bus_no}`, `${e.date_in} ${ph.originalname}`, ph.buffer));
    }

    const now = localNow();
    return storage.transact((tx) => {
      const all = tx.read('Entries');
      const year = e.date_in.slice(0, 4);
      const max = all.reduce((m, r) => {
        const mm = /^E-(\d{4})-(\d+)$/.exec(r.entry_id || '');
        return mm && mm[1] === year ? Math.max(m, Number(mm[2])) : m;
      }, 0);
      const entryId = `E-${year}-${String(max + 1).padStart(4, '0')}`;
      const assignments = tx.read('Route assignments');

      const row = {
        entry_id: entryId,
        ...e,
        days_off_road: e.date_out ? L.daysBetween(e.date_in, e.date_out) : '',
        bill_link: billLink,
        photo_links: photoLinks.join(', '),
        route_at_time: L.routeAt(assignments, e.bus_no, e.date_in),
        is_repeat: rep.isRepeat,
        record_status: 'Active',
        replaces_entry_id: correctsId || '',
        entered_by: user,
        entered_at: now,
      };
      tx.append('Entries', [row]);
      tx.append('Parts changed', parts.map((p) => ({ entry_id: entryId, bus_no: e.bus_no, system: e.system, ...p, record_status: 'Active' })));

      const log = [];
      if (old) {
        tx.update('Entries', (r) => r.entry_id === correctsId, { record_status: 'Corrected' });
        tx.update('Parts changed', (r) => r.entry_id === correctsId, { record_status: 'Corrected' });
        for (const k of Object.keys(e)) {
          if (String(old[k] ?? '') !== String(row[k] ?? '')) {
            log.push({ field: k, old_value: String(old[k] ?? ''), new_value: String(row[k] ?? '') });
          }
        }
        const partText = (p) => [p.part_name, p.position, p.removed_part_no, p.fitted_part_no, p.part_cost, p.warranty_until].filter((x) => x !== '' && x != null).join(' / ');
        const oldParts = d.parts.filter((p) => p.entry_id === correctsId).map(partText).join('; ');
        const newParts = parts.map(partText).join('; ');
        if (oldParts !== newParts) log.push({ field: 'parts', old_value: oldParts, new_value: newParts });
        if (!log.length) log.push({ field: '', old_value: '', new_value: 'No field changes (files only)' });
        tx.append('Change log', log.map((l) => ({ timestamp: now, user, action: 'Corrected', tab: 'Entries', record_id: `${correctsId} → ${entryId}`, ...l })));
      } else {
        tx.append('Change log', [{ timestamp: now, user, action: 'Added', tab: 'Entries', record_id: entryId, field: '', old_value: '', new_value: `${e.kind}, Bus ${e.bus_no}, ₹${e.total_cost}` }]);
      }

      syncBusStatus(tx, e.bus_no, now);

      if (e.workshop && !tx.read('Workshops').some((w) => w.workshop_name.toLowerCase() === e.workshop.toLowerCase())) {
        tx.append('Workshops', [{ workshop_name: e.workshop }]);
      }
      return { entry_id: entryId, bus_no: e.bus_no };
    });
  }

  async function addBus(input) {
    const b = {
      bus_no: String(input.bus_no || '').trim(),
      reg_no: String(input.reg_no || '').trim(),
      make_model: String(input.make_model || '').trim(),
      year: input.year ? Number(input.year) : '',
      seats: input.seats ? Number(input.seats) : '',
      driver_name: String(input.driver_name || '').trim(),
      status: STATUS.ON_ROUTE,
      service_every_km: input.service_every_km ? Number(input.service_every_km) : '',
      service_every_days: input.service_every_days ? Number(input.service_every_days) : '',
      active: true,
    };
    const routeNameIn = String(input.route_name || '').trim();
    if (!/^[A-Za-z0-9-]{1,10}$/.test(b.bus_no)) throw new UserError('Bus number should be short, like 04 or 11A.');
    if (b.year && !(b.year > 1980 && b.year <= Number(today().slice(0, 4)) + 1)) throw new UserError('Check the year.');
    const now = localNow();
    return storage.transact((tx) => {
      if (tx.read('Buses').some((x) => x.bus_no === b.bus_no)) throw new UserError(`Bus ${b.bus_no} already exists.`);
      tx.append('Buses', [b]);
      if (routeNameIn) {
        const routes = tx.read('Routes');
        let route = routes.find((r) => r.route_name.toLowerCase() === routeNameIn.toLowerCase());
        if (!route) {
          route = { route_id: `R${String(routes.length + 1).padStart(2, '0')}`, route_name: routeNameIn, notes: '' };
          tx.append('Routes', [route]);
        }
        tx.append('Route assignments', [{ bus_no: b.bus_no, route_id: route.route_id, from_date: today(), to_date: '' }]);
      }
      tx.append('Change log', [{ timestamp: now, user, action: 'Added', tab: 'Buses', record_id: b.bus_no, field: '', old_value: '', new_value: `${b.make_model} ${b.reg_no}`.trim() }]);
      return { bus_no: b.bus_no };
    });
  }

  async function listBuses() {
    const d = await load();
    return d.buses.map((b) => ({ ...b, route: currentRoute(d, b.bus_no) }));
  }

  // Removes a visit from the books without deleting it: it stops counting in costs and repeat checks,
  // stays stored with who removed it, when and why, and is listed under "Removed entries" on the bus page.
  async function voidEntry(entryId, reason) {
    const why = String(reason || '').trim();
    if (why.length < 5) throw new UserError('Write a short reason for removing this entry (at least 5 characters).');
    const now = localNow();
    return storage.transact((tx) => {
      const e = tx.read('Entries').find((r) => r.entry_id === entryId && L.isActive(r));
      if (!e) throw new UserError(`Entry ${entryId} was not found, or it has already been corrected or removed.`, 404);
      tx.update('Entries', (r) => r.entry_id === entryId, { record_status: 'Voided', voided_reason: why, voided_by: user, voided_at: now });
      tx.update('Parts changed', (p) => p.entry_id === entryId, { record_status: 'Voided' });
      tx.append('Change log', [{ timestamp: now, user, action: 'Removed', tab: 'Entries', record_id: entryId, field: 'reason', old_value: `${e.kind}, Bus ${e.bus_no}, ₹${e.total_cost}`, new_value: why }]);
      syncBusStatus(tx, e.bus_no, now);
      return { entry_id: entryId, bus_no: e.bus_no };
    });
  }

  // Changes a bus's details. The bus number never changes, because visits refer to it.
  // A new route starts today and the old assignment ends yesterday, so past visits keep the route they had.
  async function updateBus(busNo, input) {
    const text = (v) => String(v ?? '').trim();
    const whole = (v, label, min, max) => {
      if (v === '' || v === null || v === undefined) return '';
      const n = Number(String(v).replace(/[,\s]/g, ''));
      if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${label} must be a whole number from ${min} to ${max}.`);
      return n;
    };
    const next = {};
    if ('reg_no' in input) next.reg_no = text(input.reg_no);
    if ('make_model' in input) next.make_model = text(input.make_model);
    if ('driver_name' in input) next.driver_name = text(input.driver_name);
    if ('year' in input) next.year = whole(input.year, 'The year', 1980, Number(today().slice(0, 4)) + 1);
    if ('seats' in input) next.seats = whole(input.seats, 'Seats', 1, 200);
    if ('service_every_km' in input) next.service_every_km = whole(input.service_every_km, 'Service every (km)', 100, 200000);
    if ('service_every_days' in input) next.service_every_days = whole(input.service_every_days, 'Service every (days)', 1, 1000);
    if ('active' in input) next.active = Boolean(input.active);
    const routeIn = 'route_name' in input ? text(input.route_name) : null;
    const now = localNow();

    return storage.transact((tx) => {
      const bus = tx.read('Buses').find((b) => b.bus_no === busNo);
      if (!bus) throw new UserError(`There is no bus "${busNo}".`, 404);
      const log = [];
      const changed = {};
      for (const [k, v] of Object.entries(next)) {
        const before = k === 'active' ? bus.active !== false : bus[k];
        if (String(before ?? '') === String(v ?? '')) continue;
        changed[k] = v;
        log.push({ field: k, old_value: String(before ?? ''), new_value: String(v ?? '') });
      }
      if (Object.keys(changed).length) tx.update('Buses', (b) => b.bus_no === busNo, changed);

      if (routeIn !== null) {
        const assignments = tx.read('Route assignments');
        const routes = tx.read('Routes');
        const currentId = L.routeAt(assignments, busNo, today());
        const currentName = (routes.find((r) => r.route_id === currentId) || {}).route_name || '';
        const tripsToday = assignments.filter((a) => a.bus_no === busNo && a.from_date && a.from_date <= today() && (!a.to_date || a.to_date >= today())).length;
        if (tripsToday > 1) {
          // several trips: their routes are not changed here (the shown text joins them all)
          const joined = assignments.filter((a) => a.bus_no === busNo && a.from_date && a.from_date <= today() && (!a.to_date || a.to_date >= today())).map((a) => (routes.find((r) => r.route_id === a.route_id) || {}).route_name || a.route_id).join(' + ');
          if (routeIn !== joined) throw new UserError('This bus runs several trips, so its route cannot be changed here. Change its trip times below instead.');
        } else if (routeIn.toLowerCase() !== currentName.toLowerCase()) {
          const open = (a) => a.bus_no === busNo && !a.to_date;
          const startedBefore = (a) => open(a) && a.from_date && a.from_date < today();
          const startedToday = (a) => open(a) && (!a.from_date || a.from_date >= today());
          let route = routes.find((r) => r.route_name.toLowerCase() === routeIn.toLowerCase());
          if (routeIn && !route) {
            route = { route_id: `R${String(routes.length + 1).padStart(2, '0')}`, route_name: routeIn, notes: '' };
            tx.append('Routes', [route]);
          }
          // an earlier assignment ends yesterday, so past visits keep their route; one that began today is just changed
          tx.update('Route assignments', startedBefore, { to_date: L.addDays(today(), -1) });
          if (!route) tx.update('Route assignments', startedToday, { from_date: '' }); // set and cleared on the same day: it never applied
          else if (assignments.some(startedToday)) tx.update('Route assignments', startedToday, { route_id: route.route_id });
          else tx.append('Route assignments', [{ bus_no: busNo, route_id: route.route_id, from_date: today(), to_date: '' }]);
          log.push({ field: 'route', old_value: currentName, new_value: routeIn });
        }
      }

      if (!log.length) return { bus_no: busNo, changed: 0 };
      tx.append('Change log', log.map((l) => ({ timestamp: now, user, action: 'Updated', tab: 'Buses', record_id: busNo, ...l })));
      return { bus_no: busNo, changed: log.length };
    });
  }

  // The change log, newest first. Rows written together (one correction touching several fields) are shown as one event.
  const CHANGELOG_PAGE = 50;

  async function getChangeLog({ action = '', q = '', page = 1 } = {}) {
    const rows = (await storage.read('Change log')).map((r, i) => ({ ...r, _i: i })).filter((r) => r.timestamp);
    rows.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : b._i - a._i));

    const groups = new Map();
    for (const r of rows) {
      const key = [r.timestamp, r.user, r.action, r.tab, r.record_id].join('\u0001');
      if (!groups.has(key)) groups.set(key, { timestamp: r.timestamp, user: r.user, action: r.action, tab: r.tab, record_id: r.record_id, changes: [] });
      groups.get(key).changes.push({ field: r.field, old_value: r.old_value, new_value: r.new_value });
    }
    const events = [...groups.values()].map((e) => ({ ...e, changes: e.changes.reverse() })); // back to the order they were written

    const actions = [...new Set(events.map((e) => e.action).filter(Boolean))].sort();
    const needle = String(q || '').trim().toLowerCase().slice(0, 100);
    const wanted = String(action || '').toLowerCase();
    const shown = events.filter((e) => (!wanted || String(e.action).toLowerCase() === wanted)
      && (!needle || [e.user, e.action, e.tab, e.record_id, ...e.changes.flatMap((c) => [c.field, c.old_value, c.new_value])].some((v) => String(v ?? '').toLowerCase().includes(needle))));

    const pages = Math.max(1, Math.ceil(shown.length / CHANGELOG_PAGE));
    const current = Math.min(Math.max(1, Math.floor(Number(page)) || 1), pages);
    return { total: shown.length, page: current, pages, pageSize: CHANGELOG_PAGE, actions, events: shown.slice((current - 1) * CHANGELOG_PAGE, current * CHANGELOG_PAGE) };
  }

  // ---------- import from Excel

  const IMPORT_READS = ['Buses', 'Entries', 'Parts changed', 'Bus documents', 'Workshops', 'Route assignments', 'Lists'];

  function planFrom(parsed, existing) {
    const lists = { ...DEFAULT_LISTS, ...L.listsFrom(existing.Lists) };
    return I.planImport(parsed, existing, { today: today(), now: localNow(), user, kinds: lists.entry_kinds, systems: lists.systems });
  }

  // Without commit it only reports what would happen. With commit it saves the rows that passed.
  async function importWorkbook(file, { commit = false } = {}) {
    if (!file) throw new UserError('Choose an Excel file (.xlsx) to import.');
    const parsed = await I.parseWorkbook(file.buffer);
    const report = (plan, committed) => ({ committed, file: file.originalname, tabs: plan.tabs, notes: plan.notes, ignoredSheets: plan.ignoredSheets, totals: plan.totals });

    if (!commit) {
      const existing = {};
      for (const tab of IMPORT_READS) existing[tab] = await storage.read(tab);
      return report(planFrom(parsed, existing), false);
    }
    return storage.transact((tx) => {
      const existing = Object.fromEntries(IMPORT_READS.map((tab) => [tab, tx.read(tab)]));
      const plan = planFrom(parsed, existing);
      for (const [tab, rows] of Object.entries(plan.append)) if (rows.length) tx.append(tab, rows);
      if (plan.inWorkshop.length) {
        tx.update('Buses', (b) => plan.inWorkshop.includes(b.bus_no) && b.status !== STATUS.IN_WORKSHOP, { status: STATUS.IN_WORKSHOP });
      }
      if (plan.totals.add) {
        const counts = Object.entries(plan.append).filter(([, rows]) => rows.length).map(([tab, rows]) => `${rows.length} ${tab.toLowerCase()}`).join(', ');
        tx.append('Change log', [{ timestamp: localNow(), user, action: 'Imported', tab: 'Import', record_id: '', field: '', old_value: '', new_value: `${file.originalname}: ${counts}` }]);
      }
      return report(plan, true);
    });
  }

  async function importTemplate() {
    const lists = await getLists();
    return I.buildTemplate({ kinds: lists.entry_kinds, systems: lists.systems });
  }

  return { getLists, getFleet, getBus, getEntry, getRepeats, getDailyReport, saveDailyReport, saveExpense, setTripTimes, updateTrip, getTyres, addTyres, moveTyres, returnRetread, getTripPlans, checkRepeat, readBillFields, saveEntry, voidEntry, addBus, updateBus, listBuses, getChangeLog, importWorkbook, importTemplate };
}
