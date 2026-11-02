// Organisations (stored as "schools"), users and login sessions for the Postgres version.
// Every user belongs to exactly one organisation and can see and edit all of its data.
// An organisation is 'pending' (signed up, waiting for payment and approval), 'approved' or 'suspended'.
// A blank status counts as approved, so organisations that existed before approval was added keep working.
// Passwords are stored as scrypt hashes; session tokens are stored only as SHA-256 hashes.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, TABS, columnsOf } from './schema.js';
import { SCHOOL_ID_PATTERN, tableName } from './storage/postgres.js';
import { UserError } from './ai.js';

const scrypt = promisify(crypto.scrypt);
const COST = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200; // scrypt is slow on purpose, so very long input is refused
export const SESSION_HOURS = 24;

export const ORG_STATUSES = ['pending', 'approved', 'suspended'];
export const orgStatus = (raw) => (raw === 'pending' || raw === 'suspended' ? raw : 'approved');

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, { ...COST, maxmem: 128 * 1024 * 1024 });
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [scheme, n, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +n, r: +r, p: +p, maxmem: 128 * 1024 * 1024 });
  return crypto.timingSafeEqual(key, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normaliseEmail = (email) => String(email || '').trim().toLowerCase();

export function checkNewCredentials(email, password) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normaliseEmail(email))) throw new UserError('Enter a valid email address.');
  if (String(password || '').length < MIN_PASSWORD) throw new UserError(`The password must be at least ${MIN_PASSWORD} characters.`);
  if (String(password).length > MAX_PASSWORD) throw new UserError(`The password must be at most ${MAX_PASSWORD} characters.`);
}

