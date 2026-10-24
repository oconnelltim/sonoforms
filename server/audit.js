// SPDX-License-Identifier: GPL-3.0-or-later
//
// Audit logging. Never put patient identifiers in `details`; refer to
// records by id instead (the audit log itself is not encrypted).

import crypto from 'node:crypto';
import { pool } from './db.js';

// jsonb doesn't preserve key order, so hash a key-sorted form of `details`.
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}

function rowHash(prevHash, row) {
  const canonicalRow = JSON.stringify([
    prevHash || '', row.at, row.user_id ?? null, row.username ?? null, row.institution_id ?? null,
    row.action, row.entity_type ?? null, row.entity_id ?? null, canonical(row.details ?? null), row.ip ?? null,
  ]);
  return crypto.createHash('sha256').update(canonicalRow).digest('hex');
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
    // Auditing must never be silently skipped.
    console.error('Failed to write audit log entry', e);
    throw e;
  } finally {
    client.release();
  }
}

// Walks the whole chain; returns { ok, checked, brokenAt? }.
export async function verifyAuditChain() {
  const client = await pool.connect();
  let prev = null;
  let checked = 0;
  try {
    const cursorName = 'audit_verify';
    await client.query('BEGIN');
    await client.query(`DECLARE ${cursorName} CURSOR FOR
      SELECT id, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, user_id, username, institution_id,
             action, entity_type, entity_id, details, ip, prev_hash, hash
      FROM audit_log ORDER BY id`);
    for (;;) {
      const { rows } = await client.query(`FETCH 1000 FROM ${cursorName}`);
      if (!rows.length) break;
      for (const r of rows) {
        if ((r.prev_hash || null) !== (prev || null) || rowHash(prev, r) !== r.hash) {
          await client.query('ROLLBACK');
          return { ok: false, checked, brokenAt: r.id };
        }
        prev = r.hash;
        checked++;
      }
    }
    await client.query('COMMIT');
    return { ok: true, checked };
  } finally {
    client.release();
  }
}
