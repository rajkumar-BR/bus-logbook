// Excel import: reads a workbook the school already keeps, shows what would be added, then adds it.
//
//   parseWorkbook(buffer)          -> sheets with their rows (async, reads the .xlsx)
//   planImport(parsed, existing, ctx) -> what would be added/skipped/rejected (pure, no storage)
//   buildTemplate(lists)           -> a blank workbook with the right tab and column names
//
// Sheets and columns are matched by name, ignoring case, spaces and punctuation, with a few common
// alternatives ("Date", "Cost", "Garage"…), so a school's own sheet usually imports without changes.
// Rows that break the rules of "Enter a bill" are rejected with the Excel row number and the reason;
// everything else is imported. Importing the same file twice adds nothing the second time.

import ExcelJS from 'exceljs';
import { KINDS, STATUS } from './schema.js';
import * as L from './logic.js';
import { UserError } from './ai.js';

export const MAX_ROWS_PER_SHEET = 5000;
const MAX_ERRORS_SHOWN = 25;
const OLD_VISIT_DAYS = 14;

// The tabs the import page understands, with the columns written to the app.
export const IMPORT_TABS = {
  Buses: ['bus_no', 'reg_no', 'make_model', 'year', 'seats', 'driver_name', 'service_every_km', 'service_every_days'],
  Entries: ['entry_id', 'bus_no', 'kind', 'date_in', 'date_out', 'odometer_km', 'system', 'problem_reported', 'root_cause', 'workshop', 'bill_no', 'labour_cost', 'total_cost'],
  'Parts changed': ['entry_id', 'part_name', 'position', 'removed_part_no', 'fitted_part_no', 'part_cost', 'warranty_until'],
  'Bus documents': ['bus_no', 'doc_type', 'doc_number', 'valid_until'],
  Workshops: ['workshop_name', 'phone', 'address'],
};

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Other names a school might use for a column, per tab. The column's own name always works.
const COLUMN_ALIASES = {
  Buses: {
    bus_no: ['bus', 'busnumber', 'busid', 'busno'],
    reg_no: ['registration', 'registrationno', 'registrationnumber', 'regnumber', 'vehicleno', 'vehiclenumber', 'numberplate'],
    make_model: ['make', 'model', 'vehicle', 'vehiclemodel', 'makemodel'],
    year: ['yearofmanufacture', 'modelyear', 'mfgyear'],
    seats: ['seatingcapacity', 'capacity'],
    driver_name: ['driver'],
    service_every_km: ['servicekm', 'serviceintervalkm'],
    service_every_days: ['servicedays', 'serviceintervaldays'],
  },
  Entries: {
    entry_id: ['id', 'entryno', 'visitid', 'recordno', 'slno', 'sno'],
    bus_no: ['bus', 'busnumber', 'busid', 'vehicle', 'vehicleno'],
    kind: ['type', 'visittype', 'servicetype', 'typeofservice', 'typeofvisit', 'nature'],
    date_in: ['date', 'servicedate', 'visitdate', 'dateofservice', 'dateofrepair', 'dateofentry', 'datereceived'],
    date_out: ['datecompleted', 'completiondate', 'datereturned', 'datedelivered'],
    odometer_km: ['odometer', 'km', 'kms', 'kmreading', 'odometerreading', 'meterreading', 'meter'],
    system: ['category', 'component', 'area', 'part'],
    problem_reported: ['problem', 'issue', 'complaint', 'workdone', 'description', 'details', 'work', 'repair', 'particulars'],
    root_cause: ['cause', 'reason', 'remarks'],
    workshop: ['garage', 'vendor', 'servicecentre', 'servicecenter', 'mechanic', 'shop', 'workshopname'],
    bill_no: ['billnumber', 'bill', 'invoice', 'invoiceno', 'invoicenumber', 'receiptno'],
    labour_cost: ['labour', 'labor', 'labourcharges', 'labourcharge', 'laborcost'],
    total_cost: ['cost', 'total', 'amount', 'billamount', 'totalamount', 'expense', 'expenses'],
  },
  'Parts changed': {
    entry_id: ['id', 'entryno', 'visitid', 'recordno'],
    part_name: ['part', 'partname', 'item', 'sparepart', 'itemname'],
    position: ['location', 'side'],
    removed_part_no: ['oldpartno', 'removedpartno', 'oldpart'],
    fitted_part_no: ['newpartno', 'fittedpartno', 'newpart'],
    part_cost: ['cost', 'price', 'amount'],
    warranty_until: ['warranty', 'warrantyexpiry', 'warrantytill'],
  },
  'Bus documents': {
    bus_no: ['bus', 'busnumber'],
    doc_type: ['document', 'type', 'documenttype'],
    doc_number: ['number', 'documentno', 'documentnumber', 'policyno'],
    valid_until: ['validtill', 'expiry', 'expirydate', 'validupto', 'expires'],
  },
  Workshops: {
    workshop_name: ['workshop', 'name', 'garage', 'vendor'],
    phone: ['mobile', 'contact', 'phoneno', 'phonenumber'],
    address: ['location'],
  },
};

