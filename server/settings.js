// SPDX-License-Identifier: GPL-3.0-or-later

import { many, query } from './db.js';
import { DEFAULT_SETTINGS } from './config.js';
import { seal, unseal, decryptLegacy, isLegacyCiphertext } from './crypto.js';

let cache = null;

export async function getSettings() {
  if (!cache) {
    const rows = await many("SELECT key, value FROM settings WHERE key NOT LIKE '\\_%'");
    cache = { ...DEFAULT_SETTINGS };
    for (const r of rows) if (r.key in DEFAULT_SETTINGS) cache[r.key] = r.value;
  }
  return cache;
}

export async function updateSettings(changes, userId) {
  for (const [key, value] of Object.entries(changes)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    await query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), userId],
    );
  }
  cache = null;
  return getSettings();
}

// Stores an encrypted canary the first time the app starts, then checks it on
// every start so a wrong or changed master key is caught immediately instead
// of producing unreadable data.
export async function checkMasterKey() {
  const row = (await query("SELECT value FROM settings WHERE key = '_key_check'")).rows[0];
  const canary = () => JSON.stringify(seal('sonoforms', 'settings.key_check'));
  if (!row) {
    await query("INSERT INTO settings (key, value) VALUES ('_key_check', $1)", [canary()]);
    return;
  }
  try {
    if (isLegacyCiphertext(row.value)) {
      if (decryptLegacy(row.value, 'settings.key_check') === 'sonoforms') {
        await query("UPDATE settings SET value = $1 WHERE key = '_key_check'", [canary()]);
        return;
      }
    } else if (unseal(row.value, 'settings.key_check') === 'sonoforms') return;
  } catch { /* fall through */ }
  throw new Error('SONOFORMS_MASTER_KEY does not match the key this database was created with. Restore the original key from your backup; data cannot be read without it.');
}
