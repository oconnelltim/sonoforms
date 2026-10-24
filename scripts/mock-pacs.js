// SPDX-License-Identifier: GPL-3.0-or-later
//
// A tiny fake PACS for development: answers C-ECHO and study-level C-FIND
// with demo patients, so the real DICOM code path can be tested without a
// hospital PACS.
//
//   npm run mock-pacs            listens on port 11112, AE title MOCKPACS
//
// Then in Admin > Institutions: host 127.0.0.1, port 11112, PACS AE MOCKPACS.

import dimse from 'dcmjs-dimse';
import { mockStudies } from '../server/dicom.js';

const { Server, Scp, Dataset } = dimse;
const { CEchoResponse, CFindResponse } = dimse.responses;
const { Status, PresentationContextResult, SopClass, TransferSyntax } = dimse.constants;
const PORT = Number(process.env.MOCK_PACS_PORT || 11112);

class MockPacs extends Scp {
  associationRequested(association) {
    this.association = association;
    for (const context of association.getPresentationContexts()) {
      const ctx = association.getPresentationContext(context.id);
      if ([SopClass.Verification, SopClass.StudyRootQueryRetrieveInformationModelFind, SopClass.PatientRootQueryRetrieveInformationModelFind].includes(ctx.getAbstractSyntaxUid())) {
        const syntaxes = ctx.getTransferSyntaxUids();
        const ts = syntaxes.includes(TransferSyntax.ImplicitVRLittleEndian) ? TransferSyntax.ImplicitVRLittleEndian : syntaxes[0];
        ctx.setResult(PresentationContextResult.Accept, ts);
      } else {
        ctx.setResult(PresentationContextResult.RejectAbstractSyntaxNotSupported);
      }
    }
    this.sendAssociationAccept();
  }

  cEchoRequest(request, callback) {
    const response = CEchoResponse.fromRequest(request);
    response.setStatus(Status.Success);
    callback(response);
  }

  cFindRequest(request, callback) {
    const query = request.getDataset().getElements();
    const matches = (value, pattern) => {
      if (!pattern) return true;
      const re = new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
      return re.test(String(value ?? ''));
    };
    const studies = mockStudies({ id: 1, name: 'Main Hospital' }).filter(s =>
      matches(s.StudyInstanceUID, query.StudyInstanceUID) &&
      matches(s.ModalitiesInStudy, query.ModalitiesInStudy) &&
      matches(s.InstitutionName, query.InstitutionName));
    console.log(`C-FIND: ${studies.length} result(s) for ${JSON.stringify(Object.fromEntries(Object.entries(query).filter(([, v]) => v)))}`);
    const responses = studies.map(s => {
      const r = CFindResponse.fromRequest(request);
      r.setDataset(new Dataset(s));
      r.setStatus(Status.Pending);
      return r;
    });
    const done = CFindResponse.fromRequest(request);
    done.setStatus(Status.Success);
    responses.push(done);
    callback(responses);
  }

  associationReleaseRequested() {
    this.sendAssociationReleaseResponse();
  }
}

const server = new Server(MockPacs);
server.on('networkError', e => console.error('Network error:', e.message));
server.listen(PORT);
console.log(`Mock PACS listening on port ${PORT} (any AE title accepted)`);
