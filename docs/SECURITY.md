# Security design

SonoForms handles protected health information. This document describes how it is protected, so security and privacy officers can review it. The October 2026 OWASP review and its fixes are in [SECURITY-REVIEW-2026-10.md](SECURITY-REVIEW-2026-10.md).

## Data at rest

* **What's encrypted:** patient demographics (MRN, issuer, name, date of birth, sex), study identifiers (accession, study UID, description, referring physician), form answers, generated and edited findings, tech notes and return reasons. The app encrypts them with **AES-256-GCM** before writing them to PostgreSQL.
* **How each value is sealed:** every value gets a random 96-bit IV and a full 128-bit authentication tag. It is bound to its table, column *and row id*, so a value can't be copied into another column or another patient's record undetected.
* **Lookups without plaintext:** exact-match lookups use **blind indexes**, keyed HMAC-SHA256 values truncated to 160 bits.
  * Identifiers (MRN plus issuer, accession, study UID) must match exactly, so `1.2.3.12` and `1.2.31.2` are different studies.
  * Only last-name search ignores case, accents and punctuation; it is never used to merge records.
  * Every index is scoped to its institution, so a database dump can't link the same person across institutions.
* **Keys:** all keys (encryption, indexes, audit chain) are derived with HKDF-SHA256 from a 256-bit **master key** held outside the database, as a Docker secret file. An encrypted canary detects a wrong key at startup.
* **Not encrypted:**
  * user accounts (usernames, display names, scrypt password hashes)
  * form definitions and settings
  * the audit log, which contains no patient identifiers
  * exam dates, status, and which form an exam uses. Together these reveal, per anonymous patient record, which kind of exam happened when; see *Known limitations*.
* **Backups** are written row by row:
  * Each row is encrypted with the master key and bound to the backup's random id and its line number.
  * The end marker carries a hash of the header.
  * A restore detects truncation, reordering, lines spliced in from another backup, an altered header, or a wrong key.
* **Disk encryption:** host-level disk encryption (LUKS, BitLocker, encrypted VM storage) is still recommended as an additional layer.

## Authentication and sessions

* **Password hashing:** passwords are hashed with **scrypt** (N=32768, r=8, p=1, 16-byte salt).
* **Password policy:** configurable minimum length. Passwords containing the username, or found on a short list of common passwords, are rejected.
* **Sign-in throttling:**
  * Attempts are counted per username *and* computer, in the database, *before* the password is checked, in one atomic statement, so parallel requests can't get extra guesses.
  * After 5 failures (configurable) that computer must pause for 1 minute, then 2, 4… up to a configurable maximum. Someone guessing from their own computer can't lock the real user out of theirs.
  * A ceiling across all computers stops distributed guessing.
  * A per-IP limit applies across all usernames.
  * Unknown usernames get exactly the same responses and timing as real ones.
* **Temporary passwords:** new accounts and resets get temporary passwords (about 28 bits of randomness) that must be changed at first sign-in and **expire after 72 hours**.
* **Password changes:** the change-password form is throttled the same way. Changing a password ends the user's other sessions.
* **Session tokens:** 256-bit random tokens in `__Host-` prefixed `HttpOnly; Secure; SameSite=Strict` cookies; only their SHA-256 is stored. Signing in again replaces the browser's previous session.
* **Timeouts:** 60 minutes idle and 12 hours absolute by default. Lowering either setting applies to existing sessions.
* **CSRF:** state-changing requests require a per-session **CSRF token** header (compared in constant time) in addition to the SameSite cookie. Requests that the browser marks as cross-site (`Sec-Fetch-Site`, `Origin`) are refused, including sign-in and sign-out.

## Authorization

* **Roles:** technologist, tech manager, radiologist, administrator, superuser. Every API route checks the role on the server.
* **Institution isolation:**
  * Every patient and exam belongs to an institution.
  * Clinical access follows the user's institution assignments, for administrators too; only superusers see every institution.
  * Assignments are re-checked on every request, so removing someone takes effect immediately.
  * Requests for other institutions' records return "not found" and are audited.
* **Administrators:**
  * They can't change their own roles or institutions, so they can't grant themselves clinical access.
  * Only superusers can create, edit, reset, unlock or sign out superusers.
  * The last active superuser can't be demoted or deactivated.
  * Administrators are still trusted with account management: they can create accounts and reset passwords. Every such action is audited, and a user whose password is reset is signed out and notices at their next sign-in.

## Audit

* **Append-only:** the app's database role may only `INSERT` into `audit_log`, never update, delete or truncate it. Triggers also block changes by the owner role, except inside an explicit restore.
* **Keyed hash chain:** each entry is chained to the previous one with an **HMAC keyed from the master key**. Someone with database access alone can't rewrite entries and recompute a valid chain.
* **Anchor:** an encrypted record of the newest verified entry detects deletion of the most recent entries.
* **Verification:** the chain is checked nightly and from the UI or CLI. The head hash is written to the server log as an external reference.
* **What is logged:**
  * sign-ins, failed sign-ins and throttling
  * permission and CSRF failures, and attempts to reach other institutions' records
  * worklist and history views
  * exam open, create, edit, submit, reopen, cancel, copy, dictate and return
  * patient search, create and update
  * form changes
  * user, role, setting and institution changes, and institution switches
  * PACS tests
  * audit exports and verifications
  * backups (UI, CLI and nightly), backup failures, restores and retention purges
