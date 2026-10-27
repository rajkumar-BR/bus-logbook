// What the app can do. Each function reads from / writes to storage and applies
// the rules in logic.js. The HTTP layer (server.js) only translates requests.

import os from 'node:os';
import path from 'node:path';
import { KINDS, STATUS, DEFAULT_LISTS } from './schema.js';
import * as L from './logic.js';
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
    for (const tab of ['Buses', 'Routes', 'Route assignments', 'Daily reports', 'Trips', 'Entries', 'Parts changed', 'Workshops', 'Lists', 'Settings', 'Bus documents']) {
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
      parts: t['Parts changed'].filter(L.isActive),
      workshops: t.Workshops.map((w) => w.workshop_name).filter(Boolean),
      docs: t['Bus documents'],
      lists,
      settings: L.settingsMap(t.Settings),
    };
  }

  const activeBuses = (d) => d.buses.filter((b) => b.active !== false); // blank counts as active
  const routeName = (d, id) => (d.routes.find((r) => r.route_id === id) || {}).route_name || id || '';
  const currentRoute = (d, busNo) => routeName(d, L.routeAt(d.assignments, busNo, today()));
  const busLabel = (d, b) => `Bus ${b.bus_no}${currentRoute(d, b.bus_no) ? ` · ${currentRoute(d, b.bus_no)}` : ''}`;

  function entryTitle(e, parts) {
    if (e.kind === KINDS.SERVICE) return 'Scheduled service';
    if (e.kind === KINDS.INSPECTION) return 'Inspection';
    if (parts.length) return parts.map((p) => p.part_name).slice(0, 3).join(', ');
    return e.system || e.kind;
  }

  // ---------- reads

  async function getLists() {
    const d = await load();
    return {
      ...d.lists,
      workshops: d.workshops,
      buses: activeBuses(d).map((b) => ({ bus_no: b.bus_no, label: busLabel(d, b) })),
      aiEnabled: Boolean(readBill) && String(d.settings.ai_enabled ?? 'TRUE').toUpperCase() !== 'FALSE',
      today: today(),
    };
  }

  async function getFleet() {
    const d = await load();
    const t = today();
    const year = t.slice(0, 4);
    const rows = activeBuses(d).map((b) => {
      const be = d.entries.filter((e) => e.bus_no === b.bus_no);
      const svc = L.serviceStatus(b, be, d.settings, t);
      const spent = L.spentSinceLastService(be);
      const spentYear = be.filter((e) => e.date_in.startsWith(year)).reduce((sum, e) => sum + (Number(e.total_cost) || 0), 0);
      const f = L.findings({ bus: b, busEntries: be, busParts: d.parts.filter((p) => p.bus_no === b.bus_no), allEntries: d.entries, allParts: d.parts, activeBusCount: activeBuses(d).length, routes: d.routes, today: t });
      return {
        bus_no: b.bus_no,
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
      bus: { ...b, status: b.status || STATUS.ON_ROUTE, route: currentRoute(d, busNo) },
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
    };
  }

  async function getEntry(entryId) {
    const d = await load();
    const e = d.entries.find((x) => x.entry_id === entryId);
    if (!e) throw new UserError(`Entry ${entryId} was not found, or it has already been corrected.`, 404);
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

  async function getDailyReport(startDate = today(), endDate = startDate, busNo = '') {
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
    const days = Array.from({ length: dayCount }, (_, index) => L.addDays(from, index));
    const rows = days.flatMap((reportDate) => {
      const reports = d.dailyReports.filter((report) => report.report_date === reportDate);
      const trips = d.trips.filter((trip) => trip.trip_date === reportDate).sort((a, b) => String(a.actual_start).localeCompare(String(b.actual_start)));
      return buses.map((bus) => {
        const daily = reports.find((report) => report.bus_no === bus.bus_no);
        const busTrips = trips.filter((trip) => trip.bus_no === bus.bus_no).map((trip) => ({
          ...trip,
          photo_url: storage.fileUrl(trip.photo_link),
          timing_status: trip.on_time ? 'On time' : `Late by ${trip.late_by_minutes} min`,
        }));
        const reported = Boolean(daily);
        const lateTrips = busTrips.filter((trip) => !trip.on_time).length;
        return {
          report_date: reportDate,
          bus_no: bus.bus_no,
          driver_name: daily?.driver_name || bus.driver_name || '',
          route: currentRoute(d, bus.bus_no),
          status: !reported ? 'Not reported' : lateTrips ? 'Late' : 'On time',
          trip_count: busTrips.length,
          late_trips: lateTrips,
          income_collected: Number(daily?.income_collected) || 0,
          expenses: Number(daily?.expenses) || 0,
          net_collection: (Number(daily?.income_collected) || 0) - (Number(daily?.expenses) || 0),
          extra_km: busTrips.reduce((sum, trip) => sum + Math.max(0, Number(trip.extra_km) || 0), 0),
          trips: busTrips,
        };
      });
    });
    return {
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
    if (tripInputs.length !== 3 || photos.length !== 3) throw new UserError('Enter all three trips and attach one photo for each trip.');
    const trips = tripInputs.map((item, index) => ({
      trip_number: index + 1,
      origin: String(item.origin || '').trim(),
      destination: String(item.destination || '').trim(),
      scheduled_start: String(item.scheduled_start || '').trim(),
      actual_start: String(item.actual_start || '').trim(),
      scheduled_end: String(item.scheduled_end || '').trim(),
      actual_end: String(item.actual_end || '').trim(),
      planned_km: Number(item.planned_km),
      start_odometer_km: Number(item.start_odometer_km),
      end_odometer_km: Number(item.end_odometer_km),
      notes: String(item.notes || '').trim(),
    }));
    for (let index = 0; index < trips.length; index++) {
      const trip = trips[index];
      if (!trip.origin || !trip.destination) throw new UserError(`Enter the origin and destination for Trip ${index + 1}.`);
      if (![trip.scheduled_start, trip.actual_start, trip.scheduled_end, trip.actual_end].every(validTime)) throw new UserError(`Enter all scheduled and actual times for Trip ${index + 1}.`);
      if (![trip.planned_km, trip.start_odometer_km, trip.end_odometer_km].every(Number.isFinite) || trip.planned_km <= 0 || trip.start_odometer_km < 0 || trip.end_odometer_km <= trip.start_odometer_km) throw new UserError(`Enter a positive planned distance and increasing odometer readings for Trip ${index + 1}.`);
      if (!photos[index]?.mimetype.startsWith('image/')) throw new UserError(`Attach an image for Trip ${index + 1}.`);
      if (index > 0 && trip.start_odometer_km !== trips[index - 1].end_odometer_km) throw new UserError(`Trip ${index + 1} must start at the odometer reading where Trip ${index} ended.`);
    }
    const d = await load();
    const bus = d.buses.find((item) => item.bus_no === report.bus_no);
    if (d.dailyReports.some((item) => item.report_date === report.report_date && item.bus_no === report.bus_no)) throw new UserError(`A daily report for Bus ${report.bus_no} already exists on ${report.report_date}.`);
    const photoLinks = await Promise.all(photos.map((photo, index) => storage.saveFile(
      `Photos/Bus ${report.bus_no}/Daily trips`,
      `${report.report_date} Trip ${index + 1} ${photo.originalname}`,
      photo.buffer,
    )));
    const now = localNow();
    return storage.transact((tx) => {
      const allReports = tx.read('Daily reports');
      const reportId = `D-${report.report_date}-${report.bus_no}-${String(allReports.length + 1).padStart(3, '0')}`;
      const allTrips = tx.read('Trips');
      const savedTrips = trips.map((trip, index) => {
        const metrics = L.tripMetrics(trip);
        const tripId = `${reportId}-T${index + 1}`;
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
      tx.append('Daily reports', [{
        report_id: reportId,
        ...report,
        driver_name: report.driver_name || bus?.driver_name || '',
        entered_by: user,
        entered_at: now,
      }]);
      tx.append('Trips', savedTrips);
      tx.append('Change log', [{ timestamp: now, user, action: 'Added', tab: 'Daily reports', record_id: reportId, field: '', old_value: '', new_value: `Bus ${report.bus_no}, income ${report.income_collected}, expenses ${report.expenses}, 3 trips` }]);
      return { report_id: reportId, bus_no: report.bus_no, driver_name: report.driver_name || bus?.driver_name || '', trip_ids: savedTrips.map((trip) => trip.trip_id) };
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

  async function saveEntry(input, files = {}, { correctsId = null } = {}) {
    const d = await load();
    const { e, parts } = validate(input, d);
    let old = null;
    if (correctsId) {
      old = d.entries.find((x) => x.entry_id === correctsId);
      if (!old) throw new UserError(`Entry ${correctsId} was not found, or it has already been corrected.`, 404);
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

      // Keep the bus status in step: no date out means the bus is still in the workshop.
      const open = tx.read('Entries').filter((r) => r.bus_no === e.bus_no && L.isActive(r) && r.entry_id && !r.date_out);
      const bus = tx.read('Buses').find((b) => b.bus_no === e.bus_no);
      const want = open.length ? STATUS.IN_WORKSHOP : bus.status === STATUS.IN_WORKSHOP ? STATUS.ON_ROUTE : bus.status;
      if (want && want !== bus.status) {
        tx.update('Buses', (b) => b.bus_no === e.bus_no, { status: want });
        tx.append('Change log', [{ timestamp: now, user, action: 'Updated', tab: 'Buses', record_id: e.bus_no, field: 'status', old_value: bus.status || '', new_value: want }]);
      }

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

  return { getLists, getFleet, getBus, getEntry, getRepeats, getDailyReport, saveDailyReport, checkRepeat, readBillFields, saveEntry, addBus, listBuses };
}
