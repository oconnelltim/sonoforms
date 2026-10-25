-- SPDX-License-Identifier: GPL-3.0-or-later
-- Security review 2026-10: sign-in throttling per (username, computer)
-- replaces the per-account hard lockout, which anyone could trigger and
-- which parallel requests could bypass. `key` is a keyed hash of the
-- typed username, so mistyped passwords in the username box aren't stored.

CREATE TABLE login_failures (
  key            text NOT NULL,
  ip             text NOT NULL,
  failures       integer NOT NULL DEFAULT 0,
  last_failed_at timestamptz NOT NULL DEFAULT now(),
  locked_until   timestamptz,
  PRIMARY KEY (key, ip)
);
CREATE INDEX login_failures_recent_idx ON login_failures (key, last_failed_at);

ALTER TABLE users DROP COLUMN failed_logins;
ALTER TABLE users DROP COLUMN locked_until;
ALTER TABLE users ADD COLUMN temp_password_expires_at timestamptz;
