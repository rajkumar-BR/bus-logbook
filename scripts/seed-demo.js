// Creates ./demo-data with the sample fleet from the mockup, so the app can be
// tried without touching real data. Run with: npm run demo
//
// The real data lives in ./data (or DATA_DIR) and is never touched by this script.

import fs from 'node:fs/promises';
import { createLocalStorage } from '../src/storage/local-xlsx.js';
import { tripMetrics } from '../src/logic.js';

const DIR = './demo-data';
await fs.rm(DIR, { recursive: true, force: true });
const storage = createLocalStorage(DIR);
await storage.init();

const buses = [
  ['01', 'North Gate', 'Tata Starbus 40', 2019, 'S. Ravi'],
  ['02', 'Lakeview', 'Ashok Leyland Sunshine', 2021, 'P. Anand'],
  ['03', 'Station Road', 'Tata Starbus 40', 2017, 'K. Mani'],
  ['04', 'Hillside Colony', 'Tata Starbus 40', 2018, 'R. Kumar'],
  ['05', 'Riverside', 'Eicher Skyline Pro', 2022, 'L. Prakash'],
  ['06', 'Old Town', 'Ashok Leyland Lynx', 2016, 'S. Devi'],
  ['07', 'Market Street', 'Eicher Skyline Pro', 2020, 'V. Suresh'],
  ['08', 'East Park', 'Ashok Leyland Sunshine', 2019, 'A. Rahim'],
  ['09', 'Airport Road', 'Tata Starbus 40', 2018, 'M. Joseph'],
  ['10', 'Spare · field trips', 'Ashok Leyland Lynx', 2015, 'G. Babu'],
];

const svc = (date_in, odo, extra = {}) => ({ kind: 'Scheduled service', date_in, date_out: date_in, odometer_km: odo, system: 'Engine & cooling', problem_reported: 'Due by interval.', root_cause: 'Routine. No advisories.', workshop: 'In-house (school garage)', total_cost: 9200, parts: [['Engine oil + filter', '', '', '15W-40 / OF-118']], ...extra });

