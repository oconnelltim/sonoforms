# SonoForms security review: October 2026

| | |
|---|---|
| **Application** | SonoForms (structured ultrasound worksheets; Node.js, PostgreSQL, Apache, Docker) |
| **Version reviewed** | 0.1.0 (initial release) |
| **Fixes released in** | 0.2.0 |
| **Review dates** | 24–25 October 2026 |
| **Standard** | OWASP Top 10 (2021), plus OWASP ASVS checks for authentication, session management and access control |
| **Performed by** | The developer, using Claude Code (AI-assisted review and testing). This was not an independent third-party penetration test. |

## Summary

SonoForms stores protected health information, so it was reviewed against the OWASP Top 10 before any clinical deployment. The review found **5 high**, **8 medium** and **20 low-severity** issues, plus a few informational notes. One more issue turned up while the fixes were being tested.

**All high and medium issues are fixed in version 0.2.0**, as are all but two low-severity items, which are documented as accepted risks below. Every fix is covered by an automated regression test, and the original attack tests were re-run against the fixed code.

The core protections held up from the start:
- institution isolation
- role checks
- CSRF defenses
- session handling
- encryption of patient data at rest
- SQL injection resistance
- XSS resistance
- path-traversal resistance

The serious issues were about **availability** (crafted input could freeze the server), **patient safety** (loose identifier matching could link an exam to the wrong patient), **logging** (patient identifiers in URLs reached plaintext logs), and **brute-force resistance**.

| Severity | Found | Fixed | Accepted risk |
|---|---|---|---|
| High | 5 | 5 | 0 |
| Medium | 8 | 8 | 0 |
| Low | 20 | 18 | 2 |

## Method

1. **Three independent code reviews**, each covering part of the OWASP Top 10 and each reading the code without the author's assumptions:
   - access control and authentication (A01, A07);
   - injection, cryptography and data integrity (A02, A03, A08, A10);
   - configuration, deployment, components and logging (A04, A05, A06, A09).
2. **Live attack testing:** 63 automated probes against a throwaway instance with two institutions and a user in every role. They tried to reach another institution's data, escalate privileges, forge requests, spoof client addresses, guess passwords in parallel, traverse paths, pollute prototypes, and exhaust the server with crafted input.
3. **Verification:** every high and medium finding was reproduced before being accepted, either by a live test or by tracing the exact code path. Several were measured; the measurements are given below.
4. **Remediation and re-testing:**
   - Each fix has a regression test in `test/security.test.js`, 21 tests in all.
   - The full suite (30 tests) passes.
   - The original probes were re-run.
   - The database upgrade was exercised on data written by version 0.1.0.

Severity reflects impact in a hospital deployment and how easily an attacker could exploit it. "Technologist", "tech manager", "radiologist", "administrator" and "superuser" are the app's roles.

## Findings and fixes

### High

**H1. Any technologist could freeze the server** · A04 Insecure Design (resource exhaustion)
- *Issue:* the routine that tidies generated report text used regular expressions that slow down quadratically on long runs of unusual whitespace (e.g. non-breaking spaces). Submitted answers also had no size limit beyond the 2 MB request cap.
- *Impact:* one request with a crafted free-text answer could block the single-threaded server. Measured: 1.9 s at 40,000 characters, about 20 minutes at 2 MB. Every user would be locked out meanwhile.
- *Fix:* linear-time text cleanup and template scanning, plus server-side limits on answers: key names, nesting depth, 10,000 characters per text value, 256 KB in total. Browser inputs also carry length limits.
- *Test:* a 200,000-character answer renders in well under a second; oversized and malformed answers are rejected.

