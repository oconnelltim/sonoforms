#!/bin/sh
# Creates a self-signed certificate on first start if none was provided.
# Replace certs/server.crt and certs/server.key with your hospital's
# certificate to avoid browser warnings (see docs/ADMIN.md).
set -e
CERT=/certs/server.crt
KEY=/certs/server.key
if [ ! -s "$CERT" ] || [ ! -s "$KEY" ]; then
  echo "No TLS certificate found; generating a self-signed one for ${SERVER_NAME:-localhost}"
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -subj "/CN=${SERVER_NAME:-localhost}" \
    -addext "subjectAltName=DNS:${SERVER_NAME:-localhost},DNS:localhost,IP:127.0.0.1" \
    -keyout "$KEY" -out "$CERT"
  chmod 600 "$KEY"
fi
exec "$@"
