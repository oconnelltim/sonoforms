# Administrator guide

This guide assumes the Docker installation (`./install.sh`). Every command below runs from the SonoForms folder on the server.

## Everyday commands

```bash
./manage.sh status            # are the containers running?
./manage.sh logs              # follow the application log (Ctrl+C to stop)
./manage.sh restart
./manage.sh reset-password jsmith
./manage.sh unlock jsmith     # clear failed sign-in pauses
./manage.sh backup
```

## What lives where

| Path | Contents | Back it up? |
|---|---|---|
| `secrets/master_key` | Encryption key for all patient data and backups | **Yes: keep a separate offline copy** |
| `secrets/db_password` | Database owner password (used only by the migrate step and `./manage.sh` commands) | Yes |
| `secrets/db_app_password` | Password of the restricted role the app runs as | Yes |
| `backups/` | Encrypted backups: nightly (`sonoforms-auto-…`, the newest 14 are kept), manual, pre-update and pre-restore | Copy off the server regularly |
| `certs/` | HTTPS certificate and key | Yes |
| `.env` | Server name, ports, time zone, backup schedule, internal network range | Yes |
| Docker volume `sonoforms_db-data` | The database itself | Covered by the backups |

**If `secrets/master_key` is lost, the data cannot be recovered.** Nobody can recover it, including the developers. The app refuses to start if the key doesn't match the database, rather than showing garbage.

## HTTPS certificate

The installer asks for your hospital's certificate. If you skip that, a self-signed certificate is generated and browsers show a warning. Please don't leave it that way: staff who get used to clicking through certificate warnings can be tricked by a fake server. Get a certificate for your server name from your IT department (an internal CA is fine), then:

```bash
cp your-server.crt certs/server.crt     # include intermediate certificates in this file
cp your-server.key certs/server.key
chmod 600 certs/server.key
docker compose restart web
```

`./manage.sh cert-fingerprint` shows the certificate's SHA-256 fingerprint. If you must use the self-signed certificate for a while, have staff compare it with what the browser shows before trusting it.

## Connecting to PACS

SonoForms reads today's ultrasound studies with a study-level DICOM C-FIND, the same query a workstation uses to search PACS. It does not need a modality worklist. It never retrieves images and never writes to PACS.

1. Ask your PACS administrator to add SonoForms as a **query (C-FIND) client**. They need:
   * our AE title (default `SONOFORMS`, which you can change)
   * the IP address of this server
2. They will give you the PACS **host**, **port** and **AE title**.
3. In **Admin › Institutions › Edit**, enter these, tick *Show today's studies*, and press **Test connection** (C-ECHO), then **Test query**.
4. If your PACS holds studies for several sites, add a filter so each institution sees only its own studies, e.g. `InstitutionName = GENERAL HOSP*`. Some PACS ignore filters on some fields. If *Test query* still shows other sites' studies, switch the filter to **Filter results here**.

The worklist refreshes every minute. It looks back 24 hours by default (Admin › Settings, at most 7 days).

**Safeguards for your PACS:**
- **Narrowed queries:** every worklist query carries a date limit, and a modality (usually `US`) or an institution filter that PACS applies. SonoForms won't save or run a query without one, so it can never ask PACS for "every study".
- **Result limit:** a query stops at *Most studies to fetch* (default 500). If that happens, the worklist and *Test query* say so.
- **Shared queries:** however many technologists have the worklist open, each institution sends at most one query at a time, and **Refresh** reuses a result less than 10 seconds old.

**If your PACS behaves differently:**
- *Send modality as*: most PACS match the modality on *Modalities in Study*. Some only accept *Modality*.
- *Date matching*: if your PACS rejects date ranges, choose *One day at a time*. SonoForms then sends one query per day of the look-back period.

## Users and roles

| Role | Can |
|---|---|
| Technologist | Use the tech worklist and fill in forms |
| Tech manager | Same as technologist, plus edit forms for their institutions |
| Radiologist | Use the reading worklist, copy findings, mark dictated, return to tech |
| Administrator | Admin area: users, institutions, audit, settings, backups. No patient data unless also given a clinical role, and then only for their assigned institutions |
| Superuser | Everything, at every institution, including editing the general form library |

* **Institutions:** users see only the institutions they are assigned to, and removing someone from an institution takes effect immediately.
* **Administrators can't change their own roles or institutions;** another administrator or a superuser must do it. Only superusers can manage superuser accounts, and the last superuser can't be removed.
* **Temporary passwords:** new users and password resets get a temporary password that must be changed at first sign-in and **expires after 72 hours**.
* **Failed sign-ins:** after 5 failed sign-ins (configurable), that user can't try again *from that computer* for 1 minute, then 2, 4… up to 15 minutes.
  * Attempts from other computers aren't affected, so someone guessing passwords can't lock a colleague out.
  * After many failures from several computers, the account pauses everywhere.
  * Admin › Users shows "Locked out" and has an **Unlock** button, or use `./manage.sh unlock USERNAME`.

## Backups

* **Automatic:** every night at `BACKUP_HOUR` (default 02:00) to `backups/`, keeping the newest `BACKUP_KEEP` (default 14) automatic backups. A failed backup is retried on the next check (every 15 minutes) and is recorded in the audit log.
* **Manual:** `./manage.sh backup`, or Admin › Backups › Download backup. Manual, pre-update and pre-restore backups are never deleted automatically.

