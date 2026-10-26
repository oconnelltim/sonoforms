// SPDX-License-Identifier: GPL-3.0-or-later
//
// Radiologist workflow: worklist of submitted exams, editing the generated
// findings, copying them, and marking exams dictated or returning them.

import { audit, auditOnce } from '../audit.js';
import { requireAuth, can, userInstitutions, HttpError } from '../auth.js';
import { tx } from '../db.js';
import { listExams, updateExam, visitExams } from '../records.js';
import { loadExamFor } from './tech.js';
import { REPORT_FIELD_IDS, reportFields, reportFieldLabel, combineReports, defaultHeading } from '../../shared/report-fields.js';

// Request body for the radiologist's edited report: { fields: { indication: '…', findings: '…' } },
// or null to go back to the generated text.
const editedFieldsSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: Object.fromEntries(REPORT_FIELD_IDS.map(id => [id, { type: 'string', maxLength: 50000 }])),
};

// Generated fields with the radiologist's edits applied, in report order.
function applyEdits(generated, edits) {
  const order = [...generated.map(f => f.id), ...REPORT_FIELD_IDS.filter(id => !generated.some(f => f.id === id))];
  return order
    .filter(id => edits[id] !== undefined || generated.some(f => f.id === id))
    .map(id => ({ id, label: reportFieldLabel(id), text: edits[id] ?? generated.find(f => f.id === id)?.text ?? '' }));
}

function editedReport(exam, edits) {
  if (edits === null || edits === undefined) return null;
  return { fields: applyEdits(reportFields(exam.report), edits) };
}

// ---- Combined reports ---------------------------------------------------
// Exams for one patient on the same day can be reported together: one set
// of cards, with a heading per exam in Findings and Impression. The combined
// edits are kept on the first exam of the group (lowest id); when dictated,
// every exam in the group stores the combined report and the ids it covers.

// An exam's own report as it stands (separate edits included).
export function ownFields(exam) {
  const own = exam.final_report && !exam.final_report.combined ? exam.final_report : exam.report;
  return reportFields(own);
}
const headingOf = exam => exam.report?.heading || defaultHeading(exam.form_title);
export const combinedGenerated = group => combineReports(group.map(e => ({ heading: headingOf(e), fields: ownFields(e) })));

// Checks a requested group: this exam plus others from its visit, all
// waiting to be dictated. Returns the group's exams, oldest first.
async function loadGroup(exam, ids) {
  const want = new Set([exam.id, ...ids]);
  const visit = await visitExams(exam);
  const group = visit.filter(e => want.has(e.id));
  if (group.length !== want.size) throw new HttpError(400, 'Those exams are not all from this patient’s visit.');
  const notReady = group.find(e => e.status !== 'submitted');
  if (notReady) throw new HttpError(409, `${notReady.form_title || 'One of the exams'} is ${notReady.status}; it can’t be reported in this group.`);
  return group;
}

const groupSchema = { type: 'array', maxItems: 10, items: { type: 'integer' } };

const versionBody = { row_version: { type: 'integer' } };

