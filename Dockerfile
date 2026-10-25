# SPDX-License-Identifier: GPL-3.0-or-later
# SonoForms application image.
FROM node:26-alpine

ENV NODE_ENV=production
WORKDIR /app

# Time zone data so TZ in .env takes effect ("today" on the worklist, backup time).
RUN apk add --no-cache tzdata

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

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
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server/index.js"]
