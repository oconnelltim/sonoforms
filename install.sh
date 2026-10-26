#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# First-time setup for SonoForms. Safe to run again: existing secrets and
# settings are kept (the master key is never replaced).
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
alnum() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

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
FIRST_INSTALL=false
[ -s secrets/master_key ] || FIRST_INSTALL=true
new_secret master_key "$(random 32)"
new_secret db_password "$(alnum 32)"
new_secret db_app_password "$(alnum 32)"
INITIAL_PASSWORD=""
if $FIRST_INSTALL || [ ! -s secrets/initial_admin_password ]; then
  INITIAL_PASSWORD="$(alnum 16)"
  printf '%s' "$INITIAL_PASSWORD" > secrets/initial_admin_password
fi
chmod 600 secrets/*

if [ ! -f .env ]; then
  default_name="$(hostname -f 2>/dev/null || hostname)"
  while :; do
    read -r -p "Server name users will type in the browser [${default_name}]: " name || true
    name="${name:-$default_name}"
    if [[ "$name" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]]; then break; fi
    warn "Please enter a host name like sonoforms.hospital.local (letters, numbers, dots and hyphens only)."
  done
  tz="$(cat /etc/timezone 2>/dev/null || readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##' || true)"
  [[ "$tz" =~ ^[A-Za-z0-9_+/-]+$ ]] || tz=UTC
  # Build the whole file first, then move it into place, so an interrupted
  # run never leaves a half-written .env behind.
  umask 022
  tmp="$(mktemp .env.XXXXXX)"
  sed -e "s/^SERVER_NAME=.*/SERVER_NAME=${name}/" \
      -e "s#^TZ=.*#TZ=${tz}#" \
      -e "s/^APP_UID=.*/APP_UID=$(id -u)/" \
      -e "s/^APP_GID=.*/APP_GID=$(id -g)/" .env.example > "$tmp"
  mv "$tmp" .env
  umask 077
  echo "  created .env (edit it to change ports, time zone or backup schedule)"
fi

if [ ! -s certs/server.crt ]; then
  echo
  bold "HTTPS certificate"
  echo "A certificate from your hospital or IT department avoids browser warnings,"
  echo "which matters: staff who get used to clicking through warnings can be tricked."
  read -r -p "Path to your certificate (.crt/.pem, with intermediates), or press Enter to use a self-signed one for now: " crt || true
  if [ -n "${crt:-}" ]; then
    read -r -p "Path to the matching private key: " key || true
    [ -f "$crt" ] && [ -f "${key:-}" ] || fail "Certificate or key file not found."
    cp "$crt" certs/server.crt
    cp "$key" certs/server.key
    chmod 600 certs/server.key
  fi
fi

bold "Building and starting containers (this can take a few minutes the first time)"
docker compose pull db
docker compose build --pull
docker compose up -d

SERVER_NAME="$(grep ^SERVER_NAME= .env | cut -d= -f2)"
HTTPS_PORT="$(grep ^HTTPS_PORT= .env | cut -d= -f2)"

bold "Waiting for SonoForms to start"
# Check the whole path users take: HTTPS through Apache to the app.
web_ok() {
  if command -v curl >/dev/null 2>&1; then
    curl -ksf --max-time 5 "https://127.0.0.1:${HTTPS_PORT}/api/health" >/dev/null 2>&1
  else
    [ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' sonoforms-web-1 2>/dev/null)" = "true 0" ] &&
      docker compose exec -T app wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1
  fi
}
ok=""
for _ in $(seq 1 60); do
  if web_ok; then ok=1; break; fi
  sleep 2
done
[ "$ok" = 1 ] || { docker compose ps -a; docker compose logs --tail 30 migrate app web; fail "SonoForms did not start. See the log above."; }
URL="https://${SERVER_NAME}"; [ "${HTTPS_PORT}" != "443" ] && URL="${URL}:${HTTPS_PORT}"
FINGERPRINT="$(docker compose logs web 2>/dev/null | grep -o 'fingerprint: .*' | tail -1 | cut -d' ' -f2 || true)"

echo
bold "SonoForms is running at ${URL}"
if [ -n "$INITIAL_PASSWORD" ]; then
  echo "  Username: admin"
  echo "  Temporary password: ${INITIAL_PASSWORD}"
  echo "  (You will choose a new password at first sign-in.)"
  # The password is now stored (hashed) in the database; don't leave it on disk.
  printf '%s' "$(alnum 32)" > secrets/initial_admin_password
fi
[ -n "$FINGERPRINT" ] && echo "  Certificate fingerprint (SHA-256): ${FINGERPRINT}"
echo
warn "IMPORTANT: back up the file secrets/master_key somewhere safe and separate"
warn "(e.g. a password manager or a sealed envelope in a safe). Patient data and"
warn "backups CANNOT be decrypted without it."
echo
echo "If you used a self-signed certificate, browsers will warn until you install"
echo "your hospital's certificate in certs/ (see docs/ADMIN.md). Compare the"
echo "fingerprint above with what the browser shows before trusting it."
echo "Day-to-day commands: ./manage.sh help"
