# SonoForms

Structured ultrasound worksheets for technologists, turned into findings text the radiologist can paste straight into their dictation.

The problem it solves: tech notes come in random order and often miss items, so radiologists end up re-ordering and re-dictating them. With SonoForms the tech fills in a structured form for the exam. It has big touch-friendly buttons, calculators, and required items they can't skip. The radiologist gets complete, consistently ordered findings text with one-click copy.

* **Self-hosted and offline.** It never sends data to the internet. The only outbound connection is the DICOM query to your own PACS.
* **No AI.** Report text comes from deterministic templates your own radiologists control.
* **Free software** under the GNU GPL v3 or later.

## Workflows

| Who | What they do | Theme |
|---|---|---|
| **Technologist** | Picks today's study from the PACS worklist, so demographics come from PACS. Or enters a patient by hand. The matching form is suggested from the study description. They fill it in with section **Normal** buttons and automatic volumes (ovaries, thyroid lobes, bladder, testes, prostate, TI-RADS…), then submit. | Light, for bright scan rooms |
| **Radiologist** | Works a queue of submitted exams. Each shows the generated findings (editable), the tech's note and what was entered. **Copy**, or **Copy & mark dictated**, then on to the next case. Exams can be returned to the tech with a reason. | Dark, for reading rooms |
| **Tech manager** | Edits forms in a three-pane editor: the form source, a live fillable preview of the tech's form, and the generated findings. Forms are versioned with draft and publish steps. A general library is shared by all institutions, and each institution can copy and customize forms. | Light |
| **Administrator** | Manages users and roles, institutions and their PACS settings, the tamper-evident audit log, settings, backups and system status. | Light |

Users can have several roles. A **superuser** can do everything. One installation can serve **several institutions**, each with its own worklist, patients, forms and users.

## Install

Requirements: a Linux server (or VM) with Docker and Docker Compose v2.

```bash
git clone https://github.com/YOUR-ORG/sonoforms.git
cd sonoforms
./install.sh
```

The installer creates secrets and starts everything. It prints the address and the first admin password. Then:

1. Sign in as `admin` and choose a new password.
2. **Admin › Institutions**: rename "Main Hospital" and enter your PACS details. Use *Test connection* and *Test query*.
3. **Admin › Users**: create accounts for techs, tech managers and radiologists.
4. **Forms**: review the starter forms with your radiologists. Copy and customize them for your institution.
5. **Back up `secrets/master_key`** somewhere safe. Without it, the data and backups cannot be decrypted.

To try it without a PACS, set `DICOM_MOCK=true` in `.env` and run `./manage.sh restart`. The worklist then shows fake demo patients.

See [docs/ADMIN.md](docs/ADMIN.md) for everyday administration, certificates, PACS setup, backups and upgrades.

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for the security design, and [docs/SECURITY-REVIEW-2026-10.md](docs/SECURITY-REVIEW-2026-10.md) for the October 2026 OWASP review and its fixes. Please report vulnerabilities privately to the maintainers.

## Writing forms

Forms are YAML documents that pair what the tech fills in with the report template for each section. See [docs/FORMS.md](docs/FORMS.md). The starter forms in `forms/general/` are a starting point and **must be reviewed by your radiologists before clinical use**.

Starter library: US pelvis (female), thyroid with ACR TI-RADS, abdomen complete, RUQ, renal/bladder (with prostate volume), scrotum, lower-extremity venous duplex.

## Development

```bash
npm install
npm run dev      # embedded PostgreSQL in .dev/, fake PACS, http://localhost:3000
npm test         # form engine, API and security regression tests
npm run lint-forms
```

On a fresh development database the first admin is `admin` / `admin-dev-password`, and you'll be asked to change it at first sign-in. Forgot the password? With `npm run dev` running, in another terminal:

```bash
npm run dev:cli -- reset-password admin
```

This prints a new temporary password. The same tool also offers `unlock USERNAME`, `verify-audit` and `backup FILE`.

Layout:

```
server/        Node.js (Fastify) API: auth, encryption, audit, DICOM, routes
shared/        Form engine used by both browser and server (expressions, templates)
public/        Browser app: plain ES modules, no build step, no CDN
forms/general/ Starter form library (YAML)
docs/          Admin, form-writing and security documentation
docker/        Apache HTTPS front end
```

## License

Copyright © the SonoForms contributors.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. See [LICENSE](LICENSE).

SonoForms is a documentation aid. It does not replace review of the images by a qualified radiologist.
