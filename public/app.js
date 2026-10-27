// Bus Logbook screens. Plain JavaScript, no build step.
// Each screen fetches from the local API and renders into <main>.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const main = $('#main');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const kmText = (n) => (n === null || n === undefined || n === '' ? '—' : `${Number(n).toLocaleString('en-IN')} km`);
const fullDate = (d) => (d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : '—');
const dayMonth = (d) => (d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}` : '');
const kindKey = (k) => ({ Breakdown: 'breakdown', Repair: 'repair', 'Scheduled service': 'service', Inspection: 'inspection' }[k] || 'inspection');
const STATUS_PILL = { 'On route': 'ok', 'In workshop': 'crit', 'Out of service': 'warn' };
const pill = (status) => `<span class="pill ${STATUS_PILL[status] || 'warn'}"><i></i>${esc(status)}</span>`;
const REPEAT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/></svg>';

async function api(url, opts) {
  let res;
  try {
    res = await fetch(url, { ...(opts || {}), credentials: 'same-origin' });
  } catch {
    throw new Error('Cannot reach the Bus Logbook server. Check that its terminal window is still running.');
  }
  let body = {};
  try { body = await res.json(); } catch { /* empty body */ }
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error(body.error || 'Please log in as the school admin.');
  }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
}
const postJSON = (url, data) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

let listsCache = null;
async function getLists(force = false) {
  if (!listsCache || force) listsCache = await api('/api/lists');
  return listsCache;
}

// ---------- router

const views = { fleet: viewFleet, daily: viewDaily, bus: viewBus, repeats: viewRepeats, new: viewNew, correct: viewCorrect, buses: viewBuses };
const NAV_FOR = { fleet: '#fleet', daily: '#daily', bus: '#fleet', repeats: '#repeats', new: '#new', correct: '#new', buses: '#buses' };

async function router() {
  const [name, arg] = location.hash.slice(1).split('/');
  const view = views[name] ? name : 'fleet';
  $$('.nav button').forEach((b) => b.toggleAttribute('aria-current', b.dataset.go === NAV_FOR[view]));
  $$('.nav button[aria-current]').forEach((b) => b.setAttribute('aria-current', 'page'));
  main.innerHTML = '<p class="loading">Loading…</p>';
  try {
    await views[view](arg ? decodeURIComponent(arg) : undefined);
  } catch (err) {
    main.innerHTML = `<div class="topbar"><h1>Something went wrong</h1></div><div class="error">${esc(err.message)}</div>`;
  }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', router);
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { location.hash = go.dataset.go; }
});

// ---------- Fleet

function serviceCell(s, status) {
  if (s.state === 'unknown') return '<div class="svc"><div class="bar"><span style="width:0"></span></div><small>No service recorded yet</small></div>';
  const pct = Math.min(100, Math.round((s.progress || 0) * 100));
  const cls = status === 'In workshop' || s.state === 'overdue' ? 'crit' : s.state === 'due' ? 'warn' : '';
  const parts = [];
  if (s.kmLeft !== null) parts.push(`${s.kmLeft.toLocaleString('en-IN')} km`);
  parts.push(`${s.daysLeft} days`);
  let text;
  if (s.state === 'overdue') {
    const over = [];
    if (s.kmLeft !== null && s.kmLeft < 0) over.push(`${(-s.kmLeft).toLocaleString('en-IN')} km`);
    if (s.daysLeft < 0) over.push(`${-s.daysLeft} day${s.daysLeft === -1 ? '' : 's'}`);
    text = `Overdue by ${over.join(' and ') || '0 days'}`;
  } else text = s.state === 'due' ? `Due in ${parts.join(' or ')}` : `${parts.join(' or ')} to go`;
  return `<div class="svc"><div class="bar"><span class="${cls}" style="width:${pct}%"></span></div><small>${esc(text)}</small></div>`;
}

async function viewFleet() {
  const d = await api('/api/fleet');
  const head = `<div class="topbar"><div><h1>Fleet today</h1><p class="sub">${fullDate(d.today)} · click a bus to open its full history</p></div>
    <div class="head-actions"><a class="btn" href="#new">Enter a bill</a></div></div>`;
  if (!d.buses.length) {
    main.innerHTML = `${head}<div class="panel empty"><b>No buses yet</b><span>Add your buses first, then enter bills against them.</span><a class="btn" href="#buses">Add buses</a></div>`;
    return;
  }
  const s = d.summary;
  main.innerHTML = `${head}
    <div class="strip">
      <div><div class="n">${s.onRoute}</div><div class="d">On route</div></div>
      <div><div class="n" style="color:var(--crit)">${s.inWorkshop}</div><div class="d">In workshop</div></div>
      <div><div class="n" style="color:var(--warn)">${s.dueSoon}</div><div class="d">Service due or overdue</div></div>
      <div><div class="n">${s.repairs12}</div><div class="d">Repairs in last 12 months</div></div>
      <div><div class="n">${inr(s.spendYear)}</div><div class="d">Spent on maintenance in ${s.year}</div></div>
    </div>
    <div class="panel">
      <div class="panel-h"><h2>All buses</h2><span class="hint">Service due: every 10,000 km or 90 days unless set per bus</span></div>
      <div class="tbl-wrap"><table class="fleet">
        <thead><tr><th>Bus</th><th>Route</th><th>Status</th><th>Odometer</th><th>Last service</th><th>Next service</th><th>Spent in ${esc(s.year)}</th><th>Repairs · 12 mo</th><th>Watch</th></tr></thead>
        <tbody>${d.buses.map((b) => `
          <tr data-go="#bus/${encodeURIComponent(b.bus_no)}" tabindex="0">
            <td><span class="busno">${esc(b.bus_no)}</span></td>
            <td>${esc(b.route || '—')}<div class="route">${esc([b.make_model, b.year].filter(Boolean).join(' · '))}</div></td>
            <td>${pill(b.status)}</td>
            <td class="mono">${kmText(b.odometer)}</td>
            <td>${fullDate(b.last_service)}</td>
            <td>${serviceCell(b.service, b.status)}</td>
            <td class="mono">${inr(b.spent_year)}</td>
            <td class="mono">${b.repairs12}</td>
            <td>${b.watch.length ? `<span class="flag">${REPEAT_ICON}${esc(b.watch[0])}</span>` : '<span class="hint">—</span>'}</td>
          </tr>`).join('')}</tbody>
      </table></div>
    </div>`;
  $$('tbody tr[data-go]', main).forEach((tr) => tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') location.hash = tr.dataset.go; }));
}

// ---------- Daily trip report

async function viewDaily(range = '') {
  const todayDate = new Date().toLocaleDateString('en-CA');
  const [rangePart = '', busPart = ''] = range ? range.split('!') : [];
  const [fromDate = todayDate, toDate = todayDate] = rangePart ? rangePart.split('~') : [];
  const selectedBus = busPart;
  const [report, lists] = await Promise.all([
    api(`/api/reports/daily?start_date=${encodeURIComponent(fromDate)}&end_date=${encodeURIComponent(toDate)}&bus_no=${encodeURIComponent(selectedBus)}`),
    getLists(true),
  ]);
  main.innerHTML = `
    <div class="topbar"><div><h1>Daily bus reports</h1><p class="sub">One row per bus per calendar day · inclusive date range, up to 366 days</p></div></div>
    <form class="report-filter" id="daily-filter"><label for="report-bus">Bus</label><select id="report-bus"><option value="">All buses</option>${lists.buses.map((bus) => `<option value="${esc(bus.bus_no)}" ${bus.bus_no === selectedBus ? 'selected' : ''}>${esc(bus.label)}</option>`).join('')}</select><label for="report-from">From</label><input id="report-from" type="date" max="${lists.today}" value="${esc(report.from)}" required><label for="report-to">To</label><input id="report-to" type="date" max="${lists.today}" value="${esc(report.to)}" required><button class="btn" type="submit">View report</button></form>
    <div class="strip">
      <div><div class="n">${report.summary.reported_bus_days}/${report.summary.total_bus_days}</div><div class="d">Bus-days reported</div></div>
      <div><div class="n" style="color:var(--warn)">${report.summary.missing_report_days}</div><div class="d">Bus-days without reports</div></div>
      <div><div class="n" style="color:var(--crit)">${report.summary.late_buses}</div><div class="d">Buses with late trips</div></div>
      <div><div class="n">${kmText(report.summary.extra_km)}</div><div class="d">Extra km over plan</div></div>
      <div><div class="n">${inr(report.summary.income_collected)}</div><div class="d">Income collected</div></div>
      <div><div class="n">${inr(report.summary.expenses)}</div><div class="d">Daily expenses</div></div>
    </div>
    <div class="panel report-panel">
      <div class="panel-h"><h2>${selectedBus ? `Bus ${esc(selectedBus)} daily totals` : 'Daily totals by bus'} · ${fullDate(report.from)} to ${fullDate(report.to)}</h2><span class="hint">Net = income collected − expenses · missing reports include weekends and holidays</span></div>
      <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Bus / driver</th><th>Report status</th><th>Income</th><th>Expenses</th><th>Net</th><th>Trips logged</th><th>Late trips</th><th>Extra km</th></tr></thead>
      <tbody>${report.buses.map((bus) => `<tr>
        <td>${fullDate(bus.report_date)}</td><td><button class="text-link" data-go="#bus/${encodeURIComponent(bus.bus_no)}">Bus ${esc(bus.bus_no)}</button><div class="hint">${esc(bus.driver_name || 'Driver not recorded')}</div></td>
        <td><span class="report-status ${bus.status === 'On time' ? 'ontime' : bus.status === 'Late' ? 'late' : 'missing'}">${esc(bus.status)}</span></td>
        <td class="mono">${inr(bus.income_collected)}</td><td class="mono">${inr(bus.expenses)}</td><td class="mono">${inr(bus.net_collection)}</td>
        <td>${bus.trip_count}/3</td><td>${bus.late_trips}</td><td class="mono">${kmText(bus.extra_km)}</td>
      </tr>`).join('')}</tbody></table></div>
    </div>
    <div class="panel report-panel">
      <div class="panel-h"><h2>Trip legs · ${fullDate(report.from)} to ${fullDate(report.to)}</h2><span class="hint">Odometer readings should continue from one trip into the next</span></div>
      <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Bus / driver</th><th>Trip</th><th>From → To</th><th>Start → End km</th><th>Actual / Planned</th><th>Extra km</th><th>Scheduled / Actual</th><th>Image</th></tr></thead><tbody>
      ${report.buses.flatMap((bus) => bus.trips.map((trip) => `<tr>
        <td>${fullDate(bus.report_date)}</td><td>Bus ${esc(bus.bus_no)}<div class="hint">${esc(bus.driver_name)}</div></td><td>${trip.trip_number}</td><td>${esc(trip.origin)} → ${esc(trip.destination)}</td>
        <td class="mono">${Number(trip.start_odometer_km).toLocaleString('en-IN')} → ${Number(trip.end_odometer_km).toLocaleString('en-IN')}</td>
        <td class="mono">${kmText(trip.actual_km)} / ${kmText(trip.planned_km)}</td><td class="mono">${trip.extra_km > 0 ? `+${Number(trip.extra_km).toLocaleString('en-IN')} km` : `${Number(trip.extra_km).toLocaleString('en-IN')} km`}</td>
        <td>${esc(trip.scheduled_start)}–${esc(trip.scheduled_end)}<div class="hint">${esc(trip.actual_start)}–${esc(trip.actual_end)} · ${esc(trip.timing_status)}</div></td>
        <td>${trip.photo_url ? `<a href="${esc(trip.photo_url)}" target="_blank" rel="noopener"><img class="trip-thumb" src="${esc(trip.photo_url)}" alt="Bus ${esc(bus.bus_no)} trip ${trip.trip_number}" loading="lazy"></a>` : '—'}</td>
      </tr>`)).join('') || '<tr><td colspan="9" class="hint">No trip legs have been reported for this date range.</td></tr>'}
      </tbody></table></div>
    </div>
    <div class="panel report-panel" id="trip-entry">
      <div class="panel-h"><h2>Record a bus day</h2><span class="hint">Enter daily money totals once and attach one image for each trip</span></div>
      <form class="trip-form" id="trip-form">
        <div class="error full" id="trip-error" hidden></div>
        <div class="field"><label for="trip-bus">Bus</label><select id="trip-bus" required><option value="">Choose a bus</option>${lists.buses.map((bus) => `<option value="${esc(bus.bus_no)}">${esc(bus.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="trip-date">Date</label><input id="trip-date" type="date" max="${lists.today}" value="${esc(report.to)}" required></div>
        <div class="field"><label for="trip-driver">Driver name</label><input id="trip-driver" required></div>
        <div class="field"><label for="daily-income">Income collected today (₹)</label><input id="daily-income" type="number" min="0" step="0.01" value="0" required></div>
        <div class="field"><label for="daily-expenses">Expenses today (₹)</label><input id="daily-expenses" type="number" min="0" step="0.01" value="0" required></div>
        <div class="field full"><label for="daily-notes">Daily notes</label><textarea id="daily-notes" placeholder="Fuel, tolls, delay reasons, or other notes"></textarea></div>
        ${[1, 2, 3].map((number) => `<fieldset class="trip-leg full"><legend>Trip ${number}</legend><div class="trip-leg-grid">
          <div class="field"><label for="trip-${number}-origin">From</label><input id="trip-${number}-origin" placeholder="${number === 1 ? 'Source' : `Destination ${number - 1}`}" required></div>
          <div class="field"><label for="trip-${number}-destination">To</label><input id="trip-${number}-destination" placeholder="Destination ${number}" required></div>
          <div class="field"><label for="trip-${number}-planned">Planned km</label><input id="trip-${number}-planned" type="number" min="0.1" step="0.1" required></div>
          <div class="field"><label for="trip-${number}-start-odo">Start km</label><input id="trip-${number}-start-odo" type="number" min="0" step="0.1" required></div>
          <div class="field"><label for="trip-${number}-end-odo">End km</label><input id="trip-${number}-end-odo" type="number" min="0" step="0.1" required></div>
          <div class="field"><label for="trip-${number}-photo">Trip image</label><input id="trip-${number}-photo" type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/heic" required></div>
          <div class="field"><label for="trip-${number}-scheduled-start">Scheduled start</label><input id="trip-${number}-scheduled-start" type="time" required></div>
          <div class="field"><label for="trip-${number}-actual-start">Actual start</label><input id="trip-${number}-actual-start" type="time" required></div>
          <div class="field"><label for="trip-${number}-scheduled-end">Scheduled end</label><input id="trip-${number}-scheduled-end" type="time" required></div>
          <div class="field"><label for="trip-${number}-actual-end">Actual end</label><input id="trip-${number}-actual-end" type="time" required></div>
        </div></fieldset>`).join('')}
        <div class="btns full"><button class="btn" type="submit" id="trip-save">Save daily report</button></div>
      </form>
    </div>`;

  $('#daily-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    const bus = $('#report-bus').value;
    const start = $('#report-from').value;
    const end = $('#report-to').value;
    if (!start || !end || start > end) {
      toast('Choose a valid range: From must be on or before To.');
      return;
    }
    location.hash = `#daily/${encodeURIComponent(`${start}~${end}!${bus}`)}`;
  });
  $('#trip-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('#trip-error');
    error.hidden = true;
    const report = {
      bus_no: $('#trip-bus').value,
      report_date: $('#trip-date').value,
      driver_name: $('#trip-driver').value.trim(),
      income_collected: $('#daily-income').value,
      expenses: $('#daily-expenses').value,
      notes: $('#daily-notes').value.trim(),
      trips: [1, 2, 3].map((number) => ({
        origin: $(`#trip-${number}-origin`).value.trim(),
        destination: $(`#trip-${number}-destination`).value.trim(),
        planned_km: $(`#trip-${number}-planned`).value,
        start_odometer_km: $(`#trip-${number}-start-odo`).value,
        end_odometer_km: $(`#trip-${number}-end-odo`).value,
        scheduled_start: $(`#trip-${number}-scheduled-start`).value,
        actual_start: $(`#trip-${number}-actual-start`).value,
        scheduled_end: $(`#trip-${number}-scheduled-end`).value,
        actual_end: $(`#trip-${number}-actual-end`).value,
      })),
    };
    const data = new FormData();
    data.append('report', JSON.stringify(report));
    [1, 2, 3].forEach((number) => data.append('photos', $(`#trip-${number}-photo`).files[0]));
    const button = $('#trip-save');
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      const saved = await api('/api/reports/daily', { method: 'POST', body: data });
      toast(`Saved daily report for Bus ${saved.bus_no}.`);
      location.hash = `#daily/${encodeURIComponent(`${report.report_date}~${report.report_date}`)}`;
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      button.disabled = false;
      button.textContent = 'Save daily report';
    }
  });
}