**H2. A tech manager could freeze the server with a form definition** · A04 (regular-expression denial of service)
- *Issue:* a form's `study_match` list accepted regular expressions, which the server evaluated against every PACS study on every worklist refresh.
- *Impact:* a catastrophic pattern froze the server. Measured: 17 seconds for one worklist request, repeating on every refresh.
- *Fix:* regular expressions are no longer supported in `study_match`. Matching uses whole words only, the linter rejects regex entries, and study descriptions are length-limited. The one starter form that used a regex was converted to words.
- *Test:* a catastrophic pattern is rejected by the linter and never executed.

**H3. Loose identifier matching could link an exam to the wrong patient** · A04 / patient safety
- *Issue:* lookups for study UIDs, accession numbers and MRNs ignored all punctuation. So `1.2.3.12.345` matched `1.2.3.123.45`, and MRN `12-345` matched `1234-5`. MRN matching also ignored the issuing authority.
- *Impact:* a technologist could be sent to another patient's existing exam and document in it. A PACS refresh could overwrite one patient's demographics with another's. Two real patients could be merged.
- *Fix:*
  - Identifiers now match exactly (only surrounding whitespace is ignored), and the MRN key includes the issuer.
  - All search indexes are scoped per institution.
  - A database migration recomputes every index; it was tested on data from 0.1.0.
  - Concurrent "start exam" clicks on the same study now return the same exam instead of an error.
- *Test:* the collision examples above now produce different keys; name search stays forgiving.

**H4. Patient identifiers reached plaintext logs** · A09 Logging failures
- *Issue:* patient search sent the MRN and last name in the URL. Apache's default access log records full URLs, and container logs were never rotated.
- *Impact:* identifiers sat in plaintext logs readable by anyone with log access, outside the encrypted database.
- *Fix:*
  - Patient search now sends a POST body.
  - The Apache access log records paths without query strings, and the image's default log is disabled.
  - Container logs are size-limited and rotated.
- *Test:* the old URL form no longer exists; search works through POST.

**H5. Brute-force protection could be bypassed** · A07 Authentication failures
- *Issue 1 (race):* failed sign-ins were counted *after* the slow password check. Measured: 40 simultaneous wrong passwords counted as **one** failure, and the account never locked.
- *Issue 2 (address spoofing):* the app trusted every `X-Forwarded-For` entry, so a client could claim any IP address. That defeated the per-address limit and wrote forged addresses into the audit log.
- *Fix:*
  - Attempts are counted in the database **before** the password check, in a single atomic statement.
  - The app trusts forwarded addresses only from Apache's internal network.
  - Apache discards any client-supplied `X-Forwarded-For`.
- *Test:* 30 parallel guesses get at most 5 password checks; client-supplied forwarding entries are ignored.

### Medium

**M6. A malicious form could make calculations grow exponentially** · A04
- *Issue:* calculated fields that each combine the previous one could double in size at every step. The linter didn't catch it.
- *Impact:* the server and every browser opening the form could hang or run out of memory.
- *Fix:* evaluation has a size budget covering list sizes, string lengths and nesting depth, and the parser has a nesting limit. Decimal places are clamped.
- *Test:* a 40-step doubling chain completes in milliseconds.

**M7. Removing a user from an institution didn't take effect until their session ended** · A01 Broken access control
- *Impact:* a technologist removed from an institution kept searching and creating patients there for up to 12 hours.
- *Fix:* institution membership is re-checked on every request.
- *Test:* access stops on the next request after removal.

**M8. Administrators could give themselves access to patient data** · A01
- *Issue:* administrators automatically had every institution. They could also add a clinical role to their own account.
- *Fix:*
  - Clinical access follows institution assignments for everyone except superusers.
  - Administrators can't change their own roles or institutions; another administrator must.
- *Note:* administrators remain trusted for account management. They can still create accounts and reset passwords. These actions are audited, and a user whose password is reset is signed out and notices.
- *Test:* self-escalation is refused; an administrator with a clinical role still can't open an unassigned institution's exams.

