// SPDX-License-Identifier: GPL-3.0-or-later
//
// Technologist workflow: worklist, patients, filling in and submitting forms.
// The exam read endpoint is shared with radiologists.

import { one } from '../db.js';
import { audit, auditOnce } from '../audit.js';
import { requireAuth, can, activeInstitution, canAccessInstitution, HttpError } from '../auth.js';
import { getSettings } from '../settings.js';
import { todaysStudies, studyByUid } from '../dicom.js';
import { availableForms, getVersion } from '../forms.js';
import {
  searchPatients, upsertPatient, updatePatient, getPatient, createExam, getExam, updateExam,
  listExams, examsByStudyUids, studyUidIndex, findExamByStudyUid, templateEnv,
} from '../records.js';
import { matchScore } from '../../shared/formdef.js';
import { validateAnswers, computeCalcs } from '../../shared/engine.js';
import { generateReport } from '../../shared/template.js';
import { assertAnswersOk } from '../validate.js';

const versionBody = { row_version: { type: 'integer' } };

function today(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function rankForms(forms, description) {
  return forms
    .map(f => ({ ...f, score: matchScore({ study_match: f.study_match || [] }, description) }))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

// Loads an exam and checks the user may see it.
export async function loadExamFor(req, id) {
  const exam = await getExam(id);
  if (!(await canAccessInstitution(req.user, exam.institution_id))) {
    await audit({ req, action: 'security.forbidden', entityType: 'exam', entityId: id, details: { reason: 'institution', route: req.routeOptions?.url } });
    throw new HttpError(404, 'Exam not found');
  }
  return exam;
}

const FIFTEEN_MIN = 15 * 60000;

function requireStatus(exam, statuses, action) {
  if (!statuses.includes(exam.status)) {
    throw new HttpError(409, `This exam is ${exam.status} and cannot be ${action}.`);
  }
}

export default async function techRoutes(app) {
  const tech = { preHandler: requireAuth(can.tech) };

  app.get('/worklist/tech', tech, async (req) => {
    const institutionId = await activeInstitution(req);
    if (req.headers['x-background'] !== '1') {
      await auditOnce(`wl:${req.user.id}:${institutionId}`, FIFTEEN_MIN, { req, institutionId, action: 'worklist.view', details: { worklist: 'tech' } });
    }
    const settings = await getSettings();
    const institution = await one('SELECT id, name, code, dicom FROM institutions WHERE id = $1', [institutionId]);
    const pacs = { configured: false, error: null, studies: [], truncated: false };
    try {
      const result = await todaysStudies(institution, settings.worklist_show_hours, { force: req.query.refresh === '1' });
      pacs.configured = result.configured;
      pacs.truncated = !!result.truncated;
      const existing = await examsByStudyUids(institutionId, result.studies.map(s => s.study_uid));
      const forms = await availableForms(institutionId);
      pacs.studies = result.studies.map(s => {
        const exam = existing.get(studyUidIndex(institutionId, s.study_uid));
        const best = rankForms(forms, s.description)[0];
        return {
          ...s,
          exam: exam ? { id: exam.id, status: exam.status, tech_name: exam.tech_name, form_title: exam.form_title } : null,
          suggested_form: best && best.score > 0 ? { id: best.id, title: best.title } : null,
        };
      });
    } catch (e) {
      pacs.configured = true;
      pacs.error = e.message;
      req.log.warn({ err: e.message }, 'PACS worklist query failed');
    }
    const exams = await listExams({ institutionIds: [institutionId], fromDate: today(-1), statuses: ['draft', 'returned', 'submitted', 'dictated'] });
    const openExams = await listExams({ institutionIds: [institutionId], statuses: ['draft', 'returned'], limit: 200 });
    const seen = new Set(exams.map(e => e.id));
    return { pacs, exams: [...exams, ...openExams.filter(e => !seen.has(e.id))] };
  });

  app.get('/forms/available', tech, async (req) => {
    const forms = await availableForms(await activeInstitution(req));
    return rankForms(forms, String(req.query.description || '')).map(({ id, title, description, score, institution_id }) => ({ id, title, description, score, general: institution_id === null }));
  });

  // POST so identifiers travel in the body, never in URLs (which end up in
  // proxy access logs and browser history).
  app.post('/patients/search', {
    ...tech,
    schema: { body: { type: 'object', properties: { mrn: { type: 'string', maxLength: 64 }, last_name: { type: 'string', maxLength: 100 } } } },
  }, async (req) => {
    const institutionId = await activeInstitution(req);
    const mrn = String(req.body.mrn || '');
    const lastName = String(req.body.last_name || '');
    if (!mrn.trim() && !lastName.trim()) throw new HttpError(400, 'Enter an MRN or a last name to search.');
    const results = await searchPatients(institutionId, { mrn, last_name: lastName });
    await audit({ req, action: 'patient.search', details: { by: mrn ? 'mrn' : 'last_name', results: results.length } });
    return results;
  });

  const demographicsSchema = {
    type: 'object',
    required: ['mrn', 'last_name'],
    properties: {
      mrn: { type: 'string', maxLength: 64 }, last_name: { type: 'string', maxLength: 100 }, first_name: { type: 'string', maxLength: 100 },
      dob: { type: 'string', maxLength: 10 }, sex: { type: 'string', maxLength: 1 },
    },
  };

  app.post('/patients', { ...tech, schema: { body: demographicsSchema } }, async (req) => {
    const patient = await upsertPatient(await activeInstitution(req), req.body, req.user.id);
    if (patient.created) await audit({ req, action: 'patient.create', entityType: 'patient', entityId: patient.id });
    return patient;
  });

  app.put('/patients/:id', { ...tech, schema: { body: demographicsSchema } }, async (req) => {
    const existing = await getPatient(Number(req.params.id));
    if (!existing || existing.institution_id !== await activeInstitution(req)) throw new HttpError(404, 'Patient not found');
    const patient = await updatePatient(existing.id, req.body);
    await audit({ req, action: 'patient.update', entityType: 'patient', entityId: existing.id });
    return patient;
  });

  app.post('/exams', {
    ...tech,
    schema: { body: { type: 'object', properties: {
      study_uid: { type: 'string', maxLength: 128 }, patient_id: { type: 'integer' }, form_id: { type: 'integer' },
      description: { type: 'string', maxLength: 200 }, accession: { type: 'string', maxLength: 64 },
    } } },
  }, async (req) => {
    const institutionId = await activeInstitution(req);
    const forms = await availableForms(institutionId);
    let patientId, study, source;

    if (req.body.study_uid) {
      const existing = await findExamByStudyUid(institutionId, req.body.study_uid);
      if (existing) return { id: existing.id, existing: true };
      const institution = await one('SELECT id, name, dicom FROM institutions WHERE id = $1', [institutionId]);
      const found = await studyByUid(institution, req.body.study_uid);
      if (!found) throw new HttpError(404, 'That study could not be found in PACS. Refresh the worklist and try again.');
      const patient = await upsertPatient(institutionId, found.patient, req.user.id, { refresh: true });
      patientId = patient.id;
      study = found;
      source = 'pacs';
    } else if (req.body.patient_id) {
      const patient = await getPatient(req.body.patient_id);
      if (!patient || patient.institution_id !== institutionId) throw new HttpError(404, 'Patient not found');
      patientId = patient.id;
      study = { description: req.body.description || '', accession: req.body.accession || '' };
      source = 'manual';
    } else {
      throw new HttpError(400, 'Choose a study from the worklist or a patient.');
    }

    let form = req.body.form_id ? forms.find(f => f.id === req.body.form_id) : null;
    if (req.body.form_id && !form) throw new HttpError(400, 'That form is not available at this institution.');
    if (!form) {
      const best = rankForms(forms, study.description)[0];
      if (best && best.score > 0) form = best;
    }
    const id = await createExam({
      institutionId, patientId, formVersionId: form?.version_id ?? null, source, study,
      examDate: study.datetime ? study.datetime.slice(0, 10) : null, techId: req.user.id,
    });
    await audit({ req, action: 'exam.create', entityType: 'exam', entityId: id, details: { source, form_version_id: form?.version_id ?? null } });
    return { id, existing: false };
  });

  // Shared with radiologists.
  app.get('/exams/:id', { preHandler: requireAuth(can.tech, can.rad) }, async (req) => {
    const exam = await loadExamFor(req, Number(req.params.id));
    const version = exam.form_version_id ? await getVersion(exam.form_version_id) : null;
    await audit({ req, institutionId: exam.institution_id, action: 'exam.view', entityType: 'exam', entityId: exam.id });
    return { exam, form: version ? { version_id: version.id, version: version.version, definition: version.definition } : null, env: templateEnv(exam) };
  });

  app.get('/exams', tech, async (req) => {
    const institutionId = await activeInstitution(req);
    const days = Math.min(Number(req.query.days) || 7, 90);
    await audit({ req, institutionId, action: 'exam.list', details: { days, mine: req.query.mine === '1' } });
    return listExams({
      institutionIds: [institutionId],
      fromDate: today(-days),
      techId: req.query.mine === '1' ? req.user.id : null,
      statuses: req.query.status ? String(req.query.status).split(',') : null,
    });
  });

  app.put('/exams/:id', {
    ...tech,
    schema: { body: { type: 'object', required: ['row_version'], properties: { ...versionBody, answers: { type: 'object' }, tech_note: { type: 'string', maxLength: 5000 } } } },
  }, async (req) => {
    const exam = await loadExamFor(req, Number(req.params.id));
    requireStatus(exam, ['draft', 'returned'], 'edited');
    if (req.body.answers) assertAnswersOk(req.body.answers);
    const fields = {};
    if (req.body.answers) fields.answers = req.body.answers;
    if (req.body.tech_note !== undefined) fields.tech_note = req.body.tech_note;
    const rowVersion = await updateExam(exam.id, fields, req.body.row_version);
    await auditOnce(`edit:${req.user.id}:${exam.id}`, FIFTEEN_MIN, { req, institutionId: exam.institution_id, action: 'exam.edit', entityType: 'exam', entityId: exam.id });
    return { row_version: rowVersion };
  });

  app.post('/exams/:id/form', {
    ...tech,
    schema: { body: { type: 'object', required: ['form_id', 'row_version'], properties: { ...versionBody, form_id: { type: 'integer' } } } },
  }, async (req) => {
    const exam = await loadExamFor(req, Number(req.params.id));
    requireStatus(exam, ['draft', 'returned'], 'changed');
    const form = (await availableForms(exam.institution_id)).find(f => f.id === req.body.form_id);
    if (!form) throw new HttpError(400, 'That form is not available at this institution.');
    const rowVersion = await updateExam(exam.id, { form_version_id: form.version_id }, req.body.row_version);
    await audit({ req, institutionId: exam.institution_id, action: 'exam.form_changed', entityType: 'exam', entityId: exam.id, details: { form_version_id: form.version_id } });
    return { row_version: rowVersion };
  });

  app.post('/exams/:id/submit', {
    ...tech,
    schema: { body: { type: 'object', required: ['row_version', 'answers'], properties: { ...versionBody, answers: { type: 'object' }, tech_note: { type: 'string', maxLength: 5000 } } } },
  }, async (req) => {
    const exam = await loadExamFor(req, Number(req.params.id));
    requireStatus(exam, ['draft', 'returned'], 'submitted');
    if (!exam.form_version_id) throw new HttpError(400, 'Choose a form first.');
    const { definition } = await getVersion(exam.form_version_id);
    const env = templateEnv(exam);
    const answers = req.body.answers;
    assertAnswersOk(answers);
    const { missing, warnings } = validateAnswers(definition, answers, env);
    if (missing.length) {
      // Save their work anyway, then report what's missing.
      const rowVersion = await updateExam(exam.id, { answers, tech_note: req.body.tech_note ?? exam.tech_note }, req.body.row_version);
      throw new HttpError(400, 'Some required items are not filled in.', { missing, row_version: rowVersion });
    }
    const report = generateReport(definition, answers, env);
    if (report.errors.length) throw new HttpError(400, `The form's report template has an error; ask a tech manager to fix it. (${report.errors[0]})`);
    const rowVersion = await updateExam(exam.id, {
      answers: { ...answers, __calcs: computeCalcs(definition, answers, env) },
      tech_note: req.body.tech_note ?? exam.tech_note,
      report: report.text,
      final_report: null,
      return_reason: null,
      status: 'submitted',
      submitted_at: new Date(),
      tech_id: req.user.id,
    }, req.body.row_version);
    await audit({ req, institutionId: exam.institution_id, action: 'exam.submit', entityType: 'exam', entityId: exam.id, details: { warnings: warnings.length } });
    return { row_version: rowVersion, warnings };
  });

  app.post('/exams/:id/reopen', { ...tech, schema: { body: { type: 'object', required: ['row_version'], properties: versionBody } } }, async (req) => {
    const exam = await loadExamFor(req, Number(req.params.id));
    requireStatus(exam, ['submitted'], 'reopened');
    const rowVersion = await updateExam(exam.id, { status: 'draft', report: null, final_report: null, submitted_at: null }, req.body.row_version);
    await audit({ req, institutionId: exam.institution_id, action: 'exam.reopen', entityType: 'exam', entityId: exam.id });
    return { row_version: rowVersion };
  });

  app.post('/exams/:id/cancel', { ...tech, schema: { body: { type: 'object', required: ['row_version'], properties: versionBody } } }, async (req) => {
    const exam = await loadExamFor(req, Number(req.params.id));
    requireStatus(exam, ['draft', 'returned', 'submitted'], 'cancelled');
    const rowVersion = await updateExam(exam.id, { status: 'cancelled' }, req.body.row_version);
    await audit({ req, institutionId: exam.institution_id, action: 'exam.cancel', entityType: 'exam', entityId: exam.id });
    return { row_version: rowVersion };
  });
}
