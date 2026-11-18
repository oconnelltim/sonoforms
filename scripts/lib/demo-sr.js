// SPDX-License-Identifier: GPL-3.0-or-later
//
// Synthetic scanner reports (DICOM SR) for demos and tests, built the way a
// GE LOGIQ E9 builds them: TID 5100 vascular reports with each vessel as a
// container and the side as a Laterality modifier, and TID 5000 OB-GYN
// reports with the side in the measurement code, each value recorded per
// attempt and again as the chosen mean. No real patient data.

const code = (value, scheme, meaning) => [{ CodeValue: value, CodingSchemeDesignator: scheme, CodeMeaning: meaning }];
const UCUM = u => code(u, 'UCUM', u);
const container = (concept, children, mods = []) => ({
  RelationshipType: 'CONTAINS', ValueType: 'CONTAINER', ContinuityOfContent: 'SEPARATE', ConceptNameCodeSequence: concept,
  ContentSequence: [...mods, ...children],
});
const mod = (rel, concept, value) => ({ RelationshipType: rel, ValueType: 'CODE', ConceptNameCodeSequence: concept, ConceptCodeSequence: value });
const num = (concept, value, unit, mods = []) => ({
  RelationshipType: 'CONTAINS', ValueType: 'NUM', ConceptNameCodeSequence: concept,
  MeasuredValueSequence: [{ NumericValue: value, MeasurementUnitsCodeSequence: UCUM(unit) }],
  ...(mods.length ? { ContentSequence: mods } : {}),
});
const chosen = (derivation, status) => [
  mod('HAS CONCEPT MOD', code('121401', 'DCM', 'Derivation'), derivation),
  mod('HAS PROPERTIES', code('121404', 'DCM', 'Selection Status'), status),
];
const USER_CHOSEN = code('121410', 'DCM', 'User chosen value');
const MAXIMUM = code('G-A437', 'SRT', 'Maximum');
const BEST = code('R-002E1', 'SRT', 'Best value');
const MEAN = code('R-00317', 'SRT', 'Mean');
const MEAN_CHOSEN = code('121412', 'DCM', 'Mean value chosen');
const PSV = code('11726-7', 'LN', 'Peak Systolic Velocity');
const EDV = code('11653-3', 'LN', 'End Diastolic Velocity');
const VESSELS = { cca: code('T-45100', 'SRT', 'Common Carotid Artery'), ica: code('T-45300', 'SRT', 'Internal Carotid Artery'), eca: code('T-45200', 'SRT', 'External Carotid Artery') };
const SIDES = { right: code('G-A100', 'SRT', 'Right'), left: code('G-A101', 'SRT', 'Left') };

function base(study, title, tid, uidSuffix) {
  return {
    SpecificCharacterSet: 'ISO_IR 100',
    SOPClassUID: '1.2.840.10008.5.1.4.1.1.88.33',
    SOPInstanceUID: `${study.StudyInstanceUID}.99.${uidSuffix}`,
    SeriesInstanceUID: `${study.StudyInstanceUID}.99`,
    StudyInstanceUID: study.StudyInstanceUID,
    StudyDate: study.StudyDate, StudyTime: study.StudyTime, ContentDate: study.StudyDate, ContentTime: study.StudyTime,
    Modality: 'SR', Manufacturer: 'GE Healthcare', ManufacturerModelName: 'LOGIQE9', SoftwareVersions: 'LOGIQE9:R6.1.7',
    PatientName: study.PatientName, PatientID: study.PatientID, PatientBirthDate: study.PatientBirthDate, PatientSex: study.PatientSex,
    AccessionNumber: '', CompletionFlag: 'PARTIAL', VerificationFlag: 'UNVERIFIED',
    ValueType: 'CONTAINER', ContinuityOfContent: 'SEPARATE', ConceptNameCodeSequence: title,
    ContentTemplateSequence: [{ MappingResource: 'DCMR', TemplateIdentifier: tid }],
  };
}

// Carotid duplex. values: { right: { cca: [psv, edv], ica: [psv, edv], eca: [psv, edv] }, left: … }
export function carotidSR(study, values) {
  const ds = base(study, code('125100', 'DCM', 'Vascular Ultrasound Procedure Report'), '5100', 1);
  ds.ContentSequence = Object.entries(values).map(([side, vessels]) => container(code('121070', 'DCM', 'Findings'),
    [
      ...Object.entries(vessels).map(([v, [psv, edv]]) => container(VESSELS[v], [
        num(PSV, psv, 'cm/s', chosen(MAXIMUM, USER_CHOSEN)),
        num(EDV, edv, 'cm/s', chosen(BEST, USER_CHOSEN)),
        num(code('125106', 'DCM', 'Doppler Angle'), 60, 'deg', chosen(BEST, USER_CHOSEN)),
      ])),
      num(code('33868-1', 'LN', 'ICA/CCA velocity ratio'), Math.round(vessels.ica[0] / vessels.cca[0] * 1e4) / 1e4, '1',
        [mod('HAS CONCEPT MOD', code('R-4089A', 'SRT', 'Cardiac Cycle Point'), code('R-FAB5B', 'SRT', 'End Systole'))]),
    ],
    [
      mod('HAS CONCEPT MOD', code('G-C0E3', 'SRT', 'Finding Site'), code('T-45005', 'SRT', 'Artery of Neck')),
      mod('HAS CONCEPT MOD', code('G-C171', 'SRT', 'Laterality'), SIDES[side]),
    ]));
  return ds;
}

const OVARY = { right: { length: '11841-4', height: '11858-8', width: '11830-7', volume: '12165-7' }, left: { length: '11840-6', height: '11857-0', width: '11829-9', volume: '12164-0' } };
const cap = s => s[0].toUpperCase() + s.slice(1);

// Ovaries, as in a gynecology study. values: { right: [length, height, width] (cm), left: … }
export function ovariesSR(study, values) {
  const ds = base(study, code('125000', 'DCM', 'OB-GYN Ultrasound Procedure Report'), '5000', 2);
  const ovaries = Object.entries(values).map(([side, [l, h, w]]) => {
    const c = OVARY[side];
    const twice = (lc, name, v) => [num(code(lc, 'LN', `${cap(side)} Ovary ${name}`), v, 'cm'), num(code(lc, 'LN', `${cap(side)} Ovary ${name}`), v, 'cm', chosen(MEAN, MEAN_CHOSEN))];
    return container(code('T-87000', 'SRT', 'Ovary'), [
      num(code(c.volume, 'LN', `${cap(side)} Ovary Volume`), Math.round(Math.PI / 6 * l * h * w * 1e6) / 1e6, 'ml'),
      ...twice(c.length, 'Length', l), ...twice(c.height, 'Height', h), ...twice(c.width, 'Width', w),
    ]);
  });
  ds.ContentSequence = [container(code('121070', 'DCM', 'Findings'), ovaries,
    [mod('HAS OBS CONTEXT', code('G-C0E3', 'SRT', 'Finding Site'), code('T-87000', 'SRT', 'Ovary'))])];
  return ds;
}
