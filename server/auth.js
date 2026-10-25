// SPDX-License-Identifier: GPL-3.0-or-later
//
// Sessions, sign-in, throttling, and permission checks.
//
// Sessions are random tokens in an HttpOnly, SameSite=Strict cookie; only a
// SHA-256 of the token is stored. State-changing requests must also carry the
// session's CSRF token in an X-CSRF-Token header.

import crypto from 'node:crypto';
import { one, many, query } from './db.js';
import { config } from './config.js';
import { randomToken, sha256, verifyPassword, exactIndex, DUMMY_HASH } from './crypto.js';
import { getSettings } from './settings.js';
import { audit } from './audit.js';

// The __Host- prefix makes browsers refuse the cookie unless it is Secure,
// host-only and Path=/ (not available for plain-http development).
export const COOKIE = config.secureCookies ? '__Host-sf_session' : 'sf_session';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.statusCode = status;
    this.extra = extra;
  }
}

export const hasRole = (user, ...roles) => !!user && (user.roles.includes('superuser') || roles.some(r => user.roles.includes(r)));

// Capability helpers used by routes and sent to the browser to build menus.
export const can = {
  tech: u => hasRole(u, 'tech', 'tech_manager'),
  rad: u => hasRole(u, 'radiologist'),
  forms: u => hasRole(u, 'tech_manager'),
  admin: u => hasRole(u, 'admin'),
  superuser: u => hasRole(u),
};

export function capabilities(user) {
  return Object.fromEntries(Object.entries(can).map(([k, f]) => [k, f(user)]));
}

// Institutions whose patients and forms the user may work with. Only
// superusers get every institution; everyone else (administrators
// included) gets exactly the institutions they are assigned to.
export async function userInstitutions(user) {
  if (can.superuser(user)) {
    return many('SELECT id, code, name FROM institutions WHERE active ORDER BY name');
  }
  return many(
    `SELECT i.id, i.code, i.name FROM institutions i
     JOIN user_institutions ui ON ui.institution_id = i.id
     WHERE ui.user_id = $1 AND i.active ORDER BY i.name`, [user.id]);
}

export async function canAccessInstitution(user, institutionId) {
  if (!institutionId) return false;
  const list = await userInstitutions(user);
  return list.some(i => i.id === Number(institutionId));
}

function cookieOptions(maxAgeSeconds) {
  return { path: '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookies, maxAge: maxAgeSeconds };
}

export async function createSession(reply, req, user) {
  const settings = await getSettings();
  // Signing in again replaces any session this browser already had.
  const old = req.cookies?.[COOKIE];
  if (old) await query('DELETE FROM sessions WHERE id = $1', [sha256(old)]);
  const token = randomToken();
  const institutions = await userInstitutions(user);
  const preferred = user.preferences?.institution_id;
  const institutionId = institutions.find(i => i.id === preferred)?.id ?? institutions[0]?.id ?? null;
  await query(
    `INSERT INTO sessions (id, user_id, csrf_token, institution_id, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5), $6, $7)`,
    [sha256(token), user.id, randomToken(24), institutionId, settings.session_max_hours, req.ip, String(req.headers['user-agent'] || '').slice(0, 300)],
  );
  reply.setCookie(COOKIE, token, cookieOptions(settings.session_max_hours * 3600));
}

export async function destroySession(req, reply) {
  if (req.session) await query('DELETE FROM sessions WHERE id = $1', [req.session.id]);
  reply.clearCookie(COOKIE, { path: '/', secure: config.secureCookies, httpOnly: true, sameSite: 'strict' });
}

// Fastify onRequest hook: attaches req.user and req.session when logged in.
export async function loadSession(req) {
  req.user = null;
  req.session = null;
  const token = req.cookies?.[COOKIE];
  if (!token) return;
  const settings = await getSettings();
  const row = await one(
    `SELECT s.id, s.csrf_token, s.institution_id, s.created_at, s.last_seen_at, s.expires_at,
            u.id AS user_id, u.username, u.display_name, u.roles, u.active, u.must_change_password, u.preferences
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1`, [sha256(token)]);
  if (!row) return;
  const now = Date.now();
  const idleMs = settings.session_idle_minutes * 60000;
  // The absolute limit uses the current setting, so lowering it applies to existing sessions too.
  const maxMs = settings.session_max_hours * 3600000;
  if (!row.active || new Date(row.expires_at) < now || now - new Date(row.created_at).getTime() > maxMs ||
      now - new Date(row.last_seen_at).getTime() > idleMs) {
    await query('DELETE FROM sessions WHERE id = $1', [row.id]);
    req.sessionExpired = true;
    return;
  }
  req.session = { id: row.id, csrf: row.csrf_token, institution_id: row.institution_id };
  req.user = {
    id: row.user_id, username: row.username, display_name: row.display_name, roles: row.roles,
    must_change_password: row.must_change_password, preferences: row.preferences || {},
  };
  // Background polling (worklist refresh) shouldn't keep an idle session alive.
  if (req.headers['x-background'] !== '1' && now - new Date(row.last_seen_at).getTime() > 30000) {
    await query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.id]);
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function forbidden(req, reason, message, extra) {
  await audit({ req, action: 'security.forbidden', details: { method: req.method, route: req.routeOptions?.url || req.url.split('?')[0], reason } }).catch(() => {});
  return new HttpError(403, message, extra);
}

// Route guards. Usage: { preHandler: requireAuth(can.rad) }
export function requireAuth(...checks) {
  return async (req) => {
    if (!req.user) throw new HttpError(401, req.sessionExpired ? 'Your session has expired. Please log in again.' : 'Please log in.');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !safeEqual(req.headers['x-csrf-token'], req.session.csrf)) {
      throw await forbidden(req, 'csrf', 'Invalid security token. Please reload the page.');
    }
    if (req.user.must_change_password && !req.routeOptions?.config?.allowPasswordChange) {
      throw new HttpError(403, 'You must change your password before continuing.', { code: 'MUST_CHANGE_PASSWORD' });
    }
    if (checks.length && !checks.some(check => check(req.user))) throw await forbidden(req, 'role', 'You do not have permission to do that.');
  };
}

