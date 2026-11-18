-- SPDX-License-Identifier: GPL-3.0-or-later
-- Scanner reports: the DICOM Structured Reports (measurements) ultrasound
-- machines send when a study is done. Each waits here, unmatched, until an
-- exam with the same Study Instance UID exists; then it's linked to that exam
-- and its measurements fill in the exam's form.
--
-- The whole report is kept (encrypted), and measurements are read from it
-- each time, so parser and mapping improvements apply to reports already
-- received. Unmatched reports are deleted after a while (maintenance.js).

CREATE TABLE scanner_reports (
  id             serial PRIMARY KEY,
  institution_id integer NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  exam_id        integer REFERENCES exams(id) ON DELETE CASCADE,
  study_uid_bidx text NOT NULL,
  sop_uid_bidx   text NOT NULL,
  calling_ae     text NOT NULL,             -- the scanner that sent it
  device         text,                      -- manufacturer and model (not identifying)
  template       text,                      -- e.g. "TID 5100 · Vascular Ultrasound Procedure Report"
  report_enc     text NOT NULL,             -- the report (naturalized DICOM dataset)
  received_at    timestamptz NOT NULL DEFAULT now(),
  matched_at     timestamptz
);
-- A re-sent report (same SOP Instance UID) replaces the earlier copy.
CREATE UNIQUE INDEX scanner_reports_sop_key ON scanner_reports (institution_id, sop_uid_bidx);
CREATE INDEX scanner_reports_study_idx ON scanner_reports (institution_id, study_uid_bidx) WHERE exam_id IS NULL;
CREATE INDEX scanner_reports_exam_idx ON scanner_reports (exam_id);
