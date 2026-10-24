// SPDX-License-Identifier: GPL-3.0-or-later
//
// Encryption at rest for patient data, plus password hashing.
//
// - Patient demographics, study identifiers, form answers and report text
//   are encrypted with AES-256-GCM before they reach the database.
// - Lookups (MRN, accession, study UID, last name) use "blind indexes":
//   keyed HMACs that allow exact-match search without storing plaintext.
// - Both keys are derived from one master key (SONOFORMS_MASTER_KEY), which
//   lives outside the database. Losing it means losing the data, so the
//   installer tells the admin to back it up.

import crypto from 'node:crypto';
import { config } from './config.js';

let encKey = null;
let indexKey = null;

export function generateMasterKey() {
  return crypto.randomBytes(32).toString('base64');
}

export function initKeys(masterKeyB64 = config.masterKey) {
  if (!masterKeyB64) {
    throw new Error('SONOFORMS_MASTER_KEY is not set. Run ./install.sh (or `node server/cli.js generate-key`) to create one.');
  }
  const master = Buffer.from(masterKeyB64, 'base64');
  if (master.length !== 32) throw new Error('SONOFORMS_MASTER_KEY must be 32 bytes, base64-encoded.');
  encKey = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'sonoforms/encryption/v1', 32));
  indexKey = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'sonoforms/blind-index/v1', 32));
}

// Encrypts any JSON-serializable value. `context` (e.g. 'exams.answers') is
// bound as associated data so ciphertext can't be moved between columns.
export function encrypt(value, context) {
  if (value === null || value === undefined) return null;
  if (!encKey) throw new Error('Encryption keys not initialized');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  cipher.setAAD(Buffer.from(context));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

export function decrypt(blob, context) {
  if (blob === null || blob === undefined) return null;
  const [ver, iv, tag, ct] = String(blob).split('.');
  if (ver !== 'v1') throw new Error('Unknown ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

export function normalizeForIndex(value) {
  return String(value ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Deterministic keyed hash for exact-match lookups. Returns null for blank input.
export function blindIndex(value, context) {
  const norm = normalizeForIndex(value);
  if (!norm) return null;
  return crypto.createHmac('sha256', indexKey).update(`${context}:${norm}`).digest('hex').slice(0, 40);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Readable temporary passwords, e.g. "river-copper-71-amber".
const WORDS = 'amber,birch,cedar,coral,delta,ember,fern,flint,grove,harbor,iris,jade,juniper,kestrel,lark,linen,maple,meadow,onyx,opal,pine,quartz,raven,river,sage,slate,spruce,tidal,umber,violet,willow,zephyr,copper,granite,heron,lotus,marble,orchid,pearl,saffron'.split(',');
export function temporaryPassword() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(10, 100)}-${pick()}`;
}

// Password hashing with scrypt (built into Node; no native dependencies).
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

export function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password.normalize('NFKC'), salt, 64, SCRYPT, (err, key) => {
      if (err) return reject(err);
      resolve(`scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`);
    });
  });
}

export function verifyPassword(password, stored) {
  return new Promise(resolve => {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return resolve(false);
    const [, N, r, p, salt, hash] = parts;
    const expected = Buffer.from(hash, 'base64');
    crypto.scrypt(String(password).normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem }, (err, key) => {
        if (err) return resolve(false);
        resolve(crypto.timingSafeEqual(key, expected));
      });
  });
}

// A hash computed once at startup so failed logins for unknown users take
// as long as for real users (avoids revealing which usernames exist).
export const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
