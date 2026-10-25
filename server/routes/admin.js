// SPDX-License-Identifier: GPL-3.0-or-later
//
// Administration: users, institutions (incl. PACS settings), audit log,
// settings, backups and system status.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { one, many, query, tx } from '../db.js';
import { config, ROLES, ROLE_LABELS, DEFAULT_SETTINGS } from '../config.js';
import { hashPassword, temporaryPassword } from '../crypto.js';
import { audit, verifyAuditChain } from '../audit.js';
import { requireAuth, can, HttpError, lockStatus, unlockAccount } from '../auth.js';
import { getSettings, updateSettings } from '../settings.js';
import { echo, todaysStudies, clearCache, queryIsConstrained, MODALITY_KEYS, DEFAULT_MAX_RESULTS } from '../dicom.js';
import { writeBackup } from '../backup.js';
import { backupFiles, backupToDir, backupDir } from '../maintenance.js';

const USER_COLS = `u.id, u.username, u.display_name, u.roles, u.active, u.must_change_password,
  u.temp_password_expires_at, u.last_login_at, u.created_at,
  COALESCE((SELECT array_agg(institution_id ORDER BY institution_id) FROM user_institutions WHERE user_id = u.id), '{}') AS institution_ids`;

const TEMP_PASSWORD_HOURS = 72;

const DICOM_KEYS = ['PatientName', 'PatientID', 'IssuerOfPatientID', 'AccessionNumber', 'StudyDescription', 'ReferringPhysicianName', 'InstitutionName'];

function cleanDicom(d = {}) {
  const ae = v => String(v || '').trim().toUpperCase().slice(0, 16);
  return {
    enabled: !!d.enabled,
    host: String(d.host || '').trim().slice(0, 255),
    port: Number(d.port) || 104,
    called_ae: ae(d.called_ae),
    calling_ae: ae(d.calling_ae) || 'SONOFORMS',
    modality: d.modality === undefined ? 'US' : String(d.modality).trim().toUpperCase().slice(0, 16),
    modality_key: MODALITY_KEYS.includes(d.modality_key) ? d.modality_key : 'ModalitiesInStudy',
    date_mode: d.date_mode === 'single' ? 'single' : 'range',
    max_results: Math.min(Math.max(Number(d.max_results) || DEFAULT_MAX_RESULTS, 50), 2000),
    filters: (Array.isArray(d.filters) ? d.filters : [])
      .filter(f => f && DICOM_KEYS.includes(f.tag) && String(f.value || '').trim())
      .map(f => ({ tag: f.tag, value: String(f.value).trim().slice(0, 64), mode: f.mode === 'local' ? 'local' : 'query' })),
  };
}