const SHEET_NAMES = {
  Buses: ['buses', 'bus', 'fleet', 'vehicles', 'busdetails', 'buslist'],
  Entries: ['entries', 'servicehistory', 'services', 'service', 'repairs', 'servicerecords', 'maintenance', 'log', 'logbook', 'history', 'servicelog', 'busservice'],
  'Parts changed': ['partschanged', 'parts', 'spares', 'spareparts'],
  'Bus documents': ['busdocuments', 'documents', 'docs'],
  Workshops: ['workshops', 'garages', 'vendors'],
};

const KIND_WORDS = [
  [/break/, KINDS.BREAKDOWN],
  [/inspect|fitness|check|audit/, KINDS.INSPECTION],
  [/service|routine|regular|periodic|scheduled|oil/, KINDS.SERVICE],
  [/repair|fix|replace|change|work/, KINDS.REPAIR],
];

function columnLookup(tab) {
  const map = new Map();
  for (const col of IMPORT_TABS[tab]) map.set(norm(col), col);
  for (const [col, names] of Object.entries(COLUMN_ALIASES[tab] || {})) {
    for (const n of names) if (!map.has(n)) map.set(n, col);
  }
  return map;
}

// ---------- reading the file

function plain(v) {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('error' in v) return '';
    if ('result' in v) return plain(v.result);
    if ('text' in v) return v.text;
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
  }
  return v ?? '';
}

export async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new UserError('That file could not be read. Open it in Excel, save it as an .xlsx workbook, and try again.');
  }
  return wb.worksheets.map((ws) => {
    const grid = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (grid.length > MAX_ROWS_PER_SHEET + 12) return;
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = plain(cell.value); });
      grid.push({ rowNumber, cells: Array.from(cells, (c) => c ?? '') });
    });
    return { name: ws.name, grid };
  });
}

// Finds which tab a sheet is, and which of its rows holds the headings.
function recogniseSheet(sheet) {
  const byName = Object.keys(SHEET_NAMES).find((tab) => SHEET_NAMES[tab].includes(norm(sheet.name)));
  const candidates = byName ? [byName] : Object.keys(IMPORT_TABS);
  let best = null;
  for (const tab of candidates) {
    const lookup = columnLookup(tab);
    sheet.grid.slice(0, 10).forEach((row, index) => {
      const matched = new Set(row.cells.map((c) => lookup.get(norm(c))).filter(Boolean));
      const score = matched.size;
      if (score > (best?.score || 0)) best = { tab, headerIndex: index, score };
    });
  }
  if (!best) return null;
  const needed = byName ? 1 : 3;
  return best.score >= needed ? best : null;
}

// ---------- reading values

class RowProblem extends Error {}

const text = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').trim());

