// Copies every row of the Excel workbook into Postgres.
//   node --env-file=.env scripts/import-xlsx.js [source data folder]
// The source folder defaults to DATA_DIR (or ./data). Run it against an empty database:
// it refuses to import into tables that already hold rows, so a second run can't duplicate history.

import { TABS } from '../src/schema.js';
import { createLocalStorage } from '../src/storage/local-xlsx.js';
import { createPostgresStorage, tableName } from '../src/storage/postgres.js';

const source = createLocalStorage(process.argv[2] || process.env.DATA_DIR || './data');
const target = createPostgresStorage(process.env);

await target.init();

// init() fills Lists and Settings with defaults; the workbook's own values replace them.
for (const tab of ['Lists', 'Settings']) await target.pool.query(`TRUNCATE ${tableName(tab)} RESTART IDENTITY`);

const fromWorkbook = {};
for (const tab of Object.keys(TABS)) fromWorkbook[tab] = await source.read(tab);

for (const tab of Object.keys(TABS)) {
  const { rows } = await target.pool.query(`SELECT count(*)::int AS n FROM ${tableName(tab)}`);
  if (rows[0].n > 0 && fromWorkbook[tab].length > 0) {
    console.error(`${tab} already has ${rows[0].n} rows in Postgres. Import only into an empty database.`);
    await target.close();
    process.exit(1);
  }
}

await target.transact((tx) => {
  for (const tab of Object.keys(TABS)) {
    if (fromWorkbook[tab].length) tx.append(tab, fromWorkbook[tab]);
    console.log(`${tab.padEnd(20)} ${fromWorkbook[tab].length} rows`);
  }
});

await target.close();
console.log('\nImport finished.');
