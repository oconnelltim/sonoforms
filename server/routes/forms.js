// SPDX-License-Identifier: GPL-3.0-or-later
//
// Forms management (tech managers and superusers). General-library forms
// can be edited only by superusers; institutions copy a general form to
// customize it.

import { one, query, many } from '../db.js';
import { audit } from '../audit.js';
import { requireAuth, can, userInstitutions, HttpError } from '../auth.js';
import {
  listForms, getForm, getVersion, createForm, saveDraft, discardDraft, publishDraft, parseSource,
} from '../forms.js';

async function assertCanEdit(req, form) {
  if (form.institution_id === null) {
    if (!can.superuser(req.user)) throw new HttpError(403, 'Only a superuser can edit general-library forms. Copy it to your institution to customize it.');
    return;
  }
  const mine = (await userInstitutions(req.user)).map(i => i.id);
  if (!mine.includes(form.institution_id)) throw new HttpError(404, 'Form not found');
}

async function assertCanView(req, form) {
  if (form.institution_id === null) return;
  const mine = (await userInstitutions(req.user)).map(i => i.id);
  if (!mine.includes(form.institution_id)) throw new HttpError(404, 'Form not found');
}

export default async function formRoutes(app) {
  const mgr = { preHandler: requireAuth(can.forms) };
  const sourceBody = { type: 'object', required: ['source'], properties: { source: { type: 'string', maxLength: 200000 } } };

  app.get('/forms', mgr, async (req) => {
    const institutions = await userInstitutions(req.user);
    const forms = await listForms(institutions.map(i => i.id));
    // Which general forms each institution has switched off.
    const disabled = await many('SELECT institution_id, form_id FROM institution_forms WHERE NOT enabled AND institution_id = ANY($1::int[])', [institutions.map(i => i.id)]);
    return { forms, institutions, disabled, can_edit_general: can.superuser(req.user) };
  });

  app.get('/forms/:id', mgr, async (req) => {
    const form = await getForm(Number(req.params.id));
    await assertCanView(req, form);
    const draft = form.versions.find(v => v.status === 'draft');
    const working = await getVersion(draft ? draft.id : form.current_version_id);
    return { form, source: working.source, working_version: working.version, working_status: working.status };
  });

  app.get('/forms/:id/versions/:vid', mgr, async (req) => {
    const form = await getForm(Number(req.params.id));
    await assertCanView(req, form);
    const v = await getVersion(Number(req.params.vid));
    if (v.form_id !== form.id) throw new HttpError(404, 'Version not found');
    return v;
  });

  app.get('/forms/:id/export', mgr, async (req, reply) => {
    const form = await getForm(Number(req.params.id));
    await assertCanView(req, form);
    const v = await getVersion(Number(req.query.version) || form.current_version_id);
    if (v.form_id !== form.id) throw new HttpError(404, 'Version not found');
    reply.header('Content-Disposition', `attachment; filename="${form.slug}-v${v.version}.yaml"`);
    return reply.type('text/yaml; charset=utf-8').send(v.source);
  });

  app.post('/forms/lint', { ...mgr, schema: { body: sourceBody } }, async (req) => {
    try {
      const { def, problems } = parseSource(req.body.source);
      return { ok: !problems.some(p => p.level === 'error'), problems, definition: def };
    } catch (e) {
      if (e instanceof HttpError) return { ok: false, problems: e.extra?.problems || [{ level: 'error', path: '', message: e.message }] };
      throw e;
    }
  });

  app.post('/forms', {
    ...mgr,
    schema: { body: { ...sourceBody, properties: { ...sourceBody.properties, institution_id: { type: ['integer', 'null'] } } } },
  }, async (req) => {
    const institutionId = req.body.institution_id ?? null;
    await assertCanEdit(req, { institution_id: institutionId });
    const id = await createForm({ institutionId, source: req.body.source, userId: req.user.id });
    await audit({ req, institutionId, action: 'form.create', entityType: 'form', entityId: id });
    return { id };
  });

  app.post('/forms/:id/copy', {
    ...mgr,
    schema: { body: { type: 'object', required: ['institution_id'], properties: { institution_id: { type: 'integer' }, new_id: { type: 'string', maxLength: 80 } } } },
  }, async (req) => {
    const form = await getForm(Number(req.params.id));
    await assertCanView(req, form);
    await assertCanEdit(req, { institution_id: req.body.institution_id });
    const src = await getVersion(form.current_version_id);
    let source = src.source;
    if (req.body.new_id) source = source.replace(/^id:.*$/m, `id: ${req.body.new_id.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`);
    const id = await createForm({ institutionId: req.body.institution_id, source, userId: req.user.id, publish: false, copiedFrom: form.id });
    await audit({ req, institutionId: req.body.institution_id, action: 'form.copy', entityType: 'form', entityId: id, details: { from: form.id } });
    return { id };
  });

  app.put('/forms/:id/draft', { ...mgr, schema: { body: sourceBody } }, async (req) => {
    const form = await getForm(Number(req.params.id));
    await assertCanEdit(req, form);
    const { problems } = await saveDraft(form.id, req.body.source, req.user.id);
    await audit({ req, institutionId: form.institution_id, action: 'form.save_draft', entityType: 'form', entityId: form.id });
    return { ok: true, problems };
  });

  app.delete('/forms/:id/draft', mgr, async (req) => {
    const form = await getForm(Number(req.params.id));
    await assertCanEdit(req, form);
    const result = await discardDraft(form.id);
    await audit({ req, institutionId: form.institution_id, action: result.deletedForm ? 'form.delete' : 'form.discard_draft', entityType: 'form', entityId: form.id });
    return result;
  });

  app.post('/forms/:id/publish', {
    ...mgr,
    schema: { body: { type: 'object', properties: { notes: { type: 'string', maxLength: 2000 } } } },
  }, async (req) => {
    const form = await getForm(Number(req.params.id));
    await assertCanEdit(req, form);
    const version = await publishDraft(form.id, req.user.id, req.body?.notes);
    // Publishing an institution's copy of a general form replaces the general
    // form for that institution, so techs don't see two of the same form.
    if (form.institution_id !== null && form.copied_from_id && version === 1) {
      const source = await one('SELECT institution_id FROM forms WHERE id = $1', [form.copied_from_id]);
      if (source && source.institution_id === null) {
        await query(
          `INSERT INTO institution_forms (institution_id, form_id, enabled) VALUES ($1, $2, false)
           ON CONFLICT (institution_id, form_id) DO UPDATE SET enabled = false`, [form.institution_id, form.copied_from_id]);
      }
    }
    await audit({ req, institutionId: form.institution_id, action: 'form.publish', entityType: 'form', entityId: form.id, details: { version } });
    return { ok: true, version };
  });

  app.put('/forms/:id/active', {
    ...mgr,
    schema: { body: { type: 'object', required: ['active'], properties: { active: { type: 'boolean' } } } },
  }, async (req) => {
    const form = await getForm(Number(req.params.id));
    await assertCanEdit(req, form);
    await query('UPDATE forms SET active = $2, updated_at = now() WHERE id = $1', [form.id, req.body.active]);
    await audit({ req, institutionId: form.institution_id, action: req.body.active ? 'form.activate' : 'form.deactivate', entityType: 'form', entityId: form.id });
    return { ok: true };
  });

  // Turn a general-library form on or off for one institution.
  app.put('/forms/:id/institution-setting', {
    ...mgr,
    schema: { body: { type: 'object', required: ['institution_id', 'enabled'], properties: { institution_id: { type: 'integer' }, enabled: { type: 'boolean' } } } },
  }, async (req) => {
    const form = await one('SELECT id, institution_id FROM forms WHERE id = $1', [Number(req.params.id)]);
    if (!form || form.institution_id !== null) throw new HttpError(400, 'Only general-library forms can be switched on or off per institution.');
    await assertCanEdit(req, { institution_id: req.body.institution_id });
    await query(
      `INSERT INTO institution_forms (institution_id, form_id, enabled) VALUES ($1, $2, $3)
       ON CONFLICT (institution_id, form_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [req.body.institution_id, form.id, req.body.enabled]);
    await audit({ req, institutionId: req.body.institution_id, action: req.body.enabled ? 'form.enable_for_institution' : 'form.disable_for_institution', entityType: 'form', entityId: form.id });
    return { ok: true };
  });
}