// ---------- Bus history

function lifeChart(chart) {
  const life = chart.intervals;
  const avg = chart.fleetMedian;
  const W = 320, rowH = 34, top = 8, left = 82, right = 52, H = top + life.length * rowH + (avg ? 30 : 8);
  const max = Math.max(avg || 0, ...life.map((l) => l.km)) * 1.05 || 1;
  const x = (v) => left + ((W - left - right) * v) / max;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(chart.label)}">`;
  life.forEach((l, i) => {
    const y = top + i * rowH;
    s += `<text x="${left - 8}" y="${y + 15}" text-anchor="end">${esc(l.label)}</text>
      <rect x="${left}" y="${y + 4}" width="${Math.max(4, x(l.km) - left)}" height="16" rx="3" fill="var(--h3)"><title>${esc(l.label)}: ${l.km.toLocaleString('en-IN')} km</title></rect>
      <text class="val" x="${x(l.km) + 6}" y="${y + 16}">${l.km.toLocaleString('en-IN')}</text>`;
  });
  if (avg) {
    const ax = x(avg), bot = top + life.length * rowH;
    s += `<line x1="${ax}" x2="${ax}" y1="${top}" y2="${bot}" stroke="var(--ink)" stroke-width="1.5" stroke-dasharray="3 3"/>
      <text x="${Math.min(ax, W - 4)}" y="${bot + 16}" text-anchor="end">Fleet median ${avg.toLocaleString('en-IN')} km</text>`;
  }
  return s + '</svg>';
}

