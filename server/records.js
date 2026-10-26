// SPDX-License-Identifier: GPL-3.0-or-later
//
// Patients and exams. All identifying data passes through encrypt/decrypt
// here; nothing else in the server touches the *_enc columns directly.

import { one, many, query, tx } from './db.js';
import { encrypt, decrypt, exactIndex, nameIndex } from './crypto.js';
import { HttpError } from './auth.js';

const D = 'patients.demographics';

// Blind indexes, all scoped to the institution so the same person can't be
// linked across institutions from a database dump. Identifiers match
// exactly; the MRN key includes the issuer so two assigning authorities
// can't merge into one patient.
export const indexes = {
  mrn: (inst, issuer, mrn) => (String(mrn ?? '').trim() ? exactIndex(`${String(issuer ?? '').trim()}\u0000${String(mrn).trim()}`, `mrn:${inst}`) : null),
  mrnSearch: (inst, mrn) => exactIndex(mrn, `mrn-search:${inst}`),
  lastName: (inst, name) => nameIndex(name, `last-name:${inst}`),
  studyUid: (inst, uid) => exactIndex(uid, `study-uid:${inst}`),
  accession: (inst, acc) => exactIndex(acc, `accession:${inst}`),
};

async function nextId(table) {
  return (await one(`SELECT nextval(pg_get_serial_sequence('${table}', 'id'))::int AS id`)).id;
}

export function cleanDemographics(d = {}) {
  const s = v => (v === null || v === undefined ? '' : String(v).trim()).slice(0, 200);
  const dob = s(d.dob);
  if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new HttpError(400, 'Date of birth must be a valid date.');
  const sex = s(d.sex).toUpperCase().slice(0, 1);
  return {
    mrn: s(d.mrn),
    last_name: s(d.last_name),
    first_name: s(d.first_name),
    dob,
    sex: ['M', 'F', 'O'].includes(sex) ? sex : '',
    issuer: s(d.issuer),
  };
}

export function ageYears(dob, onDate = new Date()) {
  if (!dob) return null;
  const b = new Date(`${dob}T00:00:00`);
  if (isNaN(b)) return null;
  const ref = typeof onDate === 'string' ? new Date(`${onDate}T00:00:00`) : onDate;
  let age = ref.getFullYear() - b.getFullYear();
  const m = ref.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < b.getDate())) age--;
  return age;
}

export function patientFromRow(row) {
  if (!row) return null;
  return { id: row.id, institution_id: row.institution_id, ...decrypt(row.demographics_enc, D, row.id) };
}

export async function getPatient(id) {
  return patientFromRow(await one('SELECT * FROM patients WHERE id = $1', [id]));
}

export async function searchPatients(institutionId, { mrn, last_name }) {
  const mrnIdx = indexes.mrnSearch(institutionId, mrn);
  const nameIdx = indexes.lastName(institutionId, last_name);
  if (!mrnIdx && !nameIdx) return [];
  const rows = await many(
    `SELECT * FROM patients WHERE institution_id = $1
       AND ($2::text IS NULL OR mrn_search_bidx = $2) AND ($3::text IS NULL OR last_name_bidx = $3)
     ORDER BY updated_at DESC LIMIT 50`, [institutionId, mrnIdx, nameIdx]);
  return rows.map(patientFromRow);
}

// Find by MRN (+ issuer) or create. When `refresh` is set (data from PACS),
// stored demographics are updated to match.
export async function upsertPatient(institutionId, demographics, userId, { refresh = false } = {}) {
  const d = cleanDemographics(demographics);
  if (!d.mrn) throw new HttpError(400, 'An MRN (patient ID) is required.');
  if (!d.last_name) throw new HttpError(400, 'A last name is required.');
  const mrnIdx = indexes.mrn(institutionId, d.issuer, d.mrn);
  const existing = await one('SELECT * FROM patients WHERE institution_id = $1 AND mrn_bidx = $2', [institutionId, mrnIdx]);
  if (existing) {
    if (refresh) {
      await query('UPDATE patients SET demographics_enc = $2, last_name_bidx = $3, updated_at = now() WHERE id = $1',
        [existing.id, encrypt(d, D, existing.id), indexes.lastName(institutionId, d.last_name)]);
      return { id: existing.id, institution_id: institutionId, ...d, created: false };
    }
    return { ...patientFromRow(existing), created: false };
  }
  const id = await nextId('patients');
  const row = await one(
    `INSERT INTO patients (id, institution_id, mrn_bidx, mrn_search_bidx, last_name_bidx, demographics_enc, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (institution_id, mrn_bidx) DO UPDATE SET updated_at = now()
     RETURNING id`, [id, institutionId, mrnIdx, indexes.mrnSearch(institutionId, d.mrn), indexes.lastName(institutionId, d.last_name), encrypt(d, D, id), userId]);
  if (row.id !== id) return { ...(await getPatient(row.id)), created: false }; // lost a race; use the existing record
  return { id, institution_id: institutionId, ...d, created: true };
}