// The session's active institution, re-checked against the user's current
// assignments on every request (so removing someone from an institution
// takes effect immediately).
export async function activeInstitution(req) {
  const id = req.session?.institution_id;
  if (!id) throw new HttpError(400, 'No institution selected. Ask an administrator to assign you to an institution.');
  if (!(await canAccessInstitution(req.user, id))) {
    await query('UPDATE sessions SET institution_id = NULL WHERE id = $1', [req.session.id]);
    throw await forbidden(req, 'institution', 'You no longer have access to this institution. Reload the page.');
  }
  return id;
}

// Rejects state-changing requests that a browser marks as coming from
// another site. Complements SameSite cookies and the CSRF header, and covers
// sign-in and sign-out, which have no session yet.
export function checkRequestOrigin(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !req.url.startsWith('/api/')) return;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Cross-site request blocked.');
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let host;
    try { host = new URL(origin).host; } catch { host = ''; }
    if (host !== req.headers.host) throw new HttpError(403, 'Cross-site request blocked.');
  }
}

// ---- Sign-in throttling ----------------------------------------------------
//
// Each (username, computer) pair gets `max_failed_logins` attempts, then a
// lock that doubles in length (1, 2, 4… minutes, capped at lockout_minutes).
// An attacker guessing from their own computer can't lock the real user out
// of theirs. Attempts are counted *before* the password is checked, in one
// atomic statement, so parallel requests can't sneak extra guesses. A
// ceiling across all computers stops distributed guessing. Unknown
// usernames are treated exactly like real ones.

const ACCOUNT_CEILING_FACTOR = 10;
export const throttleKey = (kind, value) => exactIndex(String(value ?? '').trim().toLowerCase() || '(blank)', `throttle:${kind}`);

const tooMany = () => new HttpError(429, 'Too many failed attempts. Wait a few minutes and try again, or ask an administrator to unlock your account.');

// Counts one attempt; throws 429 if this key/IP is currently locked out.
export async function countAttempt(key, ip, settings) {
  const max = settings.max_failed_logins;
  const recent = await one(
    `SELECT COALESCE(sum(failures), 0)::int AS n FROM login_failures WHERE key = $1 AND last_failed_at > now() - interval '1 hour'`, [key]);
  if (recent.n >= max * ACCOUNT_CEILING_FACTOR) return { blocked: true, ceiling: true };
  await query(
    `INSERT INTO login_failures (key, ip) VALUES ($1, $2)
     ON CONFLICT (key, ip) DO UPDATE SET failures = CASE WHEN login_failures.last_failed_at < now() - interval '1 day' THEN 0 ELSE login_failures.failures END`,
    [key, ip]);
  const row = await one(
    `UPDATE login_failures SET failures = failures + 1, last_failed_at = now(),
       locked_until = CASE WHEN failures + 1 >= $3
         THEN now() + make_interval(mins => LEAST($4, power(2, LEAST(failures + 1 - $3, 20))::int)) ELSE NULL END
     WHERE key = $1 AND ip = $2 AND (locked_until IS NULL OR locked_until <= now())
     RETURNING failures`, [key, ip, max, settings.lockout_minutes]);
  return row ? { blocked: false, failures: row.failures } : { blocked: true };
}

