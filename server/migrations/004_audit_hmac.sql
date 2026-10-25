-- SPDX-License-Identifier: GPL-3.0-or-later
-- Security review 2026-10: audit entries are now chained with an HMAC keyed
-- from the master key (hash_version 2). Earlier entries keep plain SHA-256.
ALTER TABLE audit_log ADD COLUMN hash_version smallint NOT NULL DEFAULT 1;
ALTER TABLE audit_log ALTER COLUMN hash_version SET DEFAULT 2;