export async function updatePatient(id, demographics) {
  const current = await getPatient(id);
  if (!current) throw new HttpError(404, 'Patient not found');
  // Keep the issuer from PACS; it isn't editable in the UI.
  const d = cleanDemographics({ ...demographics, issuer: current.issuer });
  if (!d.mrn || !d.last_name) throw new HttpError(400, 'MRN and last name are required.');
  const inst = current.institution_id;
  const mrnIdx = indexes.mrn(inst, d.issuer, d.mrn);
  const clash = await one('SELECT id FROM patients WHERE institution_id = $1 AND mrn_bidx = $2 AND id <> $3', [inst, mrnIdx, id]);
  if (clash) throw new HttpError(409, 'Another patient already has that MRN.');
  await query('UPDATE patients SET mrn_bidx = $2, mrn_search_bidx = $3, last_name_bidx = $4, demographics_enc = $5, updated_at = now() WHERE id = $1',
    [id, mrnIdx, indexes.mrnSearch(inst, d.mrn), indexes.lastName(inst, d.last_name), encrypt(d, D, id)]);
  return { id, ...d };
}

// ---- Exams --------------------------------------------------------------

const EXAM_LIST_COLS = `e.id, e.institution_id, e.patient_id, e.status, e.source, e.exam_date, e.study_enc, e.form_version_id,
  e.submitted_at, e.dictated_at, e.created_at, e.updated_at, e.row_version, e.return_reason_enc,
  e.tech_id, tu.display_name AS tech_name, e.rad_id, ru.display_name AS rad_name,
  f.title AS form_title, fv.version AS form_version, i.name AS institution_name, i.code AS institution_code,
  p.demographics_enc,
  (SELECT json_agg(json_build_object('id', ls.id, 'enc', ls.study_enc) ORDER BY ls.id) FROM exam_studies ls WHERE ls.exam_id = e.id) AS linked_enc`;

const EXAM_JOINS = `FROM exams e
  JOIN patients p ON p.id = e.patient_id
  JOIN institutions i ON i.id = e.institution_id
  LEFT JOIN form_versions fv ON fv.id = e.form_version_id
  LEFT JOIN forms f ON f.id = fv.form_id
  LEFT JOIN users tu ON tu.id = e.tech_id
  LEFT JOIN users ru ON ru.id = e.rad_id`;

function examSummary(row) {
  const study = decrypt(row.study_enc, 'exams.study', row.id) || {};
  const patient = decrypt(row.demographics_enc, D, row.patient_id) || {};
  return {
    id: row.id,
    institution_id: row.institution_id,
    institution_name: row.institution_name,
    institution_code: row.institution_code,
    status: row.status,
    source: row.source,
    exam_date: row.exam_date,
    form_title: row.form_title,
    form_version: row.form_version,
    form_version_id: row.form_version_id,
    tech_name: row.tech_name,
    rad_name: row.rad_name,
    submitted_at: row.submitted_at,
    dictated_at: row.dictated_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    return_reason: decrypt(row.return_reason_enc, 'exams.return_reason', row.id),
    study,
    // Other PACS studies (accession numbers) this exam's form also covers.
    linked_studies: (row.linked_enc || []).map(l => decrypt(l.enc, 'exam_studies.study', l.id)).filter(Boolean),
    patient: { id: row.patient_id, ...patient, age: ageYears(patient.dob, row.exam_date) },
  };
}

export async function listExams({ institutionIds, statuses, fromDate, toDate, techId, limit = 500 }) {
  const rows = await many(
    `SELECT ${EXAM_LIST_COLS} ${EXAM_JOINS}
     WHERE e.institution_id = ANY($1::int[])
       AND ($2::text[] IS NULL OR e.status = ANY($2::text[]))
       AND ($3::date IS NULL OR e.exam_date >= $3)
       AND ($4::date IS NULL OR e.exam_date <= $4)
       AND ($5::int IS NULL OR e.tech_id = $5)
     ORDER BY COALESCE(e.submitted_at, e.created_at) DESC
     LIMIT $6`, [institutionIds, statuses || null, fromDate || null, toDate || null, techId || null, limit]);
  return rows.map(examSummary);
}

