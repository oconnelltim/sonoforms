// SPDX-License-Identifier: GPL-3.0-or-later
//
// Radiologist workflow: worklist of submitted exams, editing the generated
// findings, copying them, and marking exams dictated or returning them.

import { audit } from '../audit.js';
import { requireAuth, can, userInstitutions, HttpError } from '../auth.js';
import { listExams, updateExam } from '../records.js';
import { loadExamFor } from './tech.js';

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
    const exams = await listExams({ institutionIds, statuses, fromDate: daysAgo(days) });
    // Oldest first for the "ready to dictate" queue; newest first otherwise.
    if (status === 'submitted') exams.sort((a, b) => new Date(a.submitted_at) - new Date(b.submitted_at));
    return exams;
  });

  app.put('/exams/:id/report', {
    ...rad,
    schema: { body: { type: 'object', required: ['row_version'], properties: { ...versionBody, text: { type: ['string', 'null'], maxLength: 100000 } } } },
  }, async (req) => {
    const exam = await loadExamFor(req, Number(req.params.id));
    if (exam.status !== 'submitted') throw new HttpError(409, `This exam is ${exam.status}; the findings can no longer be edited.`);
    const rowVersion = await updateExam(exam.id, { final_report: req.body.text }, req.body.row_version);
    return { row_version: rowVersion };
  });

  app.post('/exams/:id/copied', rad, async (req) => {
    const exam = await loadExamFor(req, Number(req.params.id));
    await audit({ req, institutionId: exam.institution_id, action: 'exam.copy_findings', entityType: 'exam', entityId: exam.id });
    return { ok: true };
  });

  app.post('/exams/:id/dictated', {
    ...rad,
    schema: { body: { type: 'object', required: ['row_version'], properties: { ...versionBody, text: { type: ['string', 'null'], maxLength: 100000 } } } },
  }, async (req) => {
    const exam = await loadExamFor(req, Number(req.params.id));
    if (exam.status !== 'submitted') throw new HttpError(409, `This exam is ${exam.status} and cannot be marked dictated.`);
    const fields = { status: 'dictated', rad_id: req.user.id, dictated_at: new Date() };
    if (req.body.text !== undefined) fields.final_report = req.body.text;
    const rowVersion = await updateExam(exam.id, fields, req.body.row_version);
    await audit({ req, institutionId: exam.institution_id, action: 'exam.dictated', entityType: 'exam', entityId: exam.id });
    return { row_version: rowVersion };
  });

  app.post('/exams/:id/undictate', { ...rad, schema: { body: { type: 'object', required: ['row_version'], properties: versionBody } } }, async (req) => {
    const exam = await loadExamFor(req, Number(req.params.id));
    if (exam.status !== 'dictated') throw new HttpError(409, 'This exam is not marked dictated.');
    const rowVersion = await updateExam(exam.id, { status: 'submitted', dictated_at: null, rad_id: null }, req.body.row_version);
    await audit({ req, institutionId: exam.institution_id, action: 'exam.undictate', entityType: 'exam', entityId: exam.id });
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
