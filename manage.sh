#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Day-to-day administration of a Docker installation of SonoForms.
#   ./manage.sh help

set -euo pipefail
cd "$(dirname "$0")"

# Command-line tasks run in a one-off "migrate" container: it is the only one
# with database-owner access, which restores and password resets need.
cli() { docker compose run --rm -T --no-deps migrate node server/cli.js "$@"; }

backup_to() {
  local file="$1" tmp="$1.partial"
  mkdir -p backups
  ( umask 077; cli backup - > "$tmp" ) || { rm -f "$tmp"; echo "Backup FAILED." >&2; return 1; }
  mv "$tmp" "$file"
  echo "Backup written to $file"
}

case "${1:-help}" in
  start)    docker compose up -d ;;
  stop)     docker compose stop ;;
  restart)  docker compose restart app web ;;
  status)   docker compose ps ;;
  logs)     docker compose logs --tail "${2:-200}" -f app web ;;
  update)
    # Secrets added by newer versions (kept if they already exist).
    if [ ! -s secrets/db_app_password ]; then
      ( umask 077; head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32 > secrets/db_app_password )
      echo "  created secrets/db_app_password"
    fi
    echo "Making a backup before updating..."
    backup_to "backups/sonoforms-$(date +%Y-%m-%d-%H%M%S)-pre-update.sfbak"
    if [ -d .git ]; then git pull --ff-only; fi
    # Fresh base images bring operating-system security fixes.
    docker compose pull db
    docker compose build --pull
    docker compose up -d
    echo "Updated. Database changes were applied by the migrate step."
    ;;
  backup)
    backup_to "backups/sonoforms-$(date +%Y-%m-%d-%H%M%S)-manual.sfbak"
    ;;
  restore)
    file="${2:-}"
    [ -f "$file" ] || { echo "Usage: ./manage.sh restore backups/FILE.sfbak"; exit 1; }
    echo "This REPLACES ALL DATA with the contents of $file."
    read -r -p "Type RESTORE to continue: " answer
    [ "$answer" = "RESTORE" ] || { echo "Cancelled."; exit 1; }
    echo "Making a safety backup of the current data first..."
    backup_to "backups/sonoforms-$(date +%Y-%m-%d-%H%M%S)-pre-restore.sfbak"
    docker compose stop app
    cli restore - --wipe < "$file"
    docker compose start app
    echo "Restore complete."
    ;;
  reset-password)
    [ -n "${2:-}" ] || { echo "Usage: ./manage.sh reset-password USERNAME"; exit 1; }
    cli reset-password "$2"
    ;;
  unlock)
    [ -n "${2:-}" ] || { echo "Usage: ./manage.sh unlock USERNAME"; exit 1; }
    cli unlock "$2"
    ;;
  create-superuser)
    [ -n "${2:-}" ] || { echo "Usage: ./manage.sh create-superuser USERNAME"; exit 1; }
    cli create-superuser "$2"
    ;;
  verify-audit) cli verify-audit ;;
  lint-forms)   cli lint-forms ;;
  cert-fingerprint)
    docker compose exec -T web openssl x509 -noout -fingerprint -sha256 -in /certs/server.crt
    ;;
  shell)        docker compose exec app sh ;;
  help|*)
    cat <<'HELP'
SonoForms management

  ./manage.sh start | stop | restart | status
  ./manage.sh logs                      follow the application log
  ./manage.sh backup                    write an encrypted backup to backups/
  ./manage.sh restore backups/FILE      replace all data with a backup
  ./manage.sh update                    back up, pull the latest version and base images, rebuild
  ./manage.sh reset-password USERNAME   give a user a new temporary password (valid 72 hours)
  ./manage.sh unlock USERNAME           clear failed sign-in pauses for a user
  ./manage.sh create-superuser USERNAME
  ./manage.sh verify-audit              check the audit log has not been altered
  ./manage.sh cert-fingerprint          show the HTTPS certificate fingerprint
  ./manage.sh lint-forms                check the starter form files

Backups need secrets/master_key to be restored. Keep a copy of it safe.
HELP
    ;;
esac
