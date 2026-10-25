// SPDX-License-Identifier: GPL-3.0-or-later
//
// Brings rows written by older versions up to the current format:
//  - version-1 ciphertext (bound only to its column) is re-encrypted as
//    version 2 (bound to its column and row id);
//  - blind indexes are recomputed with exact matching for identifiers,
//    the issuer in the MRN key, and per-institution scoping.
// Used by database migration 002 and after restoring an older backup.

import { encrypt, decrypt, decryptLegacy, isLegacyCiphertext } from './crypto.js';
import { indexes } from './records.js';

const EXAM_COLUMNS = {
  study_enc: 'exams.study',
  answers_enc: 'exams.answers',
  report_enc: 'exams.report',
  final_report_enc: 'exams.final_report',
  tech_note_enc: 'exams.tech_note',
  return_reason_enc: 'exams.return_reason',
};

const readAny = (blob, context, id) => (isLegacyCiphertext(blob) ? decryptLegacy(blob, context) : decrypt(blob, context, id));

export async function upgradeLegacyRows(client, log = console) {
  let patients = 0;
  let exams = 0;
  for (;;) {
    const { rows } = await client.query(
      `SELECT id, institution_id, demographics_enc FROM patients
       WHERE demographics_enc LIKE 'v1.%' OR mrn_search_bidx IS NULL ORDER BY id LIMIT 500`);
    if (!rows.length) break;
    for (const p of rows) {
      const d = readAny(p.demographics_enc, 'patients.demographics', p.id);
      await client.query(
        'UPDATE patients SET demographics_enc = $2, mrn_bidx = $3, mrn_search_bidx = $4, last_name_bidx = $5 WHERE id = $1',
        [p.id, encrypt(d, 'patients.demographics', p.id), indexes.mrn(p.institution_id, d.issuer, d.mrn) || `missing-${p.id}`,
          indexes.mrnSearch(p.institution_id, d.mrn) || '', indexes.lastName(p.institution_id, d.last_name)]);
      patients++;
    }
  }
  const legacyCond = Object.keys(EXAM_COLUMNS).map(c => `${c} LIKE 'v1.%'`).join(' OR ');
  for (;;) {
    const { rows } = await client.query(
      `SELECT id, institution_id, ${Object.keys(EXAM_COLUMNS).join(', ')} FROM exams WHERE ${legacyCond} ORDER BY id LIMIT 500`);
    if (!rows.length) break;
    for (const e of rows) {
      const sets = [];
      const params = [e.id];
      for (const [col, context] of Object.entries(EXAM_COLUMNS)) {
        if (e[col] === null) continue;
        const value = readAny(e[col], context, e.id);
        params.push(encrypt(value, context, e.id));
        sets.push(`${col} = $${params.length}`);
        if (col === 'study_enc') {
          params.push(indexes.studyUid(e.institution_id, value?.study_uid));
          sets.push(`study_uid_bidx = $${params.length}`);
          params.push(indexes.accession(e.institution_id, value?.accession));
          sets.push(`accession_bidx = $${params.length}`);
        }
      }
      await client.query(`UPDATE exams SET ${sets.join(', ')} WHERE id = $1`, params);
      exams++;
    }
  }
  if (patients || exams) log.info(`Upgraded encryption and indexes for ${patients} patients and ${exams} exams`);
  return { patients, exams };
}
