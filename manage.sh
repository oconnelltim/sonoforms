#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Day-to-day administration of a Docker installation of SonoForms.
#   ./manage.sh help

set -euo pipefail
cd "$(dirname "$0")"

cli() { docker compose exec -T app node server/cli.js "$@"; }

case "${1:-help}" in
  start)    docker compose up -d ;;
  stop)     docker compose stop ;;
  restart)  docker compose restart ;;
  status)   docker compose ps ;;
  logs)     docker compose logs --tail "${2:-200}" -f app web ;;
  update)
    echo "Making a backup before updating..."
    "$0" backup
    if [ -d .git ]; then git pull --ff-only; fi
    docker compose up -d --build
    echo "Updated. Database changes are applied automatically on start."
    ;;
  backup)
    mkdir -p backups
    file="backups/sonoforms-$(date +%Y-%m-%d-%H%M%S)-manual.sfbak"
    cli backup - > "$file"
    chmod 600 "$file"
    echo "Backup written to $file"
    ;;
  restore)
    file="${2:-}"
    [ -f "$file" ] || { echo "Usage: ./manage.sh restore backups/FILE.sfbak"; exit 1; }
    echo "This REPLACES ALL DATA with the contents of $file."
    read -r -p "Type RESTORE to continue: " answer
    [ "$answer" = "RESTORE" ] || { echo "Cancelled."; exit 1; }
    echo "Making a safety backup of the current data first..."
    "$0" backup
    cli restore - --wipe < "$file"
    echo "Restore complete."
    ;;
  reset-password)
    [ -n "${2:-}" ] || { echo "Usage: ./manage.sh reset-password USERNAME"; exit 1; }
    cli reset-password "$2"
    ;;
  create-superuser)
    [ -n "${2:-}" ] || { echo "Usage: ./manage.sh create-superuser USERNAME"; exit 1; }
    cli create-superuser "$2"
    ;;
  verify-audit) cli verify-audit ;;
  lint-forms)   cli lint-forms ;;
  shell)        docker compose exec app sh ;;
  help|*)
    cat <<'HELP'
SonoForms management

  ./manage.sh start | stop | restart | status
  ./manage.sh logs                      follow the application log
  ./manage.sh backup                    write an encrypted backup to backups/
  ./manage.sh restore backups/FILE      replace all data with a backup
  ./manage.sh update                    back up, pull the latest version, rebuild
  ./manage.sh reset-password USERNAME   give a user a new temporary password
  ./manage.sh create-superuser USERNAME
  ./manage.sh verify-audit              check the audit log has not been altered
  ./manage.sh lint-forms                check the starter form files

Backups need secrets/master_key to be restored. Keep a copy of it safe.
HELP
    ;;
esac
