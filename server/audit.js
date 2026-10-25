// SPDX-License-Identifier: GPL-3.0-or-later
//
// Audit logging. Never put patient identifiers in `details`; refer to
// records by id instead (the audit log itself is not encrypted).
//
// Tamper evidence: each entry's hash covers the previous entry's hash and is
// an HMAC keyed from the master key, so editing, inserting or deleting
// entries breaks the chain, and the chain can't be recomputed without the
// key. The database role the app runs as can only INSERT into audit_log.
// An encrypted "anchor" (the newest verified entry) catches deletion of the
// most recent entries, and the head hash is written to the server log.

import crypto from 'node:crypto';
import { pool } from './db.js';
import { auditMac, seal, unseal } from './crypto.js';

// jsonb doesn't preserve key order, so hash a key-sorted form of `details`.
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}

function rowHash(prevHash, row, version = 2) {
  const canonicalRow = JSON.stringify([
    prevHash || '', row.at, row.user_id ?? null, row.username ?? null, row.institution_id ?? null,
    row.action, row.entity_type ?? null, row.entity_id ?? null, canonical(row.details ?? null), row.ip ?? null,
  ]);
  if (version === 1) return crypto.createHash('sha256').update(canonicalRow).digest('hex');
  return auditMac(canonicalRow);
}

// actor: { id, username } (or null for system events); req supplies ip/institution.
export async function audit({ actor = null, req = null, institutionId, action, entityType = null, entityId = null, details = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(727275)');
    const prev = (await client.query('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1')).rows[0];
    const row = {
      at: new Date().toISOString(),
      user_id: actor?.id ?? req?.user?.id ?? null,
      username: actor?.username ?? req?.user?.username ?? null,
      institution_id: institutionId !== undefined ? institutionId : (req?.session?.institution_id ?? null),
      action,
      entity_type: entityType,
      entity_id: entityId === null || entityId === undefined ? null : String(entityId),
      details: details && Object.keys(details).length ? details : null,
      ip: req?.ip ?? null,
    };
    const hash = rowHash(prev?.hash, row);
    await client.query(
      `INSERT INTO audit_log (at, user_id, username, institution_id, action, entity_type, entity_id, details, ip, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [row.at, row.user_id, row.username, row.institution_id, row.action, row.entity_type, row.entity_id,
        row.details ? JSON.stringify(row.details) : null, row.ip, prev?.hash ?? null, hash],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // Auditing must never be silently skipped: keep the event in the server
    // log so it survives, then fail the request.
    console.error(`AUDIT WRITE FAILED: ${JSON.stringify({ action, entityType, entityId, details, user: actor?.username ?? req?.user?.username ?? null, ip: req?.ip ?? null, at: new Date().toISOString() })}`, e.message);
    throw e;
  } finally {
    client.release();
  }
}

// For frequent actions (autosave, worklist refresh): record the event at
// most once per window per key, so the log stays readable.
const recent = new Map();
export async function auditOnce(key, windowMs, event) {
  const now = Date.now();
  if (now - (recent.get(key) || 0) < windowMs) return;
  recent.set(key, now);
  if (recent.size > 20000) for (const [k, t] of recent) if (now - t > windowMs) recent.delete(k);
  await audit(event);
}

// Walks the whole chain; returns { ok, checked, brokenAt? }.
export async function verifyAuditChain() {
  const anchor = await loadAnchor();
  const client = await pool.connect();
  let prev = null;
  let checked = 0;
  let sawKeyed = false;
  let anchorSeen = false;
  let head = null;
  try {
    const cursorName = 'audit_verify';
    await client.query('BEGIN');
    await client.query(`DECLARE ${cursorName} CURSOR FOR
      SELECT id, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, user_id, username, institution_id,
             action, entity_type, entity_id, details, ip, prev_hash, hash, hash_version
      FROM audit_log ORDER BY id`);
    for (;;) {
      const { rows } = await client.query(`FETCH 1000 FROM ${cursorName}`);
      if (!rows.length) break;
      for (const r of rows) {
        // Once keyed entries begin, an unkeyed one can only be a forgery.
        if (r.hash_version === 1 && sawKeyed) return await fail(r.id);
        if (r.hash_version === 2) sawKeyed = true;
        if ((r.prev_hash || null) !== (prev || null) || rowHash(prev, r, r.hash_version) !== r.hash) return await fail(r.id);
        if (anchor && Number(r.id) === anchor.id) {
          if (r.hash !== anchor.hash) return await fail(r.id);
          anchorSeen = true;
        }
        prev = r.hash;
        head = { id: Number(r.id), hash: r.hash };
        checked++;
      }
    }
    await client.query('COMMIT');
    if (anchor && !anchorSeen) return { ok: false, checked, brokenAt: anchor.id, reason: `Entries up to #${anchor.id} were verified before but are now missing.` };
    if (head) await saveAnchor(head);
    return { ok: true, checked, head };
  } finally {
    client.release();
  }

  async function fail(id) {
    await client.query('ROLLBACK');
    return { ok: false, checked, brokenAt: Number(id) };
  }
}

async function loadAnchor() {
  const row = (await pool.query("SELECT value FROM settings WHERE key = '_audit_anchor'")).rows[0];
  if (!row) return null;
  try { return unseal(row.value, 'settings.audit_anchor'); } catch { return { id: -1, hash: 'invalid' }; }
}

async function saveAnchor(head) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('_audit_anchor', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(seal(head, 'settings.audit_anchor'))]);
  console.log(`Audit chain verified; head is entry #${head.id} ${head.hash}`);
}
