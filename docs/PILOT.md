# Pilot checklist

A checklist for trying SonoForms in one ultrasound department before wider use. Tick items off as you go. Details for each step are in [ADMIN.md](ADMIN.md), [FORMS.md](FORMS.md) and [SECURITY.md](SECURITY.md).

## 1. People

- [ ] **Clinical lead** (a radiologist) to approve form wording and the go-live decision.
- [ ] **Lead technologist** to review and edit forms in the builder, and to train the techs.
- [ ] **IT contact** for the server, network, certificate and backups.
- [ ] **PACS administrator** to add SonoForms as a query client.
- [ ] **Privacy or security office**, if your hospital requires a review for new clinical software.

## 2. Approvals

- [ ] Share [SECURITY.md](SECURITY.md) and [SECURITY-REVIEW-2026-10.md](SECURITY-REVIEW-2026-10.md) with the privacy and security office. Key points:
  - SonoForms runs on a hospital server and sends no data off the network: no cloud services, telemetry or update checks.
  - Patient data is encrypted at rest.
  - Every access is recorded in a tamper-evident audit log.
- [ ] Complete any privacy impact assessment or change-management form your hospital requires.
- [ ] Agree how long data is kept: **Admin › Settings › Delete dictated exams after (days)**. By default, nothing is deleted.

## 3. Server

- [ ] A Linux VM with Docker and Docker Compose v2. 2 CPUs, 4 GB of memory and 40 GB of disk is a reasonable start for one department.
- [ ] An internal DNS name (e.g. `sonoforms.hospital.local`) and a **TLS certificate from the hospital CA**. The self-signed certificate is only for testing; see [ADMIN.md › HTTPS certificate](ADMIN.md#https-certificate).
- [ ] **Firewall:**
  - Inbound: HTTPS (443) from the hospital network only.
  - Outbound: the PACS host and port only. The rules are in [ADMIN.md › Network and privacy](ADMIN.md#network-and-privacy).
- [ ] The server's time zone (`TZ` in `.env`) and clock (NTP) are correct. "Today's" worklist depends on them.

## 4. Install

- [ ] Run `./install.sh`. Sign in as `admin` and choose a new password.
- [ ] **Store `secrets/master_key` in two safe places off the server**, e.g. the hospital password vault and a sealed offline copy. Without it, neither the data nor the backups can be decrypted.
- [ ] Rename the institution in **Admin › Institutions**.
- [ ] Create accounts in **Admin › Users** for each person in the pilot, with the right roles. (Active Directory sign-in comes later.)

## 5. PACS

- [ ] The PACS administrator adds SonoForms as a **C-FIND query client**, using our AE title (default `SONOFORMS`) and the server's IP address. SonoForms only queries: it never retrieves images or writes to PACS.
- [ ] Enter the PACS host, port and AE title in **Admin › Institutions › Edit**. Run **Test connection**, then **Test query**.
- [ ] Check that the test query shows only your site's ultrasound studies. Add an institution filter if it doesn't.
- [ ] Check that each common study description suggests the right form. If not, add the description's words to the form's *Study descriptions that pick this form*.
- [ ] Check how **multipart orders** appear, e.g. an abdomen plus a Doppler billed separately. Each should be its own study, and the tech links them to one form when starting.

## 6. Forms

- [ ] Decide which forms the pilot uses. Turn the others off with **Use here** on the Forms page.
- [ ] The clinical lead reviews the wording of every form in use. The starter forms have not been clinically validated. Open questions so far:
  - **Early pregnancy:** the CRL formula (Robinson & Fleming or Hadlock), the redating rule (ACOG or SOGC), and the impression wording.
  - **Salivary glands:** the Sjögren and atrophy wording, and whether to add an abscess or collection field.
  - **All forms:** the combined-report headings (e.g. "ULTRASOUND ABDOMEN"), used when exams from one visit are reported together.
- [ ] The lead technologist makes the agreed changes in the builder and publishes them. Each change is kept in the form's History.
- [ ] Fill in each form once with realistic answers, and read the generated report from start to finish.

## 7. Dictation

- [ ] Paste each report card (Indication, Comparison, Technique, Findings, Impression) into the matching field of your speech-recognition template. Check that the fields line up.
- [ ] Check line breaks after pasting. If they're wrong, change **Admin › Settings › Copied text line endings**.
- [ ] Try a combined report: an abdomen and a DVT study for the same patient on the same day, with a heading per exam in Findings.
- [ ] Agree whether radiologists use **Mark dictated** after each case, so the worklist stays accurate.

## 8. Backups and recovery

- [ ] Nightly backups run at `BACKUP_HOUR` (default 02:00) into `backups/`. Have IT copy that folder to another server every night.
- [ ] **Restore drill:** restore a backup onto a test VM, following [ADMIN.md › Restoring](ADMIN.md#restoring), and check that you can sign in and open an exam.
- [ ] Run `./manage.sh verify-audit` and confirm the audit log checks out.
- [ ] Write down who can restore, and where the master key is kept.

## 9. Training

- [ ] **Technologists (about 15 minutes):**
  - Picking a study and checking the suggested form.
  - The **Normal** buttons.
  - Linking a separately billed study.
  - Submitting, and the next-study prompt.
- [ ] **Radiologists (about 10 minutes):**
  - The worklist, and copying cards (Ctrl+Shift+1, 2, 3…).
  - Combined reports.
  - Returning an exam to the tech, and Mark dictated.
- [ ] Give everyone a contact for problems during the pilot.

## 10. Running the pilot

- [ ] **Scope:** one site, a few common exam types (e.g. abdomen, pelvis, thyroid, DVT), for 2 to 4 weeks.
- [ ] **Fallback:** the current workflow stays available. If SonoForms is down, techs use the old process for those exams.
- [ ] **What to measure:**
  - how often radiologists edit the generated text, and which forms or sections they edit
  - exams returned to the tech, and why
  - the tech's time per form
  - feedback from both groups
- [ ] **Weekly review** with the clinical and tech leads. Form changes go through the builder, with the clinical lead's agreement.
- [ ] **Go/no-go criteria agreed in advance**, e.g. no missed findings attributable to the form, and most reports needing little editing.

## 11. During and after the pilot

- [ ] **Updates:** `./manage.sh update` (it backs up first), then `./manage.sh update-forms` to see whether any starter forms have newer versions.
- [ ] Before each update, the maintainer runs `npm run check` and `npm run security`. See [SECURITY.md › Checking the code](SECURITY.md#checking-the-code).
- [ ] After the pilot, decide on wider rollout and Active Directory sign-in (hospital IT), and retire the old workflow for the exam types covered.
