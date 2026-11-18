// SPDX-License-Identifier: GPL-3.0-or-later
//
// DICOM receiver for scanner reports: ultrasound machines (or the hospital's
// integration engine) send their Structured Reports here with C-STORE when a
// study is done. Only scanners listed for an institution (Admin >
// Institutions > Scanners) may connect, only SR objects are accepted, and
// each report goes into that institution's holding area (scanner.js).
//
// Enabled by SCANNER_PORT. C-ECHO is answered so a connection can be tested.

import dimse from 'dcmjs-dimse';
import { many } from './db.js';
import { audit, auditOnce } from './audit.js';
import { storeReport } from './scanner.js';
import { SR_SOP_CLASSES } from './sr.js';
import { config } from './config.js';

const { Server, Scp } = dimse;
const { CEchoResponse, CStoreResponse } = dimse.responses;
const { Status, PresentationContextResult, RejectResult, RejectSource, RejectReason, SopClass, TransferSyntax } = dimse.constants;

// In development with DICOM_MOCK, the demo script sends as this scanner.
export const MOCK_SCANNER_AE = 'MOCKSCANNER';

// The institution a scanner belongs to, and the AE title it must address
// (that institution's own, "Our AE title"). null if it isn't listed, or is
// listed by more than one institution.
export async function institutionForScanner(callingAe) {
  const ae = String(callingAe || '').trim().toUpperCase();
  const rows = await many("SELECT id, dicom FROM institutions WHERE active AND dicom->'scanners' ? $1", [ae]);
  if (rows.length === 1) return { id: rows[0].id, ourAe: rows[0].dicom?.calling_ae || 'SONOFORMS' };
  if (!rows.length && config.dicomMock && ae === MOCK_SCANNER_AE) {
    const first = (await many('SELECT id FROM institutions WHERE active ORDER BY id LIMIT 1'))[0];
    return first ? { id: first.id, ourAe: null } : null;
  }
  return null;
}

class ScannerScp extends Scp {
  async associationRequested(association) {
    this.association = association;
    const calling = association.getCallingAeTitle();
    const called = association.getCalledAeTitle();
    let inst = null;
    try { inst = await institutionForScanner(calling); } catch { /* treated as unknown */ }
    if (!inst) {
      await auditOnce(`scanner-reject:${calling}`, 15 * 60000, { action: 'security.scanner_rejected', institutionId: null, details: { calling_ae: calling, reason: 'not a listed scanner' } }).catch(() => {});
      this.sendAssociationReject(RejectResult.Permanent, RejectSource.ServiceUser, RejectReason.CallingAeNotRecognized);
      return;
    }
    if (inst.ourAe && String(called || '').trim().toUpperCase() !== inst.ourAe) {
      this.sendAssociationReject(RejectResult.Permanent, RejectSource.ServiceUser, RejectReason.CalledAeNotRecognized);
      return;
    }
    this.institutionId = inst.id;
    for (const pc of association.getPresentationContexts()) {
      const ctx = association.getPresentationContext(pc.id);
      const sop = ctx.getAbstractSyntaxUid();
      if (sop !== SopClass.Verification && !SR_SOP_CLASSES[sop]) {
        ctx.setResult(PresentationContextResult.RejectAbstractSyntaxNotSupported);
        continue;
      }
      const offered = ctx.getTransferSyntaxUids();
      const ts = [TransferSyntax.ExplicitVRLittleEndian, TransferSyntax.ImplicitVRLittleEndian].find(t => offered.includes(t));
      if (ts) ctx.setResult(PresentationContextResult.Accept, ts);
      else ctx.setResult(PresentationContextResult.RejectTransferSyntaxesNotSupported);
    }
    this.sendAssociationAccept();
  }

  cEchoRequest(request, callback) {
    const response = CEchoResponse.fromRequest(request);
    response.setStatus(Status.Success);
    callback(response);
  }

  async cStoreRequest(request, callback) {
    const response = CStoreResponse.fromRequest(request);
    const calling = this.association.getCallingAeTitle();
    try {
      const { id, matched, replaced, report } = await storeReport(this.institutionId, request.getDataset().getElements(), calling);
      await audit({
        action: 'scanner.report_received', institutionId: this.institutionId, entityType: 'scanner_report', entityId: id,
        details: { calling_ae: calling, device: report.summary.device, template: report.summary.template, matched_exam: matched, replaced, measurements: report.measurements.length },
      });
      response.setStatus(Status.Success);
    } catch (e) {
      await audit({ action: 'scanner.report_refused', institutionId: this.institutionId, details: { calling_ae: calling, reason: String(e.message).slice(0, 200) } }).catch(() => {});
      response.setStatus(/not a supported structured report/.test(e.message) ? Status.DataSetSopClassMismatch : Status.ProcessingFailure);
    }
    callback(response);
  }

  associationReleaseRequested() {
    this.sendAssociationReleaseResponse();
  }
}

// Starts listening; returns the server (call .close() to stop).
export function startScannerReceiver(port, log = console) {
  const server = new Server(ScannerScp);
  server.on('networkError', e => log.warn({ err: e.message }, 'Scanner receiver network error'));
  server.listen(port);
  log.info(`Receiving scanner reports (DICOM SR) on port ${port}`);
  return server;
}
