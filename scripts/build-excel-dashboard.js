import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ExcelJS from 'exceljs';
import { createLocalStorage } from '../src/storage/local-xlsx.js';
import { createService } from '../src/service.js';

const sourcePath = path.resolve('demo-data/Bus Logbook Data.xlsx');
const outputDir = path.resolve('excel-dashboard');
const outputPath = path.join(outputDir, 'Bus Logbook Dashboard - Demo.xlsx');
const execFileAsync = promisify(execFile);
const input = new ExcelJS.Workbook();
await input.xlsx.readFile(sourcePath);
const calculationDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bus-logbook-dashboard-'));
await fs.copyFile(sourcePath, path.join(calculationDir, 'Bus Logbook Data.xlsx'));
const calculationStorage = createLocalStorage(calculationDir);
await calculationStorage.init();
const calculationService = createService(calculationStorage, { today: () => new Date().toISOString().slice(0, 10) });
const fleetData = await calculationService.getFleet();
const repeatsData = await calculationService.getRepeats();
await fs.rm(calculationDir, { recursive: true, force: true });

const workbook = new ExcelJS.Workbook();
workbook.creator = 'Bus Logbook';
workbook.subject = 'Standalone Excel fleet maintenance dashboard';
workbook.title = 'Bus Logbook Dashboard - Demo';
workbook.calcProperties = { fullCalcOnLoad: true, forceFullCalc: true, calcMode: 'auto' };

const palette = {
  ink: '17312B',
  green: '176B55',
  mint: 'E5F2EC',
  paper: 'F5F7F4',
  white: 'FFFFFF',
  muted: '61716B',
  amber: 'FFF0C2',
  red: 'FCE2DD',
  line: 'D9E3DD',
};
const titleStyle = { font: { name: 'Aptos Display', size: 22, bold: true, color: { argb: palette.white } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: palette.ink } }, alignment: { vertical: 'middle' } };
const headerStyle = { font: { name: 'Aptos', bold: true, color: { argb: palette.white } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: palette.green } }, alignment: { vertical: 'middle', wrapText: true } };

function quoteSheet(name) {
  return `'${name.replace(/'/g, "''")}'`;
}

function colLetter(index) {
  let result = '';
  while (index > 0) {
    const remainder = (index - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    index = Math.floor((index - 1) / 26);
  }
  return result;
}

function sheetColumns(sheet) {
  const headers = sheet.getRow(1).values.slice(1).map((value) => String(value ?? '').trim());
  return Object.fromEntries(headers.map((header, index) => [header, index + 1]));
}

function ref(sheetName, columns, header, start = 2, end = 5000) {
  const column = colLetter(columns[header]);
  return `${quoteSheet(sheetName)}!$${column}$${start}:$${column}$${end}`;
}

function setTitle(sheet, title, lastCol) {
  sheet.mergeCells(1, 1, 1, lastCol);
  const cell = sheet.getCell(1, 1);
  cell.value = title;
  cell.style = titleStyle;
  sheet.getRow(1).height = 38;
}

function styleHeader(row) {
  row.eachCell((cell) => { cell.style = headerStyle; });
  row.height = 30;
}

function addRawDataSheets() {
  for (const source of input.worksheets) {
    const target = workbook.addWorksheet(source.name, { properties: { tabColor: palette.green } });
    source.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
        target.getCell(rowNumber, columnNumber).value = cell.value;
      });
    });
    target.views = [{ state: 'frozen', ySplit: 1 }];
    target.autoFilter = { from: 'A1', to: { row: Math.max(1, target.rowCount), column: Math.max(1, target.columnCount) } };
    styleHeader(target.getRow(1));
    target.columns.forEach((column, index) => {
      const header = String(target.getRow(1).getCell(index + 1).value ?? '');
      column.width = Math.max(13, Math.min(30, header.length + 3));
    });
    for (let rowNumber = 2; rowNumber <= target.rowCount; rowNumber++) {
      target.getRow(rowNumber).eachCell((cell) => {
        cell.font = { name: 'Aptos', size: 10, color: { argb: palette.ink } };
        if (rowNumber % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: palette.paper } };
      });
    }
  }
}