**M9. Anyone could lock any account, and lockouts revealed which accounts exist** · A07
- *Issue:* five wrong passwords locked an account for everyone, so an attacker could keep administrators locked out indefinitely. A locked account returned a different error than an unknown username.
- *Fix:*
  - Throttling is per username *and* computer, with growing pauses (1, 2, 4… minutes, up to a configurable maximum of at most 60).
  - A ceiling across all computers stops distributed guessing.
  - Unknown usernames get identical responses.
  - Administrators can unlock an account in the UI or with `./manage.sh unlock`.
- *Test:* a throttled real account and an unknown username give identical responses; the real user can still sign in from their own computer while the attacker's is paused.

**M10. Important events weren't audited** · A09
- *Missing:* permission and CSRF failures, attempts to open other institutions' records, edits to exam answers and findings, worklist views, command-line backups, institution switches.
- *Also:* an audit-write failure left no trace.
- *Fix:* all of these are now audited. Autosaves and worklist refreshes are recorded at most once per 15 minutes per person and record. If an audit write fails, the event goes to the server log and the request fails.
- *Test:* permission failures appear in the audit log.

**M11. The audit log's tamper-evidence could be defeated** · A08 / A09
- *Issue:* the app's database account owned the audit table, so it could disable the append-only triggers. The hash chain was unkeyed, so anyone with database access could rewrite entries and recompute it. Deleting the newest entries was undetectable.
- *Fix:*
  - **Least-privilege database access.** A one-off `migrate` container applies schema changes as the owner. The long-running app connects as a restricted role that may only *insert* audit entries, and it never receives the owner password.
  - **Keyed chain.** The hash chain uses an HMAC keyed from the master key.
  - **Anchor.** An encrypted record of the last verified entry detects truncation.
  - **Nightly check.** The chain is verified nightly and its head is written to the server log as an external reference.
- *Test:* the app role gets "permission denied" on changes; a forged entry and deleted recent entries are both detected.

**M12. Base images never received security updates** · A06 Vulnerable components
- *Issue:* updates rebuilt from cached images, and image tags floated.
- *Fix:* `install.sh` and `./manage.sh update` pull fresh base images. Dependabot proposes npm, Docker and CI updates weekly.

**M13. Self-signed certificate by default** · A02 / A05
- *Issue:* low-skill installs would keep the generated certificate, training staff to click through browser warnings, which enables interception.
- *Fix:* the installer asks for the hospital's certificate and prints the certificate fingerprint for verification, and `./manage.sh cert-fingerprint` shows it later. The documentation explains the risk.

### Low

| # | Issue | Fix |
|---|---|---|
| L14 | Administrators could sign out and unlock superusers; the last superuser could remove their own role | Superuser accounts are managed only by superusers; the last superuser is protected |
| L15 | Failed sign-ins recorded the typed username, possibly a password typed in the wrong box | The username is recorded only if it belongs to a real account; throttling keys are keyed hashes |
| L16 | Decryption accepted truncated authentication tags; encrypted values weren't bound to their row | 16-byte tags and 12-byte IVs enforced; every value bound to table, column and row id (existing data migrated) |
| L17 | Backup lines could be spliced from one backup into another; the header was unauthenticated | Random per-backup id bound into every line; header hash in the end marker; restore checks column names |
| L18 | A PACS reply to a by-UID query wasn't checked against the requested study; admin "Test query" results leaked into the live worklist cache | Only an exact UID match is accepted; ad-hoc tests bypass the cache |
| L19 | Malformed ids in URLs caused server errors | They return 404 |
| L20 | A failed nightly backup wasn't retried; manual backups were rotated away; partial files were left behind | Retried every 15 minutes until done; only automatic backups rotate; partial files cleaned; failures audited |
| L21 | The Apache container ran as root without hardening | Unprivileged user on ports 8443/8080, read-only filesystem, all capabilities dropped |
| L22 | No TLS cipher list was set | Mozilla "intermediate" profile |
| L23 | The HTTP-to-HTTPS redirect broke on non-standard ports | It redirects to the configured name and port |
| L24 | `install.sh` broke on some server names and could leave a half-written `.env` | Names validated; `.env` written atomically |
| L25 | The first admin password stayed in container logs and on disk | No longer logged; scrubbed from disk after the installer shows it |
| L27 | Temporary passwords never expired (~22 bits of randomness) | Expire after 72 hours; ~28 bits; sign-in throttled |
| L28 | Signing in kept the browser's old session; lowering the session limit didn't affect existing sessions; password changes weren't throttled; the CSRF comparison wasn't constant-time | All fixed; `__Host-` cookie prefix added |
| L29 | Sign-in and sign-out had no cross-site checks; plain-text request bodies were accepted | Browser cross-site markers (`Sec-Fetch-Site`, `Origin`) are refused; only JSON bodies accepted |
| L30 | CI actions weren't pinned to exact versions, and the workflow had default permissions | Pinned to commit hashes, read-only permissions, Dependabot |
| L31 | The last-name index was shared across institutions, allowing cross-institution linking in a database dump | Per-institution indexes. Remaining plaintext metadata is documented (see accepted risks) |
| L33 | Reserved field ids (`__proto__`, `constructor`), huge `decimals` values, quadratic scanning of unclosed `{{`, unbounded form sources | Reserved ids rejected, decimals clamped, linear scanning, 200 KB source limit |

