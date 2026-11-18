// SPDX-License-Identifier: GPL-3.0-or-later
//
// Development demo: sends synthetic scanner reports (DICOM SR) over DICOM to
// the dev server's receiver, for two of the fake PACS's demo patients:
//   - DEMO^ALICE   (US PELVIS COMPLETE TRANSVAGINAL): both ovaries
//   - SAMPLE^KAREN (US CAROTID DUPLEX BILATERAL): both carotids, with a
//                  50-69% left ICA stenosis
// With `npm run dev` running:
//   npm run demo:sr
// Then start (or reopen) those patients' forms on the tech worklist.

import dimse from 'dcmjs-dimse';
import { mockStudies } from '../server/dicom.js';
import { carotidSR, ovariesSR } from './lib/demo-sr.js';

const { Client, Dataset } = dimse;
const { CStoreRequest } = dimse.requests;
const PORT = Number(process.env.SCANNER_PORT || 11113);

const studies = mockStudies({ id: 1 });
const find = desc => studies.find(s => s.StudyDescription === desc);
const reports = [
  ['pelvis', ovariesSR(find('US PELVIS COMPLETE TRANSVAGINAL'), { right: [3.153901, 1.589761, 2.857344], left: [2.367066, 1.568643, 2.249995] })],
  ['carotid', carotidSR(find('US CAROTID DUPLEX BILATERAL'), {
    right: { cca: [67.69554, 18.1304], ica: [61.15188, 28.55493], eca: [58.55685, 5.086228] },
    left: { cca: [72.4, 20.1], ica: [142.0, 41.2], eca: [88.3, 9.8] },
  })],
];

const client = new Client();
for (const [name, ds] of reports) {
  const request = new CStoreRequest(new Dataset(ds));
  request.on('response', r => console.log(`${name}: ${r.getStatus() === 0 ? 'stored' : `refused (status 0x${r.getStatus().toString(16)})`}`));
  client.addRequest(request);
}
client.on('networkError', e => { console.error(`Couldn't reach the scanner receiver on port ${PORT}: ${e.message}. Is npm run dev running?`); process.exitCode = 1; });
client.send('127.0.0.1', PORT, 'MOCKSCANNER', 'SONOFORMS');
