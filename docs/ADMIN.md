# Administrator guide

This guide assumes the Docker installation (`./install.sh`). Every command below runs from the SonoForms folder on the server.

## Everyday commands

```bash
./manage.sh status            # are the containers running?
./manage.sh logs              # follow the application log (Ctrl+C to stop)
./manage.sh restart
./manage.sh reset-password jsmith
./manage.sh backup
```

## What lives where

| Path | Contents | Back it up? |
|---|---|---|
| `secrets/master_key` | Encryption key for all patient data and backups | **Yes: keep a separate offline copy** |
| `secrets/db_password` | Database password | Yes |
| `backups/` | Nightly encrypted backups (the newest 14 are kept) | Copy off the server regularly |
| `certs/` | HTTPS certificate and key | Yes |
| `.env` | Server name, ports, time zone, backup schedule | Yes |
| Docker volume `sonoforms_db-data` | The database itself | Covered by the backups |

**If `secrets/master_key` is lost, the data cannot be recovered.** Nobody can recover it, including the developers. The app refuses to start if the key doesn't match the database, rather than showing garbage.

## HTTPS certificate

On first start a self-signed certificate is generated, and browsers will show a warning. To fix it, get a certificate for your server name from your IT department (an internal CA is fine). Then:

```bash
cp your-server.crt certs/server.crt     # include intermediate certificates in this file
cp your-server.key certs/server.key
chmod 600 certs/server.key
docker compose restart web
```

## Connecting to PACS

SonoForms reads today's ultrasound studies with a study-level DICOM C-FIND, the same query a workstation uses to search PACS. It does not need a modality worklist. It never retrieves images and never writes to PACS.

1. Ask your PACS administrator to add SonoForms as a **query (C-FIND) client**. They need:
   * our AE title (default `SONOFORMS`, which you can change)
   * the IP address of this server
2. They will give you the PACS **host**, **port** and **AE title**.
3. In **Admin › Institutions › Edit**, enter these, tick *Show today's studies*, and press **Test connection** (C-ECHO), then **Test query**.
4. If your PACS holds studies for several sites, add a filter so each institution sees only its own studies, e.g. `InstitutionName = GENERAL HOSP*`. Some PACS ignore filters on some fields. If *Test query* still shows other sites' studies, switch the filter to **Filter results here**.

The worklist refreshes every minute. It looks back 24 hours by default (Admin › Settings).

## Users and roles

| Role | Can |
|---|---|
| Technologist | Use the tech worklist and fill in forms |
| Tech manager | Same as technologist, plus edit forms for their institutions |
| Radiologist | Use the reading worklist, copy findings, mark dictated, return to tech |
| Administrator | Admin area: users, institutions, audit, settings, backups. Not patient data |
| Superuser | Everything, including editing the general form library |

Users see only the institutions they are assigned to. New users and password resets get a temporary password that must be changed at first sign-in. Accounts lock for 15 minutes after 5 failed attempts; you can unlock them sooner in Admin › Users.

## Backups

* **Automatic:** every night at `BACKUP_HOUR` (default 02:00) to `backups/`, keeping the newest `BACKUP_KEEP` (default 14).
* **Manual:** `./manage.sh backup`, or Admin › Backups › Download backup.

Backups are encrypted with the master key. Copy `backups/` to another machine regularly; a backup on the same disk won't survive a disk failure. For example, with a nightly cron job:

```bash
rsync -a /opt/sonoforms/backups/ backupserver:/srv/sonoforms-backups/
```

### Restoring

```bash
./manage.sh restore backups/sonoforms-2026-10-24-02-00-00.sfbak
```

This replaces all data, after first saving a safety backup of the current state. To restore onto a **new server**: install SonoForms there, then copy the old `secrets/master_key` and `secrets/db_password` over the new ones *before* the first start. If you've already started it, run `docker compose down -v` to clear the empty database, copy the secrets, run `./install.sh` again, then restore.

## Upgrading

```bash
./manage.sh update
```

This makes a backup, pulls the new version, rebuilds and restarts. Database changes are applied automatically.

## Audit log

Admin › Audit log records sign-ins (including failures), every exam opened, created, submitted, copied or dictated, patient searches, form changes, user and setting changes, exports and backups. Patient names and MRNs are never written to the audit log; records are referred to by number.

Entries cannot be edited or deleted (the database blocks it), and each entry contains a hash of the previous one. **Verify integrity** (or `./manage.sh verify-audit`) checks the whole chain. Use **Export CSV** for compliance requests.

## Data retention

By default nothing is deleted. To keep data only as long as it's useful, e.g. for the time it takes to dictate, set **Admin › Settings › Delete dictated exams after (days)**. Dictated and cancelled exams older than that are deleted automatically, along with patients that have no remaining exams. Backups still contain them until the backups age out.

## Network and privacy

* Only the `web` container is reachable from the network (ports 443 and 80; 80 just redirects to HTTPS).
* The database sits on an internal Docker network with no outside access.
* The app container connects only to the PACS you configure. It loads no external scripts, fonts or analytics, has no update checks and sends no telemetry. The browser's Content-Security-Policy blocks connections to any other site.
* For defense in depth, firewall the server so it can reach only the PACS (and your backup target), not the internet.

## Troubleshooting

| Symptom | Check |
|---|---|
| Browser can't connect | `./manage.sh status`. Are the ports open in the server's firewall? |
| "PACS query failed" on the worklist | Admin › Institutions › Test connection. Common causes are an AE title not registered on the PACS, or a wrong port or firewall. |
| App won't start, "master key does not match" | The `secrets/master_key` file was changed. Restore the original. |
| Forgot the admin password | `./manage.sh reset-password admin` |
| Studies from other sites appear | Add or adjust the institution filter (see *Connecting to PACS*) |