Backups are encrypted with the master key. Copy `backups/` to another machine regularly; a backup on the same disk won't survive a disk failure. For example, with a nightly cron job:

```bash
rsync -a /opt/sonoforms/backups/ backupserver:/srv/sonoforms-backups/
```

### Restoring

```bash
./manage.sh restore backups/sonoforms-2026-10-24-02-00-00.sfbak
```

This stops the app, saves a safety backup of the current state, replaces all data, and starts the app again. A backup can't be altered or mixed with another backup without the restore failing. To restore onto a **new server**: install SonoForms there, then copy the old `secrets/master_key` and `secrets/db_password` over the new ones *before* the first start. If you've already started it, run `docker compose down -v` to clear the empty database, copy the secrets, run `./install.sh` again, then restore.

## Upgrading

```bash
./manage.sh update
```

This makes a backup, pulls the new version, pulls fresh base images (bringing operating-system security fixes), rebuilds and restarts. Database changes are applied by a short-lived `migrate` container before the app starts. That's the only container with the database owner password; the app itself runs with a restricted database account. Run `update` at least monthly.

### Newer starter forms

An update can include improved starter forms, but the copies already in your general library are never changed automatically. To see which have newer versions:

```bash
./manage.sh update-forms
./manage.sh update-forms --apply      # publish the newer versions
```

Each newer version is published as the form's next version; earlier versions stay in the form's History, and exams keep the version they were filled in with. Your institutions' own copies of a form are never changed.

Forms someone has edited in the app are left alone, as are forms with an unpublished draft. To replace an edited form with the starter version anyway, add `--force`. Have your radiologists check the new wording before applying, as with any form change. Each update is recorded in the audit log.

Without Docker, the command is `node server/cli.js update-general-forms [--apply] [--force]`; in development, `npm run dev:cli -- update-general-forms`.

## Audit log

Admin › Audit log records sign-ins (including failures), every exam opened, created, submitted, copied or dictated, patient searches, form changes, user and setting changes, exports and backups. Patient names and MRNs are never written to the audit log; records are referred to by number.

It also records permission failures, attempts to open other institutions' records, worklist and history views, and edits to exams and findings (at most once per 15 minutes per person and exam).

The application can only add entries; its database account can't change or delete them. Each entry is sealed to the previous one with a key derived from the master key, so changes are detectable even by someone with direct database access.

**Verify integrity** (or `./manage.sh verify-audit`) checks the whole chain. It also runs every night and writes the newest entry's hash to the server log (`./manage.sh logs`). Note it down occasionally, or forward logs to your SIEM, for an independent record. Use **Export CSV** for compliance requests.

## Data retention

By default nothing is deleted. To keep data only as long as it's useful, e.g. for the time it takes to dictate, set **Admin › Settings › Delete dictated exams after (days)**. Dictated and cancelled exams older than that are deleted automatically, along with patients that have no remaining exams. Backups still contain them until the backups age out.

## Network and privacy

* **What's reachable:** only the `web` container (Apache) is reachable from the network, on ports 443 and 80 (80 just redirects to HTTPS).
* **Internal networks:** Apache reaches the app over an internal Docker network (`PROXY_SUBNET` in `.env`, default `172.31.250.0/28`; change it only if it clashes with your hospital's addresses). The database sits on a separate internal network with no outside access.
* **Logs:** the access log records paths without query strings, and container logs are rotated (5 × 10 MB per container).
* **Outbound connections:** the app container connects only to the PACS you configure. It loads no external scripts, fonts or analytics, has no update checks and sends no telemetry. The browser's Content-Security-Policy blocks connections to any other site.
* **Firewalling outbound traffic:** for defense in depth, block the server from reaching the internet. On Linux with Docker, this limits the containers to your PACS (replace the address and port):

  ```bash
  sudo iptables -I DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  sudo iptables -I DOCKER-USER 2 -d 10.0.0.5 -p tcp --dport 104 -j ACCEPT
  sudo iptables -A DOCKER-USER -o eth0 -j DROP
  ```

  Ask your IT team to make this persistent and to adapt it to your network.

## Troubleshooting

| Symptom | Check |
|---|---|
| Browser can't connect | `./manage.sh status`. Are the ports open in the server's firewall? |
| "PACS query failed" on the worklist | Admin › Institutions › Test connection. Common causes are an AE title not registered on the PACS, or a wrong port or firewall. |
| App won't start, "master key does not match" | The `secrets/master_key` file was changed. Restore the original. |
| Forgot the admin password | `./manage.sh reset-password admin` |
| "Too many failed attempts" | Wait a few minutes, or Admin › Users › Unlock (or `./manage.sh unlock USERNAME`) |
| "Temporary password has expired" | Reset the password again (it is valid for 72 hours) |
| App won't start, "The database needs updating" | Run `./manage.sh update` (or `docker compose up -d`, which runs the migrate step first) |
| All audit log IP addresses are the same | The proxy network range doesn't match `PROXY_SUBNET`. Run `docker compose down` then `docker compose up -d` after changing it |
| Studies from other sites appear | Add or adjust the institution filter (see *Connecting to PACS*) |