* **No identifiers:** patient identifiers are never written to the audit log. Failed sign-ins record the username only if it belongs to a real account.
* **Fallback:** if an audit write fails, the event is written to the server log and the request fails.

## Network

* **No internet use:** the app never contacts the internet. There are no CDNs, fonts, analytics, telemetry or update checks, and all browser assets are served locally.
* **Browser security headers:** Content-Security-Policy `default-src 'self'` with no inline scripts or styles, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, and HSTS. API responses are `Cache-Control: no-store`.
* **TLS:** Apache terminates TLS 1.2/1.3 with the Mozilla "intermediate" cipher list.
* **Container networks:**
  * Apache is on an internal network shared only with the app.
  * The database is on an internal network shared only with the app and the migrate step.
  * The app's outbound network is for DICOM to the configured PACS.
* **Client addresses:** the app trusts the client address reported in `X-Forwarded-For` only from Apache's network. Apache discards any `X-Forwarded-For` the client sends.
* **Access log:** it records paths without query strings, and nothing identifying is ever sent in a URL; patient search uses a POST body. Container logs are size-limited and rotated.
* **PACS:** the only outbound connection is DICOM C-FIND/C-ECHO to the PACS an administrator configures. Demographics for a new exam are re-queried from PACS by study UID, and only an answer for exactly that UID is accepted.

## Application hardening

* **No markup injection:** all browser rendering uses text nodes (no `innerHTML`), so patient data can't inject markup.
* **Form expressions and templates:**
  * They use a purpose-built parser with whitelisted functions (no `eval`), and lookups ignore inherited object properties.
  * Evaluation is bounded (list sizes, string lengths, nesting), so a malicious form can't exhaust CPU or memory.
  * Template scanning and cleanup are linear-time. `study_match` uses words only, with no regular expressions.
* **Input limits:** answers submitted by the browser are checked for key names, nesting depth, string length and total size. Form sources are limited to 200 KB.
* **SQL:** all SQL uses parameterized queries. Request bodies are validated against JSON schemas, and malformed ids in URLs return 404.
* **Concurrent edits:** optimistic locking (row versions) prevents silent overwrites when two people edit the same exam.
* **Least-privilege database access:** a one-off migrate container applies schema changes as the database owner. The long-running app connects as a restricted role and never receives the owner password.
* **Containers:** every SonoForms container runs as a non-root user with a read-only root filesystem, all Linux capabilities dropped, and `no-new-privileges`. Apache listens on unprivileged ports inside its container.
* **Images:** both images apply the base image's security updates (`apk upgrade`) when built. npm is removed from the app image after installing packages, so its own dependencies aren't shipped.
* **Updates and pinning:** updates rebuild from freshly pulled base images. The optional GitHub workflow (started by hand only) has its actions pinned to commit hashes.
* **Security scans:** `npm run security` runs Semgrep, Gitleaks, Hadolint, ShellCheck and Grype locally in Docker (see [Checking the code](#checking-the-code)).

## Known limitations

* **`adm-zip`:** the DICOM library's dependency `dcmjs` declares `adm-zip`, though its built code never loads it. It's pinned to a fixed version (0.6.1) with an npm override. One medium advisory (symlinks during extraction) has no fix yet; SonoForms never handles ZIP files.
* **Free text:** free-text fields (comparison, "other" descriptions, tech notes) can contain whatever the tech types, including identifiers. They are encrypted like all other answers.
* **Plaintext metadata:** exam dates, form titles and the patient each exam belongs to are not encrypted, so a database dump shows which kinds of exams an anonymous patient record had, and when.
* **Admin connection tests:** administrators can point the PACS connection tests at any host and port. The connection only speaks DICOM, and detailed errors are kept because they're needed for troubleshooting.
* **Outbound traffic:** the app container's outbound traffic isn't restricted at the network level by default. docs/ADMIN.md shows how to limit it to your PACS with a firewall rule.
* **Owner credentials:** the database owner password and master key are on the server, in `secrets/`. Anyone with root on the host can read all data. Protect the host accordingly.
* **No single sign-on:** there is no LDAP/SAML yet.

## Checking the code

All checks run on your own computer; nothing is sent to GitHub or any other service (the scanners do download their rules and vulnerability databases).

```bash
npm run check          # tests, form check, npm audit (fails on high or critical)
npm run check:linux    # the same in a clean Linux container in UTC (needs Docker)
npm run security       # security scans (needs Docker)
```

`npm run security` runs pinned versions of:

| Tool | Checks |
|---|---|
| Semgrep | the JavaScript and Dockerfiles, with the `javascript`, `nodejs`, `owasp-top-ten`, `secrets` and `dockerfile` rule packs |
| Gitleaks | the whole git history for committed secrets |
| Hadolint | the Dockerfiles |
| ShellCheck | `install.sh`, `manage.sh` and the other shell scripts |
| Grype | npm packages (from `package-lock.json`) and the built app and web images, for known vulnerabilities |

Reports are written to `reports/` (git-ignored). Add `--no-images` to skip building and scanning the Docker images. Run it before each release and after updating dependencies.

## Reporting a vulnerability

Please report security issues privately to the maintainers rather than in a public issue.
