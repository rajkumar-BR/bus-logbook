// Picks the storage backend. The current local implementation is kept for dev,
// while the Google Drive adapter supports the single-school admin deployment mode.
import { createLocalStorage } from './local-xlsx.js';
import { createGoogleDriveStorage } from './google-drive.js';
import { createPostgresStorage } from './postgres.js';

export function createStorage(env = process.env) {
  const kind = (env.STORAGE || 'local').toLowerCase();
  if (kind === 'local') return createLocalStorage(env.DATA_DIR || './data');
  if (kind === 'google') return createGoogleDriveStorage(env);
  if (kind === 'postgres') return createPostgresStorage(env);
  throw new Error(`Unknown STORAGE "${kind}". Use STORAGE=local, STORAGE=google or STORAGE=postgres.`);
}