// [bus_no, entry]
const entries = [
  // Bus 04: brakes keep failing on the hill route
  ['04', { kind: 'Breakdown', date_in: '2025-11-28', date_out: '2025-11-29', odometer_km: 107600, system: 'Engine & cooling', problem_reported: 'Temperature warning on the way back from school. Students moved to Bus 10.', root_cause: 'Upper radiator hose cracked at the clamp.', workshop: 'City Auto Works', total_cost: 3200, parts: [['Radiator hose, upper', '', 'RH-40', 'RH-40']] }],
  ['04', { kind: 'Repair', date_in: '2026-01-19', date_out: '2026-01-20', odometer_km: 110180, system: 'Brakes', problem_reported: 'Squeak over speed breakers and brake noise.', root_cause: 'Worn.', workshop: 'City Auto Works', total_cost: 8900, parts: [['Front brake pads (set)', 'Front axle', 'BP-2241', 'BP-2241'], ['Leaf spring bushes (4)', 'Rear', 'LB-12', 'LB-12']] }],
  ['04', svc('2026-02-12', 111200, { total_cost: 9400 })],
  ['04', { kind: 'Inspection', date_in: '2026-03-02', date_out: '2026-03-02', odometer_km: 111900, system: 'Brakes', problem_reported: 'Annual fitness certificate.', root_cause: 'Passed. Advisory: front brake pads at 40%.', workshop: 'RTO inspection', total_cost: 1500, parts: [] }],
  ['04', { kind: 'Repair', date_in: '2026-04-15', date_out: '2026-04-17', odometer_km: 114280, system: 'Brakes', problem_reported: 'Longer stopping distance noticed by driver.', root_cause: 'Worn.', workshop: 'City Auto Works', total_cost: 11300, parts: [['Front brake pads (set)', 'Front axle', 'BP-2241', 'BP-2241'], ['Rear brake shoes', 'Rear axle', 'BS-77', 'BS-77']] }],
  ['04', { kind: 'Repair', date_in: '2026-06-03', date_out: '2026-06-06', odometer_km: 115050, system: 'Clutch & gearbox', problem_reported: 'Clutch slipping when starting uphill near Hillside stop 6.', root_cause: 'Normal wear, accelerated by repeated hill starts.', workshop: 'Sri Murugan Motors', total_cost: 22500, parts: [['Clutch plate', '', 'CP-880', 'CP-880'], ['Pressure plate', '', 'PP-880', 'PP-880']] }],
  ['04', svc('2026-07-22', 115900, { total_cost: 9800, root_cause: 'Routine. Advisory: front pads at 60%.' })],
  ['04', { kind: 'Repair', date_in: '2026-09-07', date_out: '2026-09-08', odometer_km: 116980, system: 'Brakes', problem_reported: 'Wear indicator squeal during morning route.', root_cause: 'Pads glazed, consistent with overheating. Same part re-fitted.', workshop: 'Sri Murugan Motors', total_cost: 6200, parts: [['Front brake pads (set)', 'Front axle', 'BP-2241', 'BP-2241']] }],
  ['04', { kind: 'Breakdown', date_in: '2026-10-18', date_out: '', odometer_km: 118640, system: 'Brakes', problem_reported: 'Grinding noise and pulling left when braking on the Hillside descent. Reported by driver R. Kumar.', root_cause: 'Pads worn to 2 mm after only 1,660 km. Left caliper slider pins sticking.', workshop: 'Sri Murugan Motors', bill_no: '2231', total_cost: 18400, parts: [['Front brake pads (set)', 'Front axle', 'BP-2241', 'BP-2241HD'], ['Front brake disc', 'Front-left', 'BD-310', 'BD-310']] }],

  // Bus 06: batteries, alternator never tested
  ['06', { kind: 'Repair', date_in: '2025-11-02', date_out: '2025-11-02', odometer_km: 151000, system: 'Battery & electrical', problem_reported: 'Dead battery after the Diwali break.', root_cause: 'Sat unused for 12 days.', workshop: 'Power Batteries Co.', total_cost: 13900, parts: [['Battery 12V 150Ah', '', 'BT-150', 'BT-150']] }],
  ['06', svc('2026-03-09', 155400, { total_cost: 9100 })],
  ['06', { kind: 'Repair', date_in: '2026-05-20', date_out: '2026-05-20', odometer_km: 158200, system: 'Battery & electrical', problem_reported: 'Slow cranking.', root_cause: 'Weak battery.', workshop: 'Power Batteries Co.', total_cost: 14200, parts: [['Battery 12V 150Ah', '', 'BT-150', 'BT-150']] }],
  ['06', svc('2026-08-20', 162300, { total_cost: 9000, root_cause: 'Routine. Battery terminals cleaned.' })],
  ['06', { kind: 'Breakdown', date_in: '2026-09-15', date_out: '2026-09-15', odometer_km: 163900, system: 'Battery & electrical', problem_reported: 'Would not start at 6:45 am. Jump-started.', root_cause: 'Battery fully discharged. Replaced under warranty claim.', workshop: 'Power Batteries Co.', total_cost: 14800, parts: [['Battery 12V 150Ah', '', 'BT-150', 'BT-150']] }],

  // Bus 09: same tyre keeps wearing out
  ['09', { kind: 'Repair', date_in: '2025-12-18', date_out: '2025-12-18', odometer_km: 114900, system: 'Tyres & alignment', problem_reported: 'Worn tread on front-left.', root_cause: '', workshop: 'Highway Tyres', total_cost: 15800, parts: [['Tyre 8.25R16', 'Front-left', '', 'MRF Steel Muscle']] }],
  ['09', svc('2026-04-10', 119500, { total_cost: 9300 })],
  ['09', { kind: 'Repair', date_in: '2026-05-14', date_out: '2026-05-14', odometer_km: 120300, system: 'Tyres & alignment', problem_reported: 'Bulge on sidewall.', root_cause: 'Pothole impact.', workshop: 'Highway Tyres', total_cost: 16200, parts: [['Tyre 8.25R16', 'Front-left', '', 'MRF Steel Muscle']] }],
  ['09', svc('2026-08-28', 125100, { total_cost: 9300, root_cause: 'Routine. No advisories.' })],
  ['09', { kind: 'Repair', date_in: '2026-09-05', date_out: '2026-09-05', odometer_km: 125770, system: 'Tyres & alignment', problem_reported: 'Inner edge worn to the wire.', root_cause: 'Uneven inner wear on front-left.', workshop: 'Highway Tyres', total_cost: 16500, parts: [['Tyre 8.25R16', 'Front-left', 'MRF Steel Muscle', 'MRF Steel Muscle']] }],

  // Other buses: routine history
  ['01', svc('2026-09-12', 79010)], ['01', { kind: 'Repair', date_in: '2026-10-10', date_out: '2026-10-10', odometer_km: 83900, system: 'Doors & body', problem_reported: 'Wiper not working in rain.', root_cause: 'Wiper motor burnt out.', workshop: 'City Auto Works', total_cost: 2800, parts: [['Wiper motor', '', 'WM-12', 'WM-12']] }],
  ['02', svc('2026-08-30', 49780)],
  ['03', { kind: 'Repair', date_in: '2026-02-11', date_out: '2026-02-12', odometer_km: 128400, system: 'Suspension', problem_reported: 'Bus leaning to one side.', root_cause: 'Broken leaf spring, rear-left.', workshop: 'City Auto Works', total_cost: 12600, parts: [['Leaf spring', 'Rear-left', 'LS-90', 'LS-90']] }],
  ['03', svc('2026-07-28', 131680)], ['03', { kind: 'Repair', date_in: '2026-10-08', date_out: '2026-10-09', odometer_km: 141100, system: 'Suspension', problem_reported: 'Bouncy ride, knocking sound at rear.', root_cause: 'Rear-left shock absorber leaking oil.', workshop: 'City Auto Works', total_cost: 7900, parts: [['Shock absorber', 'Rear-left', 'SA-44', 'SA-44']] }],
  ['05', svc('2026-10-02', 37550)],
  ['07', svc('2026-07-31', 64120)], ['07', { kind: 'Repair', date_in: '2026-09-25', date_out: '2026-09-25', odometer_km: 70400, system: 'AC / fans', problem_reported: 'Cabin fans not running.', root_cause: 'Fan motor seized.', workshop: 'City Auto Works', total_cost: 3400, parts: [['Cabin fan motor', '', 'FM-3', 'FM-3']] }],
  ['08', svc('2026-09-20', 93960)],
  ['10', svc('2026-08-10', 180500)], ['10', { kind: 'Repair', date_in: '2026-10-12', date_out: '2026-10-12', odometer_km: 182300, system: 'Battery & electrical', problem_reported: 'Headlamps dim.', root_cause: 'Bulbs at end of life.', workshop: 'City Auto Works', total_cost: 1200, parts: [['Headlamp bulbs (pair)', '', 'H4', 'H4']] }],
];

