// Copies every row of the Excel workbook into Postgres.
//   node --env-file=.env scripts/import-xlsx.js <school-id> [source data folder]
// The school must exist already (scripts/admin.js create-school). Every row is stamped with that
// school's id. The source folder defaults to DATA_DIR (or ./data). The school's own tables must be
// empty apart from the default Lists and Settings: a second run would duplicate the history, so it refuses.

import { TABS } from '../src/schema.js';
import { createLocalStorage } from '../src/storage/local-xlsx.js';
import { createPostgresStorage, tableName } from '../src/storage/postgres.js';

const [schoolId, folder] = process.argv.slice(2);
if (!schoolId) {
  console.error('Usage: node --env-file=.env scripts/import-xlsx.js <school-id> [source data folder]');
  process.exit(1);
}
const source = createLocalStorage(folder || process.env.DATA_DIR || './data');
const root = createPostgresStorage(process.env);
await root.init();
const target = root.forSchool(schoolId);

if (!(await target.read('Schools')).length) {
  console.error(`School ${schoolId} does not exist. Create it first with scripts/admin.js create-school.`);
  await root.close();
  process.exit(1);
}

const fromWorkbook = {};
for (const tab of Object.keys(TABS)) fromWorkbook[tab] = await source.read(tab);

for (const tab of Object.keys(TABS)) {
  const { rows } = await root.pool.query(`SELECT count(*)::int AS n FROM ${tableName(tab)} WHERE school_id = $1`, [schoolId]);
  if (rows[0].n > 0 && fromWorkbook[tab].length > 0 && !['Schools', 'Lists', 'Settings'].includes(tab)) {
    console.error(`${tab} already has ${rows[0].n} rows for ${schoolId}. Import into a school with no history.`);
    await root.close();
    process.exit(1);
  }
}

// New schools start with default Lists and Settings; the workbook's own values replace them.
for (const tab of ['Lists', 'Settings']) {
  if (fromWorkbook[tab].length) await root.pool.query(`DELETE FROM ${tableName(tab)} WHERE school_id = $1`, [schoolId]);
}

await target.transact((tx) => {
  for (const tab of Object.keys(TABS)) {
    if (tab === 'Schools') continue; // the school was created by admin.js
    if (fromWorkbook[tab].length) tx.append(tab, fromWorkbook[tab]);
    console.log(`${tab.padEnd(20)} ${fromWorkbook[tab].length} rows`);
  }
});

await root.close();
console.log('\nImport finished.');
