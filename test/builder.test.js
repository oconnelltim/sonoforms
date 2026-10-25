// Logic behind the visual form builder (shared/builder/*).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';
import { parseCondition, serializeCondition, describeCondition } from '../shared/builder/conditions.js';
import { renameInExpression, renameInTemplate, findReferences, uniqueFieldId } from '../shared/builder/refs.js';
import { tokenize, join, chipLabel, defaultSectionTemplate } from '../shared/builder/template-tokens.js';
import { createDocTools } from '../shared/builder/yamldoc.js';
import { normalizeForm, lintForm } from '../shared/formdef.js';
import { generateReport } from '../shared/template.js';

const tools = createDocTools(YAML);
const pelvisSrc = fs.readFileSync('forms/general/us-pelvis-female.yaml', 'utf8');
const pelvis = normalizeForm(YAML.parse(pelvisSrc));
const lookup = (id) => {
  for (const s of pelvis.sections) for (const f of s.fields) if (f.id === id) return f;
  return undefined;
};

test('conditions: simple rules round-trip through the row editor', () => {
  for (const src of [
    "uterus_status == 'present'",
    "r_ovary_status != 'absent' and lmp_status in ['postmenopausal', 'unknown']",
    "has(indication, 'pain_r') or has(indication, 'pain_l')",
    'not has(indication, \'iud\')',
    'patient.age >= 50',
    'duplex',
    'not tv_declined',
    'present(comparison)',
  ]) {
    const cond = parseCondition(src);
    assert.ok(cond, `parses: ${src}`);
    assert.equal(serializeCondition(cond), src);
  }
  assert.equal(parseCondition("a == 'x' and b == 'y' or c == 'z'"), null, 'mixed and/or is left as text');
  assert.equal(parseCondition('round(x, 1) > 3'), null, 'calculations are left as text');
  assert.deepEqual(parseCondition(''), { join: 'and', rows: [] });
  assert.equal(serializeCondition({ join: 'and', rows: [{ field: 'a', op: '==', value: "O'Neil" }] }), "a == 'O\\'Neil'");
});

test('conditions: described in plain words', () => {
  assert.equal(describeCondition("r_ovary_status == 'seen'", lookup), 'Right ovary is Visualized');
  assert.equal(describeCondition("approach in ['tv', 'both']", lookup), 'Approach is one of Endovaginal or Both');
});

test('renaming a field updates expressions and report text, not quoted text or filters', () => {
  assert.equal(renameInExpression("size > 2 and label == 'size' and size_other", 'size', 'dims'), "dims > 2 and label == 'size' and dims_other");
  assert.equal(renameInExpression('sizes + size.x + my_size', 'size', 'dims'), 'sizes + size.x + my_size');
  assert.equal(renameInTemplate('Size {{size}} {{size | cap}} {{#if size > 1}}big{{/if}} size', 'size', 'dims'), 'Size {{dims}} {{dims | cap}} {{#if dims > 1}}big{{/if}} size');
  assert.equal(renameInTemplate('{{cap | cap}}', 'cap', 'capsule'), '{{capsule | cap}}');
});

