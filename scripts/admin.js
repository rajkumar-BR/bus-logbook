// Manage schools and users (Postgres mode).
//   node --env-file=.env scripts/admin.js <command> [options]
//
//   create-school "Little Flower School" [--short LFS] [--region Kerala] [--id school-001]
//   create-user <school-id> <email> [--name "Office"]     asks for the password
//   set-password <email>                                  asks for the new password; signs the user out everywhere
//   disable-user <email> | enable-user <email>
//   list                                                  schools and users
//   assign-legacy <school-id>                             give rows that have no school (Phase 1 data) to this school

import readline from 'node:readline';
import { createPostgresStorage } from '../src/storage/postgres.js';
import { createAccounts } from '../src/accounts.js';

const [command, ...rest] = process.argv.slice(2);
const positional = [];
const flags = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i];
  else positional.push(rest[i]);
}

const usage = () => {
  console.error('Commands: create-school, create-user, set-password, disable-user, enable-user, list, assign-legacy.\nSee the top of scripts/admin.js.');
  process.exit(1);
};

// One readline session serves both prompts, so piped input works as well as typing.
let rl = null;
const lines = [];
const waiting = [];
function askPassword(label) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    rl._writeToOutput = () => {}; // hide what is typed; the labels are printed below
    rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
    rl.on('close', () => { while (waiting.length) waiting.shift()(''); });
  }
  process.stdout.write(label);
  return new Promise((resolve) => {
    if (lines.length) resolve(lines.shift());
    else waiting.push(resolve);
  }).then((answer) => { process.stdout.write('\n'); return answer; });
}

async function newPassword() {
  const first = await askPassword('Password (at least 8 characters): ');
  const again = await askPassword('Type it again: ');
  rl?.close();
  if (first !== again) throw new Error('The two passwords are different.');
  return first;
}

const storage = createPostgresStorage(process.env);
const accounts = createAccounts(storage);

try {
  await storage.init();
  await accounts.init();

  if (command === 'create-school') {
    const id = await accounts.createSchool({ name: positional[0], shortName: flags.short, region: flags.region, id: flags.id });
    console.log(`Created ${id}. Next: node --env-file=.env scripts/admin.js create-user ${id} <email>`);
  } else if (command === 'create-user') {
    const [schoolId, email] = positional;
    if (!schoolId || !email) usage();
    await accounts.createUser({ schoolId, email, name: flags.name, password: await newPassword() });
    console.log(`User ${email.toLowerCase()} can now sign in and see ${schoolId}.`);
  } else if (command === 'set-password') {
    if (!positional[0]) usage();
    await accounts.setPassword(positional[0], await newPassword());
    console.log('Password changed. The user was signed out everywhere.');
  } else if (command === 'disable-user' || command === 'enable-user') {
    if (!positional[0]) usage();
    await accounts.setActive(positional[0], command === 'enable-user');
    console.log(`${positional[0].toLowerCase()} ${command === 'enable-user' ? 'enabled' : 'disabled'}.`);
  } else if (command === 'list') {
    const users = await accounts.listUsers();
    for (const s of await accounts.listSchools()) {
      console.log(`${s.school_id}  ${s.school_name}`);
      for (const u of users.filter((x) => x.school_id === s.school_id)) console.log(`    ${u.email}${u.active ? '' : '  (disabled)'}`);
    }
  } else if (command === 'assign-legacy') {
    if (!positional[0]) usage();
    const moved = await accounts.assignLegacyData(positional[0]);
    console.log(Object.keys(moved).length ? moved : 'No rows without a school were found.');
    console.log(`Files saved before schools existed are served only to ${positional[0]} when LEGACY_SCHOOL_ID=${positional[0]} is set.`);
  } else {
    usage();
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
} finally {
  await storage.close();
}