export async function clearAttempts(key, ip) {
  await query('DELETE FROM login_failures WHERE key = $1 AND ip = $2', [key, ip]);
}

// Simple in-memory limiter per client IP across all usernames.
const ipAttempts = new Map();
function ipLimited(ip) {
  const now = Date.now();
  const list = (ipAttempts.get(ip) || []).filter(t => now - t < 15 * 60000);
  list.push(now);
  ipAttempts.set(ip, list);
  if (ipAttempts.size > 10000) {
    for (const [k, v] of ipAttempts) if (!v.some(t => now - t < 15 * 60000)) ipAttempts.delete(k);
  }
  return list.length > 100;
}

export async function login(req, username, password) {
  const settings = await getSettings();
  if (ipLimited(req.ip)) throw tooMany();
  const key = throttleKey('login', username);
  const attempt = await countAttempt(key, req.ip, settings);
  if (attempt.blocked) {
    await audit({ req, actor: { id: null, username: null }, institutionId: null, action: attempt.ceiling ? 'auth.account_throttled' : 'auth.throttled' });
    throw tooMany();
  }
  const user = await one('SELECT * FROM users WHERE lower(username) = lower($1)', [String(username || '').trim()]);
  const ok = await verifyPassword(password, user?.password_hash || DUMMY_HASH);
  if (!user || !user.active || !ok) {
    // Only record the username if it belongs to a real account; people
    // sometimes type their password into the username box.
    await audit({
      req, actor: user ? { id: user.id, username: user.username } : { id: null, username: null }, institutionId: null,
      action: 'auth.login_failed', details: { reason: !user ? 'unknown_user' : !user.active ? 'inactive' : 'bad_password' },
    });
    throw new HttpError(401, 'Incorrect username or password.');
  }
  await clearAttempts(key, req.ip);
  if (user.must_change_password && user.temp_password_expires_at && new Date(user.temp_password_expires_at) < new Date()) {
    await audit({ req, actor: user, institutionId: null, action: 'auth.login_failed', details: { reason: 'temporary_password_expired' } });
    throw new HttpError(401, 'Your temporary password has expired. Ask an administrator to reset it.');
  }
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  return user;
}

// Is this account currently throttled (from any computer)?
export async function lockStatus(usernames, settings) {
  const keys = usernames.map(u => throttleKey('login', u));
  const rows = await many(
    `SELECT key, bool_or(locked_until > now()) AS locked, sum(failures) FILTER (WHERE last_failed_at > now() - interval '1 hour')::int AS recent
     FROM login_failures WHERE key = ANY($1::text[]) GROUP BY key`, [keys]);
  const byKey = new Map(rows.map(r => [r.key, r.locked || (r.recent || 0) >= settings.max_failed_logins * ACCOUNT_CEILING_FACTOR]));
  return new Map(usernames.map((u, i) => [u, !!byKey.get(keys[i])]));
}

export async function unlockAccount(username) {
  await query('DELETE FROM login_failures WHERE key = $1', [throttleKey('login', username)]);
}

const COMMON_PASSWORDS = new Set(`password password1 password123 passw0rd 123456789 1234567890 12345678 qwertyuiop qwerty123
iloveyou welcome123 letmein123 admin123 administrator changeme changeme123 sunshine1 football1 baseball1 monkey123
dragon123 abc123456 trustno1 superman1 starwars1 hospital radiology ultrasound sonography sonoforms
winter2025 summer2025 spring2025 autumn2025 winter2026 summer2026 spring2026 autumn2026`.split(/\s+/));

export function passwordProblems(password, settings, username) {
  const problems = [];
  const p = String(password);
  if (p.length < settings.password_min_length) problems.push(`at least ${settings.password_min_length} characters`);
  if (p.length > 200) problems.push('at most 200 characters');
  if (username && p.toLowerCase().includes(String(username).toLowerCase())) problems.push('must not contain your username');
  if (/^(.)\1+$/.test(p)) problems.push('must not be a single repeated character');
  if (COMMON_PASSWORDS.has(p.toLowerCase()) || COMMON_PASSWORDS.has(p.toLowerCase().replace(/[!.\d]+$/, ''))) problems.push('must not be a common password');
  return problems;
}
