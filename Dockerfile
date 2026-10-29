# SPDX-License-Identifier: GPL-3.0-or-later
# SonoForms application image.
FROM node:26-alpine

ENV NODE_ENV=production
WORKDIR /app

# Security updates for the base image's packages, and time zone data so TZ in
# .env takes effect ("today" on the worklist, backup time).
RUN apk upgrade --no-cache && apk add --no-cache tzdata

# npm is only needed to install the app's packages; it's removed afterwards so
# its own dependencies (and their vulnerabilities) aren't in the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && rm -rf /root/.npm /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

COPY server ./server
COPY shared ./shared
COPY public ./public
COPY forms ./forms
COPY docs ./docs
COPY LICENSE README.md ./

# The container runs as an unprivileged user (overridden by docker-compose to
# match the host user, so backups written to ./backups are owned by the admin).
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server/index.js"]