function eventItem(e) {
  const k = kindKey(e.kind);
  const parts = e.parts.length ? `<dt>What changed</dt><dd><ul class="parts">${e.parts.map((p) => `<li>${esc(p.part_name)}${p.position ? ` <span class="hint">(${esc(p.position)})</span>` : ''}
      ${p.removed_part_no ? `<span class="pn old">${esc(p.removed_part_no)}</span> →` : ''} ${p.fitted_part_no ? `<span class="pn">${esc(p.fitted_part_no)}</span>` : ''}
      ${p.part_cost !== '' ? `<span class="hint">${inr(p.part_cost)}</span>` : ''}</li>`).join('')}</ul></dd>` : '';
  const links = [
    e.bill_url ? `<a href="${esc(e.bill_url)}" target="_blank" rel="noopener">View bill</a>` : '<span class="hint">No bill attached</span>',
    ...e.photo_urls.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">Photo ${i + 1}</a>`),
    `<button type="button" data-go="#correct/${encodeURIComponent(e.entry_id)}">Correct this entry</button>`,
  ];
  return `<li class="ev" data-kind="${k}">
    <div class="when"><b>${dayMonth(e.date_in)}</b><span>${e.date_in.slice(0, 4)}</span></div>
    <div class="rail"><span class="dot t-${k}"></span></div>
    <div class="body">
      <div class="ev-top"><span class="tag t-${k}">${esc(e.kind)}</span><span class="ev-title">${esc(e.title)}</span>${e.is_repeat ? '<span class="repeat">↻ Repeat</span>' : ''}</div>
      <dl class="kv">
        <dt>Why it came in</dt><dd>${esc(e.problem_reported || '—')}</dd>
        ${parts}
        <dt>Finding</dt><dd>${esc(e.root_cause || '—')}</dd>
      </dl>
      ${e.between ? `<div class="between">Repairs since the previous service${e.between.since ? ` (${fullDate(e.between.since)})` : ''}: <b>${inr(e.between.total)}</b> across ${e.between.jobs} job${e.between.jobs === 1 ? '' : 's'}</div>` : ''}
      <div class="ev-meta"><span class="mono">${kmText(e.odometer_km)}</span>${e.workshop ? `<span>${esc(e.workshop)}${e.bill_no ? ` · bill ${esc(e.bill_no)}` : ''}</span>` : ''}<span>${inr(e.total_cost)}</span>
        <span>${e.date_out ? `Off road: ${e.days_off_road === 0 ? 'same day' : `${e.days_off_road} day${e.days_off_road === 1 ? '' : 's'}`}` : 'Still in workshop'}</span>
        ${e.route_name ? `<span>Route: ${esc(e.route_name)}</span>` : ''}<span class="mono">${esc(e.entry_id)}</span></div>
      <div class="ev-links">${links.join('')}</div>
    </div></li>`;
}