addRawDataSheets();

const busesSheet = workbook.getWorksheet('Buses');
const entriesSheet = workbook.getWorksheet('Entries');
const routesSheet = workbook.getWorksheet('Routes');
const assignmentsSheet = workbook.getWorksheet('Route assignments');
const docsSheet = workbook.getWorksheet('Bus documents');
const listsSheet = workbook.getWorksheet('Lists');
const buses = sheetColumns(busesSheet);
const entries = sheetColumns(entriesSheet);
const routes = sheetColumns(routesSheet);
const assignments = sheetColumns(assignmentsSheet);
const docs = sheetColumns(docsSheet);
const listColumns = sheetColumns(listsSheet);
const systems = [];
for (let row = 2; row <= listsSheet.rowCount; row++) {
  const value = String(listsSheet.getCell(row, listColumns.systems).value ?? '').trim();
  if (value && value !== 'Other' && !systems.includes(value)) systems.push(value);
}

const busNoRange = ref('Buses', buses, 'bus_no');
const entryBusRange = ref('Entries', entries, 'bus_no');
const entryDateRange = ref('Entries', entries, 'date_in');
const entryKindRange = ref('Entries', entries, 'kind');
const entryOdoRange = ref('Entries', entries, 'odometer_km');
const entryCostRange = ref('Entries', entries, 'total_cost');
const entryStateRange = ref('Entries', entries, 'record_status');
const entrySystemRange = ref('Entries', entries, 'system');
const entryActive = 'Active';
const maxDataRow = 5000;

const fleet = workbook.addWorksheet('Fleet dashboard', { properties: { tabColor: palette.green } });
fleet.views = [{ state: 'frozen', ySplit: 4 }];
setTitle(fleet, 'Fleet service view', 10);
fleet.mergeCells('A2:J2');
fleet.getCell('A2').value = 'Live calculations from the workbook data. Service intervals default to 10,000 km or 90 days unless set per bus.';
fleet.getCell('A2').font = { italic: true, color: { argb: palette.muted } };
const fleetHeaders = ['Bus', 'Route', 'Status', 'Odometer km', 'Last service', 'Service status', 'Km to service', 'Days to service', 'Spend since service (₹)', 'Repairs · 12 mo'];
fleet.addRow([]);
fleet.addRow(fleetHeaders);
for (const bus of fleetData.buses) {
  const row = fleet.addRow([]);
  row.values = [bus.bus_no, bus.route, bus.status, bus.odometer ?? '', bus.last_service ? new Date(`${bus.last_service}T00:00:00`) : '', bus.service.state === 'overdue' ? 'OVERDUE' : bus.service.state === 'due' ? 'DUE SOON' : bus.service.state === 'unknown' ? 'No service recorded' : 'OK', bus.service.kmLeft ?? '', bus.service.daysLeft ?? '', bus.spent_since_service, bus.repairs12];
}
fleet.autoFilter = { from: 'A4', to: { row: fleet.rowCount, column: fleetHeaders.length } };
fleet.columns = [{ width: 13 }, { width: 24 }, { width: 18 }, { width: 16 }, { width: 16 }, { width: 22 }, { width: 17 }, { width: 18 }, { width: 24 }, { width: 17 }];
for (let row = 5; row <= fleet.rowCount; row++) {
  fleet.getCell(row, 5).numFmt = 'dd mmm yyyy';
  fleet.getCell(row, 9).numFmt = '₹#,##0';
  fleet.getCell(row, 4).numFmt = '#,##0';
  fleet.getCell(row, 7).numFmt = '#,##0';
}
fleet.addConditionalFormatting({ ref: `F5:F${fleet.rowCount}`, rules: [
  { type: 'containsText', formulae: ['"OVERDUE"'], text: 'OVERDUE', style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: palette.red } }, font: { bold: true, color: { argb: '9C2F1F' } } } },
  { type: 'containsText', formulae: ['"DUE SOON"'], text: 'DUE SOON', style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: palette.amber } }, font: { bold: true, color: { argb: '805500' } } } },
] });

