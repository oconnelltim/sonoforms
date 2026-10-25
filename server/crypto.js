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
let auditKey = null;

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
  auditKey = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'sonoforms/audit-chain/v1', 32));
}

// Low-level authenticated encryption of a JSON value. `aad` is bound as
// associated data: the ciphertext only decrypts with exactly the same aad.
// Format: v2.<iv>.<tag>.<ciphertext> (base64). 96-bit IV, 128-bit tag.
export function seal(value, aad) {
  if (!encKey) throw new Error('Encryption keys not initialized');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `v2.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

function openWith(blob, aad, version) {
  const parts = String(blob).split('.');
  if (parts.length !== 4 || parts[0] !== version) throw new Error('Unrecognized ciphertext');
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  // Reject truncated IVs/tags, which would weaken authentication.
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Malformed ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

export function unseal(blob, aad) {
  return openWith(blob, aad, 'v2');
}

// Record-level encryption. Binding "table.column#rowId" means a value can't
// be copied into another column or another patient's row undetected.
export function encrypt(value, context, rowId) {
  if (value === null || value === undefined) return null;
  if (rowId === undefined || rowId === null) throw new Error(`encrypt(${context}) needs a row id`);
  return seal(value, `${context}#${rowId}`);
}

export function decrypt(blob, context, rowId) {
  if (blob === null || blob === undefined) return null;
  return unseal(blob, `${context}#${rowId}`);
}

export const isLegacyCiphertext = blob => typeof blob === 'string' && blob.startsWith('v1.');

// Version-1 ciphertext (before row binding) was bound to the column only.
// Only the upgrade routine (server/upgrade.js) reads it.
export function decryptLegacy(blob, context) {
  if (blob === null || blob === undefined) return null;
  return openWith(blob, context, 'v1');
}

const keyed = (context, value) => crypto.createHmac('sha256', indexKey).update(`${context}\u0000${value}`).digest('hex').slice(0, 40);

// Exact-match index for identifiers (study UID, accession, MRN): only
// surrounding whitespace is ignored, so "1.2.3.12" and "1.2.31.2" differ.
export function exactIndex(value, context) {
  const v = String(value ?? '').trim();
  return v ? keyed(context, v) : null;
}

// Forgiving index for names: case, accents and punctuation are ignored so
// "O'Neil" finds "ONEIL". Only used for searching, never to merge records.
export function normalizeForIndex(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
export function nameIndex(value, context) {
  const v = normalizeForIndex(value);
  return v ? keyed(context, v) : null;
}

// Keyed hash for the audit chain: without the master key, nobody with only
// database access can rewrite entries and recompute a valid chain.
export function auditMac(data) {
  if (!auditKey) throw new Error('Encryption keys not initialized');
  return crypto.createHmac('sha256', auditKey).update(data).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Readable temporary passwords, e.g. "river-copper-71-amber-heron" (~28 bits;
// they expire after 72 hours and sign-in is throttled).
const WORDS = 'amber,birch,cedar,coral,delta,ember,fern,flint,grove,harbor,iris,jade,juniper,kestrel,lark,linen,maple,meadow,onyx,opal,pine,quartz,raven,river,sage,slate,spruce,tidal,umber,violet,willow,zephyr,copper,granite,heron,lotus,marble,orchid,pearl,saffron'.split(',');
export function temporaryPassword() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(10, 100)}-${pick()}-${pick()}`;
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
