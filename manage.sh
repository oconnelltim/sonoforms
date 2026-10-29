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

env_get() { grep "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2-; }

# Sets KEY=VALUE in .env (adding it if missing), writing a new file in one step.
env_set() {
  local tmp
  tmp="$(mktemp .env.XXXXXX)"
  if grep -q "^$1=" .env; then sed "s|^$1=.*|$1=$2|" .env > "$tmp"; else cat .env > "$tmp"; echo "$1=$2" >> "$tmp"; fi
  chmod 644 "$tmp"
  mv "$tmp" .env
}

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
  version)
    echo "SonoForms $(env_get SONOFORMS_VERSION) (images from $(env_get SONOFORMS_REGISTRY))"
    ;;
  update)
    target="${2:-}"
    if [ -n "$target" ] && ! [[ "$target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "Usage: ./manage.sh update [VERSION]   e.g. ./manage.sh update 0.3.2"; exit 1
    fi
    # Settings and secrets added by newer versions (kept if they already exist).
    [ -n "$(env_get SONOFORMS_VERSION)" ] || env_set SONOFORMS_VERSION "$(grep ^SONOFORMS_VERSION= .env.example | cut -d= -f2)"
    [ -n "$(env_get SONOFORMS_REGISTRY)" ] || env_set SONOFORMS_REGISTRY ghcr.io/oconnelltim
    if [ ! -s secrets/db_app_password ]; then
      ( umask 077; head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32 > secrets/db_app_password )
      echo "  created secrets/db_app_password"
    fi
    echo "Making a backup before updating..."
    backup_to "backups/sonoforms-$(date +%Y-%m-%d-%H%M%S)-pre-update.sfbak"
    if [ -n "$target" ] && [ "$target" != "$(env_get SONOFORMS_VERSION)" ]; then
      if [ -d .git ]; then
        git fetch --tags --quiet && git checkout --quiet "v$target"
      else
        echo "Note: if the release notes for $target say so, also replace docker-compose.yml,"
        echo "install.sh and manage.sh with the ones from the $target bundle."
      fi
      env_set SONOFORMS_VERSION "$target"
    fi
    # Re-pulling brings any re-published images; offline servers use ./manage.sh load first.
    docker compose pull || echo "Could not download images; using the ones already on this server."
    docker compose up -d
    echo "Now running SonoForms $(env_get SONOFORMS_VERSION). Database changes were applied by the migrate step."
    echo "To see whether the starter forms have newer versions: ./manage.sh update-forms"
    ;;
  load)
    [ -f "${2:-}" ] || { echo "Usage: ./manage.sh load sonoforms-VERSION-images-amd64.tar.gz"; exit 1; }
    docker load -i "$2"
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
  update-forms) shift; cli update-general-forms "$@" ;;
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
  ./manage.sh version                   show the version this server runs
  ./manage.sh update [VERSION]          back up, then move to VERSION (e.g. 0.3.2) or re-pull the current one
  ./manage.sh load FILE                 load images from an offline bundle file (no internet needed)
  ./manage.sh reset-password USERNAME   give a user a new temporary password (valid 72 hours)
  ./manage.sh unlock USERNAME           clear failed sign-in pauses for a user
  ./manage.sh create-superuser USERNAME
  ./manage.sh verify-audit              check the audit log has not been altered
  ./manage.sh cert-fingerprint          show the HTTPS certificate fingerprint
  ./manage.sh lint-forms                check the starter form files
  ./manage.sh update-forms              list starter forms with newer versions
  ./manage.sh update-forms --apply      publish them (forms edited in the app are
                                        left alone unless you add --force)

Backups need secrets/master_key to be restored. Keep a copy of it safe.
HELP
    ;;
esac
