-- SPDX-License-Identifier: GPL-3.0-or-later
-- Linked studies: extra PACS studies covered by one exam's form, e.g. an
-- abdomen and an abdominal Doppler that are billed as two exams (two
-- studies, two accession numbers) but filled in and reported as one.
-- The exam's own study stays in exams.study_*; this table holds the others.
-- A study belongs to at most one active exam (checked by the app across
-- both tables; this index covers the linked side). Cancelling an exam
-- removes its links.

CREATE TABLE exam_studies (
  id             serial PRIMARY KEY,
  exam_id        integer NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  institution_id integer NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  study_uid_bidx text NOT NULL,
  accession_bidx text,
  study_enc      text NOT NULL,             -- {accession, study_uid, description, datetime, referring}
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX exam_studies_study_uid_key ON exam_studies (institution_id, study_uid_bidx);
CREATE INDEX exam_studies_exam_idx ON exam_studies (exam_id);

-- Exams for the same patient on the same day (a "visit") are offered to the
-- radiologist as one combined report.
CREATE INDEX exams_visit_idx ON exams (patient_id, institution_id, exam_date);
