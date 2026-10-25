// SPDX-License-Identifier: GPL-3.0-or-later
//
// Security review 2026-10: identifiers (MRN, accession, study UID) are now
// matched exactly instead of after stripping punctuation, the MRN key
// includes the issuer, indexes are scoped per institution, and encrypted
// values are bound to their row.

import { upgradeLegacyRows } from '../upgrade.js';

export async function up(client, log) {
  await client.query('ALTER TABLE patients ADD COLUMN mrn_search_bidx text');
  await client.query('CREATE INDEX patients_mrn_search_idx ON patients (institution_id, mrn_search_bidx)');
  await upgradeLegacyRows(client, log);
}
