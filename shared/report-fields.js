// SPDX-License-Identifier: GPL-3.0-or-later
//
// The parts of a report that dictation systems treat as separate fields.
// Each form section's report text goes into one of these (Findings unless
// the section says otherwise), and the radiologist copies each one into the
// matching field of their speech-recognition template.

export const REPORT_FIELDS = [
  { id: 'indication', label: 'Indication' },
  { id: 'comparison', label: 'Comparison' },
  { id: 'technique', label: 'Technique' },
  { id: 'findings', label: 'Findings' },
  { id: 'impression', label: 'Impression' },
];

export const REPORT_FIELD_IDS = REPORT_FIELDS.map(f => f.id);
export const DEFAULT_REPORT_FIELD = 'findings';
export const reportFieldLabel = id => REPORT_FIELDS.find(f => f.id === id)?.label || id;

// One block of text for the whole report: a single Findings field reads as
// plain text; several fields get a heading each.
export function reportText(fields) {
  if (fields.length === 1 && fields[0].id === DEFAULT_REPORT_FIELD) return fields[0].text;
  return fields.map(f => `${f.label.toUpperCase()}:\n${f.text}`).join('\n\n');
}

// Exams store their report as { fields: [{ id, label, text }] }; reports
// saved by version 0.2 and earlier were a single string of findings.
export function reportFields(stored) {
  if (stored === null || stored === undefined || stored === '') return [];
  if (typeof stored === 'string') return [{ id: DEFAULT_REPORT_FIELD, label: reportFieldLabel(DEFAULT_REPORT_FIELD), text: stored }];
  return Array.isArray(stored.fields) ? stored.fields : [];
}
