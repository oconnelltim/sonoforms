#!/bin/sh
# Creates a self-signed certificate on first start if none was provided,
# and prints its fingerprint so users can verify it. Replace certs/server.crt
# and certs/server.key with your hospital's certificate to avoid browser
# warnings (see docs/ADMIN.md).
set -e
CERT=/certs/server.crt
KEY=/certs/server.key
if [ ! -s "$CERT" ] || [ ! -s "$KEY" ]; then
  echo "No TLS certificate found; generating a self-signed one for ${SERVER_NAME:-localhost}"
  umask 077
  openssl req -x509 -nodes -newkey rsa:3072 -days 825 \
    -subj "/CN=${SERVER_NAME:-localhost}" \
    -addext "subjectAltName=DNS:${SERVER_NAME:-localhost},DNS:localhost,IP:127.0.0.1" \
    -addext "basicConstraints=critical,CA:FALSE" \
    -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth" \
    -keyout "$KEY" -out "$CERT"
fi
echo "TLS certificate SHA-256 fingerprint: $(openssl x509 -noout -fingerprint -sha256 -in "$CERT" | cut -d= -f2)"

# A hospital reverse proxy in front: trust the client address it forwards.
# Only IP addresses and CIDR ranges are accepted, separated by spaces.
if [ -n "${UPSTREAM_PROXY:-}" ]; then
  if printf '%s' "$UPSTREAM_PROXY" | grep -Eq '^[0-9A-Fa-f.:/ ]+$'; then
    echo "Trusting client addresses forwarded by: $UPSTREAM_PROXY"
    exec "$@" -DUPSTREAM_PROXY
  fi
  echo "UPSTREAM_PROXY must be IP addresses or CIDR ranges separated by spaces; ignoring it." >&2
fi
exec "$@"