const repeats = workbook.addWorksheet('Repeat repairs', { properties: { tabColor: 'D28A27' } });
repeats.views = [{ state: 'frozen', ySplit: 4, xSplit: 1 }];
const repeatCols = Math.max(3, systems.length + 2);
setTitle(repeats, 'Repeat repairs · last 12 months', repeatCols);
repeats.mergeCells(2, 1, 2, repeatCols);
repeats.getCell('A2').value = 'Repair and breakdown counts by bus and system. Cells with 2 or more warrant review.';
repeats.getCell('A2').font = { italic: true, color: { argb: palette.muted } };
repeats.addRow([]);
repeats.addRow(['Bus', ...systems, 'Total']);
styleHeader(repeats.getRow(4));
for (const bus of fleetData.buses) {
  const row = repeats.addRow([]);
  const matrixRow = repeatsData.matrix.find((item) => item.bus_no === bus.bus_no);
  row.getCell(1).value = bus.bus_no;
  systems.forEach((system, index) => { row.getCell(index + 2).value = matrixRow?.counts[repeatsData.systems.indexOf(system)] ?? 0; });
  row.getCell(systems.length + 2).value = matrixRow?.total ?? 0;
}
repeats.columns = [{ width: 13 }, ...systems.map(() => ({ width: 23 })), { width: 14 }];
repeats.autoFilter = { from: 'A4', to: { row: repeats.rowCount, column: systems.length + 2 } };
if (systems.length) {
  repeats.addConditionalFormatting({ ref: `B5:${colLetter(systems.length + 1)}${repeats.rowCount}`, rules: [
    { type: 'cellIs', operator: 'greaterThanOrEqual', formulae: ['2'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: palette.red } }, font: { bold: true, color: { argb: '9C2F1F' } } } },
    { type: 'cellIs', operator: 'equal', formulae: ['1'], style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: palette.amber } } } },
  ] });
}

const dashboard = workbook.addWorksheet('Dashboard', { properties: { tabColor: palette.ink } });
dashboard.views = [{ state: 'frozen', ySplit: 2 }];
dashboard.columns = Array.from({ length: 8 }, () => ({ width: 18 }));
setTitle(dashboard, 'BUS LOGBOOK  /  FLEET DASHBOARD', 8);
dashboard.mergeCells('A2:H2');
dashboard.getCell('A2').value = 'Standalone Excel edition · illustrative demo data · summary calculated from included records';
dashboard.getCell('A2').font = { italic: true, color: { argb: palette.muted } };

function card(label, value, fromCol, toCol, valueFormat = '0') {
  dashboard.mergeCells(4, fromCol, 4, toCol);
  dashboard.mergeCells(5, fromCol, 6, toCol);
  const labelCell = dashboard.getCell(4, fromCol);
  labelCell.value = label.toUpperCase();
  labelCell.font = { bold: true, size: 9, color: { argb: palette.muted } };
  labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: palette.mint } };
  labelCell.alignment = { vertical: 'middle' };
  const valueCell = dashboard.getCell(5, fromCol);
  valueCell.value = value;
  valueCell.font = { bold: true, size: 22, color: { argb: palette.ink } };
  valueCell.numFmt = valueFormat;
  valueCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: palette.mint } };
  valueCell.alignment = { vertical: 'middle' };
  for (let row = 4; row <= 6; row++) {
    for (let col = fromCol; col <= toCol; col++) dashboard.getCell(row, col).border = { bottom: { style: 'thin', color: { argb: palette.line } } };
  }
}

const inWorkshop = fleetData.buses.filter((bus) => bus.status === 'In workshop').length;
const serviceDue = fleetData.buses.filter((bus) => ['due', 'overdue'].includes(bus.service.state)).length;
card('Active buses', fleetData.buses.length, 1, 2);
card('In workshop', inWorkshop, 3, 4);
card('Service due / overdue', serviceDue, 5, 6);
card('Maintenance spend · this year', fleetData.summary.spendYear, 7, 8, '₹#,##0');