test('finding what depends on a field', () => {
  const where = findReferences(pelvis, 'uterus_status').map(h => h.where).join(' | ');
  assert.match(where, /"Uterus" report text/);
  assert.match(where, /"Uterus size"'s show-only-when rule/);
  assert.match(where, /"Endometrium" section's show-only-when rule/);
  assert.deepEqual(findReferences(pelvis, 'tech_impression'), []);
});

test('new field ids are readable and unique', () => {
  assert.equal(uniqueFieldId(pelvis, 'Uterus size'), 'uterus_size');
  assert.equal(uniqueFieldId(pelvis, 'Uterus'), 'uterus');
  assert.equal(uniqueFieldId(pelvis, 'Comparison'), 'comparison_2');
  assert.equal(uniqueFieldId(pelvis, '3rd trimester'), 'f_3rd_trimester');
  assert.equal(uniqueFieldId(pelvis, 'constructor'), 'constructor_field');
});

test('report text splits into chips and joins back exactly', () => {
  for (const s of pelvis.sections) {
    if (typeof s.report !== 'string') continue;
    assert.equal(join(tokenize(s.report)), s.report);
  }
  const tokens = tokenize("Measures {{r_ovary}} and {{indication | cap}}. {{#if r_ovary_status == 'seen'}}x{{else}}y{{/if}} {{ round(a, 1) }} {{ unclosed");
  const labels = tokens.filter(t => t.kind === 'tag').map(t => chipLabel(t, lookup));
  assert.deepEqual(labels, ['Size', 'Indication · capitalized', 'If Right ovary is Visualized', 'Otherwise', 'End if', '= round(a, 1)']);
  assert.equal(tokens.at(-1).text, ' {{ unclosed', 'unclosed tags stay as text');
});

test('"Start from the fields" drafts valid report text', () => {
  for (const s of pelvis.sections) {
    const draft = defaultSectionTemplate(s);
    const def = normalizeForm({ title: 't', sections: [{ ...s, report: draft }] });
    const errors = lintForm(def).filter(p => p.level === 'error' && p.path.endsWith('.report'));
    assert.deepEqual(errors, [], `${s.title}: ${draft}`);
    assert.deepEqual(generateReport(def, {}).errors, []);
  }
});

test('YAML edits change only what was edited and keep comments and styles', () => {
  const doc = tools.parse(pelvisSrc);
  assert.equal(tools.stringify(doc), pelvisSrc, 'untouched round trip is exact');
  tools.setProp(doc, [3, 0], 'label', 'Endometrial thickness (double-layer)');
  let out = tools.stringify(doc);
  assert.equal(out.split('\n').filter((l, i) => l !== pelvisSrc.split('\n')[i]).length, 1);
  assert.ok(out.startsWith('# Starter form'));
  // Multi-line report text stays a readable block.
  tools.setProp(doc, [3], 'report', 'ENDOMETRIUM: {{endo_thickness}}.\nSecond line.\n');
  out = tools.stringify(doc);
  assert.match(out, /report: \|\n\s+ENDOMETRIUM: \{\{endo_thickness\}\}\.\n\s+Second line\./);
  // New keys go in a sensible place; blank values remove keys.
  tools.setProp(doc, [3, 0], 'help', 'Measure in the sagittal plane');
  const keys = Object.keys(YAML.parse(tools.stringify(doc)).sections[3].fields[0]);
  assert.ok(keys.indexOf('help') === keys.indexOf('label') + 1, keys.join(','));
  tools.setProp(doc, [3, 0], 'help', '');
  assert.equal(YAML.parse(tools.stringify(doc)).sections[3].fields[0].help, undefined);
});

test('YAML edits: options, insert, move and delete', () => {
  const doc = tools.parse(pelvisSrc);
  tools.setOptions(doc, [0, 1], [{ value: 'date', label: 'Date known' }, { value: 'pm', label: 'Postmenopausal', text: 'postmenopausal' }]);
  assert.match(tools.stringify(doc), /- \{ value: pm, label: Postmenopausal, text: postmenopausal \}/);
  const at = tools.insert(doc, [0], 1, { id: 'new_q', type: 'text', label: 'New question' });
  assert.equal(at, 1);
  let def = YAML.parse(tools.stringify(doc));
  assert.equal(def.sections[0].fields[1].id, 'new_q');
  const moved = tools.move(doc, [0, 1], [2], 0);
  assert.deepEqual(moved, [2, 0]);
  def = YAML.parse(tools.stringify(doc));
  assert.equal(def.sections[2].fields[0].id, 'new_q');
  assert.notEqual(def.sections[0].fields[1].id, 'new_q');
  tools.move(doc, [0], [], 3);
  def = YAML.parse(tools.stringify(doc));
  assert.equal(def.sections[2].id, 'clinical', 'sections reorder');
  tools.remove(doc, [1, 0]);
  def = YAML.parse(tools.stringify(doc));
  assert.notEqual(def.sections[1].fields[0]?.id, 'new_q');
});

test('YAML edits: renaming rewrites references across the form', () => {
  const doc = tools.parse(pelvisSrc);
  tools.setProp(doc, [2, 0], 'id', 'uterus_seen');
  tools.rewriteStrings(doc, ['show_if', 'required', 'formula'], v => renameInExpression(v, 'uterus_status', 'uterus_seen'));
  tools.rewriteStrings(doc, ['report', 'header', 'footer'], v => renameInTemplate(v, 'uterus_status', 'uterus_seen'));
  const out = tools.stringify(doc);
  assert.ok(!out.includes('uterus_status'));
  assert.deepEqual(lintForm(YAML.parse(out)).filter(p => p.level === 'error'), []);
});