export async function getExam(id) {
  const row = await one(
    `SELECT ${EXAM_LIST_COLS}, e.answers_enc, e.report_enc, e.final_report_enc, e.tech_note_enc, e.study_uid_bidx
     ${EXAM_JOINS} WHERE e.id = $1`, [id]);
  if (!row) throw new HttpError(404, 'Exam not found');
  return {
    ...examSummary(row),
    row_version: row.row_version,
    answers: decrypt(row.answers_enc, 'exams.answers', row.id) || {},
    report: decrypt(row.report_enc, 'exams.report', row.id),
    final_report: decrypt(row.final_report_enc, 'exams.final_report', row.id),
    tech_note: decrypt(row.tech_note_enc, 'exams.tech_note', row.id) || '',
  };
}

// The active exam for a study: its own exam, or the exam it is linked to.
export async function findExamByStudyUid(institutionId, studyUid) {
  const idx = indexes.studyUid(institutionId, studyUid);
  if (!idx) return null;
  return (await one("SELECT id, status FROM exams WHERE institution_id = $1 AND study_uid_bidx = $2 AND status <> 'cancelled'", [institutionId, idx]))
    || one(`SELECT e.id, e.status, true AS linked FROM exam_studies s JOIN exams e ON e.id = s.exam_id
            WHERE s.institution_id = $1 AND s.study_uid_bidx = $2 AND e.status <> 'cancelled'`, [institutionId, idx]);
}

// Map of study_uid_bidx -> exam summary, for marking PACS worklist rows.
// Studies covered by another exam's form are marked `linked: true`.
export async function examsByStudyUids(institutionId, studyUids) {
  const idx = studyUids.map(u => indexes.studyUid(institutionId, u)).filter(Boolean);
  if (!idx.length) return new Map();
  const rows = await many(
    `SELECT ${EXAM_LIST_COLS}, e.study_uid_bidx ${EXAM_JOINS}
     WHERE e.institution_id = $1 AND e.study_uid_bidx = ANY($2::text[]) AND e.status <> 'cancelled'`, [institutionId, idx]);
  const linked = await many(
    `SELECT ${EXAM_LIST_COLS}, s.study_uid_bidx AS linked_bidx ${EXAM_JOINS}
     JOIN exam_studies s ON s.exam_id = e.id
     WHERE s.institution_id = $1 AND s.study_uid_bidx = ANY($2::text[]) AND e.status <> 'cancelled'`, [institutionId, idx]);
  return new Map([
    ...linked.map(r => [r.linked_bidx, { ...examSummary(r), linked: true }]),
    ...rows.map(r => [r.study_uid_bidx, examSummary(r)]),
  ]);
}

// Replaces the extra studies an exam's form covers. Each study may belong to
// only one active exam, as its own study or as a linked one.
export async function setLinkedStudies(exam, studies) {
  const inst = exam.institution_id;
  const seen = new Set([exam.study?.study_uid].filter(Boolean));
  const list = studies.map(cleanStudy).filter(st => st.study_uid && !seen.has(st.study_uid) && seen.add(st.study_uid));
  await tx(async (c) => {
    await c.query('DELETE FROM exam_studies WHERE exam_id = $1', [exam.id]);
    for (const st of list) {
      const idx = indexes.studyUid(inst, st.study_uid);
      const label = [st.description || 'That study', st.accession && `(Acc ${st.accession})`].filter(Boolean).join(' ');
      const own = await c.query("SELECT 1 FROM exams WHERE institution_id = $1 AND study_uid_bidx = $2 AND status <> 'cancelled' AND id <> $3", [inst, idx, exam.id]);
      if (own.rowCount) throw new HttpError(409, `${label} already has its own form. Cancel that form first, or leave the study out.`);
      const id = (await c.query("SELECT nextval(pg_get_serial_sequence('exam_studies', 'id'))::int AS id")).rows[0].id;
      try {
        await c.query(
          'INSERT INTO exam_studies (id, exam_id, institution_id, study_uid_bidx, accession_bidx, study_enc) VALUES ($1, $2, $3, $4, $5, $6)',
          [id, exam.id, inst, idx, indexes.accession(inst, st.accession), encrypt(st, 'exam_studies.study', id)]);
      } catch (e) {
        if (e.code === '23505') throw new HttpError(409, `${label} is already covered by another form.`);
        throw e;
      }
    }
  });
  return list;
}