const dailyReportSeeds = [
  {
    report_date: '2026-10-22', bus_no: '01', driver_name: 'S. Ravi', income_collected: 4200, expenses: 1350,
    notes: 'One toll receipt included in expenses.',
    trips: [
      { origin: 'School', destination: 'North Gate', scheduled_start: '06:45', actual_start: '06:47', scheduled_end: '08:10', actual_end: '08:15', planned_km: 28, start_odometer_km: 84000, end_odometer_km: 84031 },
      { origin: 'North Gate', destination: 'Lakeview', scheduled_start: '10:00', actual_start: '10:00', scheduled_end: '11:10', actual_end: '11:08', planned_km: 24, start_odometer_km: 84031, end_odometer_km: 84056 },
      { origin: 'Lakeview', destination: 'School', scheduled_start: '14:00', actual_start: '14:02', scheduled_end: '15:15', actual_end: '15:18', planned_km: 25, start_odometer_km: 84056, end_odometer_km: 84084 },
    ],
  },
  {
    report_date: '2026-10-23', bus_no: '01', driver_name: 'S. Ravi', income_collected: 4500, expenses: 1280,
    notes: 'Normal service day.',
    trips: [
      { origin: 'School', destination: 'North Gate', scheduled_start: '06:45', actual_start: '06:45', scheduled_end: '08:10', actual_end: '08:12', planned_km: 28, start_odometer_km: 84084, end_odometer_km: 84115 },
      { origin: 'North Gate', destination: 'Lakeview', scheduled_start: '10:00', actual_start: '10:00', scheduled_end: '11:10', actual_end: '11:10', planned_km: 24, start_odometer_km: 84115, end_odometer_km: 84139 },
      { origin: 'Lakeview', destination: 'School', scheduled_start: '14:00', actual_start: '14:03', scheduled_end: '15:15', actual_end: '15:20', planned_km: 25, start_odometer_km: 84139, end_odometer_km: 84167 },
    ],
  },
  {
    report_date: '2026-10-23', bus_no: '02', driver_name: 'P. Anand', income_collected: 3900, expenses: 980,
    notes: 'Short diversion due to road work.',
    trips: [
      { origin: 'School', destination: 'Lakeview', scheduled_start: '06:50', actual_start: '06:54', scheduled_end: '08:05', actual_end: '08:13', planned_km: 22, start_odometer_km: 49800, end_odometer_km: 49827 },
      { origin: 'Lakeview', destination: 'Station Road', scheduled_start: '10:05', actual_start: '10:05', scheduled_end: '11:15', actual_end: '11:18', planned_km: 26, start_odometer_km: 49827, end_odometer_km: 49858 },
      { origin: 'Station Road', destination: 'School', scheduled_start: '14:05', actual_start: '14:05', scheduled_end: '15:20', actual_end: '15:20', planned_km: 27, start_odometer_km: 49858, end_odometer_km: 49890 },
    ],
  },
];

