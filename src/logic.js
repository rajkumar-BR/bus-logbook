// Business rules for the logbook. Pure functions over plain row objects, with
// no Node or storage dependencies, so this file can be reused as-is in Google
// Apps Script later.
//
// Dates are 'YYYY-MM-DD' strings. Costs are numbers in rupees.

import { KINDS } from './schema.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const REPAIR_KINDS = [KINDS.REPAIR, KINDS.BREAKDOWN];

// ---------- small helpers

export const isActive = (r) => r.record_status !== 'Corrected';
export const isRepair = (e) => REPAIR_KINDS.includes(e.kind);
export const isService = (e) => e.kind === KINDS.SERVICE;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

export function toUTC(d) {
  const [y, m, day] = String(d).split('-').map(Number);
  return Date.UTC(y, m - 1, day);
}

export function daysBetween(a, b) {
  return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}

export function addDays(d, n) {
  return new Date(toUTC(d) + n * 86400000).toISOString().slice(0, 10);
}

export function shortDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${Number(day)} ${MONTHS[Number(m) - 1]} ${y}`;
}

const monthLabel = (d) => MONTHS[Number(d.split('-')[1]) - 1];

export function byDate(a, b) {
  return a.date_in < b.date_in ? -1 : a.date_in > b.date_in ? 1 : String(a.entered_at).localeCompare(String(b.entered_at));
}

export function settingsMap(rows) {
  const s = {};
  for (const r of rows) if (r.key) s[r.key] = r.value;
  return s;
}

export function listsFrom(rows) {
  const lists = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (v === '' || v === false) continue;
      (lists[k] ||= []).push(String(v));
    }
  }
  return lists;
}

export function recordsForSchool(rows, schoolId) {
  if (!Array.isArray(rows)) return [];
  if (!schoolId || String(schoolId).trim() === '') {
    return rows;
  }
  const target = String(schoolId).trim();
  return rows.filter((r) => {
    const id = String(r?.school_id ?? '').trim();
    return id === '' || id === target;
  });
}

// ---------- cost periods between scheduled services

// Splits a bus's entries into periods bounded by scheduled services. Each repair,
// breakdown or inspection cost goes into the period it falls in. The scheduled
// service's own cost is not counted in any period.
// Returns [{ start, end, total, jobs }] oldest first. start is null for costs before
// the first recorded service; end is null for the open (current) period.
export function costPeriods(busEntries) {
  const periods = [];
  let cur = { start: null, end: null, total: 0, jobs: [] };
  for (const e of [...busEntries].sort(byDate)) {
    if (isService(e)) {
      if (cur.start || cur.jobs.length) { cur.end = e; periods.push(cur); }
      cur = { start: e, end: null, total: 0, jobs: [] };
    } else {
      cur.total += num(e.total_cost);
      cur.jobs.push(e);
    }
  }
  if (cur.start || cur.jobs.length) periods.push(cur);
  return periods;
}

export function spentSinceLastService(busEntries) {
  const periods = costPeriods(busEntries);
  const open = periods[periods.length - 1];
  if (!open || open.end) return { total: 0, jobs: [], since: null };
  return { total: open.total, jobs: open.jobs, since: open.start };
}

// ---------- service due

export function latestOdometer(busEntries) {
  return busEntries.reduce((m, e) => Math.max(m, num(e.odometer_km)), 0) || null;
}

export function serviceStatus(bus, busEntries, settings, today) {
  const everyKm = num(bus.service_every_km) || num(settings.default_service_km) || 10000;
  const everyDays = num(bus.service_every_days) || num(settings.default_service_days) || 90;
  const services = busEntries.filter(isService).sort(byDate);
  const last = services[services.length - 1];
  const odo = latestOdometer(busEntries);
  if (!last) return { state: 'unknown', progress: null, everyKm, everyDays, odometer: odo, last: null };

  const kmSince = odo && num(last.odometer_km) ? odo - num(last.odometer_km) : null;
  const daysSince = daysBetween(last.date_in, today);
  const progress = Math.max(kmSince === null ? 0 : kmSince / everyKm, daysSince / everyDays);
  return {
    state: progress >= 1 ? 'overdue' : progress >= 0.85 ? 'due' : 'ok',
    progress,
    everyKm,
    everyDays,
    odometer: odo,
    last,
    kmSince,
    daysSince,
    kmLeft: kmSince === null ? null : everyKm - kmSince,
    daysLeft: everyDays - daysSince,
  };
}

// ---------- route at a date

export function routeAt(assignments, busNo, date) {
  const a = assignments.find((r) => r.bus_no === busNo && r.from_date && r.from_date <= date && (!r.to_date || r.to_date >= date));
  return a ? a.route_id : '';
}

// ---------- repeat detection

// REPEAT if the same bus + system already has 2 or more repairs/breakdowns in the
// window before this date.
export function repeatCheck(entries, { bus_no, system, date_in, exclude_entry_id }, windowDays = 180) {
  if (!bus_no || !system || !date_in) return { isRepeat: false, count: 0, previous: [] };
  const from = addDays(date_in, -windowDays);
  const previous = entries
    .filter((e) => e.bus_no === bus_no && e.system === system && isRepair(e)
      && e.entry_id !== exclude_entry_id && e.date_in >= from && e.date_in <= date_in)
    .sort(byDate);
  return { isRepeat: previous.length >= 2, count: previous.length, windowDays, previous };
}

export function repairsInLastYear(entries, today) {
  const from = addDays(today, -365);
  return entries.filter((e) => isRepair(e) && e.date_in >= from && e.date_in <= today);
}

// Bus × system repair counts for the last 12 months.
export function repeatMatrix(entries, buses, systems, today) {
  const recent = repairsInLastYear(entries, today);
  return buses.map((b) => {
    const counts = systems.map((s) => recent.filter((e) => e.bus_no === b.bus_no && e.system === s).length);
    return { bus_no: b.bus_no, counts, total: counts.reduce((a, c) => a + c, 0) };
  });
}

export function tripMetrics(trip) {
  const actualKm = Number(trip.end_odometer_km) - Number(trip.start_odometer_km);
  const plannedKm = Number(trip.planned_km);
  const departureDelay = Math.max(0, minutesBetween(trip.scheduled_start, trip.actual_start));
  const arrivalDelay = Math.max(0, minutesBetween(trip.scheduled_end, trip.actual_end));
  const lateByMinutes = Math.max(departureDelay, arrivalDelay);
  return {
    actual_km: actualKm,
    extra_km: actualKm - plannedKm,
    late_by_minutes: lateByMinutes,
    on_time: lateByMinutes === 0,
  };
}

function minutesBetween(scheduled, actual) {
  if (!/^\d{2}:\d{2}$/.test(String(scheduled)) || !/^\d{2}:\d{2}$/.test(String(actual))) return 0;
  const toMinutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  return toMinutes(actual) - toMinutes(scheduled);
}

// ---------- part life

const partKey = (p) => `${String(p.part_name).trim().toLowerCase()}|${String(p.position || '').trim().toLowerCase()}`;

// Groups a bus's part changes by part + position, oldest first, with the km each
// one lasted since the previous replacement.
export function partHistory(busParts, entriesById) {
  const groups = {};
  for (const p of busParts) {
    const e = entriesById[p.entry_id];
    if (!e || !p.part_name) continue;
    (groups[partKey(p)] ||= { part_name: p.part_name, position: p.position, system: p.system || e.system, items: [] })
      .items.push({ ...p, date_in: e.date_in, odometer_km: num(e.odometer_km) });
  }
  return Object.values(groups).map((g) => {
    g.items.sort(byDate);
    g.intervals = [];
    for (let i = 1; i < g.items.length; i++) {
      const a = g.items[i - 1], b = g.items[i];
      if (a.odometer_km && b.odometer_km) {
        g.intervals.push({ label: `${monthLabel(a.date_in)} → ${monthLabel(b.date_in)}`, km: b.odometer_km - a.odometer_km });
      }
    }
    return g;
  });
}

// Median km between replacements of the same part name across the whole fleet.
export function fleetMedianLife(allParts, entriesById, partName) {
  const byBus = {};
  for (const p of allParts) {
    if (String(p.part_name).trim().toLowerCase() !== String(partName).trim().toLowerCase()) continue;
    (byBus[p.bus_no] ||= []).push(p);
  }
  const intervals = Object.values(byBus).flatMap((ps) => partHistory(ps, entriesById).flatMap((g) => g.intervals.map((i) => i.km)));
  if (intervals.length < 2) return null;
  intervals.sort((a, b) => a - b);
  const mid = Math.floor(intervals.length / 2);
  return intervals.length % 2 ? intervals[mid] : Math.round((intervals[mid - 1] + intervals[mid]) / 2);
}

// ---------- rule-based findings ("Why does it keep coming back?")

const VAGUE = /^(worn|worn out|ok|done|replaced|changed|repaired|fixed|normal wear)\.?$/i;

export function findings({ bus, busEntries, busParts, allEntries, allParts, activeBusCount, routes, today }) {
  const out = [];
  const entriesById = Object.fromEntries(allEntries.map((e) => [e.entry_id, e]));
  const recent = repairsInLastYear(busEntries, today);
  const fleetRecent = repairsInLastYear(allEntries, today);
  const routeName = (id) => (routes.find((r) => r.route_id === id) || {}).route_name || id;
  const watch = [];

  const systems = [...new Set(recent.map((e) => e.system).filter(Boolean))];
  for (const sys of systems) {
    const jobs = recent.filter((e) => e.system === sys);
    if (jobs.length < 3) continue;
    const fleetAvg = fleetRecent.filter((e) => e.system === sys).length / Math.max(1, activeBusCount);
    watch.push({ system: sys, count: jobs.length });
    out.push({
      level: 'crit',
      title: `${sys} repaired ${jobs.length} times in 12 months`,
      detail: `The fleet average is ${fleetAvg.toFixed(1)} per bus over the same period.`,
    });
    // Route link: only meaningful if the bus ran more than one route in the year;
    // otherwise, point to the route's own notes (e.g. a steep descent) if any.
    const routeIds = jobs.map((e) => e.route_at_time).filter(Boolean);
    const routesThisYear = new Set(busEntries.filter((e) => e.date_in >= addDays(today, -365)).map((e) => e.route_at_time).filter(Boolean));
    if (routeIds.length >= 3) {
      const top = mode(routeIds);
      const share = top.count / jobs.length;
      const notes = (routes.find((r) => r.route_id === top.value) || {}).notes;
      if (routesThisYear.size >= 2 && share >= 0.75) {
        out.push({
          level: 'crit',
          title: `${share === 1 ? 'All' : 'Most'} ${sys.toLowerCase()} repairs happened on one route`,
          detail: `${top.count} of ${jobs.length} were while the bus ran ${routeName(top.value)}${notes ? ` (${notes})` : ''}. The route may be part of the cause.`,
        });
      } else if (routesThisYear.size === 1 && notes) {
        out.push({
          level: 'minor',
          title: `Runs ${routeName(top.value)} all year`,
          detail: `Route notes: ${notes}. Check whether the route explains the ${sys.toLowerCase()} wear.`,
        });
      }
    }
  }

  const groups = partHistory(busParts, entriesById);
  let lifeChart = null;
  for (const g of groups) {
    if (g.items.length < 3) continue;
    const kms = g.intervals.map((i) => i.km);
    const shrinking = kms.length >= 2 && kms.every((k, i) => i === 0 || k < kms[i - 1]);
    const median = fleetMedianLife(allParts.filter((p) => p.bus_no !== bus.bus_no), entriesById, g.part_name);
    if (shrinking) {
      out.push({
        level: 'crit',
        title: `${g.part_name} is lasting less each time`,
        detail: `Km between replacements: ${kms.map((k) => k.toLocaleString('en-IN')).join(' → ')}.`,
      });
    }
    const refitted = g.items.filter((p) => p.removed_part_no && p.removed_part_no === p.fitted_part_no).length;
    if (refitted >= 2) {
      out.push({
        level: 'crit',
        title: `The same part was fitted ${refitted} times`,
        detail: `${g.part_name} ${g.items[0].removed_part_no} went back in after failing. A different or heavier-duty part may be needed.`,
      });
    }
    if (!lifeChart || g.items.length > lifeChart.count) {
      lifeChart = { label: `${g.part_name}${g.position ? ` (${g.position})` : ''}: km between replacements`, intervals: g.intervals, fleetMedian: median, count: g.items.length };
    }
  }

  const batteries = busParts.filter((p) => /batter/i.test(p.part_name) && (entriesById[p.entry_id] || {}).date_in >= addDays(today, -365));
  const mentions = (re) => busEntries.some((e) => re.test(`${e.problem_reported} ${e.root_cause}`)) || busParts.some((p) => re.test(p.part_name));
  if (batteries.length >= 2 && !mentions(/alternator|charging/i)) {
    out.push({ level: 'crit', title: `${batteries.length} batteries in 12 months, alternator never checked`, detail: 'Test the alternator and look for a power drain before replacing the battery again.' });
  }
  const tyreGroups = groups.filter((g) => /tyre|tire/i.test(g.part_name) && g.items.length >= 2);
  if (tyreGroups.length && !mentions(/alignment/i)) {
    const g = tyreGroups[0];
    out.push({ level: 'crit', title: `${g.part_name}${g.position ? ` (${g.position})` : ''} replaced ${g.items.length} times, no wheel alignment logged`, detail: 'Repeated wear in one position usually points to alignment or steering, not the tyre.' });
  }

  const vague = recent.filter((e) => !e.root_cause || e.root_cause.trim().length < 12 || VAGUE.test(e.root_cause.trim()));
  if (vague.length >= 2) {
    out.push({ level: 'minor', title: `Root cause missing on ${vague.length} repairs`, detail: `${vague.map((e) => shortDate(e.date_in)).join(', ')}. Without a cause, patterns are hard to spot.` });
  }

  watch.sort((a, b) => b.count - a.count);
  return { findings: out, lifeChart, watch };
}

function mode(arr) {
  const counts = {};
  arr.forEach((v) => { counts[v] = (counts[v] || 0) + 1; });
  const [value, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { value, count };
}
