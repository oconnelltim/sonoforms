// SPDX-License-Identifier: GPL-3.0-or-later
//
// Form library: versioned form definitions, per-institution forms, and the
// shared "general" library (institution_id NULL) seeded from forms/general.
//
// Every edit is saved as a draft version; publishing makes it the version
// techs use. Exams keep a reference to the exact version they were filled
// with, so old reports always render with the form as it was.

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { one, many, tx } from './db.js';
import { config } from './config.js';
import { normalizeForm, lintForm } from '../shared/formdef.js';
import { HttpError } from './auth.js';

export function parseSource(source) {
  if (String(source || '').length > 200000) throw new HttpError(400, 'The form source is too large (200,000 characters at most).', { problems: [] });
  let raw;
  try {
    raw = YAML.parse(String(source || ''), { prettyErrors: true, maxAliasCount: 50 });
  } catch (e) {
    throw new HttpError(400, `The form could not be read: ${e.message}`, { problems: [{ level: 'error', path: '', message: e.message }] });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'The form must be a YAML mapping with a title and sections.', { problems: [] });
  }
  const problems = lintForm(raw);
  const def = normalizeForm(raw);
  return { def, problems, errors: problems.filter(p => p.level === 'error') };
}

const FORM_COLS = `f.id, f.institution_id, f.slug, f.title, f.active, f.current_version_id, f.copied_from_id, f.updated_at,
  i.name AS institution_name,
  cv.version AS current_version, cv.published_at,
  (SELECT version FROM form_versions d WHERE d.form_id = f.id AND d.status = 'draft') AS draft_version`;

// Forms a manager can see: the general library plus their institutions' forms.
export async function listForms(institutionIds, { includeGeneral = true } = {}) {
  return many(
    `SELECT ${FORM_COLS} FROM forms f
     LEFT JOIN institutions i ON i.id = f.institution_id
     LEFT JOIN form_versions cv ON cv.id = f.current_version_id
     WHERE ($2::boolean AND f.institution_id IS NULL) OR f.institution_id = ANY($1::int[])
     ORDER BY f.institution_id NULLS FIRST, f.title`, [institutionIds, includeGeneral]);
}

export async function getForm(id) {
  const form = await one(
    `SELECT ${FORM_COLS} FROM forms f
     LEFT JOIN institutions i ON i.id = f.institution_id
     LEFT JOIN form_versions cv ON cv.id = f.current_version_id
     WHERE f.id = $1`, [id]);
  if (!form) throw new HttpError(404, 'Form not found');
  form.versions = await many(
    `SELECT v.id, v.version, v.status, v.notes, v.created_at, v.published_at,
            cu.display_name AS created_by_name, pu.display_name AS published_by_name
     FROM form_versions v
     LEFT JOIN users cu ON cu.id = v.created_by
     LEFT JOIN users pu ON pu.id = v.published_by
     WHERE v.form_id = $1 ORDER BY v.version DESC`, [id]);
  return form;
}

export async function getVersion(versionId) {
  const v = await one('SELECT * FROM form_versions WHERE id = $1', [versionId]);
  if (!v) throw new HttpError(404, 'Form version not found');
  return v;
}

