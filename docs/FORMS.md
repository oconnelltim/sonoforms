# Writing forms

Each form is a single YAML document. It describes two things side by side:

1. **What the technologist fills in.** Sections of fields: choices, measurements, check boxes.
2. **What the radiologist gets.** A report template for each section that turns the answers into findings text.

Forms are edited in **Forms** inside the app. The editor shows a live preview of the tech's form and of the generated report as you type. Every save is a *draft*. Techs keep using the last *published* version until you publish the draft. Old exams always keep the version they were filled in with.

Starter forms live in `forms/general/` and are loaded into the general library on first start. These starter forms have not been clinically validated. Have your radiologists review the wording before going live.

## Skeleton

```yaml
id: us-thyroid                  # unique, lowercase, hyphens. Cannot change once created.
title: US Thyroid
description: Thyroid and neck ultrasound   # optional, shown to techs
study_match:                    # used to auto-pick this form from the DICOM study description
  - THYROID
  - US NECK SOFT TISSUE
report:                         # optional, applies to the whole report
  separator: "\n\n"             # between sections (default: blank line)
  header: "FINDINGS:"           # optional template placed before all sections
  footer: ""                    # optional template placed after all sections
sections:
  - id: right_lobe
    title: Right lobe
    fields: [ ... ]
    report: |
      RIGHT LOBE: ...
```

### study_match

Each entry is a set of whole words that must *all* appear in the study description (case-insensitive, any order). `US PELVIS` matches "US PELVIS COMPLETE TRANSVAGINAL", and `RENAL` does not match "ADRENAL". Entries with more words are more specific and win over shorter ones. An entry that exactly equals the description wins outright. The tech can always pick a different form.

## Fields

Every field has an `id` (letters, numbers, underscores) and usually a `label`. Common keys:

| key | meaning |
|---|---|
| `type` | one of the types below (default `text`) |
| `label` | what the tech sees |
| `help` | small hint text under the field |
| `required` | `true`, or an expression, e.g. `required: "uterus == 'present'"` |
| `show_if` | expression; field is hidden (and ignored in the report) unless true |
| `default` | value filled in when the form is started |
| `normal` | value set by the section's **Normal** button |
| `width` | `short` to put several small fields on one row |

Sections can also have `show_if`.

### Types

| type | value | notes |
|---|---|---|
| `choice` | one option | shown as big touch-friendly buttons. `layout: dropdown` for long lists |
| `multi` | list of options | check-all-that-apply. Reports as "a, b, and c"; `conjunction: or` gives "a, b, or c" |
| `number` | number | `unit`, `decimals` (fixed places, e.g. `1` gives "6.0"), `min`/`max` (outside range = warning, not an error) |
| `dims` | list of numbers | a measurement set, default axes `[L, AP, W]` in `cm`. Change with `axes:` and `unit:` |
| `calc` | computed | read-only; `formula:` expression, `unit`, `decimals` |
| `text` / `textarea` | text | free text; use sparingly, structured fields make better reports. `rows:` sets textarea height |
| `boolean` | true/false | a single check box. `true_text`/`false_text` control report wording |
| `date` | YYYY-MM-DD | rendered as MM/DD/YYYY in reports |
| `repeat` | list of items | a repeating group (e.g. nodules, masses), with its own `fields:` |
| `note` | none | instructions to the tech, `label:` holds the text |

### Options

```yaml
options:
  - value: normal                  # stored value, used in expressions
    label: Normal                  # what the tech sees
    text: normal in size and echotexture   # what goes into the report (defaults to label)
  - value: increased
    label: Increased echogenicity
    text: diffusely increased in echogenicity, suggesting hepatic steatosis
  - Coarsened                      # shorthand: value "coarsened", label/text "Coarsened"
other: true                        # adds "Other" with a free-text box; the typed text goes into the report
```

Options can also carry `points:` for scoring systems (see TI-RADS below).

### Repeat groups

```yaml
- id: nodules
  type: repeat
  label: Nodules
  item_label: Nodule          # buttons say "Add nodule"
  max_items: 10
  fields:
    - { id: location, type: choice, label: Location, options: [Upper, Mid, Lower] }
    - { id: size, type: dims, label: Size }
```

Inside a repeat, field ids refer to the current item. Fields outside the repeat are still visible.

## Expressions

Used in `show_if`, `required`, `formula` and inside report templates.