function number(v, label) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  const cleaned = String(v).replace(/(₹|rs\.?|inr)/gi, '').replace(/[,\s]/g, '');
  if (cleaned === '') return '';
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new RowProblem(`${label} "${text(v)}" is not a number.`);
  return n;
}

const MONTH_INDEX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function validDate(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
  return date.toISOString().slice(0, 10);
}

// Day-first for numeric dates (18/10/2026), as is usual in India.
function date(v, label) {
  if (v === '' || v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    const result = v > 20000 && v < 80000 ? new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10) : '';
    if (!result) throw new RowProblem(`${label} "${v}" is not a date.`);
    return result;
  }
  const s = String(v).trim();
  if (!s) return '';
  let m;
  let out = '';
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) out = validDate(+m[1], +m[2], +m[3]);
  else if ((m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/.exec(s))) out = validDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  else if ((m = /^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ,]*(\d{2}|\d{4})$/.exec(s))) {
    const month = MONTH_INDEX[m[2].slice(0, 3).toLowerCase()];
    if (month) out = validDate(m[3].length === 2 ? 2000 + +m[3] : +m[3], month, +m[1]);
  }
  if (!out) throw new RowProblem(`${label} "${s}" is not a date. Use a form like 18/10/2026.`);
  return out;
}

function kindFrom(value, kinds) {
  const s = text(value);
  const exact = kinds.find((k) => k.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  for (const [pattern, kind] of KIND_WORDS) if (pattern.test(s.toLowerCase()) && kinds.includes(kind)) return kind;
  throw new RowProblem(`Type "${s}" is not one of: ${kinds.join(', ')}.`);
}

const addDays = (isoDate, days) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const stripZeros = (s) => (/^\d+$/.test(s) ? String(Number(s)) : s.toLowerCase());

// ---------- planning

// parsed: from parseWorkbook. existing: rows already in the app, by tab. ctx: { today, now, user, file, kinds, systems }
export function planImport(parsed, existing, ctx) {
  const { today, now, user, kinds, systems } = ctx;
  const tabs = {};
  const notes = [];
  const ignoredSheets = [];
  const append = { Buses: [], Entries: [], 'Parts changed': [], 'Bus documents': [], Workshops: [] };

  // 1. recognise sheets
  const found = {};
  for (const sheet of parsed) {
    const match = recogniseSheet(sheet);
    if (!match || found[match.tab]) { ignoredSheets.push(sheet.name); continue; }
    const lookup = columnLookup(match.tab);
    const headerRow = sheet.grid[match.headerIndex];
    const columns = headerRow.cells.map((c) => lookup.get(norm(c)) || null);
    const unknownColumns = headerRow.cells.filter((c, i) => text(c) && !columns[i]).map(text);
    const rows = sheet.grid.slice(match.headerIndex + 1)
      .map((r) => ({ rowNumber: r.rowNumber, values: Object.fromEntries(columns.map((col, i) => [col, r.cells[i] ?? '']).filter(([col]) => col)) }))
      .filter((r) => Object.values(r.values).some((v) => text(v) !== ''));
    found[match.tab] = { sheet: sheet.name, rows, columns: new Set(columns.filter(Boolean)), unknownColumns };
    tabs[match.tab] = { tab: match.tab, sheet: sheet.name, found: rows.length, add: 0, skipped: 0, errors: [], errorCount: 0, unknownColumns };
    if (rows.length > MAX_ROWS_PER_SHEET) {
      throw new UserError(`Sheet "${sheet.name}" has more than ${MAX_ROWS_PER_SHEET} rows. Split it into smaller files and import them one at a time.`);
    }
  }

  const problem = (tab, row, message) => {
    tabs[tab].errorCount++;
    if (tabs[tab].errors.length < MAX_ERRORS_SHOWN) tabs[tab].errors.push({ row: row.rowNumber, message });
  };
  const eachRow = (tab, fn) => {
    for (const row of found[tab]?.rows || []) {
      try { fn(row.values, row); } catch (err) { if (err instanceof RowProblem) problem(tab, row, err.message); else throw err; }
    }
  };

  // 2. buses already known (in the app, or in this file's Buses sheet)
  const busNames = new Map(); // normalised number -> canonical number
  for (const b of existing.Buses) if (b.bus_no) busNames.set(stripZeros(b.bus_no), b.bus_no);
  const newBusNumbers = new Set();
  const resolveBus = (raw, label = 'Bus number') => {
    const no = text(raw);
    if (!no) throw new RowProblem(`${label} is missing.`);
    if (!/^[A-Za-z0-9-]{1,10}$/.test(no)) throw new RowProblem(`${label} "${no}" should be short, like 04 or 11A.`);
    return busNames.get(stripZeros(no)) || no;
  };

  // 3. Buses
  const busRows = [];
  eachRow('Buses', (v) => {
    const bus_no = resolveBus(v.bus_no);
    const year = number(v.year, 'Year');
    if (year !== '' && !(year > 1980 && year <= Number(today.slice(0, 4)) + 1)) throw new RowProblem(`Year ${year} looks wrong.`);
    if (busNames.has(stripZeros(bus_no))) { tabs.Buses.skipped++; return; }
    busNames.set(stripZeros(bus_no), bus_no);
    newBusNumbers.add(bus_no);
    busRows.push({
      bus_no, reg_no: text(v.reg_no), make_model: text(v.make_model), year, seats: number(v.seats, 'Seats'),
      driver_name: text(v.driver_name), status: STATUS.ON_ROUTE,
      service_every_km: number(v.service_every_km, 'Service km'), service_every_days: number(v.service_every_days, 'Service days'), active: true,
    });
    tabs.Buses.add++;
  });

  // buses mentioned elsewhere but not listed anywhere get a minimal record
  const autoBuses = [];
  const useBus = (raw) => {
    const no = resolveBus(raw);
    if (!busNames.has(stripZeros(no))) {
      busNames.set(stripZeros(no), no);
      autoBuses.push({ bus_no: no, reg_no: '', make_model: '', year: '', seats: '', driver_name: '', status: STATUS.ON_ROUTE, service_every_km: '', service_every_days: '', active: true });
    }
    return busNames.get(stripZeros(no));
  };

  // 4. Workshops
  const workshopKeys = new Set(existing.Workshops.map((w) => String(w.workshop_name).toLowerCase()));
  const workshopRows = [];
  const addWorkshop = (name, extra = {}) => {
    const key = name.toLowerCase();
    if (!name || workshopKeys.has(key)) return false;
    workshopKeys.add(key);
    workshopRows.push({ workshop_name: name, phone: '', address: '', ...extra });
    return true;
  };
  eachRow('Workshops', (v) => {
    const name = text(v.workshop_name);
    if (!name) throw new RowProblem('Workshop name is missing.');
    if (addWorkshop(name, { phone: text(v.phone), address: text(v.address) })) tabs.Workshops.add++; else tabs.Workshops.skipped++;
  });

  // 5. Entries
  const existingEntryIds = new Set(existing.Entries.map((e) => e.entry_id).filter(Boolean));
  const naturalKey = (e) => [e.bus_no, e.date_in, e.kind, e.system, e.problem_reported, e.total_cost, e.bill_no].map((x) => String(x ?? '').toLowerCase()).join('|');
  const existingKeys = new Set(existing.Entries.filter(L.isActive).map(naturalKey));
  const fileEntryIds = new Set();
  const skippedEntryIds = new Set();
  const entryRows = [];
  let noKind = 0;
  let noSystem = 0;
  let closedOldVisits = 0;
  eachRow('Entries', (v, row) => {
    const bus_no = resolveBus(v.bus_no);
    const date_in = date(v.date_in, 'Date');
    if (!date_in) throw new RowProblem('The date is missing.');
    if (date_in > today) throw new RowProblem(`The date ${date_in} is in the future.`);
    let date_out = date(v.date_out, 'Date out');
    if (date_out && date_out < date_in) throw new RowProblem('The date out is before the date in.');
    let kind;
    if (text(v.kind)) kind = kindFrom(v.kind, kinds);
    else { kind = KINDS.REPAIR; noKind++; }
    const odometer_km = number(v.odometer_km, 'Odometer');
    const labour_cost = number(v.labour_cost, 'Labour cost');
    const total_cost = number(v.total_cost, 'Amount');
    if (odometer_km !== '' && odometer_km < 0) throw new RowProblem('The odometer reading cannot be negative.');
    if (total_cost === '') throw new RowProblem('The bill amount is missing (use 0 if there was no charge).');
    if (total_cost < 0 || (labour_cost !== '' && labour_cost < 0)) throw new RowProblem('Amounts cannot be negative.');
    let system = text(v.system);
    if (system) system = systems.find((s) => s.toLowerCase() === system.toLowerCase()) || system;
    else if ([KINDS.REPAIR, KINDS.BREAKDOWN].includes(kind)) { system = 'Other'; noSystem++; }
    const entry_id = text(v.entry_id);
    if (entry_id && fileEntryIds.has(entry_id)) throw new RowProblem(`Entry ID "${entry_id}" appears more than once in this sheet.`);

    const entry = {
      entry_id, bus_no, kind, date_in, date_out, odometer_km, system, problem_reported: text(v.problem_reported),
      root_cause: text(v.root_cause), workshop: text(v.workshop), bill_no: text(v.bill_no), labour_cost, total_cost,
    };
    if ((entry_id && existingEntryIds.has(entry_id)) || existingKeys.has(naturalKey(entry))) {
      if (entry_id) skippedEntryIds.add(entry_id);
      tabs.Entries.skipped++;
      return;
    }
    if (entry_id) fileEntryIds.add(entry_id);
    // Old records often lack a date out; leaving them open would show the bus as still in the workshop.
    if (!date_out && date_in < addDays(today, -OLD_VISIT_DAYS)) { entry.date_out = date_in; closedOldVisits++; }
    entry.bus_no = useBus(bus_no);
    entryRows.push({ ...entry, _row: row.rowNumber });
    tabs.Entries.add++;
  });

  // ids for entries that came without one: E-YYYY-NNNN, continuing from what the app already has
  const highest = {};
  for (const id of [...existingEntryIds, ...fileEntryIds]) {
    const m = /^E-(\d{4})-(\d+)$/.exec(id);
    if (m) highest[m[1]] = Math.max(highest[m[1]] || 0, Number(m[2]));
  }
  for (const e of entryRows) {
    if (e.entry_id) continue;
    const year = e.date_in.slice(0, 4);
    highest[year] = (highest[year] || 0) + 1;
    e.entry_id = `E-${year}-${String(highest[year]).padStart(4, '0')}`;
  }

  const finalEntries = entryRows.map(({ _row, ...e }) => ({
    ...e,
    days_off_road: e.date_out ? L.daysBetween(e.date_in, e.date_out) : '',
    bill_link: '', photo_links: '',
    route_at_time: L.routeAt(existing['Route assignments'], e.bus_no, e.date_in),
    is_repeat: false, filled_by_ai: false, record_status: 'Active', replaces_entry_id: '',
    entered_by: `${user} (import)`, entered_at: now,
  }));
  for (const e of finalEntries) if (e.workshop) addWorkshop(e.workshop);

  // 6. Parts changed: each part must belong to a visit in this file (or one already imported)
  const entryById = new Map(finalEntries.map((e) => [e.entry_id, e]));
  const partRows = [];
  const partKey = (p) => [p.entry_id, p.part_name, p.position, p.fitted_part_no, p.part_cost].map((x) => String(x ?? '').toLowerCase()).join('|');
  const existingPartKeys = new Set(existing['Parts changed'].map(partKey));
  eachRow('Parts changed', (v) => {
    const entry_id = text(v.entry_id);
    const part_name = text(v.part_name);
    if (!entry_id) throw new RowProblem('Entry ID is missing. It links the part to a visit in the Entries sheet.');
    if (!part_name) throw new RowProblem('Part name is missing.');
    const part_cost = number(v.part_cost, 'Part cost');
    const warranty_until = date(v.warranty_until, 'Warranty date');
    if (skippedEntryIds.has(entry_id) || (existingEntryIds.has(entry_id) && !entryById.has(entry_id))) { tabs['Parts changed'].skipped++; return; }
    const entry = entryById.get(entry_id);
    if (!entry) throw new RowProblem(`No visit with Entry ID "${entry_id}" in the Entries sheet.`);
    const part = {
      entry_id, bus_no: entry.bus_no, system: entry.system, part_name, position: text(v.position),
      removed_part_no: text(v.removed_part_no), fitted_part_no: text(v.fitted_part_no), part_cost, warranty_until, record_status: 'Active',
    };
    if (existingPartKeys.has(partKey(part))) { tabs['Parts changed'].skipped++; return; }
    partRows.push(part);
    tabs['Parts changed'].add++;
  });

  // 7. Bus documents
  const docKey = (d) => [d.bus_no, d.doc_type, d.doc_number, d.valid_until].map((x) => String(x ?? '').toLowerCase()).join('|');
  const docKeys = new Set(existing['Bus documents'].map(docKey));
  const docRows = [];
  eachRow('Bus documents', (v) => {
    const doc_type = text(v.doc_type);
    if (!doc_type) throw new RowProblem('Document type is missing.');
    const doc = { bus_no: resolveBus(v.bus_no), doc_type, doc_number: text(v.doc_number), valid_until: date(v.valid_until, 'Valid until'), file_link: '' };
    if (docKeys.has(docKey(doc))) { tabs['Bus documents'].skipped++; return; }
    docKeys.add(docKey(doc));
    doc.bus_no = useBus(doc.bus_no);
    docRows.push(doc);
    tabs['Bus documents'].add++;
  });

  // 8. buses that have an open (no date out) visit are in the workshop
  const inWorkshop = new Set(finalEntries.filter((e) => !e.date_out).map((e) => e.bus_no));

  append.Buses = [...busRows, ...autoBuses];
  append.Entries = finalEntries;
  append['Parts changed'] = partRows;
  append['Bus documents'] = docRows;
  append.Workshops = workshopRows;

  if (autoBuses.length) {
    const list = autoBuses.slice(0, 5).map((b) => b.bus_no).join(', ');
    notes.push(`${autoBuses.length} bus${autoBuses.length === 1 ? '' : 'es'} (${list}${autoBuses.length > 5 ? '…' : ''}) ${autoBuses.length === 1 ? 'is' : 'are'} not in your Buses list, so ${autoBuses.length === 1 ? 'it' : 'they'} will be added with just the number. Fill in the details later.`);
  }
  if (noKind) notes.push(`${noKind} visit${noKind === 1 ? ' has' : 's have'} no type, so ${noKind === 1 ? 'it' : 'they'} will be saved as "Repair".`);
  if (noSystem) notes.push(`${noSystem} repair${noSystem === 1 ? ' has' : 's have'} no system (brakes, tyres…), so ${noSystem === 1 ? 'it' : 'they'} will be saved under "Other".`);
  if (closedOldVisits) notes.push(`${closedOldVisits} older visit${closedOldVisits === 1 ? ' has' : 's have'} no "date out". ${closedOldVisits === 1 ? 'It' : 'They'} will be saved as finished the same day, so those buses do not show as still in the workshop.`);
  if (inWorkshop.size) notes.push(`Bus ${[...inWorkshop].join(', ')} ${inWorkshop.size === 1 ? 'has a recent visit' : 'have recent visits'} with no date out, so ${inWorkshop.size === 1 ? 'it' : 'they'} will show as "In workshop".`);
  for (const [tab, t] of Object.entries(tabs)) {
    if (t.unknownColumns.length) notes.push(`Sheet "${t.sheet}": the columns ${t.unknownColumns.map((c) => `"${c}"`).join(', ')} are not used by the logbook and will be ignored.`);
  }
  if (!Object.keys(tabs).length) {
    notes.push('No sheet in this file looked like buses, service visits, parts, documents or workshops. Download the template and copy your records into it.');
  }
  for (const [tab] of Object.entries(IMPORT_TABS)) {
    if (found[tab] && !['Buses', 'Workshops'].includes(tab)) {
      const needed = { Entries: ['bus_no', 'date_in', 'total_cost'], 'Parts changed': ['entry_id', 'part_name'], 'Bus documents': ['bus_no', 'doc_type'] }[tab] || [];
      const missing = needed.filter((c) => !found[tab].columns.has(c));
      if (missing.length) notes.push(`Sheet "${found[tab].sheet}" has no column for ${missing.join(', ')}. Add one with a heading like "${missing[0]}" or every row will be rejected.`);
    }
  }

  const list = Object.values(tabs);
  const totals = {
    // workshops noticed in the visits are added too, on top of the Workshops sheet's own rows
    add: list.reduce((n, t) => n + t.add, 0) + autoBuses.length + (workshopRows.length - (tabs.Workshops?.add || 0)),
    skipped: list.reduce((n, t) => n + t.skipped, 0),
    errors: list.reduce((n, t) => n + t.errorCount, 0),
  };

  return { tabs: list, notes, ignoredSheets, totals, append, inWorkshop: [...inWorkshop], autoBuses: autoBuses.length };
}

// ---------- template

export async function buildTemplate({ kinds, systems }) {
  const wb = new ExcelJS.Workbook();
  const help = wb.addWorksheet('Read me');
  help.columns = [{ width: 110 }];
  [
    'Bus Logbook import template',
    '',
    'Fill in the sheets you need and import the file from the Import page. Leave a sheet empty if you do not need it.',
    'Keep the heading row as it is. Dates can be written as 18/10/2026. Amounts are plain numbers in rupees.',
    '',
    'Buses: one row per bus. Only "bus_no" is required.',
    'Entries: one row per workshop visit. Required: bus_no, date_in, total_cost. Leave "kind" and "system" blank and they default to Repair / Other.',
    `  kind is one of: ${kinds.join(', ')}.`,
    `  system is usually one of: ${systems.join(', ')}.`,
    '  entry_id is optional. Give a visit an ID (V1, V2…) only if you also list its parts in "Parts changed".',
    'Parts changed: one row per part. entry_id must match a visit in Entries. Required: entry_id, part_name.',
    'Bus documents: fitness certificate, insurance and so on. Required: bus_no, doc_type.',
    'Workshops: garages you use. Required: workshop_name.',
    '',
    'Importing the same file twice does not create duplicates.',
  ].forEach((line, i) => { help.getCell(i + 1, 1).value = line; });
  help.getCell(1, 1).font = { bold: true, size: 14 };

  for (const [tab, cols] of Object.entries(IMPORT_TABS)) {
    const ws = wb.addWorksheet(tab, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.addRow(cols);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2B300' } };
    cols.forEach((c, i) => {
      ws.getColumn(i + 1).width = /problem|cause|address/.test(c) ? 36 : 16;
      if (/^date_|warranty|valid_until/.test(c)) ws.getColumn(i + 1).numFmt = 'dd/mm/yyyy';
    });
    if (tab === 'Entries') {
      const col = cols.indexOf('kind') + 1;
      ws.dataValidations.add(`${ws.getColumn(col).letter}2:${ws.getColumn(col).letter}${MAX_ROWS_PER_SHEET}`, { type: 'list', allowBlank: true, formulae: [`"${kinds.join(',')}"`] });
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