### Found during remediation

**Forwarded client addresses were silently ignored.** Fastify 5.12 deliberately refuses numeric hop counts for its `trustProxy` setting. The first fix for H5 used one, so Docker installs would have logged Apache's address for every user. The regression test caught this before release. The final fix trusts Apache's network address range, which is configurable as `PROXY_SUBNET`.

### Accepted risks

| # | Risk | Rationale and mitigation |
|---|---|---|
| L26 | The app container's outbound traffic isn't restricted at the network level | The app opens no connections except to the configured PACS, and the browser CSP blocks other sites. docs/ADMIN.md gives a firewall rule that limits containers to the PACS. |
| L32 | Administrators can point PACS connection tests at any host and port | Administrator-only and audited, and the connection only speaks DICOM, so it can't send HTTP requests. Detailed errors are kept because administrators need them to troubleshoot. |
| — | Exam dates, form titles and which patient record an exam belongs to are not encrypted | A database dump reveals which kinds of exams an anonymous record had, and when, but no identities. Encrypting these would prevent worklist queries. Documented in docs/SECURITY.md. |
| — | `adm-zip` advisory reported by `npm audit` | `adm-zip` is declared by `dcmjs` but appears nowhere in its built code, and SonoForms never handles ZIP files. CI fails on any *critical* advisory. |
| — | Anyone with root on the server can read all data | The master key and owner password must be on the server for it to run. Protect the host, and use disk encryption. |

## What held up from the start

- **Institution isolation:** no cross-institution access was possible in any of 13 attempts, including pulling another site's study, searching its patients, or editing its forms.
- **Role boundaries:** all held (technologist, radiologist, tech manager, administrator).
- **CSRF:** the token is required on every state-changing request, and cookies are `HttpOnly` and `SameSite=Strict`.
- **Sessions:** they end on sign-out, password reset and deactivation, and tokens are stored only as hashes.
- **Login responses:** timing and messages don't reveal which usernames exist (apart from M9's lockout message).
- **SQL injection:** all SQL is parameterized.
- **XSS:** no HTML injection points. The UI never uses `innerHTML`, and a strict CSP blocks inline scripts.
- **Path traversal and prototype pollution:** neither is possible. YAML alias "bombs" are rejected.
- **Encryption at rest:** patient data is encrypted (AES-256-GCM, HKDF-derived keys, keyed blind indexes); no plaintext identifiers were found in the database.
- **Secrets:** handled as Docker secret files, never environment values, and excluded from images.
- **Dependencies:** pinned with a committed lockfile.