async function viewBus(busNo) {
  const d = await api(`/api/buses/${encodeURIComponent(busNo)}`);
  const b = d.bus, f = d.facts;
  const facts = [
    ['Odometer', kmText(f.odometer)],
    ['Last service', fullDate(f.last_service)],
    ['Spent since last service', inr(f.spent_since_service)],
    [`Spent in ${d.today.slice(0, 4)}`, inr(f.spent_year)],
    ['Repairs · 12 mo', f.repairs12],
    ['Fitness certificate', f.fitness_until ? `Valid till ${fullDate(f.fitness_until)}` : 'Not recorded'],
    ['Insurance', f.insurance_until ? `Valid till ${fullDate(f.insurance_until)}` : 'Not recorded'],
  ];
  const sp = d.spending;
  const maxT = Math.max(1, ...sp.periods.map((p) => p.total));
  const spendHTML = !d.entries.length ? '<p class="hint" style="margin:0">No entries yet.</p>' : `
    <div class="spend-now"><div><div class="label">${sp.current.since ? `Since last service (${fullDate(sp.current.since)})` : 'No scheduled service recorded yet'}</div><div class="big">${inr(sp.current.total)}</div></div>
      <span class="hint">${sp.current.jobs.length} job${sp.current.jobs.length === 1 ? '' : 's'}${sp.current.jobs.length ? ': ' + esc(sp.current.jobs.join(' · ').toLowerCase()) : ''}</span></div>
    ${sp.periods.length ? `<div><div class="label" style="margin-bottom:6px">Repair spend in each service period</div>
      <div style="display:flex;flex-direction:column;gap:6px">${sp.periods.slice().reverse().map((p) => `<div class="sp-row" title="${p.jobs} job${p.jobs === 1 ? '' : 's'}"><span>${p.from ? dayMonth(p.from) : 'Start'} → ${p.to ? dayMonth(p.to) : 'today'}</span><div class="bar"><span style="width:${((p.total / maxT) * 100).toFixed(0)}%"></span></div><b>${inr(p.total)}</b></div>`).join('')}</div>
      <p class="hint" style="margin:8px 0 0">Excludes the cost of the scheduled service itself.</p></div>` : ''}`;
  const whyHTML = d.findings.length || d.lifeChart ? `
    ${d.findings.map((x) => `<div class="finding ${x.level === 'minor' ? 'minor' : ''}"><b>${esc(x.title)}</b><p>${esc(x.detail)}</p></div>`).join('')}
    ${d.lifeChart && d.lifeChart.intervals.length ? `<div><div class="label" style="margin-bottom:6px">${esc(d.lifeChart.label)}</div>${lifeChart(d.lifeChart)}</div>` : ''}`
    : '<div class="finding minor" style="border-left-color:var(--ok)"><b>No repeat problems</b><p>No part or system has needed repeated repairs in the last 12 months.</p></div>';

  main.innerHTML = `
    <div class="topbar"><button class="back" data-go="#fleet">← All buses</button></div>
    <div class="bus-head">
      <div class="bus-plate">${esc(b.bus_no)}</div>
      <div><h1>Bus ${esc(b.bus_no)}${b.route ? ` · ${esc(b.route)}` : ''}</h1>
        <p class="sub">${esc([b.make_model, b.year, b.seats ? `${b.seats} seats` : '', b.reg_no, b.driver_name ? `Driver ${b.driver_name}` : ''].filter(Boolean).join(' · '))}</p>
        <div style="margin-top:6px">${pill(b.status)}</div></div>
      <div class="head-actions"><a class="btn" href="#new/${encodeURIComponent(b.bus_no)}">Enter a bill for this bus</a></div>
    </div>
    <div class="facts">${facts.map(([k, v]) => `<div><div class="label">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>
    ${d.tyreHistory.length ? `<div class="panel report-panel"><div class="panel-h"><h2>Tyre replacement history</h2><span class="hint">Distance from each recorded fitment to its next recorded replacement</span></div><div class="tbl-wrap"><table><thead><tr><th>Tyre / position</th><th>Changed on</th><th>Odometer at change</th><th>Km survived</th><th>Replaced on</th></tr></thead><tbody>${d.tyreHistory.map((tyre) => `<tr><td>${esc(tyre.part_name)}${tyre.position ? `<div class="hint">${esc(tyre.position)}</div>` : ''}</td><td>${fullDate(tyre.date)}</td><td class="mono">${kmText(tyre.odometer_km)}</td><td class="mono">${tyre.km_survived === null ? '<span class="hint">Awaiting next recorded change</span>' : kmText(tyre.km_survived)}</td><td>${fullDate(tyre.replaced_on)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <div class="detail">
      <div class="panel">
        <div class="panel-h"><h2>Service history</h2>
          <div class="filters" id="ev-filters">
            ${[['all', 'All'], ['breakdown', 'Breakdowns'], ['repair', 'Repairs'], ['service', 'Scheduled service'], ['inspection', 'Inspections']].map(([k, l], i) => `<button class="fbtn" aria-pressed="${i === 0}" data-f="${k}">${l}</button>`).join('')}
          </div></div>
        ${d.entries.length ? `<ol class="timeline" id="timeline">${d.entries.map(eventItem).join('')}</ol><p class="hint" id="tl-empty" style="padding:0 16px 16px" hidden>No entries of this type.</p>`
          : `<div class="empty"><b>No entries yet</b><span>Enter the first bill for this bus.</span><a class="btn" href="#new/${encodeURIComponent(b.bus_no)}">Enter a bill</a></div>`}
      </div>
      <div class="right">
        <div class="panel"><div class="panel-h"><h2>Spending between services</h2></div><div class="spend">${spendHTML}</div></div>
        <div class="panel"><div class="panel-h"><h2>Why does it keep coming back?</h2></div><div class="why">${whyHTML}</div></div>
      </div>
    </div>`;
  const filters = $('#ev-filters');
  filters.addEventListener('click', (e) => {
    const btn = e.target.closest('.fbtn');
    if (!btn) return;
    $$('.fbtn', filters).forEach((x) => x.setAttribute('aria-pressed', x === btn));
    let shown = 0;
    $$('#timeline .ev').forEach((li) => { li.hidden = btn.dataset.f !== 'all' && li.dataset.kind !== btn.dataset.f; if (!li.hidden) shown++; });
    const empty = $('#tl-empty');
    if (empty) empty.hidden = shown > 0;
  });
}

// ---------- Repeat repairs

async function viewRepeats() {
  const d = await api('/api/repeats');
  const level = (v) => Math.min(v, 4);
  main.innerHTML = `
    <div class="topbar"><div><h1>Repeat repairs</h1><p class="sub">Which buses keep failing, and on which part · last 12 months</p></div></div>
    ${d.matrix.length ? `
    <div class="panel">
      <div class="panel-h"><h2>Repairs by bus and system</h2>
        <div class="legend">Repairs <i style="background:var(--h0)"></i>0 <i style="background:var(--h1)"></i>1 <i style="background:var(--h2)"></i>2 <i style="background:var(--h3)"></i>3 <i style="background:var(--h4)"></i>4+</div></div>
      <div class="heat-wrap"><table class="heat" id="heat">
        <thead><tr><th></th>${d.systems.map((s) => `<th>${esc(s)}</th>`).join('')}<th>Total</th></tr></thead>
        <tbody>${d.matrix.map((r) => `<tr data-go="#bus/${encodeURIComponent(r.bus_no)}" style="cursor:pointer"><th class="rowh"><span class="busno" style="font-size:15px">${esc(r.bus_no)}</span></th>
          ${r.counts.map((v, i) => `<td class="l${level(v)}" data-tip="Bus ${esc(r.bus_no)} · ${esc(d.systems[i])}: ${v} repair${v === 1 ? '' : 's'} in 12 months">${v || '·'}</td>`).join('')}
          <td class="tot mono">${r.total}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>
    ${d.patterns.length ? `<div class="patterns">${d.patterns.map((p) => `<div class="panel pat"><span class="label">Repeat pattern</span><div class="big">${esc(p.headline)}</div><p class="hint" style="margin:0">${esc(p.detail)}</p><button class="back" data-go="#bus/${encodeURIComponent(p.bus_no)}">Open Bus ${esc(p.bus_no)} →</button></div>`).join('')}</div>`
      : '<p class="hint">No bus has had the same system repaired 3 or more times in the last 12 months.</p>'}`
    : '<div class="panel empty"><b>No buses yet</b><a class="btn" href="#buses">Add buses</a></div>'}`;
  const heat = $('#heat');
  if (!heat) return;
  const tip = $('#tip');
  heat.addEventListener('mousemove', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    tip.textContent = t.dataset.tip + ' · click to open';
    tip.hidden = false;
    tip.style.left = Math.min(e.clientX + 12, innerWidth - 250) + 'px';
    tip.style.top = e.clientY + 14 + 'px';
  });
  heat.addEventListener('mouseleave', () => { tip.hidden = true; });
}

// ---------- Enter a bill / correct an entry

function viewNew(busNo) { return entryForm({ bus_no: busNo }); }

async function viewCorrect(entryId) {
  const entry = await api(`/api/entries/${encodeURIComponent(entryId)}`);
  return entryForm(entry, entryId);
}

function partRow(p = {}) {
  return `<div class="partrow withrm">
    <input aria-label="Part" data-p="part_name" placeholder="e.g. Front brake pads" value="${esc(p.part_name)}">
    <input aria-label="Position" data-p="position" placeholder="Front-left" value="${esc(p.position)}">
    <input aria-label="Removed part no." data-p="removed_part_no" class="mono" value="${esc(p.removed_part_no)}">
    <input aria-label="Fitted part no." data-p="fitted_part_no" class="mono" value="${esc(p.fitted_part_no)}">
    <input aria-label="Part cost" data-p="part_cost" class="mono" inputmode="numeric" value="${esc(p.part_cost)}">
    <input aria-label="Warranty until" data-p="warranty_until" type="date" value="${esc(p.warranty_until)}">
    <button type="button" class="rm" aria-label="Remove this part">×</button></div>`;
}

async function entryForm(e, correctsId = null) {
  const lists = await getLists(true);
  if (!lists.buses.length) {
    main.innerHTML = '<div class="topbar"><h1>Enter a bill</h1></div><div class="panel empty"><b>Add a bus first</b><span>Bills are always entered against a bus.</span><a class="btn" href="#buses">Add buses</a></div>';
    return;
  }
  const v = (k) => esc(e[k] ?? '');
  const kind = e.kind || 'Repair';
  main.innerHTML = `
    <div class="topbar"><div><h1>${correctsId ? `Correct entry ${esc(correctsId)}` : 'Enter a service or repair'}</h1>
      <p class="sub">${correctsId ? 'Fix any mistakes and save. The original stays in the Change log.' : 'From the bill and details the driver hands in'}</p></div></div>
    <form class="panel form" id="entryform" novalidate>
      <div class="error full field" id="form-error" hidden></div>
      ${correctsId ? `<div class="correct-note">Saving creates a corrected copy of ${esc(correctsId)} and marks the original as "Corrected". Nothing is deleted.</div>` : ''}
      <div class="step"><span>1</span>Upload the bill <small>${correctsId ? 'optional: only if you want to replace it' : 'from the driver'}</small></div>
      <div class="drop" id="drop">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M13 18v-6M10.5 14.5 13 12l2.5 2.5"/></svg>
        <b>Drag the bill here, or choose a file</b>
        <span class="hint">A phone photo, a scan or a PDF · JPG, PNG or PDF, up to 10 MB</span>
        <div class="row">
          <label class="filebtn">Choose file<input class="vh" type="file" id="f-bill" accept="image/*,application/pdf"></label>
          <label class="filebtn ghost">Take photo<input class="vh" type="file" id="f-bill-cam" accept="image/*" capture="environment"></label>
        </div>
        ${e.bill_url ? `<span class="hint">Current bill: <a href="${esc(e.bill_url)}" target="_blank" rel="noopener">view</a></span>` : ''}
      </div>
      <div class="receipt" id="receipt" hidden>
        <div class="thumb" id="bill-thumb">PDF</div>
        <div class="txt"><b id="bill-name"></b><span class="hint" id="bill-size"></span>
          <div class="acts"><label class="linkbtn">Replace<input class="vh" type="file" id="f-bill-2" accept="image/*,application/pdf"></label><button type="button" class="linkbtn" id="bill-remove">Remove</button></div></div>
        <button type="button" class="btn" id="scan" ${lists.aiEnabled ? '' : 'disabled'}>Read bill with AI</button>
      </div>
      <p class="hint full field" style="margin:0" id="ai-hint">${lists.aiEnabled ? 'Reading the bill with AI is optional; you can type the details yourself below.' : 'AI bill reading is off. To turn it on, add your Anthropic API key to the .env file and restart the app. You can type the details yourself below.'}</p>

      <div class="step"><span>2</span>Check the details</div>
      <div class="ai-done" id="ai-done" hidden></div>
      <div class="field"><label for="f-bus">Bus<span class="req">*</span></label>
        <select id="f-bus" ${correctsId ? 'disabled' : ''}><option value="">Choose a bus…</option>${lists.buses.map((b) => `<option value="${esc(b.bus_no)}" ${b.bus_no === e.bus_no ? 'selected' : ''}>${esc(b.label)}</option>`).join('')}</select></div>
      <div class="field"><label for="f-workshop">Workshop</label><input id="f-workshop" list="workshops" value="${v('workshop')}"><datalist id="workshops">${lists.workshops.map((w) => `<option value="${esc(w)}"></option>`).join('')}</datalist></div>
      <fieldset class="field full"><legend>What kind of visit?<span class="req">*</span></legend>
        <div class="seg">${lists.entry_kinds.map((k, i) => `<label><input type="radio" name="kind" id="k${i}" value="${esc(k)}" ${k === kind ? 'checked' : ''}> ${esc(k)}</label>`).join('')}</div></fieldset>
      <div class="field"><label for="f-date-in">Date in<span class="req">*</span></label><input id="f-date-in" type="date" max="${lists.today}" value="${v('date_in') || lists.today}"></div>
      <div class="field"><label for="f-date-out">Date out</label><input id="f-date-out" type="date" value="${v('date_out')}"><span class="hint">Leave blank if the bus is still in the workshop.</span></div>
      <div class="field"><label for="f-odo">Odometer (km)</label><input id="f-odo" class="mono" inputmode="numeric" value="${v('odometer_km')}"></div>
      <div class="field"><label for="f-sys">System affected<span class="req" id="sys-req">*</span></label>
        <select id="f-sys"><option value="">Choose…</option>${lists.systems.map((s) => `<option ${s === e.system ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
      <div class="field full"><label for="f-why">Problem reported (why it came in)</label><textarea id="f-why">${v('problem_reported')}</textarea></div>
      <div class="inline-warn full field" id="repeat-warn" hidden></div>
      <fieldset class="field full"><legend>What was changed</legend>
        <div class="partrow withrm head hint"><span>Part</span><span>Position</span><span>Removed part no.</span><span>Fitted part no.</span><span>Cost (₹)</span><span>Warranty until</span><span></span></div>
        <div id="parts">${(e.parts && e.parts.length ? e.parts : [{}]).map(partRow).join('')}</div>
        <button type="button" class="btn ghost" id="add-part" style="margin-top:10px">+ Add part</button>
      </fieldset>
      <div class="field full"><label for="f-root">Root cause (mechanic's finding)<span class="req" id="root-req" hidden>*</span></label><textarea id="f-root">${v('root_cause')}</textarea></div>
      <div class="field"><label for="f-billno">Bill number</label><input id="f-billno" value="${v('bill_no')}"></div>
      <div class="field"><label for="f-labour">Labour cost (₹)</label><input id="f-labour" class="mono" inputmode="numeric" value="${v('labour_cost')}"></div>
      <div class="field"><label for="f-total">Bill total (₹)<span class="req">*</span></label><input id="f-total" class="mono" inputmode="numeric" value="${v('total_cost')}"></div>
      <div class="field"><label for="f-photos">Other photos, e.g. the damaged part</label><input id="f-photos" type="file" multiple accept="image/*,application/pdf"></div>
      <div class="step"><span>3</span>Save</div>
      <div class="btns"><button class="btn" type="submit" id="save">${correctsId ? 'Save correction' : 'Save to history'}</button><button class="btn ghost" type="button" data-go="${e.bus_no ? `#bus/${encodeURIComponent(e.bus_no)}` : '#fleet'}">Cancel</button></div>
    </form>`;

  const form = $('#entryform');
  let billFile = null;
  let billURL = null;
  let filledByAI = Boolean(e.filled_by_ai);

  // Bill upload
  const showBill = (file) => {
    if (billURL) URL.revokeObjectURL(billURL);
    billURL = null;
    const th = $('#bill-thumb');
    if (file.type.startsWith('image/')) { billURL = URL.createObjectURL(file); th.innerHTML = `<img src="${billURL}" alt="Bill preview">`; } else th.textContent = 'PDF';
    $('#bill-name').textContent = file.name;
    $('#bill-size').textContent = file.size > 1048576 ? `${(file.size / 1048576).toFixed(1)} MB` : `${Math.round(file.size / 1024)} KB`;
    $('#drop').hidden = true;
    $('#receipt').hidden = false;
  };
  const takeFile = (file) => {
    if (!file) return;
    if (!/^image\/|application\/pdf/.test(file.type)) { toast("That file type isn't supported. Upload a JPG, PNG or PDF."); return; }
    if (file.size > 10 * 1024 * 1024) { toast('That file is over 10 MB. Take a smaller photo or compress the PDF.'); return; }
    billFile = file;
    showBill(file);
  };
  ['#f-bill', '#f-bill-cam', '#f-bill-2'].forEach((q) => $(q).addEventListener('change', (ev) => { takeFile(ev.target.files[0]); ev.target.value = ''; }));
  $('#bill-remove').addEventListener('click', () => {
    billFile = null;
    if (billURL) URL.revokeObjectURL(billURL);
    $('#receipt').hidden = true;
    $('#drop').hidden = false;
  });
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (ev) => takeFile(ev.dataTransfer.files[0]));

  // Parts rows
  $('#add-part').addEventListener('click', () => $('#parts').insertAdjacentHTML('beforeend', partRow()));
  $('#parts').addEventListener('click', (ev) => {
    if (!ev.target.classList.contains('rm')) return;
    const rows = $$('#parts .partrow');
    if (rows.length > 1) ev.target.closest('.partrow').remove();
    else $$('input', rows[0]).forEach((i) => { i.value = ''; });
  });

  // AI bill reading
  const setVal = (sel, val) => {
    if (val === null || val === undefined || val === '') return false;
    const el = $(sel);
    if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === String(val))) return false;
    el.value = val;
    el.classList.add('from-ai');
    return true;
  };
  $('#scan').addEventListener('click', async () => {
    if (!billFile) return;
    const btn = $('#scan');
    btn.disabled = true;
    btn.textContent = 'Reading bill…';
    try {
      const fd = new FormData();
      fd.append('bill', billFile);
      const r = await api('/api/bills/read', { method: 'POST', body: fd });
      $$('.from-ai', form).forEach((x) => x.classList.remove('from-ai'));
      let n = 0;
      n += setVal('#f-date-in', r.date_in);
      n += setVal('#f-date-out', r.date_out);
      n += setVal('#f-workshop', r.workshop);
      n += setVal('#f-billno', r.bill_no);
      n += setVal('#f-sys', r.system);
      n += setVal('#f-odo', r.odometer_km);
      n += setVal('#f-why', r.problem_reported);
      n += setVal('#f-root', r.root_cause);
      n += setVal('#f-labour', r.labour_cost);
      n += setVal('#f-total', r.total_cost);
      if (r.kind) {
        const radio = $$('input[name=kind]').find((x) => x.value === r.kind);
        if (radio) { radio.checked = true; n++; }
      }
      if (r.parts && r.parts.length) {
        $('#parts').innerHTML = r.parts.map((p) => partRow({ ...p, part_cost: p.part_cost ?? '' })).join('');
        $$('#parts input').forEach((i) => { if (i.value) i.classList.add('from-ai'); });
        n += r.parts.length;
      }
      filledByAI = true;
      const unclear = (r.unclear || []).filter(Boolean);
      $('#ai-done').innerHTML = `Filled ${n} field${n === 1 ? '' : 's'} from the bill. Highlighted fields came from AI, so please check them before saving.${unclear.length ? ` <span class="ai-unclear">Could not read clearly: ${esc(unclear.join(', '))}.</span>` : ''}`;
      $('#ai-done').hidden = false;
      checkRepeat();
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Read again';
    }
  });

  // Repeat warning, checked as the bus, kind, system or date change
  const kindNow = () => ($$('input[name=kind]').find((x) => x.checked) || {}).value;
  let repeatOn = false;
  async function checkRepeat() {
    const k = kindNow();
    $('#sys-req').hidden = !['Repair', 'Breakdown'].includes(k);
    const body = { bus_no: $('#f-bus').value, system: $('#f-sys').value, date_in: $('#f-date-in').value, kind: k, exclude_entry_id: correctsId };
    if (!body.bus_no || !body.system || !body.date_in) { setRepeat(null); return; }
    try { setRepeat(await postJSON('/api/check-repeat', body)); } catch { setRepeat(null); }
  }
  function setRepeat(r) {
    repeatOn = Boolean(r && r.isRepeat);
    $('#repeat-warn').hidden = !repeatOn;
    $('#repeat-warn').textContent = repeatOn ? `Heads up: ${r.message}` : '';
    $('#root-req').hidden = !repeatOn;
  }
  ['#f-bus', '#f-sys', '#f-date-in'].forEach((q) => $(q).addEventListener('change', checkRepeat));
  $$('input[name=kind]').forEach((r) => r.addEventListener('change', checkRepeat));
  checkRepeat();

  // Save
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const errBox = $('#form-error');
    errBox.hidden = true;
    const entry = {
      bus_no: $('#f-bus').value,
      kind: kindNow(),
      date_in: $('#f-date-in').value,
      date_out: $('#f-date-out').value,
      odometer_km: $('#f-odo').value.trim(),
      system: $('#f-sys').value,
      problem_reported: $('#f-why').value,
      root_cause: $('#f-root').value,
      workshop: $('#f-workshop').value,
      bill_no: $('#f-billno').value,
      labour_cost: $('#f-labour').value.trim(),
      total_cost: $('#f-total').value.trim(),
      filled_by_ai: filledByAI,
      parts: $$('#parts .partrow').map((row) => Object.fromEntries($$('input', row).map((i) => [i.dataset.p, i.value.trim()]))),
    };
    if (repeatOn && entry.root_cause.trim().length < 12) {
      errBox.textContent = 'This is a repeat repair. Write at least a short sentence in "Root cause" before saving.';
      errBox.hidden = false;
      $('#f-root').focus();
      return;
    }
    const fd = new FormData();
    fd.append('entry', JSON.stringify(entry));
    if (billFile) fd.append('bill', billFile);
    for (const ph of $('#f-photos').files) fd.append('photos', ph);
    const btn = $('#save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const url = correctsId ? `/api/entries/${encodeURIComponent(correctsId)}/correct` : '/api/entries';
      const r = await api(url, { method: 'POST', body: fd });
      toast(`Saved to Bus ${r.bus_no} history as ${r.entry_id}.`);
      location.hash = `#bus/${encodeURIComponent(r.bus_no)}`;
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
      errBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
      btn.disabled = false;
      btn.textContent = correctsId ? 'Save correction' : 'Save to history';
    }
  });
}

// ---------- Buses

async function viewBuses() {
  const buses = await api('/api/buses');
  main.innerHTML = `
    <div class="topbar"><div><h1>Buses</h1><p class="sub">The fleet the office tracks</p></div></div>
    ${buses.length ? `<div class="panel" style="margin-bottom:18px"><div class="tbl-wrap"><table>
      <thead><tr><th>Bus</th><th>Route</th><th>Make / model</th><th>Registration</th><th>Year</th><th>Driver</th><th>Status</th></tr></thead>
      <tbody>${buses.map((b) => `<tr data-go="#bus/${encodeURIComponent(b.bus_no)}"><td><span class="busno">${esc(b.bus_no)}</span></td><td>${esc(b.route || '—')}</td><td>${esc(b.make_model || '—')}</td><td class="mono">${esc(b.reg_no || '—')}</td><td>${esc(b.year || '—')}</td><td>${esc(b.driver_name || '—')}</td><td>${b.active === false ? '<span class="hint">Retired</span>' : pill(b.status || 'On route')}</td></tr>`).join('')}</tbody>
    </table></div></div>` : ''}
    <form class="panel" id="busform" novalidate>
      <div class="panel-h"><h2>Add a bus</h2></div>
      <div class="busform">
        <div class="error" id="bus-error" style="grid-column:1/-1" hidden></div>
        <div class="field"><label for="b-no">Bus number<span class="req">*</span></label><input id="b-no" placeholder="04"></div>
        <div class="field"><label for="b-route">Route</label><input id="b-route" placeholder="Hillside Colony"></div>
        <div class="field"><label for="b-model">Make / model</label><input id="b-model" placeholder="Tata Starbus 40"></div>
        <div class="field"><label for="b-reg">Registration</label><input id="b-reg" placeholder="TN 22 BX 1104"></div>
        <div class="field"><label for="b-year">Year</label><input id="b-year" inputmode="numeric" placeholder="2018"></div>
        <div class="field"><label for="b-seats">Seats</label><input id="b-seats" inputmode="numeric" placeholder="40"></div>
        <div class="field"><label for="b-driver">Driver</label><input id="b-driver"></div>
        <div class="field"><label for="b-km">Service every (km)</label><input id="b-km" inputmode="numeric" placeholder="10000"></div>
        <div class="btns"><button class="btn" type="submit">Add bus</button></div>
      </div>
    </form>
    <p class="ann">To change an existing bus (route, driver, or retiring it), edit the Buses or Route assignments tab in the Excel file. Close the file in Excel before entering bills here, so the two don't overwrite each other.</p>`;
  $('#busform').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = { bus_no: $('#b-no').value.trim(), route_name: $('#b-route').value, make_model: $('#b-model').value, reg_no: $('#b-reg').value, year: $('#b-year').value, seats: $('#b-seats').value, driver_name: $('#b-driver').value, service_every_km: $('#b-km').value };
    try {
      const r = await postJSON('/api/buses', body);
      toast(`Added Bus ${r.bus_no}.`);
      listsCache = null;
      router();
    } catch (err) {
      $('#bus-error').textContent = err.message;
      $('#bus-error').hidden = false;
    }
  });
}

router();
