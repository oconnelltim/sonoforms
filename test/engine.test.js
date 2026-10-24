import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, evaluate, compile } from '../shared/expr.js';
import { FUNCTIONS } from '../shared/functions.js';
import { normalizeForm, lintForm, matchScore, initialAnswers, normalAnswers } from '../shared/formdef.js';
import { createEvaluator, validateAnswers } from '../shared/engine.js';
import { generateReport, renderTemplate, parseTemplate } from '../shared/template.js';

const ctx = vars => ({ lookup: n => (Object.hasOwn(vars, n) ? vars[n] : null), field: () => undefined });
const ev = (src, vars = {}) => evaluate(compile(src), ctx(vars));

test('expressions: arithmetic, comparison, logic', () => {
  assert.equal(ev('1 + 2 * 3'), 7);
  assert.equal(ev('(1 + 2) * 3'), 9);
  assert.equal(ev("a == 'x' and b > 2", { a: 'x', b: 3 }), true);
  assert.equal(ev("a == 'x' && not (b > 2)", { a: 'x', b: 3 }), false);
  assert.equal(ev("a in ['p', 'q']", { a: 'q' }), true);
  assert.equal(ev('a + 1', {}), null, 'missing input propagates null');
  assert.equal(ev("x == ''", {}), true, 'empty equals empty');
  assert.equal(ev('n >= 50', { n: '55' }), true, 'numeric strings compare as numbers');
  assert.throws(() => parse('a = 1'), /Use '=='/);
  assert.throws(() => parse('evil(1)'), /Unknown function/);
  assert.throws(() => parse('constructor(1)'), /Unknown function/);
  assert.equal(ev('constructor'), null);
});

test('functions: volumes and TI-RADS', () => {
  assert.equal(Math.round(FUNCTIONS.ellipsoid([3, 2, 1]) * 100) / 100, 3.14);
  assert.equal(FUNCTIONS.ellipsoid([3, 2, null]), null);
  assert.equal(FUNCTIONS.volume([4, 3, 2], 0.71), 4 * 3 * 2 * 0.71);
  assert.equal(FUNCTIONS.tirads(0), 'TR1');
  assert.equal(FUNCTIONS.tirads(3), 'TR3');
  assert.equal(FUNCTIONS.tirads(5), 'TR4');
  assert.equal(FUNCTIONS.tirads(9), 'TR5');
  assert.equal(FUNCTIONS.tirads_rec('TR4', 1.6), 'FNA recommended');
  assert.equal(FUNCTIONS.tirads_rec('TR4', 1.2), 'Follow-up recommended');
  assert.equal(FUNCTIONS.tirads_rec('TR2', 4), 'No FNA or follow-up indicated');
  assert.equal(FUNCTIONS.ga_from_lmp('2026-01-01', '2026-03-05'), '9w 0d');
});

const sample = normalizeForm({
  id: 'test-pelvis',
  title: 'Test pelvis',
  study_match: ['US PELVIS', 'TRANSVAGINAL'],
  sections: [
    {
      title: 'Uterus',
      fields: [
        { id: 'uterus', type: 'choice', label: 'Uterus', options: [
          { value: 'present', label: 'Present' },
          { value: 'absent', label: 'Surgically absent', text: 'surgically absent' },
        ], default: 'present', required: true },
        { id: 'uterus_dims', type: 'dims', label: 'Size', show_if: "uterus == 'present'", required: true, min: 1, max: 15 },
        { id: 'myometrium', type: 'choice', label: 'Myometrium', show_if: "uterus == 'present'", normal: 'normal', options: [
          { value: 'normal', label: 'Normal', text: 'homogeneous' },
          { value: 'fibroids', label: 'Fibroids', text: 'heterogeneous with fibroids' },
        ], other: true },
      ],
      report: `
{{#if uterus == 'absent'}}
UTERUS: Surgically absent.
{{else}}
UTERUS: Measures {{uterus_dims}}. The myometrium is {{myometrium}}.
{{/if}}`,
    },
    {
      title: 'Ovaries',
      fields: [
        { id: 'r_ovary', type: 'dims', label: 'Right ovary' },
        { id: 'r_ovary_vol', type: 'calc', label: 'Right ovary volume', formula: 'ellipsoid(r_ovary)', unit: 'mL', decimals: 1 },
        { id: 'findings', type: 'multi', label: 'Findings', options: ['Follicles', 'Corpus luteum', 'Cyst'] },
      ],
      report: 'RIGHT OVARY: {{r_ovary}} (volume {{r_ovary_vol}}).{{#if present(findings)}} {{findings | cap}}.{{/if}}',
    },
    {
      title: 'Masses',
      fields: [
        { id: 'masses', type: 'repeat', label: 'Masses', item_label: 'Mass', fields: [
          { id: 'side', type: 'choice', label: 'Side', options: ['Right', 'Left'] },
          { id: 'size', type: 'number', label: 'Size', unit: 'cm' },
        ] },
      ],
      report: `
{{#if count(masses) == 0}}
ADNEXA: No adnexal mass.
{{else}}
ADNEXA:
{{#each masses}}
{{@index}}. {{side | lower}} adnexal mass measuring {{size}}.
{{/each}}
{{/if}}`,
    },
  ],
});