## Verification of the fixes

- **Automated tests:** 30 tests pass. They include 21 security regression tests in `test/security.test.js`, one or more per finding.
- **Re-run probes:** of the original 63, 61 now pass. The other two now behave differently by design:
  - An administrator trying to remove their own admin role is refused with `403` (the new rule against changing one's own roles) instead of `400`.
  - The per-address sign-in limit was raised from 30 to 100 attempts per 15 minutes, because guessing is now limited far more tightly per user and computer.
- **Upgrade path:** the database migrations ran on a development database created by 0.1.0. All records were re-encrypted to the new format, re-indexed, and remained readable. The mixed old/new audit chain verifies.
- **User interface:** sign-in, patient search, user administration and audit verification were checked in a browser after the changes.

### Not yet verified

**The Docker deployment.** Docker wasn't available on the review machine, so the changes to `docker-compose.yml`, the Apache image, `install.sh` and `manage.sh` were checked only by reading them. Before clinical use, install 0.2.0 on a staging server and confirm:

1. `docker compose ps` shows `db`, `app` and `web` healthy, and `migrate` exited with code 0.
2. The app's logs show no "running as the database owner" warning, and audit log entries show real workstation IP addresses.
3. `./manage.sh logs` shows access-log lines without query strings.
4. A TLS scan (e.g. `testssl.sh https://your-server`) reports only TLS 1.2/1.3 and forward-secret ciphers.
5. `./manage.sh backup`, `./manage.sh verify-audit` and a restore onto a scratch install all succeed.

### Addendum, 25 October 2026: Docker deployment verified

A full `./install.sh` run on Docker Desktop 29.9 (macOS, Apple Silicon) went through the checklist above. It found four deployment bugs, all now fixed:
- Apache failed to start (its scratch space wasn't writable by its unprivileged user).
- The installer's health check bypassed Apache, so it didn't notice.
- The self-signed certificate was marked as a certificate authority.
- Apache ignored the configured time zone.

After the fixes, everything passed:

- **Containers:** `db`, `app` and `web` running and healthy, `migrate` exited with code 0. Apache and the app run as the unprivileged installing user with read-only root filesystems.
- **Database role:** the app connects as `sonoforms_app`, which gets "permission denied" when trying to change the audit log. The app container holds only its own database password and the master key.
- **Client addresses:** the audit log records the real client address, never Apache's address or a forged `X-Forwarded-For` value.
- **Logs:** the access log records paths without query strings. A test secret sent in a query string appeared in no log.
- **TLS and headers:**
  - TLS 1.0 and 1.1 are refused by the server, and only forward-secret cipher suites are accepted on TLS 1.2. TLS 1.3 works.
  - HTTP redirects to HTTPS.
  - The HSTS, CSP and frame headers are present, and the session cookie carries the `__Host-` prefix.
- **Installer:** the initial admin password is shown once and then scrubbed from disk. The certificate fingerprint is shown at install.
- **Backup and audit:** `./manage.sh backup` and `verify-audit` succeed.
- **Restore:** a restore removed changes made after the backup, took a safety backup first, brought the app back up, and was itself audited.
- **Update:** `./manage.sh update` made a pre-update backup, pulled fresh base images, rebuilt, migrated and restarted cleanly.

Still to do on the production server: a TLS scan with the hospital's real certificate, and a test against the real PACS.

## Recommendations for operators

- Install your hospital's TLS certificate rather than the self-signed one.
- Keep an offline copy of `secrets/master_key`, and copy `backups/` off the server regularly.
- Run `./manage.sh update` at least monthly.
- Apply the outbound firewall rule from docs/ADMIN.md.
- Forward container logs to your SIEM, and occasionally record the audit chain head hash shown by **Verify integrity**.
- Consider an independent penetration test before large-scale use. This review was AI-assisted, so a fresh set of human eyes on the deployed system is worthwhile.