export async function unlinkStudies(examId) {
  await query('DELETE FROM exam_studies WHERE exam_id = $1', [examId]);
}

// The patient's other exams the same day at the same institution (a
// "visit"), including this one, with their reports, oldest first.
export async function visitExams(exam) {
  const rows = await many(
    `SELECT ${EXAM_LIST_COLS}, e.report_enc, e.final_report_enc ${EXAM_JOINS}
     WHERE e.patient_id = $1 AND e.institution_id = $2 AND e.exam_date = $3 AND e.status <> 'cancelled'
     ORDER BY e.id`, [exam.patient.id, exam.institution_id, exam.exam_date]);
  return rows.map(r => ({
    ...examSummary(r),
    row_version: r.row_version,
    report: decrypt(r.report_enc, 'exams.report', r.id),
    final_report: decrypt(r.final_report_enc, 'exams.final_report', r.id),
  }));
}

export function studyUidIndex(institutionId, uid) {
  return indexes.studyUid(institutionId, uid);
}

// Today's date in the server's local time zone (TZ), as YYYY-MM-DD.
export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function cleanStudy(study) {
  return {
    accession: String(study?.accession || '').slice(0, 64),
    study_uid: String(study?.study_uid || '').slice(0, 128),
    description: String(study?.description || '').slice(0, 200),
    datetime: study?.datetime || null,
    referring: String(study?.referring || '').slice(0, 200),
  };
}

export async function createExam({ institutionId, patientId, formVersionId, source, study, examDate, techId }) {
  const s = cleanStudy(study);
  const id = await nextId('exams');
  try {
    await query(
      `INSERT INTO exams (id, institution_id, patient_id, form_version_id, source, exam_date, study_uid_bidx, accession_bidx, study_enc, answers_enc, tech_id)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, $11)`,
      [id, institutionId, patientId, formVersionId, source, examDate || localToday(), indexes.studyUid(institutionId, s.study_uid),
        indexes.accession(institutionId, s.accession), encrypt(s, 'exams.study', id), encrypt({}, 'exams.answers', id), techId]);
  } catch (e) {
    // Two techs started the same study at once: return the exam that won.
    if (e.code === '23505' && s.study_uid) {
      const existing = await findExamByStudyUid(institutionId, s.study_uid);
      if (existing) return existing.id;
    }
    throw e;
  }
  return id;
}

// Optimistic concurrency: callers pass the row_version they loaded. Pass a
// transaction client to update several exams together.
export async function updateExam(id, fields, expectedVersion, client = null) {
  const sets = [];
  const params = [id];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if ('answers' in fields) add('answers_enc', encrypt(fields.answers || {}, 'exams.answers', id));
  if ('tech_note' in fields) add('tech_note_enc', encrypt(fields.tech_note || '', 'exams.tech_note', id));
  if ('report' in fields) add('report_enc', encrypt(fields.report, 'exams.report', id));
  if ('final_report' in fields) add('final_report_enc', fields.final_report === null ? null : encrypt(fields.final_report, 'exams.final_report', id));
  if ('return_reason' in fields) add('return_reason_enc', fields.return_reason ? encrypt(fields.return_reason, 'exams.return_reason', id) : null);
  if ('study' in fields) add('study_enc', encrypt(fields.study, 'exams.study', id));
  for (const col of ['status', 'form_version_id', 'tech_id', 'rad_id', 'submitted_at', 'dictated_at', 'patient_id']) {
    if (col in fields) add(col, fields[col]);
  }
  sets.push('updated_at = now()', 'row_version = row_version + 1');
  let where = 'id = $1';
  if (expectedVersion !== undefined && expectedVersion !== null) {
    params.push(expectedVersion);
    where += ` AND row_version = $${params.length}`;
  }
  const run = client ? (text, values) => client.query(text, values) : query;
  const r = await run(`UPDATE exams SET ${sets.join(', ')} WHERE ${where} RETURNING row_version`, params);
  if (!r.rowCount) throw new HttpError(409, 'This exam was changed by someone else (or in another window). Reload to see the latest version.', { code: 'CONFLICT' });
  return r.rows[0].row_version;
}

// Context available to form expressions/templates as patient.*, exam.*, institution.*
export function templateEnv(exam) {
  return {
    patient: { age: exam.patient?.age ?? null, sex: exam.patient?.sex || null },
    exam: { date: exam.exam_date, study_description: exam.study?.description || '' },
    institution: { name: exam.institution_name, code: exam.institution_code },
  };
}