const dailyReports = [];
const dailyTrips = [];
for (const report of dailyReportSeeds) {
  const reportId = `D-${report.report_date}-${report.bus_no}-DEMO`;
  dailyReports.push({ report_id: reportId, report_date: report.report_date, bus_no: report.bus_no, driver_name: report.driver_name, income_collected: report.income_collected, expenses: report.expenses, notes: report.notes, entered_by: 'demo', entered_at: `${report.report_date} 16:00` });
  for (let index = 0; index < report.trips.length; index++) {
    const trip = report.trips[index];
    const tripNumber = index + 1;
    const tripId = `${reportId}-T${tripNumber}`;
    const label = `Bus ${report.bus_no} · Trip ${tripNumber}: ${trip.origin} to ${trip.destination}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450"><rect width="800" height="450" fill="#e8f1eb"/><rect y="300" width="800" height="150" fill="#c5d9ce"/><path d="M0 350h800" stroke="#fff" stroke-width="8" stroke-dasharray="36 28"/><g transform="translate(170 145)"><rect x="0" y="25" width="390" height="150" rx="18" fill="#176b55"/><rect x="24" y="45" width="72" height="56" rx="6" fill="#d8eee3"/><rect x="112" y="45" width="72" height="56" rx="6" fill="#d8eee3"/><rect x="200" y="45" width="72" height="56" rx="6" fill="#d8eee3"/><rect x="288" y="45" width="72" height="56" rx="6" fill="#d8eee3"/><circle cx="90" cy="180" r="28" fill="#17312b"/><circle cx="300" cy="180" r="28" fill="#17312b"/></g><text x="400" y="70" text-anchor="middle" font-family="Arial,sans-serif" font-size="25" font-weight="700" fill="#17312b">${label.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text><text x="400" y="410" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" fill="#17312b">Illustrative demo trip image · ${report.report_date}</text></svg>`;
    const photoLink = await storage.saveFile(`Photos/Bus ${report.bus_no}/Daily trips`, `${report.report_date} Trip ${tripNumber} demo.svg`, Buffer.from(svg));
    dailyTrips.push({ trip_id: tripId, report_id: reportId, trip_date: report.report_date, bus_no: report.bus_no, trip_number: tripNumber, ...trip, ...tripMetrics(trip), photo_link: photoLink, notes: '', entered_by: 'demo', entered_at: `${report.report_date} 16:00` });
  }
}