test('form linter accepts the sample and flags mistakes', () => {
  assert.deepEqual(lintForm(sample).filter(p => p.level === 'error'), []);
  const bad = lintForm({
    title: 'Bad',
    sections: [{ title: 'S', fields: [
      { id: 'a', type: 'choice', options: ['X', 'X'] },
      { id: 'b', type: 'number', show_if: "aa == 'x'" },
      { id: 'c', type: 'calc' },
    ], report: '{{#if a}}unterminated' }],
  });
  const msgs = bad.map(p => p.message).join('\n');
  assert.match(msgs, /Duplicate option value 'x'/);
  assert.match(msgs, /Unknown field 'aa'/);
  assert.match(msgs, /needs a formula/);
  assert.match(msgs, /ended before \{\{\/if\}\}/);
});

test('report generation with conditionals, calcs, multi and repeat', () => {
  const data = {
    uterus: 'present', uterus_dims: [8.1, 4.2, 5], myometrium: 'other', myometrium_other: 'adenomyotic',
    r_ovary: [3, 2, 1], findings: ['follicles', 'cyst'],
    masses: [{ side: 'right', size: 2.5 }, { side: 'left', size: 1 }],
  };
  const { text, errors } = generateReport(sample, data);
  assert.deepEqual(errors, []);
  assert.equal(text, [
    'UTERUS: Measures 8.1 x 4.2 x 5 cm. The myometrium is adenomyotic.',
    'RIGHT OVARY: 3 x 2 x 1 cm (volume 3.1 mL). Follicles and Cyst.',
    'ADNEXA:\n1. right adnexal mass measuring 2.5 cm.\n2. left adnexal mass measuring 1 cm.',
  ].join('\n\n'));
});

test('hidden fields are ignored and not required', () => {
  const data = { uterus: 'absent', uterus_dims: [9, 9, 9] };
  const scope = createEvaluator(sample, data);
  assert.equal(scope.lookup('uterus_dims'), null);
  const { missing } = validateAnswers(sample, data);
  assert.deepEqual(missing.map(m => m.id), []);
  assert.match(generateReport(sample, data).text, /^UTERUS: Surgically absent\./);
  const v2 = validateAnswers(sample, { uterus: 'present', uterus_dims: [20, 4] });
  assert.deepEqual(v2.missing.map(m => m.id), ['uterus_dims']);
  assert.equal(v2.warnings.length, 1);
  const v3 = validateAnswers(sample, { uterus: 'present', uterus_dims: ['8.2 x 4', 3, 3] });
  assert.match(v3.missing[0].label, /not a valid number/);
});

test('defaults, normals and study matching', () => {
  assert.deepEqual(initialAnswers(sample), { uterus: 'present' });
  assert.deepEqual(normalAnswers(sample.sections[0]), { myometrium: 'normal' });
  assert.ok(matchScore(sample, 'US PELVIS COMPLETE TRANSVAGINAL') > 0);
  assert.equal(matchScore(sample, 'US THYROID'), 0);
  assert.equal(matchScore({ study_match: ['RENAL'] }, 'US ADRENAL'), 0, 'whole words only');
  assert.ok(matchScore({ study_match: ['/\\bRUQ\\b/'] }, 'US RUQ LIMITED') > 0, 'regex case preserved');
  assert.ok(matchScore({ study_match: ['ABDOMEN PELVIS'] }, 'US ABDOMEN AND PELVIS') > matchScore({ study_match: ['/PELVI(S|C)/'] }, 'US ABDOMEN AND PELVIS'));
});

test('template whitespace: standalone tags vanish, inline tags stay', () => {
  const scope = createEvaluator(sample, { uterus: 'present' });
  assert.equal(renderTemplate('A\n  {{#if true}}\nB\n  {{/if}}\nC', scope), 'A\nB\nC');
  assert.equal(renderTemplate('A {{#if false}}x{{/if}}.', scope), 'A.');
  assert.throws(() => parseTemplate('{{x | bogus}}'), /Unknown filter/);
});
