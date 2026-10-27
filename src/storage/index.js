// Picks the storage backend. The current local implementation is kept for dev,
// while the Google Drive adapter supports the single-school admin deployment mode.
import { createLocalStorage } from './local-xlsx.js';
import { createGoogleDriveStorage } from './google-drive.js';

export function createStorage(env = process.env) {
  const kind = (env.STORAGE || 'local').toLowerCase();
  if (kind === 'local') return createLocalStorage(env.DATA_DIR || './data');
  if (kind === 'google') return createGoogleDriveStorage(env);
  throw new Error(`Unknown STORAGE "${kind}". Use STORAGE=local or STORAGE=google.`);
}