export async function createForm({ institutionId = null, source, userId, publish = false, copiedFrom = null }) {
  const { def, errors } = parseSource(source);
  if (publish && errors.length) throw new HttpError(400, 'The form has errors and cannot be published.', { problems: errors });
  return tx(async (c) => {
    const exists = await c.query('SELECT 1 FROM forms WHERE COALESCE(institution_id, 0) = COALESCE($1, 0) AND slug = $2', [institutionId, def.id]);
    if (exists.rowCount) throw new HttpError(409, `A form with id '${def.id}' already exists here. Change the 'id:' line to something unique.`);
    const form = (await c.query(
      'INSERT INTO forms (institution_id, slug, title, copied_from_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [institutionId, def.id, def.title, copiedFrom])).rows[0];
    const version = (await c.query(
      `INSERT INTO form_versions (form_id, version, status, source, definition, created_by, published_by, published_at, notes)
       VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [form.id, publish ? 'published' : 'draft', source, def, userId, publish ? userId : null, publish ? new Date() : null,
        copiedFrom ? 'Copied from the general library' : 'Created'])).rows[0];
    if (publish) await c.query('UPDATE forms SET current_version_id = $2 WHERE id = $1', [form.id, version.id]);
    return form.id;
  });
}

// Creates or replaces the single draft version of a form.
export async function saveDraft(formId, source, userId) {
  const { def, problems } = parseSource(source);
  return tx(async (c) => {
    const form = (await c.query('SELECT * FROM forms WHERE id = $1 FOR UPDATE', [formId])).rows[0];
    if (!form) throw new HttpError(404, 'Form not found');
    if (def.id !== form.slug) {
      throw new HttpError(400, `The form id cannot be changed (it must stay '${form.slug}'). Copy the form to make a new one.`, { problems: [{ level: 'error', path: 'id', message: `id must be '${form.slug}'` }] });
    }
    const draft = (await c.query("SELECT id FROM form_versions WHERE form_id = $1 AND status = 'draft'", [formId])).rows[0];
    if (draft) {
      await c.query('UPDATE form_versions SET source = $2, definition = $3, created_by = $4, created_at = now() WHERE id = $1', [draft.id, source, def, userId]);
    } else {
      const next = (await c.query('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM form_versions WHERE form_id = $1', [formId])).rows[0].v;
      await c.query(
        `INSERT INTO form_versions (form_id, version, status, source, definition, created_by) VALUES ($1, $2, 'draft', $3, $4, $5)`,
        [formId, next, source, def, userId]);
    }
    await c.query('UPDATE forms SET title = $2, updated_at = now() WHERE id = $1', [formId, def.title]);
    return { problems };
  });
}

export async function discardDraft(formId) {
  return tx(async (c) => {
    const r = await c.query("DELETE FROM form_versions WHERE form_id = $1 AND status = 'draft' RETURNING version", [formId]);
    // A form that was never published has nothing to fall back to: remove it entirely.
    const form = (await c.query('SELECT current_version_id FROM forms WHERE id = $1', [formId])).rows[0];
    if (form && !form.current_version_id) {
      await c.query('DELETE FROM forms WHERE id = $1', [formId]);
      return { deletedForm: true };
    }
    return { discarded: r.rowCount > 0 };
  });
}

export async function publishDraft(formId, userId, notes) {
  return tx(async (c) => {
    const draft = (await c.query("SELECT * FROM form_versions WHERE form_id = $1 AND status = 'draft' FOR UPDATE", [formId])).rows[0];
    if (!draft) throw new HttpError(400, 'There is no draft to publish.');
    const { def, errors } = parseSource(draft.source);
    if (errors.length) throw new HttpError(400, 'The draft has errors and cannot be published.', { problems: errors });
    await c.query("UPDATE form_versions SET status = 'retired' WHERE form_id = $1 AND status = 'published'", [formId]);
    await c.query(
      `UPDATE form_versions SET status = 'published', definition = $2, published_by = $3, published_at = now(), notes = $4 WHERE id = $1`,
      [draft.id, def, userId, notes || null]);
    await c.query('UPDATE forms SET current_version_id = $2, title = $3, updated_at = now() WHERE id = $1', [formId, draft.id, def.title]);
    return draft.version;
  });
}

// Published forms a tech can choose from at an institution.
export async function availableForms(institutionId) {
  return many(
    `SELECT f.id, f.title, f.slug, f.institution_id, v.id AS version_id, v.version,
            v.definition->'study_match' AS study_match, v.definition->>'description' AS description
     FROM forms f
     JOIN form_versions v ON v.id = f.current_version_id
     LEFT JOIN institution_forms inf ON inf.form_id = f.id AND inf.institution_id = $1
     WHERE f.active
       AND (f.institution_id = $1 OR (f.institution_id IS NULL AND COALESCE(inf.enabled, true)))
     ORDER BY f.title`, [institutionId]);
}

// Load forms/general/*.yaml into the general library if they aren't there yet.
// Existing forms are never overwritten, because admins may have edited them.
export async function seedGeneralForms(log = console) {
  const dir = path.join(config.formsDir, 'general');
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort()) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    let def, errors;
    try {
      ({ def, errors } = parseSource(source));
    } catch (e) {
      log.error(`Skipping ${file}: ${e.message}`);
      continue;
    }
    if (errors.length) {
      log.error(`Skipping ${file}: ${errors.map(e => `${e.path}: ${e.message}`).join('; ')}`);
      continue;
    }
    const exists = await one('SELECT id FROM forms WHERE institution_id IS NULL AND slug = $1', [def.id]);
    if (exists) continue;
    await createForm({ source, publish: true, userId: null });
    log.info(`Added general form '${def.title}' from ${file}`);
  }
}

// Compares forms/general/*.yaml with the general library, for
// `update-general-forms`. A form is only replaced if nobody has edited it in
// the app since it last came from the starter files (its published version
// has no author), unless force is set. A form with an unpublished draft is
// always left alone so nobody's work in progress is overwritten.
// Each entry: { file, slug, title, action, formId?, version?, copies?, reason? }
//   action: 'add' | 'update' | 'same' | 'edited' | 'draft' | 'invalid'
export async function planGeneralFormUpdates({ force = false } = {}) {
  const dir = path.join(config.formsDir, 'general');
  if (!fs.existsSync(dir)) return [];
  const plan = [];
  for (const file of fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort()) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    let def, errors;
    try {
      ({ def, errors } = parseSource(source));
    } catch (e) {
      plan.push({ file, action: 'invalid', reason: e.message });
      continue;
    }
    if (errors.length) {
      plan.push({ file, slug: def.id, title: def.title, action: 'invalid', reason: errors.map(e => `${e.path}: ${e.message}`).join('; ') });
      continue;
    }
    const entry = { file, slug: def.id, title: def.title, source };
    const form = await one(
      `SELECT f.id, cv.version, cv.source, cv.created_by,
              (SELECT count(*)::int FROM forms c WHERE c.copied_from_id = f.id) AS copies,
              EXISTS (SELECT 1 FROM form_versions d WHERE d.form_id = f.id AND d.status = 'draft') AS has_draft
       FROM forms f LEFT JOIN form_versions cv ON cv.id = f.current_version_id
       WHERE f.institution_id IS NULL AND f.slug = $1`, [def.id]);
    if (!form) { plan.push({ ...entry, action: 'add' }); continue; }
    Object.assign(entry, { formId: form.id, version: form.version, copies: form.copies });
    if (form.source === source) entry.action = 'same';
    else if (form.has_draft) entry.action = 'draft';
    else if (form.created_by !== null && !force) entry.action = 'edited';
    else entry.action = 'update';
    plan.push(entry);
  }
  return plan;
}

// Applies the 'add' and 'update' entries of a plan. Old versions stay in the
// form's history, and exams keep the version they were filled in with.
export async function applyGeneralFormUpdates(plan) {
  const done = [];
  for (const p of plan) {
    if (p.action === 'add') {
      const id = await createForm({ source: p.source, publish: true, userId: null });
      done.push({ ...p, formId: id, newVersion: 1 });
    } else if (p.action === 'update') {
      await saveDraft(p.formId, p.source, null);
      const newVersion = await publishDraft(p.formId, null, `Updated from the starter file ${p.file}`);
      done.push({ ...p, newVersion });
    }
  }
  return done;
}