function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default async function radRoutes(app) {
  const rad = { preHandler: requireAuth(can.rad) };

  app.get('/worklist/rad', rad, async (req) => {
    const mine = (await userInstitutions(req.user)).map(i => i.id);
    let institutionIds = mine;
    if (req.query.institution && req.query.institution !== 'all') {
      const id = Number(req.query.institution);
      if (!mine.includes(id)) throw new HttpError(403, 'You do not have access to that institution.');
      institutionIds = [id];
    }
    const status = String(req.query.status || 'submitted');
    const statuses = { submitted: ['submitted'], dictated: ['dictated'], returned: ['returned'], all: ['submitted', 'dictated', 'returned'] }[status] || ['submitted'];
    const days = Math.min(Number(req.query.days) || (status === 'submitted' ? 30 : 3), 90);
    if (req.headers['x-background'] !== '1') {
      await auditOnce(`wl:${req.user.id}:rad:${status}`, 15 * 60000, { req, institutionId: null, action: 'worklist.view', details: { worklist: 'rad', status, institution: req.query.institution || 'all' } });
    }
    const exams = await listExams({ institutionIds, statuses, fromDate: daysAgo(days) });
    // Oldest first for the "ready to dictate" queue; newest first otherwise.
    if (status === 'submitted') exams.sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
    return exams;
  });

  // The patient's exams from the same day, for reporting them together.
  app.get('/exams/:id/visit', rad, async (req) => {
    const exam = await loadExamFor(req, Number(req.params.id));
    const visit = await visitExams(exam);
    return {
      exams: visit.map(e => ({
        id: e.id, status: e.status, form_title: e.form_title, heading: headingOf(e), study: e.study, linked_studies: e.linked_studies,
        tech_name: e.tech_name, submitted_at: e.submitted_at, row_version: e.row_version, report: e.report, final_report: e.final_report,
      })),
    };
  });

  app.put('/exams/:id/report', {
    ...rad,
    schema: { body: { type: 'object', required: ['row_version'], properties: { ...versionBody, fields: editedFieldsSchema, combined_with: groupSchema } } },
  }, async (req) => {
    const exam = await loadExamFor(req, Number(req.params.id));
    if (exam.status !== 'submitted') throw new HttpError(409, `This exam is ${exam.status}; the findings can no longer be edited.`);
    let finalReport = editedReport(exam, req.body.fields);
    if (req.body.combined_with?.length) {
      const group = await loadGroup(exam, req.body.combined_with);
      finalReport = req.body.fields ? { fields: applyEdits(combinedGenerated(group), req.body.fields), combined: group.map(e => e.id) } : null;
    }
    const rowVersion = await updateExam(exam.id, { final_report: finalReport }, req.body.row_version);
    await auditOnce(`report:${req.user.id}:${exam.id}`, 15 * 60000, { req, institutionId: exam.institution_id, action: 'exam.report_edit', entityType: 'exam', entityId: exam.id });
    return { row_version: rowVersion };
  });

  app.post('/exams/:id/copied', {
    ...rad,
    schema: { body: { type: ['object', 'null'], properties: { field: { type: 'string', enum: [...REPORT_FIELD_IDS, 'all'] } } } },
  }, async (req) => {
    const exam = await loadExamFor(req, Number(req.params.id));
    await audit({ req, institutionId: exam.institution_id, action: 'exam.copy_findings', entityType: 'exam', entityId: exam.id, details: req.body?.field ? { field: req.body.field } : null });
    return { ok: true };
  });

  // Marks a group of exams reported together as dictated. Each stores the
  // combined report. versions: { examId: row_version } for every exam.
  app.post('/exams/:id/dictated-group', {
    ...rad,
    schema: { body: { type: 'object', required: ['versions'], properties: {
      versions: { type: 'object', additionalProperties: { type: 'integer' }, maxProperties: 10 }, fields: editedFieldsSchema,
    } } },
  }, async (req) => {
    const exam = await loadExamFor(req, Number(req.params.id));
    const ids = Object.keys(req.body.versions).map(Number);
    if (!ids.includes(exam.id) || ids.length < 2) throw new HttpError(400, 'A combined report needs this exam and at least one other.');
    const group = await loadGroup(exam, ids);
    const combined = { fields: applyEdits(combinedGenerated(group), req.body.fields || {}), combined: group.map(e => e.id) };
    const now = new Date();
    await tx(async (c) => {
      for (const e of group) {
        await updateExam(e.id, { status: 'dictated', rad_id: req.user.id, dictated_at: now, final_report: combined }, req.body.versions[e.id], c);
      }
    });
    for (const e of group) {
      await audit({ req, institutionId: e.institution_id, action: 'exam.dictated', entityType: 'exam', entityId: e.id, details: { combined_with: group.map(x => x.id).filter(x => x !== e.id) } });
    }
    return { ok: true };
  });

  app.post('/exams/:id/dictated', {
    ...rad,
    schema: { body: { type: 'object', required: ['row_version'], properties: { ...versionBody, fields: editedFieldsSchema } } },
  }, async (req) => {
    const exam = await loadExamFor(req, Number(req.params.id));
    if (exam.status !== 'submitted') throw new HttpError(409, `This exam is ${exam.status} and cannot be marked dictated.`);
    const fields = { status: 'dictated', rad_id: req.user.id, dictated_at: new Date() };
    if (req.body.fields !== undefined) fields.final_report = editedReport(exam, req.body.fields);
    const rowVersion = await updateExam(exam.id, fields, req.body.row_version);
    await audit({ req, institutionId: exam.institution_id, action: 'exam.dictated', entityType: 'exam', entityId: exam.id });
    return { row_version: rowVersion };
  });

  app.post('/exams/:id/undictate', { ...rad, schema: { body: { type: 'object', required: ['row_version'], properties: versionBody } } }, async (req) => {
    const exam = await loadExamFor(req, Number(req.params.id));
    if (exam.status !== 'dictated') throw new HttpError(409, 'This exam is not marked dictated.');
    // A combined report moves back as a group, keeping its edits on the first exam.
    const groupIds = exam.final_report?.combined || [];
    const others = groupIds.length ? (await visitExams(exam)).filter(e => groupIds.includes(e.id) && e.id !== exam.id && e.status === 'dictated') : [];
    let rowVersion;
    await tx(async (c) => {
      const back = (e, version) => updateExam(e.id, {
        status: 'submitted', dictated_at: null, rad_id: null, final_report: groupIds.length && e.id !== Math.min(...groupIds) ? null : e.final_report,
      }, version, c);
      rowVersion = await back(exam, req.body.row_version);
      for (const e of others) await back(e, e.row_version);
    });
    for (const e of [exam, ...others]) await audit({ req, institutionId: e.institution_id, action: 'exam.undictate', entityType: 'exam', entityId: e.id });
    return { row_version: rowVersion };
  });

  app.post('/exams/:id/return', {
    ...rad,
    schema: { body: { type: 'object', required: ['row_version', 'reason'], properties: { ...versionBody, reason: { type: 'string', minLength: 1, maxLength: 2000 } } } },
  }, async (req) => {
    const exam = await loadExamFor(req, Number(req.params.id));
    if (exam.status !== 'submitted') throw new HttpError(409, `This exam is ${exam.status} and cannot be returned.`);
    const rowVersion = await updateExam(exam.id, { status: 'returned', return_reason: req.body.reason, rad_id: req.user.id }, req.body.row_version);
    await audit({ req, institutionId: exam.institution_id, action: 'exam.return', entityType: 'exam', entityId: exam.id });
    return { row_version: rowVersion };
  });
}
