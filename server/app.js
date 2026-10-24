// SPDX-License-Identifier: GPL-3.0-or-later

import path from 'node:path';
import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { config, ROOT } from './config.js';
import { loadSession, HttpError } from './auth.js';
import authRoutes from './routes/auth.js';
import techRoutes from './routes/tech.js';
import radRoutes from './routes/rad.js';
import formRoutes from './routes/forms.js';
import adminRoutes from './routes/admin.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export async function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger ?? { level: config.logLevel, redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]'] },
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });

  // Per-request log lines are noise in production; route logs show warnings and errors only.
  app.addHook('onRoute', (route) => { if (!route.logLevel) route.logLevel = process.env.REQUEST_LOG_LEVEL || 'warn'; });

  await app.register(fastifyCookie);
  app.addHook('onRequest', loadSession);

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    // Static files revalidate on every load (cheap via ETag) so upgrades take effect immediately.
    else if (!reply.getHeader('Cache-Control')) reply.header('Cache-Control', 'no-cache');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.message, ...(err.extra || {}) });
    }
    if (err.validation) {
      return reply.status(400).send({ error: `Invalid request: ${err.message}` });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'Something went wrong on the server. The error has been logged.' });
  });

  app.get('/api/health', async () => ({ ok: true, version: config.version }));

  await app.register(authRoutes, { prefix: '/api' });
  await app.register(techRoutes, { prefix: '/api' });
  await app.register(radRoutes, { prefix: '/api' });
  await app.register(formRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api/admin' });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
    return reply.status(404).type('text/plain').send('Not found');
  });

  // Static files: the browser app, the shared form engine, and the YAML parser.
  await app.register(fastifyStatic, { root: path.join(ROOT, 'public'), prefix: '/', index: ['index.html'], cacheControl: false });
  await app.register(fastifyStatic, { root: path.join(ROOT, 'shared'), prefix: '/shared/', decorateReply: false, cacheControl: false });
  await app.register(fastifyStatic, { root: path.join(ROOT, 'node_modules', 'yaml', 'browser'), prefix: '/vendor/yaml/', decorateReply: false });
  await app.register(fastifyStatic, { root: path.join(ROOT, 'docs'), prefix: '/docs/', decorateReply: false, cacheControl: false });

  return app;
}
