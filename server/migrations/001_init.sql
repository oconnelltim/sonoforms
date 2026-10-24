-- SPDX-License-Identifier: GPL-3.0-or-later
-- Initial schema. Columns ending in _enc hold AES-256-GCM ciphertext
-- (see server/crypto.js); columns ending in _bidx hold blind indexes.

CREATE TABLE institutions (
  id            serial PRIMARY KEY,
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  -- PACS query settings: { enabled, host, port, called_ae, calling_ae, modality, filters: {Tag: value} }
  dicom         jsonb NOT NULL DEFAULT '{}',
  settings      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                   serial PRIMARY KEY,
  username             text NOT NULL,
  display_name         text NOT NULL,
  password_hash        text NOT NULL,
  roles                text[] NOT NULL DEFAULT '{}',
  active               boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  failed_logins        integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  password_changed_at  timestamptz,
  preferences          jsonb NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

CREATE TABLE user_institutions (
  user_id        integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  institution_id integer NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, institution_id)
);

CREATE TABLE sessions (
  id             text PRIMARY KEY,           -- sha256 of the cookie token
  user_id        integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token     text NOT NULL,
  institution_id integer REFERENCES institutions(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  ip             text,
  user_agent     text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Forms with institution_id NULL belong to the shared "general" library.
CREATE TABLE forms (
  id                 serial PRIMARY KEY,
  institution_id     integer REFERENCES institutions(id) ON DELETE CASCADE,
  slug               text NOT NULL,
  title              text NOT NULL,
  active             boolean NOT NULL DEFAULT true,
  current_version_id integer,
  copied_from_id     integer REFERENCES forms(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX forms_slug_key ON forms (COALESCE(institution_id, 0), slug);

CREATE TABLE form_versions (
  id           serial PRIMARY KEY,
  form_id      integer NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  status       text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  source       text NOT NULL,                -- YAML as written by the author
  definition   jsonb NOT NULL,               -- normalized definition
  notes        text,
  created_by   integer REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_by integer REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz,
  UNIQUE (form_id, version)
);
CREATE UNIQUE INDEX form_versions_one_draft ON form_versions (form_id) WHERE status = 'draft';
ALTER TABLE forms ADD CONSTRAINT forms_current_version_fk FOREIGN KEY (current_version_id) REFERENCES form_versions(id)
  ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE;

-- Lets an institution hide general-library forms it doesn't use.
CREATE TABLE institution_forms (
  institution_id integer NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  form_id        integer NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  enabled        boolean NOT NULL DEFAULT true,
  PRIMARY KEY (institution_id, form_id)
);

CREATE TABLE patients (
  id               serial PRIMARY KEY,
  institution_id   integer NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  mrn_bidx         text NOT NULL,
  last_name_bidx   text,
  demographics_enc text NOT NULL,            -- {mrn, last_name, first_name, dob, sex}
  created_by       integer REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, mrn_bidx)
);
CREATE INDEX patients_last_name_idx ON patients (institution_id, last_name_bidx);

CREATE TABLE exams (
  id                 serial PRIMARY KEY,
  institution_id     integer NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  patient_id         integer NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  form_version_id    integer REFERENCES form_versions(id) ON DELETE RESTRICT,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'returned', 'dictated', 'cancelled')),
  source             text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'pacs', 'hl7')),
  exam_date          date NOT NULL DEFAULT CURRENT_DATE,
  study_uid_bidx     text,
  accession_bidx     text,
  study_enc          text,                   -- {accession, study_uid, description, datetime, referring}
  answers_enc        text,
  report_enc         text,                   -- generated at submit
  final_report_enc   text,                   -- edited by the radiologist
  tech_note_enc      text,                   -- free-text note from tech to radiologist
  return_reason_enc  text,
  tech_id            integer REFERENCES users(id) ON DELETE SET NULL,
  rad_id             integer REFERENCES users(id) ON DELETE SET NULL,
  submitted_at       timestamptz,
  dictated_at        timestamptz,
  row_version        integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exams_worklist_idx ON exams (institution_id, status, exam_date);
CREATE INDEX exams_patient_idx ON exams (patient_id);
CREATE UNIQUE INDEX exams_study_uid_key ON exams (institution_id, study_uid_bidx)
  WHERE study_uid_bidx IS NOT NULL AND status <> 'cancelled';

-- Append-only audit trail. Each row's hash covers the previous row's hash,
-- so any edit or deletion breaks the chain (checked in Admin > Audit log).
CREATE TABLE audit_log (
  id             bigserial PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  user_id        integer,
  username       text,
  institution_id integer,
  action         text NOT NULL,
  entity_type    text,
  entity_id      text,
  details        jsonb,
  ip             text,
  prev_hash      text,
  hash           text NOT NULL
);
CREATE INDEX audit_log_at_idx ON audit_log (at);
CREATE INDEX audit_log_user_idx ON audit_log (user_id, at);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);

CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by integer REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
