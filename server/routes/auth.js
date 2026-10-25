// SPDX-License-Identifier: GPL-3.0-or-later

import { query, one } from '../db.js';
import { config, ROLE_LABELS } from '../config.js';
import { hashPassword, verifyPassword } from '../crypto.js';
import { getSettings } from '../settings.js';
import { audit } from '../audit.js';
import {
  login, createSession, destroySession, requireAuth, userInstitutions, capabilities,
  canAccessInstitution, passwordProblems, HttpError, countAttempt, clearAttempts, throttleKey,
} from '../auth.js';

export default async function authRoutes(app) {
  // Public info for the login page.
  app.get('/public-info', async () => {
    const s = await getSettings();
    return { app_name: s.app_name, login_banner: s.login_banner };
  });

  app.post('/auth/login', {
    schema: { body: { type: 'object', required: ['username', 'password'], properties: { username: { type: 'string', maxLength: 100 }, password: { type: 'string', maxLength: 500 } } } },
  }, async (req, reply) => {
    const user = await login(req, req.body.username, req.body.password);
    await createSession(reply, req, user);
    await audit({ req, actor: user, institutionId: null, action: 'auth.login' });
    return { ok: true };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.user) await audit({ req, action: 'auth.logout' });
    await destroySession(req, reply);
    return { ok: true };
  });

  app.get('/session', async (req) => {
    const settings = await getSettings();
    if (!req.user) return { user: null, expired: !!req.sessionExpired, app_name: settings.app_name };
    return {
      user: { ...req.user, role_labels: req.user.roles.map(r => ROLE_LABELS[r] || r) },
      can: capabilities(req.user),
      csrf: req.session.csrf,
      institution_id: req.session.institution_id,
      institutions: await userInstitutions(req.user),
      settings: {
        app_name: settings.app_name,
        session_idle_minutes: settings.session_idle_minutes,
        report_line_ending: settings.report_line_ending,
        password_min_length: settings.password_min_length,
        worklist_show_hours: settings.worklist_show_hours,
      },
      version: config.version,
    };
  });

  app.post('/session/institution', {
    preHandler: requireAuth(),
    schema: { body: { type: 'object', required: ['institution_id'], properties: { institution_id: { type: 'integer' } } } },
  }, async (req) => {
    const id = req.body.institution_id;
    if (!(await canAccessInstitution(req.user, id))) throw new HttpError(403, 'You do not have access to that institution.');
    await query('UPDATE sessions SET institution_id = $2 WHERE id = $1', [req.session.id, id]);
    await query("UPDATE users SET preferences = preferences || jsonb_build_object('institution_id', $2::int) WHERE id = $1", [req.user.id, id]);
    await audit({ req, institutionId: id, action: 'session.switch_institution', entityType: 'institution', entityId: id });
    return { ok: true };
  });

  app.put('/session/preferences', {
    preHandler: requireAuth(),
    schema: { body: { type: 'object', properties: { theme: { type: 'string', enum: ['auto', 'light', 'dark'] }, rad_institutions: { type: 'string', maxLength: 20 } }, additionalProperties: false } },
  }, async (req) => {
    await query('UPDATE users SET preferences = preferences || $2::jsonb WHERE id = $1', [req.user.id, JSON.stringify(req.body)]);
    return { ok: true };
  });

  app.post('/auth/password', {
    preHandler: requireAuth(),
    config: { allowPasswordChange: true },
    schema: { body: { type: 'object', required: ['current', 'next'], properties: { current: { type: 'string', maxLength: 500 }, next: { type: 'string', maxLength: 500 } } } },
  }, async (req) => {
    const settings = await getSettings();
    // Throttled like sign-in, so a stolen session can't be used to guess the password.
    const key = throttleKey('password', req.user.id);
    const attempt = await countAttempt(key, req.ip, settings);
    if (attempt.blocked) throw new HttpError(429, 'Too many incorrect attempts. Wait a few minutes and try again.');
    const row = await one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await verifyPassword(req.body.current, row.password_hash))) {
      await audit({ req, action: 'auth.password_change_failed', entityType: 'user', entityId: req.user.id });
      throw new HttpError(400, 'Your current password is incorrect.');
    }
    await clearAttempts(key, req.ip);
    if (req.body.current === req.body.next) throw new HttpError(400, 'The new password must be different from the current one.');
    const problems = passwordProblems(req.body.next, settings, req.user.username);
    if (problems.length) throw new HttpError(400, `The new password needs: ${problems.join(', ')}.`);
    await query('UPDATE users SET password_hash = $2, must_change_password = false, temp_password_expires_at = NULL, password_changed_at = now() WHERE id = $1',
      [req.user.id, await hashPassword(req.body.next)]);
    // Sign out other sessions for this user.
    await query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user.id, req.session.id]);
    await audit({ req, action: 'auth.password_changed', entityType: 'user', entityId: req.user.id });
    return { ok: true };
  });
}
