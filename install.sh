#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# First-time setup for SonoForms. Safe to run again: existing secrets and
# settings are kept.
#
#   ./install.sh

set -euo pipefail
cd "$(dirname "$0")"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
fail() { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

bold "SonoForms installer"

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. See https://docs.docker.com/engine/install/ (or ask your IT team)."
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is not available ('docker compose'). Please update Docker."
docker info >/dev/null 2>&1 || fail "Cannot talk to Docker. Is it running, and is your user allowed to use it (try: sudo usermod -aG docker \$USER, then log out and in)?"

random() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
readable_password() { head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 14; }

umask 077
mkdir -p secrets backups certs

new_secret() {
  local file="secrets/$1"
  if [ ! -s "$file" ]; then
    printf '%s' "$2" > "$file"
    echo "  created $file"
  fi
}
bold "Creating secrets (kept if they already exist)"
new_secret db_password "$(random 24 | tr -dc 'A-Za-z0-9')"
FIRST_INSTALL=false
if [ ! -s secrets/master_key ]; then FIRST_INSTALL=true; fi
new_secret master_key "$(random 32)"
new_secret initial_admin_password "$(readable_password)"
chmod 600 secrets/*

if [ ! -f .env ]; then
  umask 022
  cp .env.example .env
  default_name="$(hostname -f 2>/dev/null || hostname)"
  read -r -p "Server name users will type in the browser [${default_name}]: " name || true
  name="${name:-$default_name}"
  sed -i.bak "s/^SERVER_NAME=.*/SERVER_NAME=${name}/" .env
  tz="$(cat /etc/timezone 2>/dev/null || readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##' || echo UTC)"
  sed -i.bak "s#^TZ=.*#TZ=${tz:-UTC}#" .env
  sed -i.bak "s/^APP_UID=.*/APP_UID=$(id -u)/; s/^APP_GID=.*/APP_GID=$(id -g)/" .env
  rm -f .env.bak
  echo "  created .env (edit it to change ports, time zone or backup schedule)"
fi

bold "Building and starting containers (this can take a few minutes the first time)"
docker compose up -d --build

bold "Waiting for SonoForms to start"
for i in $(seq 1 60); do
  if docker compose exec -T app wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ "${ok:-}" = 1 ] || { docker compose logs --tail 50 app; fail "SonoForms did not start. See the log above."; }

SERVER_NAME="$(grep ^SERVER_NAME= .env | cut -d= -f2)"
HTTPS_PORT="$(grep ^HTTPS_PORT= .env | cut -d= -f2)"
URL="https://${SERVER_NAME}"; [ "${HTTPS_PORT}" != "443" ] && URL="${URL}:${HTTPS_PORT}"

echo
bold "SonoForms is running at ${URL}"
if $FIRST_INSTALL; then
  echo "  Username: admin"
  echo "  Temporary password: $(cat secrets/initial_admin_password)"
  echo "  (You will choose a new password at first sign-in.)"
fi
echo
warn "IMPORTANT: back up the file secrets/master_key somewhere safe and separate"
warn "(e.g. a password manager or a sealed envelope in a safe). Patient data and"
warn "backups CANNOT be decrypted without it."
echo
echo "Your browser will warn about the certificate until you install your"
echo "hospital's certificate in certs/ (see docs/ADMIN.md)."
echo "Day-to-day commands: ./manage.sh help"
