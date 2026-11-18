// SPDX-License-Identifier: GPL-3.0-or-later
//
// The holding area for scanner reports (DICOM Structured Reports sent by
// ultrasound machines). Reports are matched to exams by Study Instance UID:
// when one arrives, and again whenever an exam's scanner values are looked
// up, so a report that arrives before its form is started is picked up later.
// Nobody handles these files by hand; they only arrive over DICOM.

import { one, many, query } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { indexes, findExamByStudyUid } from './records.js';
import { readReport } from './sr.js';

const CONTEXT = 'scanner_reports.report';
// Unmatched reports are kept this long, in case the exam is started late.
export const UNMATCHED_KEEP_DAYS = 14;

async function nextId() {
  return (await one("SELECT nextval(pg_get_serial_sequence('scanner_reports', 'id'))::int AS id")).id;
}

// Strips what we don't keep from a received dataset (binary values, which
// naturalize to {} and aren't needed for measurements).
function storable(ds) {
  return JSON.parse(JSON.stringify(ds, (k, v) => (k === '_vrMap' || v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? undefined : v)));
}

// Stores a received report for an institution and links it to its exam if
// one exists. Returns { id, matched: examId|null, replaced }.
export async function storeReport(institutionId, dataset, callingAe) {
  const ds = storable(dataset);
  const report = readReport(ds);   // throws if it isn't a usable SR
  const studyIdx = indexes.studyUid(institutionId, report.studyUid);
  const sopIdx = indexes.sopUid(institutionId, report.sopInstanceUid || report.studyUid);
  const existing = await one('SELECT id, exam_id FROM scanner_reports WHERE institution_id = $1 AND sop_uid_bidx = $2', [institutionId, sopIdx]);
  const exam = await findExamByStudyUid(institutionId, report.studyUid);
  const examId = exam?.id ?? existing?.exam_id ?? null;
  const id = existing?.id ?? await nextId();
  const enc = encrypt(ds, CONTEXT, id);
  if (existing) {
    await query(
      `UPDATE scanner_reports SET report_enc = $2, calling_ae = $3, device = $4, template = $5, received_at = now(),
         exam_id = $6, matched_at = CASE WHEN $6::int IS NULL THEN NULL ELSE COALESCE(matched_at, now()) END WHERE id = $1`,
      [id, enc, callingAe, report.summary.device, report.summary.template, examId]);
  } else {
    await query(
      `INSERT INTO scanner_reports (id, institution_id, exam_id, study_uid_bidx, sop_uid_bidx, calling_ae, device, template, report_enc, matched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $3::int IS NULL THEN NULL ELSE now() END)`,
      [id, institutionId, examId, studyIdx, sopIdx, callingAe, report.summary.device, report.summary.template, enc]);
  }
  return { id, matched: examId, replaced: !!existing, report };
}

// Links waiting reports for an exam's studies (its own and any linked ones).
export async function matchPending(exam) {
  const uids = [exam.study?.study_uid, ...(exam.linked_studies || []).map(s => s.study_uid)].filter(Boolean);
  if (!uids.length) return 0;
  const idx = uids.map(u => indexes.studyUid(exam.institution_id, u));
  const r = await query(
    `UPDATE scanner_reports SET exam_id = $1, matched_at = now()
     WHERE institution_id = $2 AND exam_id IS NULL AND study_uid_bidx = ANY($3::text[])`, [exam.id, exam.institution_id, idx]);
  return r.rowCount;
}

// An exam's reports, newest first, with their measurements.
export async function reportsForExam(exam) {
  await matchPending(exam);
  const rows = await many('SELECT id, calling_ae, device, template, report_enc, received_at FROM scanner_reports WHERE exam_id = $1 ORDER BY received_at DESC, id DESC', [exam.id]);
  return rows.map((row) => {
    const report = readReport(decrypt(row.report_enc, CONTEXT, row.id));
    return { id: row.id, calling_ae: row.calling_ae, device: row.device, template: row.template, received_at: row.received_at, ...report };
  });
}

// When an exam is cancelled, its reports go back to waiting, so a new exam
// for the same study can pick them up.
export async function releaseReports(examId) {
  await query('UPDATE scanner_reports SET exam_id = NULL, matched_at = NULL WHERE exam_id = $1', [examId]);
}

// For administrators: what arrived recently, without patient details.
export async function recentReports(institutionIds, limit = 200) {
  return many(
    `SELECT r.id, r.institution_id, i.name AS institution_name, r.calling_ae, r.device, r.template, r.received_at, r.matched_at,
            r.exam_id IS NOT NULL AS matched
     FROM scanner_reports r JOIN institutions i ON i.id = r.institution_id
     WHERE r.institution_id = ANY($1::int[]) ORDER BY r.received_at DESC LIMIT $2`, [institutionIds, limit]);
}

export async function purgeUnmatchedReports(log = console) {
  const r = await query(`DELETE FROM scanner_reports WHERE exam_id IS NULL AND received_at < now() - make_interval(days => $1)`, [UNMATCHED_KEEP_DAYS]);
  if (r.rowCount) log.info(`Deleted ${r.rowCount} scanner reports that matched no exam within ${UNMATCHED_KEEP_DAYS} days`);
  return r.rowCount;
}