export default async function adminRoutes(app) {
  const admin = { preHandler: requireAuth(can.admin) };

  // ---- Users ------------------------------------------------------------

  app.get('/users', admin, async () => {
    const users = await many(`SELECT ${USER_COLS} FROM users u ORDER BY lower(u.display_name)`);
    const locks = await lockStatus(users.map(u => u.username), await getSettings());
    return {
      users: users.map(u => ({ ...u, locked: locks.get(u.username) })),
      roles: ROLES.map(r => ({ id: r, label: ROLE_LABELS[r] })),
    };
  });

  const userBody = {
    type: 'object',
    properties: {
      username: { type: 'string', minLength: 2, maxLength: 64, pattern: '^[A-Za-z0-9._@-]+$' },
      display_name: { type: 'string', minLength: 1, maxLength: 120 },
      roles: { type: 'array', items: { type: 'string', enum: ROLES }, maxItems: ROLES.length },
      institution_ids: { type: 'array', items: { type: 'integer' }, maxItems: 500 },
      active: { type: 'boolean' },
    },
  };

  // Only superusers may grant superuser or act on superuser accounts.
  function checkRoleChange(req, roles, target) {
    const touchesSuper = roles.includes('superuser') || target?.roles?.includes('superuser');
    if (touchesSuper && !can.superuser(req.user)) throw new HttpError(403, 'Only a superuser can grant, remove, or manage superuser accounts.');
  }

  async function loadTarget(req) {
    const target = await one('SELECT id, username, roles, active FROM users WHERE id = $1', [Number(req.params.id)]);
    if (!target) throw new HttpError(404, 'User not found');
    return target;
  }

  async function otherActiveSuperusers(id) {
    return (await one("SELECT count(*)::int AS n FROM users WHERE active AND 'superuser' = ANY(roles) AND id <> $1", [id])).n;
  }

  async function setInstitutions(c, userId, ids) {
    await c.query('DELETE FROM user_institutions WHERE user_id = $1', [userId]);
    for (const id of new Set(ids)) {
      await c.query('INSERT INTO user_institutions (user_id, institution_id) SELECT $1, id FROM institutions WHERE id = $2', [userId, id]);
    }
  }

  app.post('/users', { ...admin, schema: { body: { ...userBody, required: ['username', 'display_name', 'roles'] } } }, async (req) => {
    const b = req.body;
    checkRoleChange(req, b.roles, null);
    if (await one('SELECT 1 FROM users WHERE lower(username) = lower($1)', [b.username])) throw new HttpError(409, 'That username is already taken.');
    const password = temporaryPassword();
    const id = await tx(async (c) => {
      const row = (await c.query(
        `INSERT INTO users (username, display_name, password_hash, roles, must_change_password, temp_password_expires_at)
         VALUES ($1, $2, $3, $4, true, now() + make_interval(hours => $5)) RETURNING id`,
        [b.username.trim(), b.display_name.trim(), await hashPassword(password), b.roles, TEMP_PASSWORD_HOURS])).rows[0];
      await setInstitutions(c, row.id, b.institution_ids || []);
      return row.id;
    });
    await audit({ req, institutionId: null, action: 'user.create', entityType: 'user', entityId: id, details: { username: b.username, roles: b.roles, institution_ids: b.institution_ids || [] } });
    return { id, temporary_password: password };
  });

  app.put('/users/:id', { ...admin, schema: { body: userBody } }, async (req) => {
    const target = await loadTarget(req);
    const id = target.id;
    const b = req.body;
    checkRoleChange(req, b.roles || [], target);
    const sameRoles = b.roles === undefined || [...b.roles].sort().join() === [...target.roles].sort().join();
    if (id === req.user.id) {
      if (b.active === false) throw new HttpError(400, 'You cannot deactivate your own account.');
      // Administrators can't widen their own access (e.g. give themselves a
      // clinical role or more institutions); another administrator must.
      if (!can.superuser(req.user) && (!sameRoles || b.institution_ids !== undefined)) {
        throw new HttpError(403, 'You cannot change your own roles or institutions. Ask another administrator.');
      }
      if (b.roles && !b.roles.some(r => r === 'admin' || r === 'superuser')) throw new HttpError(400, 'You cannot remove your own administrator access.');
    }
    const losesSuper = target.roles.includes('superuser') && ((b.roles && !b.roles.includes('superuser')) || b.active === false);
    if (losesSuper && target.active && (await otherActiveSuperusers(id)) === 0) {
      throw new HttpError(400, 'This is the last active superuser. Make someone else a superuser first.');
    }
    await tx(async (c) => {
      if (b.display_name !== undefined) await c.query('UPDATE users SET display_name = $2 WHERE id = $1', [id, b.display_name.trim()]);
      if (b.roles !== undefined) await c.query('UPDATE users SET roles = $2 WHERE id = $1', [id, b.roles]);
      if (b.active !== undefined) {
        await c.query('UPDATE users SET active = $2 WHERE id = $1', [id, b.active]);
        if (!b.active) await c.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      }
      if (b.institution_ids !== undefined) await setInstitutions(c, id, b.institution_ids);
      await c.query('UPDATE users SET updated_at = now() WHERE id = $1', [id]);
    });
    const changed = Object.keys(b).filter(k => k !== 'username');
    await audit({ req, institutionId: null, action: 'user.update', entityType: 'user', entityId: id, details: { changed, roles: b.roles, active: b.active, institution_ids: b.institution_ids } });
    return { ok: true };
  });

  app.post('/users/:id/reset-password', admin, async (req) => {
    const target = await loadTarget(req);
    const id = target.id;
    checkRoleChange(req, [], target);
    const password = temporaryPassword();
    await query(
      `UPDATE users SET password_hash = $2, must_change_password = true, temp_password_expires_at = now() + make_interval(hours => $3) WHERE id = $1`,
      [id, await hashPassword(password), TEMP_PASSWORD_HOURS]);
    await unlockAccount(target.username);
    await query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await audit({ req, institutionId: null, action: 'user.reset_password', entityType: 'user', entityId: id });
    return { temporary_password: password };
  });

  app.post('/users/:id/unlock', admin, async (req) => {
    const target = await loadTarget(req);
    checkRoleChange(req, [], target);
    await unlockAccount(target.username);
    await audit({ req, institutionId: null, action: 'user.unlock', entityType: 'user', entityId: target.id });
    return { ok: true };
  });

  app.post('/users/:id/sign-out', admin, async (req) => {
    const target = await loadTarget(req);
    checkRoleChange(req, [], target);
    const id = target.id;
    const r = await query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await audit({ req, institutionId: null, action: 'user.sign_out_all', entityType: 'user', entityId: id, details: { sessions: r.rowCount } });
    return { ok: true, sessions: r.rowCount };
  });

  // ---- Institutions -----------------------------------------------------

  app.get('/institutions', admin, async () => ({
    institutions: await many(`SELECT i.*, (SELECT count(*)::int FROM user_institutions ui WHERE ui.institution_id = i.id) AS user_count
      FROM institutions i ORDER BY i.name`),
    dicom_keys: DICOM_KEYS,
    dicom_mock: config.dicomMock,
  }));

  const instBody = {
    type: 'object',
    properties: {
      code: { type: 'string', minLength: 1, maxLength: 20, pattern: '^[A-Za-z0-9_-]+$' },
      name: { type: 'string', minLength: 1, maxLength: 200 },
      active: { type: 'boolean' },
      dicom: { type: 'object' },
    },
  };

  function assertSafeQuery(dicom) {
    if (dicom.enabled && !queryIsConstrained(dicom)) {
      throw new HttpError(400, 'Set a modality (e.g. US) or an institution filter applied by PACS, so a worklist query can never ask PACS for every study.');
    }
  }

  app.post('/institutions', { ...admin, schema: { body: { ...instBody, required: ['code', 'name'] } } }, async (req) => {
    assertSafeQuery(cleanDicom(req.body.dicom));
    if (await one('SELECT 1 FROM institutions WHERE lower(code) = lower($1)', [req.body.code])) throw new HttpError(409, 'That code is already used.');
    const row = await one('INSERT INTO institutions (code, name, dicom) VALUES ($1, $2, $3) RETURNING id',
      [req.body.code.toUpperCase(), req.body.name.trim(), cleanDicom(req.body.dicom)]);
    await audit({ req, institutionId: row.id, action: 'institution.create', entityType: 'institution', entityId: row.id, details: { code: req.body.code } });
    return { id: row.id };
  });

  app.put('/institutions/:id', { ...admin, schema: { body: instBody } }, async (req) => {
    const id = Number(req.params.id);
    const cur = await one('SELECT * FROM institutions WHERE id = $1', [id]);
    if (!cur) throw new HttpError(404, 'Institution not found');
    const b = req.body;
    if (b.dicom) assertSafeQuery(cleanDicom(b.dicom));
    await query('UPDATE institutions SET name = $2, active = $3, dicom = $4, updated_at = now() WHERE id = $1',
      [id, b.name?.trim() ?? cur.name, b.active ?? cur.active, b.dicom ? cleanDicom(b.dicom) : cur.dicom]);
    clearCache();
    await audit({ req, institutionId: id, action: 'institution.update', entityType: 'institution', entityId: id, details: { changed: Object.keys(b) } });
    return { ok: true };
  });

  app.post('/institutions/:id/echo', { ...admin, schema: { body: { type: 'object', properties: { dicom: { type: 'object' } } } } }, async (req) => {
    const inst = await one('SELECT * FROM institutions WHERE id = $1', [Number(req.params.id)]);
    if (!inst) throw new HttpError(404, 'Institution not found');
    const settings = req.body?.dicom ? cleanDicom(req.body.dicom) : inst.dicom;
    if (!settings.host) throw new HttpError(400, 'Enter the PACS host first.');
    try {
      await echo(settings);
      return { ok: true, message: `Connected to ${settings.called_ae}@${settings.host}:${settings.port} successfully (C-ECHO).` };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  app.post('/institutions/:id/test-query', { ...admin, schema: { body: { type: 'object', properties: { dicom: { type: 'object' } } } } }, async (req) => {
    const inst = await one('SELECT * FROM institutions WHERE id = $1', [Number(req.params.id)]);
    if (!inst) throw new HttpError(404, 'Institution not found');
    const dicom = req.body?.dicom ? { ...cleanDicom(req.body.dicom), enabled: true } : inst.dicom;
    const settings = await getSettings();
    try {
      const { studies, truncated } = await todaysStudies({ ...inst, dicom }, settings.worklist_show_hours, { force: true, cache: !req.body?.dicom });
      await audit({ req, institutionId: inst.id, action: 'institution.test_query', entityType: 'institution', entityId: inst.id, details: { results: studies.length } });
      // Admins see counts and descriptions only, not patient details.
      const descriptions = {};
      for (const s of studies) descriptions[s.description || '(none)'] = (descriptions[s.description || '(none)'] || 0) + 1;
      return { ok: true, count: studies.length, truncated: !!truncated, max_results: dicom.max_results || DEFAULT_MAX_RESULTS, descriptions };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  // ---- Audit log --------------------------------------------------------

  function auditFilter(q) {
    const where = [];
    const params = [];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (q.from) add('a.at >= ?::date', q.from);
    if (q.to) add("a.at < (?::date + interval '1 day')", q.to);
    if (q.user) add('lower(a.username) = lower(?)', q.user);
    if (q.action) add('a.action LIKE ?', `${String(q.action).replace(/[%_]/g, '')}%`);
    if (q.entity_type) add('a.entity_type = ?', q.entity_type);
    if (q.entity_id) add('a.entity_id = ?', String(q.entity_id));
    if (q.institution) add('a.institution_id = ?', Number(q.institution));
    return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  app.get('/audit', admin, async (req) => {
    const { where, params } = auditFilter(req.query);
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rows = await many(
      `SELECT a.id, a.at, a.username, a.institution_id, i.code AS institution_code, a.action, a.entity_type, a.entity_id, a.details, a.ip
       FROM audit_log a LEFT JOIN institutions i ON i.id = a.institution_id ${where}
       ORDER BY a.id DESC LIMIT ${limit} OFFSET ${offset}`, params);
    const total = (await one(`SELECT count(*)::int AS n FROM audit_log a ${where}`, params)).n;
    const actions = (await many('SELECT DISTINCT action FROM audit_log ORDER BY action')).map(r => r.action);
    return { rows, total, actions };
  });

  app.get('/audit/verify', admin, async (req) => {
    const result = await verifyAuditChain();
    await audit({ req, institutionId: null, action: 'audit.verify', details: { ok: result.ok, checked: result.checked } });
    return result;
  });

  app.get('/audit/export', admin, async (req, reply) => {
    const { where, params } = auditFilter(req.query);
    const rows = await many(
      `SELECT a.id, a.at, a.username, i.code AS institution, a.action, a.entity_type, a.entity_id, a.details, a.ip, a.hash
       FROM audit_log a LEFT JOIN institutions i ON i.id = a.institution_id ${where} ORDER BY a.id LIMIT 200000`, params);
    // Leading =,+,-,@ are neutralized so spreadsheets don't treat cells as formulas.
    const cell = v => {
      let s = v === null || v === undefined ? '' : (typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : (v instanceof Date ? v.toISOString() : String(v)));
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const cols = ['id', 'at', 'username', 'institution', 'action', 'entity_type', 'entity_id', 'details', 'ip', 'hash'];
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n');
    await audit({ req, institutionId: null, action: 'audit.export', details: { rows: rows.length } });
    reply.header('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    return reply.type('text/csv; charset=utf-8').send(csv);
  });

  // ---- Settings ---------------------------------------------------------

  app.get('/settings', admin, async () => ({ settings: await getSettings(), defaults: DEFAULT_SETTINGS }));

  app.put('/settings', {
    ...admin,
    schema: { body: { type: 'object', additionalProperties: false, properties: {
      app_name: { type: 'string', minLength: 1, maxLength: 60 },
      session_idle_minutes: { type: 'integer', minimum: 5, maximum: 720 },
      session_max_hours: { type: 'integer', minimum: 1, maximum: 24 },
      password_min_length: { type: 'integer', minimum: 8, maximum: 64 },
      max_failed_logins: { type: 'integer', minimum: 3, maximum: 20 },
      lockout_minutes: { type: 'integer', minimum: 1, maximum: 60 },
      retention_days: { type: 'integer', minimum: 0, maximum: 36500 },
      worklist_show_hours: { type: 'integer', minimum: 1, maximum: 168 },
      report_line_ending: { type: 'string', enum: ['crlf', 'lf'] },
      login_banner: { type: 'string', maxLength: 500 },
    } } },
  }, async (req) => {
    const settings = await updateSettings(req.body, req.user.id);
    await audit({ req, institutionId: null, action: 'settings.update', details: req.body });
    return { settings };
  });

  // ---- Backups & status -------------------------------------------------

  app.get('/backup', admin, async (req, reply) => {
    await audit({ req, institutionId: null, action: 'system.backup_download' });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    reply.header('Content-Disposition', `attachment; filename="sonoforms-${stamp}.sfbak"`);
    reply.type('application/octet-stream');
    // Stream straight to the browser.
    reply.hijack();
    reply.raw.writeHead(200, reply.getHeaders());
    try {
      await writeBackup(reply.raw);
    } catch (e) {
      req.log.error(e, 'Backup download failed');
    }
    reply.raw.end();
  });

  app.get('/backups', admin, async () => ({ dir: backupDir() || null, files: backupFiles() }));

  app.post('/backups', admin, async (req) => {
    if (!backupDir()) throw new HttpError(400, 'Automatic backups are not configured (BACKUP_DIR is not set).');
    return backupToDir(req.log);
  });

  app.get('/backups/:name', admin, async (req, reply) => {
    const name = path.basename(String(req.params.name));
    const file = path.join(backupDir(), name);
    if (!backupDir() || !/^sonoforms-.*\.sfbak$/.test(name) || !fs.existsSync(file)) throw new HttpError(404, 'Backup not found');
    await audit({ req, institutionId: null, action: 'system.backup_download', details: { file: name } });
    reply.header('Content-Disposition', `attachment; filename="${name}"`);
    return reply.type('application/octet-stream').send(fs.createReadStream(file));
  });

  app.get('/status', admin, async () => {
    const counts = await one(`SELECT
      (SELECT count(*)::int FROM users WHERE active) AS users,
      (SELECT count(*)::int FROM institutions WHERE active) AS institutions,
      (SELECT count(*)::int FROM forms WHERE active) AS forms,
      (SELECT count(*)::int FROM exams WHERE status = 'draft') AS exams_draft,
      (SELECT count(*)::int FROM exams WHERE status = 'submitted') AS exams_submitted,
      (SELECT count(*)::int FROM exams WHERE status = 'dictated') AS exams_dictated,
      (SELECT count(*)::int FROM sessions WHERE expires_at > now()) AS sessions,
      (SELECT count(*)::int FROM audit_log) AS audit_entries,
      pg_database_size(current_database()) AS db_bytes,
      version() AS pg_version`);
    const migrations = await many('SELECT name, applied_at FROM schema_migrations ORDER BY name');
    const files = backupFiles();
    return {
      version: config.version,
      node: process.version,
      uptime_seconds: Math.round(process.uptime()),
      hostname: os.hostname(),
      dicom_mock: config.dicomMock,
      counts,
      migrations,
      backups: { configured: !!backupDir(), latest: files[0] || null, count: files.length },
    };
  });
}