dashboard.mergeCells('A8:D8');
dashboard.getCell('A8').value = 'SERVICE WATCH';
dashboard.getCell('A8').style = headerStyle;
dashboard.mergeCells('E8:H8');
dashboard.getCell('E8').value = 'REPEAT REPAIRS';
dashboard.getCell('E8').style = headerStyle;
dashboard.mergeCells('A9:D10');
const overdueCount = fleetData.buses.filter((bus) => bus.service.state === 'overdue').length;
const dueSoonCount = fleetData.buses.filter((bus) => bus.service.state === 'due').length;
dashboard.getCell('A9').value = overdueCount ? `${overdueCount} bus(es) overdue for service` : dueSoonCount ? `${dueSoonCount} bus(es) due soon` : 'No service alerts based on current records';
dashboard.getCell('A9').alignment = { wrapText: true, vertical: 'middle' };
dashboard.getCell('A9').font = { size: 13, bold: true, color: { argb: palette.ink } };
dashboard.mergeCells('E9:H10');
const repeatedPairs = repeatsData.matrix.reduce((count, row) => count + row.counts.filter((value) => value >= 2).length, 0);
dashboard.getCell('E9').value = `${repeatedPairs} bus/system pair(s) have 2+ repairs`;
dashboard.getCell('E9').alignment = { wrapText: true, vertical: 'middle' };
dashboard.getCell('E9').font = { size: 13, bold: true, color: { argb: palette.ink } };
dashboard.mergeCells('A12:H12');
dashboard.getCell('A12').value = 'WORKBOOK CONTENTS';
dashboard.getCell('A12').style = headerStyle;
dashboard.mergeCells('A13:H14');
dashboard.getCell('A13').value = 'Fleet dashboard: per-bus service and spending status. Repeat repairs: 12-month counts by bus and system. The remaining tabs contain the full editable source data, including buses, routes, maintenance entries, changed parts, documents, workshops, settings and change log.';
dashboard.getCell('A13').alignment = { wrapText: true, vertical: 'top' };
dashboard.getCell('A13').font = { color: { argb: palette.ink }, size: 11 };
dashboard.mergeCells('A16:H16');
dashboard.getCell('A16').value = 'Illustrative sample records are included for demonstration. Replace the rows in the data tabs with approved school data before operational use.';
dashboard.getCell('A16').font = { italic: true, color: { argb: '805500' }, size: 10 };
dashboard.getCell('A16').alignment = { wrapText: true };
dashboard.getRow(9).height = 28;
dashboard.getRow(10).height = 28;
dashboard.getRow(13).height = 32;
dashboard.getRow(14).height = 32;
dashboard.getRow(16).height = 30;

dashboard.getCell('A18').value = 'Fleet detail: use the Fleet dashboard tab below';
dashboard.getCell('C18').value = 'Repeat repairs: use the Repeat repairs tab below';
dashboard.getCell('A18').font = { underline: true, color: { argb: palette.green }, bold: true };
dashboard.getCell('C18').font = { underline: true, color: { argb: palette.green }, bold: true };

for (const sheet of workbook.worksheets) {
  sheet.eachRow((row) => row.eachCell((cell) => {
    if (cell.value && !cell.font?.name) cell.font = { ...cell.font, name: 'Aptos' };
  }));
}

await fs.mkdir(outputDir, { recursive: true });
workbook.views = [{ activeTab: workbook.worksheets.indexOf(dashboard), firstSheet: 0 }];
await workbook.xlsx.writeFile(outputPath);
const cleanDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bus-logbook-xlsx-clean-'));
try {
  await execFileAsync('soffice', ['--headless', '--convert-to', 'xlsx', '--outdir', cleanDir, outputPath]);
  await fs.copyFile(path.join(cleanDir, path.basename(outputPath)), outputPath);
} catch (error) {
  throw new Error(`Could not sanitize the generated workbook with LibreOffice. Install LibreOffice and retry. ${error.message}`);
} finally {
  await fs.rm(cleanDir, { recursive: true, force: true });
}
console.log(`Created ${outputPath}`);