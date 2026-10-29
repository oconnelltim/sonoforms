# Changelog

All notable changes to SonoForms are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). While the version is below 1.0, minor versions may include changes that need action when upgrading; these are listed under **Upgrading**.

## [Unreleased]

### Added

- **Software bill of materials:** `npm run sbom` writes CycloneDX and SPDX SBOMs for the app and web images and for the npm dependency tree, to attach to releases or give to hospital IT. See "Software bill of materials" in [docs/SECURITY.md](docs/SECURITY.md).

- **Hospital reverse proxy support.** SonoForms can sit behind the hospital's existing reverse proxy or load balancer, which then holds the hospital certificate. Set `UPSTREAM_PROXY` in `.env` to the proxy's address(es) or range; Apache then records each workstation's real address from that proxy's `X-Forwarded-For` (for the audit log and per-computer sign-in throttling), and ignores the header from any other computer. Setup steps are in [docs/ADMIN.md › Behind a hospital reverse proxy](docs/ADMIN.md#behind-a-hospital-reverse-proxy). Existing installs are unaffected unless the setting is added.

### Changed

- Apache's access log records the client address Apache settled on (`%a`), which is the forwarded workstation address behind a trusted proxy.

- The October 2026 security review ([docs/SECURITY-REVIEW-2026-10.md](docs/SECURITY-REVIEW-2026-10.md)) is brought up to date: the Docker deployment verification is folded into the main text (it no longer reads as unverified), the Dependabot and `adm-zip` notes reflect the current setup, and a new section records the automated scan findings and fixes from 0.3.0 and 0.3.1.

## [0.3.1] - 2026-10-28

Runs on Node.js 26 (long-term support), with a clean dependency audit, and adds a pilot checklist for hospitals.

### Upgrading

- **Node.js 26.** SonoForms now runs on Node.js 26, the current long-term-support version (Node.js 22 reaches end of life in April 2027). Docker installs get it automatically with `./manage.sh update`. Installs without Docker, and development machines, need Node.js 26 (`nvm install 26`).

### Added

- **Pilot checklist** ([docs/PILOT.md](docs/PILOT.md)): people, approvals, server, PACS, forms review, dictation, backups and a restore drill, training, and how to run and measure a departmental pilot.

### Changed

- The app image is built on `node:26-alpine`; `npm run check:linux` and the optional GitHub workflow use Node 26 too.

### Security

- `dcmjs` (used by the DICOM library) is pinned to 0.52.2, which fixes a low-severity advisory about lax validation of two numeric DICOM value types. `npm audit` now reports no vulnerabilities.

## [0.3.0] - 2026-10-25

The visual form builder, reports split into dictation fields, multipart studies (linked studies and combined visit reports), early pregnancy and salivary gland starter forms, and local security scans.

### Upgrading

Docker installs: run `./manage.sh update`. The database change (a table for linked studies) is applied automatically. Then:

- **Starter forms already in your general library are not updated automatically**, because admins may have edited them. Until they are replaced, their Indication and Comparison lines stay inside the Findings card, and they have no combined-report heading. Run `./manage.sh update-forms` to see what would change, then `./manage.sh update-forms --apply`. Forms edited in the app are skipped unless you add `--force`. The new early pregnancy and salivary gland forms are added by the same command (or automatically on start-up).
- **Have your radiologists review** the new starter forms and the combined-report headings before clinical use.
- **API changes** (only matters if something else calls the API): reports are stored and edited per report field; see *Changed* below.

### Added

- **Visual form builder.** Tech managers can edit forms without writing YAML:
  - An outline of sections and questions, with drag-to-reorder and problem markers.
  - Plain-language settings for each question, with friendly answer-type names and a choices table (button text, report text, normal answer, points).
  - "Show only when" rules built from drop-downs.
  - Recipes for calculated fields (ellipsoid volume, correction factor, points total, TI-RADS level, ratio).
  - Report-text editing with insertable answer chips, "If… otherwise…" blocks, a "Start from the fields" first draft, and a live preview line.
  - Clicking a question in the tech-form preview selects it in the builder.
  - Safe renaming that updates every reference, and warnings before deleting something other parts depend on.
  - The builder edits the same YAML as the Source tab, keeping comments and formatting: an edit changes only the lines it touches.
- **Report fields.** A report is now split into the fields dictation templates use (Indication, Comparison, Technique, Findings, Impression):
  - Radiologists see one card per field, each with its own Copy button (Ctrl+Shift+1, 2, 3… copies the first, second, third card), a "Copied" mark and "Reset to generated". Edits are saved per field. *Copy all as one block* is still there, with a heading per field. *Mark dictated* is highlighted once every card has been copied.
  - Forms say where each section's text goes with `report_field:`, or give `report:` one entry per field. In the builder, pick *Goes into the report's … field*, or add *Text for another report field*. See "Report fields" in [docs/FORMS.md](docs/FORMS.md).
  - The starter forms send their clinical section to Indication and Comparison, and the pelvis technique section to Technique.
  - Copying a card is recorded in the audit log with the field copied.
- **Multipart studies:**
  - **Linked studies.** One form can cover several PACS studies, for an exam billed as two (e.g. an abdomen and an abdominal Doppler). When a tech starts a form, the patient's other studies today are offered, with likely ones ticked. A linked study shows as "Covered" on the worklist and opens the same form. *Change studies covered…* on the form edits the list. Cancelling a form frees its studies.
  - **Combined reports.** Exams for one patient on the same day (e.g. an abdomen and a DVT study) are one row on the reading worklist and are reported together by default: one set of cards, with a heading per exam in Findings and Impression, shared Indication, Technique and Comparison, and every accession number listed. *Mark dictated* marks them all; *Move back to worklist* moves them back together; *Report separately* splits them. The radiologist is told if another exam for the patient is still with the tech.
  - **Next study.** After submitting, the tech is offered the patient's next study that has no form yet.
  - Forms have a `report.heading` (a template, e.g. `ULTRASOUND {{side | upper}} VENOUS DOPPLER`) for combined reports, set in the builder under Form settings. The starter forms have one.
  - API: `GET /api/exams/:id/related-studies`, `PUT /api/exams/:id/studies`, `GET /api/exams/:id/visit`, `POST /api/exams/:id/dictated-group`; `POST /api/exams` takes `linked_study_uids`, and `PUT /api/exams/:id/report` takes `combined_with`.
- **Salivary glands starter form** (`us-salivary`): parotid and submandibular glands per side (echotexture, vascularity, ducts, calculi, intraparotid nodes), masses as a repeating group, and cervical lymph nodes.
- **Early pregnancy starter form** (`us-early-ob`): first-trimester ultrasound for rule out ectopic, pain or bleeding, viability and dating. It drafts the Impression: live intrauterine pregnancy with gestational age; SRU criteria for pregnancy failure (definite and suspicious, with follow-up advice); pregnancy of unknown location; adnexal findings suspicious for ectopic or heterotopic pregnancy; cesarean scar, cervical and interstitial locations; and possible hemoperitoneum. For a live embryo it gives gestational age by CRL and LMP, and an estimated date of delivery, redating by ultrasound per ACOG. As with every starter form, have your radiologists review the wording before clinical use.
- **Form functions for early pregnancy:** `crl_ga` (Robinson & Fleming, or Hadlock), `msd_ga`, `ga_text`, `edd_from_lmp`, `edd_from_ga`, `redate_by_us` and `add_days`. Calculated dates print as MM/DD/YYYY.
- **`update-general-forms` command** (`./manage.sh update-forms`): lists starter forms with newer versions and, with `--apply`, publishes them as each form's next version. Forms edited in the app or with an unpublished draft are left alone (`--force` replaces edited ones), institution copies are never touched, and each update is audited.
- **Form editor:** undo and redo, and automatic draft saving (the "Save draft" button is gone; Ctrl+S still saves immediately). Leaving the editor saves pending changes instead of discarding them.
- **PACS query guardrails:**
  - Worklist queries stop at a per-institution maximum (default 500, settable from 50 to 2000). The app asks PACS to cancel the rest and disconnects if PACS ignores the cancel. Technologists and the admin "Test query" are told when the list was cut short.
  - A worklist query must be narrowed by a modality or by an institution filter that PACS applies. Admin › Institutions refuses to save a configuration without one, and the server refuses to run it.
  - Simultaneous worklist loads at an institution share one PACS query, and the **Refresh** button reuses a result less than 10 seconds old.
- **Per-institution PACS compatibility settings:** which attribute carries the modality (Modalities in Study, or Modality), and whether PACS accepts date ranges or needs one query per day.

### Changed

- **Checks run locally.** `npm run check` (tests, form check, npm audit), `npm run check:linux` (the same in a clean Linux container) and `npm run security` (Semgrep, Gitleaks, Hadolint, ShellCheck and Grype, in Docker). The GitHub workflow now runs only when started by hand, and the Dependabot configuration was removed.
- **Docker images:** both apply Alpine security updates when built; npm is removed from the app image after installing packages; the Apache image runs as `www-data` by default; the app health check no longer uses `wget`.
- `adm-zip` (an unused dependency of the DICOM library) is pinned to 0.6.1, which fixes its high-severity advisories. `npm run check` fails on high as well as critical advisories.
- The logo is now a small ultrasound probe, in the header, on the sign-in page and as the browser tab icon.
- **API:** `PUT /api/exams/:id/report` and `POST /api/exams/:id/dictated` take `fields` (an object of edited text per report field, or `null`) instead of a single `report` string. `POST /api/exams/:id/copied` takes `field`. Exams store their report as `{ fields: [...] }`; reports saved before this change still display, as one Findings card.
- A study lookup by UID never sends a blank UID (which would match every study) and fetches at most a handful of results.
- Automatic backup file names use local time, like manual backups.
- The starter forms were respaced to one consistent YAML style, so builder edits produce minimal changes. Only spacing inside `[ ]` lists changed.

### Fixed

- A test failed on machines set to UTC late in the day: the fake PACS's studies could fall on the previous day, splitting a patient's visit. Fake studies are now always dated today.
- The tech worklist showed a date under today's studies in the evening (it compared against the UTC date), and the form editor's preview used the UTC date as the exam date.
- **Form editor layout:**
  - Hidden on/off-switch checkboxes in the tech-form preview escaped their scrolling pane and stretched the whole page.
  - The editor's panes now always fill the window and scroll independently in every browser (previously the Source box could be only a few lines tall, and the builder could fail to scroll on its own).
  - Below 1100 px wide, the builder took only part of the width.
  - The builder's outline and settings panel now have proper spacing from the window edge.

Found by the first full Docker install test of 0.2.0:
- **Apache crash at startup:** it couldn't write its PID file, because the container's scratch areas were writable only by root and Apache now runs unprivileged.
- **Installer health check:** it checked the app directly, so it reported success even when Apache was down. It now checks the full HTTPS path through Apache.
- **Self-signed certificate:** it was marked as a certificate authority rather than a server certificate (Apache warned about this).
- **Time zone:** Apache logged in UTC instead of the configured time zone.

## [0.2.0] - 2026-10-25

Security release addressing the October 2026 OWASP Top 10 review. Details of every finding, how it was tested and how it was fixed are in [docs/SECURITY-REVIEW-2026-10.md](docs/SECURITY-REVIEW-2026-10.md).

### Upgrading

Docker installs: run `./manage.sh update`. It creates the one new secret, backs up, rebuilds and migrates. Notes:

- **New secret:** `secrets/db_app_password`, the password of the restricted database account the app now runs as. `./manage.sh update` and `./install.sh` create it automatically.
- **New container layout:**
  - A one-off `migrate` container now applies database changes before the app starts. It's the only container with the database owner password.
  - `./manage.sh` command-line tasks (backup, restore, reset-password, …) run through it.
- **Ports inside the web container:** Apache now listens on 8443/8080. Host ports are unchanged (443/80, set in `.env`).
- **`PROXY_SUBNET`:** a new `.env` setting, the address range of the internal web-to-app network (default `172.31.250.0/28`). Change it only if it clashes with addresses on your network.
- **`TRUST_PROXY`:** now takes addresses or CIDR ranges and is off by default. Hop counts such as `1` are rejected. Installs that don't use Docker should set it to their proxy's address.
- **Database migrations** run automatically. Existing records are re-encrypted and re-indexed in place, so no data is lost and no action is needed.
- **Forms using regular expressions in `study_match`** (entries like `/PELVI(S|C)/`) now fail validation and can't be published. Replace them with plain words, e.g. `PELVIS` and `PELVIC`. Existing published versions keep working, but their regex entries are ignored.
- **API change:** patient search moved from `GET /api/patients?mrn=…` to `POST /api/patients/search` with a JSON body.
- **Sessions:** the session cookie is renamed, so everyone signs in again once after the update.

### Security

Fixed:
- Server freezes:
  - Crafted free-text answers could freeze the server, because report text cleanup took quadratic time and answers had no size limits (H1).
  - A tech manager could freeze the server with a catastrophic regular expression in a form's `study_match` (H2).
  - A malicious form could make calculated fields grow exponentially (M6).
- **Wrong-patient risk:** study UIDs, accession numbers and MRNs were matched after stripping punctuation, and MRN matching ignored the issuer (H3).
- **Patient identifiers in plaintext logs:** patient search put MRNs and names in URLs, which the Apache access log recorded (H4).
- **Password guessing:** parallel sign-in attempts bypassed the lockout, and a client-supplied `X-Forwarded-For` header could spoof client IP addresses (H5).
- **Access-control gaps:**
  - Removing a user from an institution didn't take effect until their session ended (M7).
  - Administrators could grant themselves clinical roles and access to every institution (M8).
  - Administrators could sign out and unlock superusers, and the last superuser could remove their own role.
- **Lockouts:** anyone could keep any account locked out, and the lockout response revealed which usernames exist (M9).
- **Audit log:**
  - Missing events, and no fallback when an audit write failed (M10).
  - Tamper-evidence that the app's own database account could defeat (M11).
- **Base images and certificates:** base images were never refreshed on update (M12), and the installer defaulted silently to a self-signed certificate (M13).
- **Low-severity issues:**
  - truncated encryption tags were accepted, and ciphertext wasn't bound to its row
  - backup lines could be spliced between backups
  - unchecked PACS replies
  - malformed ids caused server errors
  - nightly backups weren't retried
  - the Apache container ran as root
  - no TLS cipher list was set
  - a fragile HTTP-to-HTTPS redirect
  - installer input wasn't validated
  - the initial admin password leaked into logs
  - temporary passwords never expired
  - unpinned CI actions

### Added

- **Sign-in throttling** per username and computer. Pauses double from 1 minute up to a configurable maximum. A ceiling across all computers stops distributed guessing, and unknown usernames get identical responses.
- **Least-privilege database access.** The app runs as a restricted role that can only *add* audit entries and can't change the schema.
- **Audit chain:**
  - The hash chain is keyed (HMAC) with a secret derived from the master key.
  - An encrypted anchor detects deletion of recent entries.
  - It is verified nightly, and the head hash is written to the server log.
- **New audit events:** permission and CSRF failures, attempts to open other institutions' records, exam and findings edits, worklist and history views, institution switches, CLI backups and unlocks, backup failures.
- **Expiring temporary passwords:** they now expire after 72 hours.
- **Common-password check:** common passwords are rejected.
- **Cross-site blocking:** requests that the browser marks as cross-site are refused, including sign-in and sign-out.
- **Server-side answer limits:** key names, nesting depth, text length and total size.
- **Linter checks:** reserved field ids, regular expressions in `study_match`, and a 200 KB limit on form source.
- **New `./manage.sh` commands:** `unlock USERNAME` and `cert-fingerprint`.
- **Development helper:** `npm run dev:cli` runs admin commands such as `reset-password` against the development database.
- **Installer:** asks for the hospital's TLS certificate and prints the certificate fingerprint.
- **Security regression tests:** `test/security.test.js`, 21 tests, one or more per review finding. Shared test setup is in `test/helpers.js`.
- **Dependabot:** weekly update proposals for npm packages, Docker base images and GitHub Actions.
- **Documentation:** docs/SECURITY-REVIEW-2026-10.md.

### Changed

- **Encryption:** values are bound to their table, column *and row*. Full 128-bit authentication tags are required.
- **Blind indexes:**
  - Identifiers match exactly, and the MRN key includes the issuer.
  - Indexes are scoped per institution.
  - Last-name search stays forgiving about case, accents and punctuation.
- **Clinical access** follows institution assignments for everyone except superusers, administrators included.
- **Administrators** can't change their own roles or institutions. Only superusers can manage superuser accounts, and the last active superuser is protected.
- **Lockout setting** is now a maximum pause of at most 60 minutes, replacing the fixed lockout that could be set as high as 24 hours.
- **Sessions:**
  - The cookie uses the `__Host-` prefix.
  - Signing in again replaces the browser's previous session.
  - Lowering the session time limits applies to existing sessions.
  - The CSRF token is compared in constant time.
- **Throttled password changes:** the password-change form is throttled like sign-in.
- **Backups:**
  - The format is now version 2: every line is bound to a random backup id, and the header is authenticated. Version-1 backups can still be restored.
  - Automatic backups are named `sonoforms-auto-…`, and only they are rotated. Manual, pre-update and pre-restore backups are kept.
  - A failed nightly backup is retried every 15 minutes.
- **Docker:**
  - Apache runs as an unprivileged user with a read-only filesystem and all capabilities dropped. It uses the Mozilla "intermediate" TLS profile and logs paths without query strings.
  - Container logs are rotated.
  - Internal networks are split so the database is reachable only from the app and migrate containers.
- **Updates:** `./manage.sh update` and `./install.sh` pull fresh base images.
- **CI:** actions are pinned to commit hashes, the workflow has read-only permissions, and it fails on critical `npm audit` advisories.
- **`/api/health` and `/api/public-info`** no longer report the version number.
- **docs/SECURITY.md and docs/ADMIN.md** were corrected and updated, including claims the review found inaccurate.

### Removed

- Regular-expression entries in form `study_match` lists.
- `GET /api/patients` (replaced by `POST /api/patients/search`).
- The `users.failed_logins` and `users.locked_until` columns (replaced by the `login_failures` table).

## [0.1.0] - 2026-10-24

First release.

### Added

- **Technologist workflow** (light theme):
  - Today's ultrasound worklist from PACS via study-level DICOM C-FIND, with demographics taken from PACS. Manual patient entry is also available.
  - Forms are suggested automatically from the study description.
  - Touch-friendly forms with section **Normal** buttons, required items, and automatic calculations: ellipsoid volumes, bladder, testicular (Lambert), and ACR TI-RADS.
  - Live findings preview, autosave, and submit to the radiologist.
- **Radiologist workflow** (dark theme):
  - A reading queue across the user's institutions.
  - Editable generated findings with one-click copy (CRLF or LF), and "copy & mark dictated".
  - The tech's note and a summary of entered values.
  - Return to tech with a reason, and keyboard shortcuts.
- **Forms management:**
  - A three-pane editor: YAML source, a live fillable tech-form preview, and live findings.
  - A linter.
  - Versioning with draft and publish, and version history.
  - Export and import.
  - A general library shared by all institutions, with per-institution copies and an on/off switch for each institution.
- **Form engine** shared by browser and server: a safe expression language with no `eval`, report templates with conditionals and loops, choice, multi-select, number, measurement, calculated, date and repeat fields, and conditional visibility.
- **Starter form library:** female pelvis, thyroid (ACR TI-RADS), complete abdomen, RUQ, renal/bladder (with prostate volume), scrotum, and lower-extremity venous duplex. These need radiologist review before clinical use.
- **Multi-institution support:** separate worklists, patients, forms and PACS settings per institution, with users assigned to institutions.
- **Administration:**
  - Users and roles (technologist, tech manager, radiologist, administrator, superuser).
  - Institutions and PACS settings, with connection and query tests.
  - Audit log with search, CSV export and integrity check.
  - Settings, backups and system status.
- **Security:**
  - Encryption of patient data at rest (AES-256-GCM) with blind indexes for lookups.
  - scrypt password hashing, forced first-login password change and account lockout.
  - `HttpOnly`/`SameSite=Strict` session cookies and CSRF tokens.
  - A strict Content Security Policy.
  - An append-only, hash-chained audit log.
  - No external network calls apart from PACS.
- **Deployment:**
  - Docker Compose (PostgreSQL, Node.js app, Apache HTTPS proxy).
  - `install.sh` for first-time setup and `manage.sh` for day-to-day tasks.
  - Encrypted nightly backups and restore.
  - Automatic database migrations.
  - Optional data retention.
- **Development:** `npm run dev` with an embedded PostgreSQL and a fake PACS worklist; `npm run mock-pacs` for testing real DICOM queries.
- **Documentation:** README, docs/ADMIN.md, docs/FORMS.md, docs/SECURITY.md.

[Unreleased]: https://github.com/oconnelltim/sonoforms/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/oconnelltim/sonoforms/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/oconnelltim/sonoforms/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/oconnelltim/sonoforms/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/oconnelltim/sonoforms/releases/tag/v0.1.0