```
uterus == 'present'
uterus != 'absent' and lmp_status == 'postmenopausal'
has(indication, 'pain')              # multi contains a value
technique in ['tv', 'both']
count(nodules) > 0
patient.age >= 50 and patient.sex == 'F'
round(ellipsoid(r_ovary), 1)
```

Operators: `== != < <= > >= + - * / %`, `and or not` (or `&& || !`), `in [..]`, parentheses.

Context values: `patient.age`, `patient.sex` (`M`/`F`/`O`), `exam.date`, `exam.study_description`, `institution.name`, `institution.code`. Patient name and MRN are deliberately not available, so they never end up in findings text.

### Functions

| function | result |
|---|---|
| `ellipsoid(dims)` or `ellipsoid(a, b, c)` | π/6 × a × b × c (cm → mL) |
| `volume(dims, factor)` | a × b × c × factor, e.g. `volume(testis, 0.71)` |
| `max_dim(dims)`, `dim(dims, 0)` | largest dimension / a single axis (0-based) |
| `round(x, d)`, `fixed(x, d)`, `floor`, `ceil`, `abs`, `sqrt`, `pow` | arithmetic |
| `min(..)`, `max(..)`, `sum(..)`, `avg(..)`, `product(..)`, `ratio(a, b)` | ignore blanks |
| `count(list)`, `has(list, v)`, `has_any(list, v1, v2..)`, `empty(x)`, `present(x)` | |
| `if(cond, a, b)`, `coalesce(a, b, ..)` | |
| `points(field1, field2, ..)` | sum of `points:` of the selected options |
| `label(field)`, `text(field)` | label / report text of the selected option(s) |
| `shown(field)` | true if the field is currently visible |
| `tirads(points)` → `TR1`..`TR5`; `tirads_rec(level, max_cm)` | ACR TI-RADS |
| `days_between(d1, d2)`, `ga_from_lmp(lmp, exam.date)` | dates |
| `lower(s)`, `upper(s)`, `join(list, sep)` | text |

A calculated field that is hidden by `show_if` has no value. Missing inputs make a result blank rather than an error, so a calculated field stays empty until its measurements are filled in.

## Report templates

A section's `report:` is text with placeholders:

```yaml
report: |
  {{#if liver == 'normal'}}
  LIVER: Normal in size and echotexture. No focal lesion.
  {{else}}
  LIVER: Measures {{liver_length}}. The liver is {{liver_echo}}.
  {{#if present(liver_lesions)}}
  {{liver_lesions | sentence}}
  {{/if}}
  {{/if}}
```

* `{{ field }}` prints the field's report text: the option `text`, a multi as "a, b, and c", a number with its unit, dims as "3.1 x 2.0 x 2.5 cm".
* Filters: `{{ field | num }}` (number without unit), `| cap` (capitalize the first letter), `| sentence` (capitalize and end with a period), `| upper`, `| lower`, `| raw` (stored value).
* `{{ expression }}`, e.g. `{{ round(ellipsoid(r_ovary), 1) }} mL`.
* `{{#if expr}} … {{else if expr}} … {{else}} … {{/if}}`
* `{{#each repeat_field}} … {{/each}}`, with `{{@index}}` (1, 2, 3…) and `@first`, `@last`, `@count` inside.
* `{{! comment }}` is ignored.

Lines containing only `{{#if}}`, `{{else}}`, `{{/if}}`, `{{#each}}` or `{{/each}}` disappear from the output, so lay templates out one tag per line. Doubled spaces and spaces before punctuation left behind by empty values are cleaned up automatically. A section whose template produces nothing is left out of the report.

If a section has no `report:`, a plain "TITLE: Label: value. Label: value." line is generated. That's handy while drafting. Use `report: false` to leave a section (e.g. a tech-only checklist) out of the report entirely.

## Worked example: scoring

```yaml
- id: composition
  type: choice
  label: Composition
  options:
    - { value: cystic, label: Cystic, points: 0 }
    - { value: mixed, label: Mixed cystic and solid, points: 1 }
    - { value: solid, label: Solid, points: 2 }
- id: tr_points
  type: calc
  label: TI-RADS points
  formula: points(composition, echogenicity, shape, margin, foci)
- id: tr_level
  type: calc
  label: TI-RADS level
  formula: tirads(tr_points)
```

## Checking forms from the command line

```bash
npm run lint-forms             # checks forms/general/*.yaml
node server/cli.js lint-forms path/to/dir
```
