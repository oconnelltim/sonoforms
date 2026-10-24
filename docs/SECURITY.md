# Security design

SonoForms handles protected health information. This document describes how it is protected, so security and privacy officers can review it.

## Data at rest

* Patient demographics (MRN, name, date of birth, sex), study identifiers (accession, study UID, description, referring physician), form answers, generated and edited findings, tech notes and return reasons are encrypted in the application with **AES-256-GCM** before being written to PostgreSQL. Each value has a random 96-bit IV, and the column name is bound as associated data, so a value can't be moved to another column undetected.
* Exact-match lookups (MRN, last name, accession, study UID) use **blind indexes**: HMAC-SHA256 with a separate derived key, truncated to 160 bits.
* Both keys are derived with HKDF-SHA256 from a 256-bit **master key** held outside the database (a Docker secret file). An encrypted canary detects a wrong key at startup.
* Not encrypted: user accounts (usernames, display names, scrypt password hashes), form definitions, the audit log (which contains no patient identifiers), settings, and exam dates and status.
* **Backups** are written row by row, each row encrypted with the master key and bound to its line number. Truncation, reordering or a wrong key is detected on restore.
* Host-level disk encryption (LUKS, BitLocker, encrypted VM storage) is still recommended as an additional layer.

## Authentication and sessions

* Passwords are hashed with **scrypt** (N=32768, r=8, p=1, 16-byte salt). Configurable minimum length; passwords containing the username are rejected.
* Accounts lock after repeated failures (default 5 attempts, 15 minutes), with an additional per-IP limit. Unknown usernames take the same time to fail as wrong passwords.
* New accounts and resets use temporary passwords that must be changed at first sign-in. Changing a password ends the user's other sessions.
* Sessions are 256-bit random tokens in `HttpOnly; Secure; SameSite=Strict` cookies; only their SHA-256 is stored. Default timeouts are 60 minutes idle and 12 hours absolute.
* State-changing requests require a per-session **CSRF token** header as well as the SameSite cookie.

## Authorization

* Roles: technologist, tech manager, radiologist, administrator, superuser. Checked on every API route on the server.
* Institution isolation: every patient and exam belongs to an institution, and users can reach only the institutions assigned to them. Requests for other institutions' records return "not found".
* Administrators manage the system but have no access to patient records unless also given a clinical role.

## Audit

* An append-only `audit_log` table. Database triggers reject UPDATE, DELETE and TRUNCATE.
* A SHA-256 hash chain links every entry to the previous one, verifiable in the UI or CLI.
* Logged: sign-in and sign-out, failed sign-ins, lockouts, exam view, create, submit, reopen, cancel, copy, dictate and return, patient search, create and update, form changes, user, role and setting changes, PACS tests, audit exports and verifications, backups, restores, and retention purges.

## Network

* The app never contacts the internet: no CDNs, fonts, analytics, telemetry or update checks. All browser assets are served locally.
* Content-Security-Policy `default-src 'self'` with no inline scripts or styles, plus `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, and HSTS over HTTPS. API responses are `Cache-Control: no-store`.
* Apache terminates TLS (1.2 and 1.3 only). The app and database containers publish no ports. The database is on an internal-only Docker network.
* The only outbound connection is DICOM C-FIND/C-ECHO to the PACS configured by an administrator. Demographics used to create an exam are re-queried from PACS by study UID, not taken from the browser.

## Application hardening

* All browser rendering uses text nodes (no `innerHTML`), so patient data cannot inject markup.
* Form expressions and templates use a purpose-built parser with whitelisted functions (no `eval`), and lookups ignore inherited object properties.
* All SQL uses parameterized queries. Request bodies are validated against JSON schemas.
* Optimistic locking (row versions) prevents silent overwrites when two people edit the same exam.
* Containers run as non-root with `no-new-privileges`. The app container has a read-only root filesystem and drops all Linux capabilities.

## Known limitations

* `npm audit` reports an advisory in `adm-zip`, pulled in by the DICOM library (`dcmjs`). SonoForms never processes ZIP files, so the vulnerable code path is not reachable. We will update when the upstream dependency does.
* Free-text fields (comparison, "other" descriptions, tech notes) can contain whatever the tech types, including identifiers. They are encrypted like all other answers.
* There is no single sign-on (LDAP/SAML) yet.

## Reporting a vulnerability

Please report security issues privately to the maintainers rather than in a public issue.