await storage.transact((tx) => {
  tx.append('Routes', buses.map(([no, route], i) => ({ route_id: `R${String(i + 1).padStart(2, '0')}`, route_name: route, notes: no === '04' ? '1.8 km steep descent, 22 stops' : '' })));
  tx.append('Route assignments', buses.map(([no], i) => ({ bus_no: no, route_id: `R${String(i + 1).padStart(2, '0')}`, from_date: '2025-06-01', to_date: '' })));
  tx.append('Buses', buses.map(([no, , model, year, driver]) => ({
    bus_no: no, reg_no: `TN 22 BX ${1100 + Number(no)}`, make_model: model, year, seats: 40, driver_name: driver,
    status: no === '04' ? 'In workshop' : 'On route', active: true,
  })));
  tx.append('Workshops', ['In-house (school garage)', 'City Auto Works', 'Sri Murugan Motors', 'Power Batteries Co.', 'Highway Tyres', 'RTO inspection'].map((w) => ({ workshop_name: w })));
  tx.append('Bus documents', buses.flatMap(([no]) => [
    { bus_no: no, doc_type: 'Fitness certificate', doc_number: `FC/2026/${88100 + Number(no)}`, valid_until: '2027-03-01' },
    { bus_no: no, doc_type: 'Insurance', doc_number: `POL-${7700 + Number(no)}`, valid_until: no === '07' ? '2026-11-05' : '2027-01-14' },
  ]));
  tx.append('Daily reports', dailyReports);
  tx.append('Trips', dailyTrips);

  const sorted = entries.map(([bus_no, e]) => ({ bus_no, ...e })).sort((a, b) => a.date_in.localeCompare(b.date_in));
  const counters = {};
  const rows = [], parts = [];
  for (const e of sorted) {
    const year = e.date_in.slice(0, 4);
    counters[year] = (counters[year] || 0) + 1;
    const entry_id = `E-${year}-${String(counters[year]).padStart(4, '0')}`;
    const routeId = `R${e.bus_no}`;
    rows.push({
      entry_id, bus_no: e.bus_no, kind: e.kind, date_in: e.date_in, date_out: e.date_out,
      days_off_road: e.date_out ? Math.round((Date.parse(e.date_out) - Date.parse(e.date_in)) / 86400000) : '',
      odometer_km: e.odometer_km, system: e.system, problem_reported: e.problem_reported, root_cause: e.root_cause,
      workshop: e.workshop, bill_no: e.bill_no || '', labour_cost: '', total_cost: e.total_cost,
      route_at_time: routeId, is_repeat: false, filled_by_ai: false, record_status: 'Active',
      entered_by: 'demo', entered_at: `${e.date_out || e.date_in} 17:00`,
    });
    for (const [part_name, position, removed, fitted] of e.parts) {
      parts.push({ entry_id, bus_no: e.bus_no, system: e.system, part_name, position, removed_part_no: removed, fitted_part_no: fitted, record_status: 'Active' });
    }
  }
  tx.append('Entries', rows);
  tx.append('Parts changed', parts);
  tx.append('Change log', [{ timestamp: '2026-10-23 16:00', user: 'demo', action: 'Added', tab: 'Daily reports', record_id: '', field: '', old_value: '', new_value: `${dailyReports.length} illustrative daily bus reports with ${dailyTrips.length} trip legs` }]);
  tx.append('Change log', [{ timestamp: '2026-10-22 09:00', user: 'demo', action: 'Added', tab: 'All', record_id: '', field: '', old_value: '', new_value: 'Demo data loaded' }]);
});

console.log(`Demo data written to ${storage.workbookPath}`);