export function createAccounts(storage) {
  const { pool, schema } = storage;
  const t = (name) => `"${schema}"."${name}"`;
  let dummyHash = null; // checked when the email is unknown, so unknown and wrong-password logins take equally long

  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${t('app_users')} (
      user_id bigserial PRIMARY KEY,
      school_id text NOT NULL,
      email text NOT NULL,
      name text,
      password_hash text NOT NULL,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS app_users_email ON ${t('app_users')} (lower(email))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${t('app_sessions')} (
      token_hash text PRIMARY KEY,
      user_id bigint NOT NULL REFERENCES ${t('app_users')} (user_id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL)`);
  }

  // ---------- schools

  async function createSchool({ name, shortName = '', region = '', id = null, status = 'approved' }) {
    if (!String(name || '').trim()) throw new UserError('The organisation needs a name.');
    const schoolId = id || (await nextSchoolId());
    if (!SCHOOL_ID_PATTERN.test(schoolId)) throw new UserError('An organisation id uses lowercase letters, digits and dashes, e.g. school-001.');
    const own = storage.forSchool(schoolId);
    if ((await own.read('Schools')).length) throw new UserError(`Organisation ${schoolId} already exists.`);
    await own.transact((tx) => {
      if (tx.read('Schools').length) throw new UserError(`Organisation ${schoolId} already exists.`); // two creations at once
      tx.append('Schools', [{
        school_name: name.trim(), short_name: shortName, region, active: true, status,
        created_at: new Date().toISOString().slice(0, 16).replace('T', ' '),
      }]);
      const longest = Math.max(...Object.values(DEFAULT_LISTS).map((l) => l.length));
      tx.append('Lists', Array.from({ length: longest }, (_, i) => Object.fromEntries(
        columnsOf('Lists').map((c) => [c, DEFAULT_LISTS[c][i] ?? '']),
      )));
      tx.append('Settings', DEFAULT_SETTINGS.map(([key, value]) => ({ key, value })));
    });
    return schoolId;
  }

  async function nextSchoolId() {
    const { rows } = await pool.query(`SELECT school_id FROM ${t('schools')} WHERE school_id ~ '^school-[0-9]+$'`);
    const highest = Math.max(0, ...rows.map((r) => Number(r.school_id.slice(7))));
    return `school-${String(highest + 1).padStart(3, '0')}`;
  }

  async function listSchools() {
    const { rows } = await pool.query(`
      SELECT s.school_id, s.school_name, s.status, s.created_at,
             (SELECT count(*)::int FROM ${t('app_users')} u WHERE u.school_id = s.school_id AND u.active) AS users
      FROM ${t('schools')} s ORDER BY s.school_id`);
    return rows;
  }

  // Phase 1 data has no school id. This stamps it with one, so the first school can keep its history.
  async function assignLegacyData(schoolId) {
    if (!(await storage.forSchool(schoolId).read('Schools')).length) throw new UserError(`Organisation ${schoolId} does not exist. Create it first.`);
    const moved = {};
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const tab of Object.keys(TABS)) {
        if (tab === 'Schools') continue;
        const name = t(tableName(tab));
        const blank = `(school_id IS NULL OR school_id = '')`;
        // Lists and Settings: the old rows replace the defaults the new school was given.
        if (tab === 'Lists' || tab === 'Settings') {
          const { rows } = await client.query(`SELECT 1 FROM ${name} WHERE ${blank} LIMIT 1`);
          if (rows.length) await client.query(`DELETE FROM ${name} WHERE school_id = $1`, [schoolId]);
        }
        const res = await client.query(`UPDATE ${name} SET school_id = $1 WHERE ${blank}`, [schoolId]);
        if (res.rowCount) moved[tab] = res.rowCount;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return moved;
  }

  async function removeSchool(schoolId) {
    for (const tab of Object.keys(TABS)) await pool.query(`DELETE FROM ${t(tableName(tab))} WHERE school_id = $1`, [schoolId]);
  }

  async function setStatus(schoolId, status) {
    if (!ORG_STATUSES.includes(status)) throw new UserError(`Status must be one of: ${ORG_STATUSES.join(', ')}.`);
    const changed = await storage.forSchool(schoolId).transact((tx) => tx.update('Schools', () => true, { status }));
    if (!changed.length) throw new UserError(`Organisation ${schoolId} does not exist.`);
  }

  // Self-service signup: an organisation and its first user, created together. The organisation
  // starts 'pending' and cannot use the app until it has paid and been approved.
  async function signUp({ organisationName, email, password }) {
    const name = String(organisationName || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 120) throw new UserError('Enter the organisation name (2 to 120 characters).');
    checkNewCredentials(email, password);
    const taken = await pool.query(`SELECT 1 FROM ${t('app_users')} WHERE lower(email) = $1`, [normaliseEmail(email)]);
    if (taken.rows.length) throw new UserError('That email already has an account. Log in instead.', 409);

    const schoolId = `school-${crypto.randomBytes(4).toString('hex')}`; // random, so ids do not reveal how many schools exist
    await createSchool({ name, id: schoolId, status: 'pending' });
    try {
      const userId = await createUser({ schoolId, email, password });
      return { user_id: userId, school_id: schoolId, email: normaliseEmail(email) };
    } catch (err) {
      await removeSchool(schoolId); // do not leave an empty school behind
      throw err;
    }
  }

  // ---------- users

  async function createUser({ schoolId, email, password, name = '' }) {
    checkNewCredentials(email, password);
    if (!(await storage.forSchool(schoolId).read('Schools')).length) throw new UserError(`Organisation ${schoolId} does not exist.`);
    const hash = await hashPassword(password);
    try {
      const { rows } = await pool.query(
        `INSERT INTO ${t('app_users')} (school_id, email, name, password_hash) VALUES ($1, $2, $3, $4) RETURNING user_id`,
        [schoolId, normaliseEmail(email), name, hash],
      );
      return rows[0].user_id;
    } catch (err) {
      if (err.code === '23505') throw new UserError(`A user with the email ${normaliseEmail(email)} already exists.`);
      throw err;
    }
  }

  async function setPassword(email, password) {
    checkNewCredentials(email, password);
    const { rows } = await pool.query(
      `UPDATE ${t('app_users')} SET password_hash = $2 WHERE lower(email) = $1 RETURNING user_id`,
      [normaliseEmail(email), await hashPassword(password)],
    );
    if (!rows.length) throw new UserError(`No user with the email ${normaliseEmail(email)}.`);
    await pool.query(`DELETE FROM ${t('app_sessions')} WHERE user_id = $1`, [rows[0].user_id]); // sign out everywhere
  }

  async function setActive(email, active) {
    const { rows } = await pool.query(
      `UPDATE ${t('app_users')} SET active = $2 WHERE lower(email) = $1 RETURNING user_id`,
      [normaliseEmail(email), active],
    );
    if (!rows.length) throw new UserError(`No user with the email ${normaliseEmail(email)}.`);
    if (!active) await pool.query(`DELETE FROM ${t('app_sessions')} WHERE user_id = $1`, [rows[0].user_id]);
  }

  async function listUsers() {
    const { rows } = await pool.query(`SELECT user_id, school_id, email, name, active FROM ${t('app_users')} ORDER BY school_id, email`);
    return rows;
  }

  // Returns the user, or null when the email or password is wrong or the user is disabled.
  async function login(email, password) {
    const { rows } = await pool.query(
      `SELECT user_id, school_id, email, name, password_hash, active FROM ${t('app_users')} WHERE lower(email) = $1`,
      [normaliseEmail(email)],
    );
    const user = rows[0];
    if (!user) {
      dummyHash ||= await hashPassword('not-a-real-password');
      await verifyPassword(String(password), dummyHash);
      return null;
    }
    const ok = await verifyPassword(String(password), user.password_hash);
    if (!ok || !user.active) return null;
    return { user_id: user.user_id, school_id: user.school_id, email: user.email, name: user.name };
  }

  // ---------- sessions

  async function createSession(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO ${t('app_sessions')} (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
      [sha256(token), userId, SESSION_HOURS],
    );
    await pool.query(`DELETE FROM ${t('app_sessions')} WHERE expires_at < now()`);
    return token;
  }

  async function getSession(token) {
    if (!token) return null;
    const { rows } = await pool.query(
      `SELECT u.user_id, u.school_id, u.email, u.name, sc.status AS school_status
       FROM ${t('app_sessions')} s JOIN ${t('app_users')} u USING (user_id)
       LEFT JOIN ${t('schools')} sc ON sc.school_id = u.school_id
       WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
      [sha256(token)],
    );
    if (!rows[0]) return null;
    const { school_status: status, ...user } = rows[0];
    return { ...user, org_status: orgStatus(status) };
  }

  async function deleteSession(token) {
    if (token) await pool.query(`DELETE FROM ${t('app_sessions')} WHERE token_hash = $1`, [sha256(token)]);
  }

  return {
    init, createSchool, signUp, setStatus, listSchools, assignLegacyData,
    createUser, setPassword, setActive, listUsers, login,
    createSession, getSession, deleteSession,
  };
}
