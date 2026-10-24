// SPDX-License-Identifier: GPL-3.0-or-later
//
// Sessions, login, and permission checks.
//
// Sessions are random tokens in an HttpOnly, SameSite=Strict cookie; only a
// SHA-256 of the token is stored. State-changing requests must also carry the
// session's CSRF token in an X-CSRF-Token header.

import { one, many, query } from './db.js';
import { config } from './config.js';
import { randomToken, sha256, verifyPassword, DUMMY_HASH } from './crypto.js';
import { getSettings } from './settings.js';
import { audit } from './audit.js';

export const COOKIE = 'sf_session';

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

export async function userInstitutions(user) {
  if (can.superuser(user) || can.admin(user)) {
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
  reply.clearCookie(COOKIE, { path: '/' });
}

// Fastify onRequest hook: attaches req.user and req.session when logged in.
export async function loadSession(req) {
  req.user = null;
  req.session = null;
  const token = req.cookies?.[COOKIE];
  if (!token) return;
  const settings = await getSettings();
  const row = await one(
    `SELECT s.id, s.csrf_token, s.institution_id, s.last_seen_at, s.expires_at,
            u.id AS user_id, u.username, u.display_name, u.roles, u.active, u.must_change_password, u.preferences
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1`, [sha256(token)]);
  if (!row) return;
  const idleMs = settings.session_idle_minutes * 60000;
  if (!row.active || new Date(row.expires_at) < new Date() || Date.now() - new Date(row.last_seen_at).getTime() > idleMs) {
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
  if (req.headers['x-background'] !== '1' && Date.now() - new Date(row.last_seen_at).getTime() > 30000) {
    await query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.id]);
  }
}

// Route guards. Usage: { preHandler: requireAuth(can.rad) }
export function requireAuth(...checks) {
  return async (req) => {
    if (!req.user) throw new HttpError(401, req.sessionExpired ? 'Your session has expired. Please log in again.' : 'Please log in.');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (req.headers['x-csrf-token'] !== req.session.csrf) throw new HttpError(403, 'Invalid security token. Please reload the page.');
    }
    if (req.user.must_change_password && !req.routeOptions?.config?.allowPasswordChange) {
      throw new HttpError(403, 'You must change your password before continuing.', { code: 'MUST_CHANGE_PASSWORD' });
    }
    if (checks.length && !checks.some(check => check(req.user))) throw new HttpError(403, 'You do not have permission to do that.');
  };
}

// The active institution for this session; throws if none.
export function activeInstitution(req) {
  const id = req.session?.institution_id;
  if (!id) throw new HttpError(400, 'No institution selected. Ask an administrator to assign you to an institution.');
  return id;
}

// Simple in-memory limiter for login attempts per IP (in addition to per-account lockout).
const attempts = new Map();
export function loginRateLimited(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter(t => now - t < 15 * 60000);
  attempts.set(ip, list);
  return list.length >= 30;
}
function noteFailedLogin(ip) {
  const list = attempts.get(ip) || [];
  list.push(Date.now());
  attempts.set(ip, list);
}

export async function login(req, username, password) {
  const settings = await getSettings();
  if (loginRateLimited(req.ip)) throw new HttpError(429, 'Too many login attempts. Please wait 15 minutes.');
  const user = await one('SELECT * FROM users WHERE lower(username) = lower($1)', [String(username || '').trim()]);
  const ok = await verifyPassword(password, user?.password_hash || DUMMY_HASH);
  const fail = async (reason) => {
    noteFailedLogin(req.ip);
    await audit({ req, actor: user ? { id: user.id, username: user.username } : { id: null, username: String(username).slice(0, 64) }, institutionId: null, action: 'auth.login_failed', details: { reason } });
    return new HttpError(401, 'Incorrect username or password.');
  };
  if (!user) throw await fail('unknown_user');
  if (!user.active) throw await fail('inactive');
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    await audit({ req, actor: user, institutionId: null, action: 'auth.login_failed', details: { reason: 'locked' } });
    throw new HttpError(423, 'This account is temporarily locked after too many failed attempts. Try again later or ask an administrator to unlock it.');
  }
  if (!ok) {
    const failed = user.failed_logins + 1;
    const lock = failed >= settings.max_failed_logins;
    await query(
      `UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1`,
      [user.id, lock ? 0 : failed, lock, settings.lockout_minutes]);
    if (lock) await audit({ req, actor: user, institutionId: null, action: 'auth.account_locked' });
    throw await fail('bad_password');
  }
  await query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
  return user;
}

export function passwordProblems(password, settings, username) {
  const problems = [];
  if (String(password).length < settings.password_min_length) problems.push(`at least ${settings.password_min_length} characters`);
  if (username && String(password).toLowerCase().includes(String(username).toLowerCase())) problems.push('must not contain your username');
  if (/^(.)\1+$/.test(password)) problems.push('must not be a single repeated character');
  return problems;
}
