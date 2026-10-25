#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Command-line administration. In Docker, run via ./manage.sh, e.g.
//   ./manage.sh reset-password admin
//
// Commands:
//   generate-key                 print a new random master key
//   reset-password <username>    set a temporary password and unlock the account
//   unlock <username>            clear failed sign-in pauses for an account
//   create-superuser <username>  create a superuser with a temporary password
//   backup <file|->              write an encrypted backup
//   restore <file> [--wipe]      restore a backup (needs the same master key)
//   verify-audit                 check the audit log hash chain
//   lint-forms [dir]             check form YAML files for mistakes

import fs from 'node:fs';
import path from 'node:path';

const [cmd, ...args] = process.argv.slice(2);
const log = { info: (...a) => console.error(...a), warn: (...a) => console.error(...a), error: (...a) => console.error(...a) };

async function withDb(fn) {
  const { initKeys, hashPassword, temporaryPassword } = await import('./crypto.js');
  const { pool } = await import('./db.js');
  const { migrate } = await import('./migrate.js');
  const { checkMasterKey } = await import('./settings.js');
  initKeys();
  await migrate(log);
  await checkMasterKey();
  try {
    return await fn({ pool, hashPassword, temporaryPassword });
  } finally {
    await pool.end();
  }
}

async function main() {
  switch (cmd) {
    case 'generate-key': {
      const { generateMasterKey } = await import('./crypto.js');
      console.log(generateMasterKey());
      return;
    }
    case 'reset-password':
    case 'create-superuser': {
      const username = args[0];
      if (!username) throw new Error(`Usage: ${cmd} <username>`);
      await withDb(async ({ pool, hashPassword, temporaryPassword }) => {
        const { audit } = await import('./audit.js');
        const password = temporaryPassword();
        const hash = await hashPassword(password);
        if (cmd === 'reset-password') {
          const r = await pool.query(
            `UPDATE users SET password_hash = $2, must_change_password = true, active = true,
               temp_password_expires_at = now() + interval '72 hours'
             WHERE lower(username) = lower($1) RETURNING id`, [username, hash]);
          await pool.query('DELETE FROM login_failures WHERE key = $1', [(await import('./auth.js')).throttleKey('login', username)]);
          if (!r.rowCount) throw new Error(`No user named '${username}'.`);
          await pool.query('DELETE FROM sessions WHERE user_id = $1', [r.rows[0].id]);
          await audit({ action: 'user.reset_password_cli', institutionId: null, entityType: 'user', entityId: r.rows[0].id });
        } else {
          const r = await pool.query(
            `INSERT INTO users (username, display_name, password_hash, roles, must_change_password, temp_password_expires_at)
             VALUES ($1, $1, $2, '{superuser}', true, now() + interval '72 hours') RETURNING id`, [username, hash]);
          await audit({ action: 'user.create_cli', institutionId: null, entityType: 'user', entityId: r.rows[0].id, details: { username, roles: ['superuser'] } });
        }
        console.log(`Temporary password for ${username}: ${password}`);
      });
      return;
    }
    case 'unlock': {
      const username = args[0];
      if (!username) throw new Error('Usage: unlock <username>');
      await withDb(async () => {
        const { unlockAccount } = await import('./auth.js');
        const { audit } = await import('./audit.js');
        await unlockAccount(username);
        await audit({ action: 'user.unlock_cli', institutionId: null, details: { username } });
        console.log(`Cleared failed sign-in pauses for ${username}.`);
      });
      return;
    }
    case 'backup': {
      const target = args[0];
      if (!target) throw new Error('Usage: backup <file>   (use - for standard output)');
      await withDb(async () => {
        const { writeBackup } = await import('./backup.js');
        const { audit } = await import('./audit.js');
        const out = target === '-' ? process.stdout : fs.createWriteStream(target, { mode: 0o600 });
        const result = await writeBackup(out);
        if (target !== '-') await new Promise(r => out.end(r));
        await audit({ action: 'system.backup_cli', institutionId: null, details: { rows: result.rows } });
        log.info(`Backup complete: ${result.rows} rows`);
      });
      return;
    }
    case 'restore': {
      const file = args.find(a => !a.startsWith('--'));
      if (!file) throw new Error('Usage: restore <file> [--wipe]');
      await withDb(async () => {
        const { restoreBackup } = await import('./backup.js');
        const input = file === '-' ? process.stdin : fs.createReadStream(file);
        const result = await restoreBackup(input, { wipe: args.includes('--wipe'), log });
        const { audit } = await import('./audit.js');
        await audit({ action: 'system.restore', institutionId: null, details: { rows: result.rows, backup_created_at: result.header.created_at } });
        log.info(`Restore complete: ${result.rows} rows from a backup made ${result.header.created_at}`);
      });
      return;
    }
    case 'verify-audit': {
      await withDb(async () => {
        const { verifyAuditChain } = await import('./audit.js');
        const r = await verifyAuditChain();
        console.log(r.ok ? `Audit log OK (${r.checked} entries).` : `Audit log BROKEN at entry ${r.brokenAt} (after ${r.checked} good entries).`);
        if (!r.ok) process.exitCode = 2;
      });
      return;
    }
    case 'lint-forms': {
      const YAML = (await import('yaml')).default;
      const { lintForm } = await import('../shared/formdef.js');
      const dir = args[0] || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'forms', 'general');
      let bad = 0;
      for (const f of fs.readdirSync(dir).filter(x => /\.ya?ml$/.test(x)).sort()) {
        let problems;
        try { problems = lintForm(YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch (e) { problems = [{ level: 'error', path: '', message: e.message }]; }
        const errors = problems.filter(p => p.level === 'error');
        bad += errors.length;
        console.log(`${errors.length ? 'FAIL' : 'ok  '} ${f}`);
        for (const p of problems) console.log(`     ${p.level}: ${p.path} ${p.message}`);
      }
      if (bad) process.exitCode = 1;
      return;
    }
    default:
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//   ')).map(l => l.slice(3)).join('\n'));
      if (cmd) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
