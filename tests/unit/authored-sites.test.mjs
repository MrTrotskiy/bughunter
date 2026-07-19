// ONE TEMPLATE IS NOT ALWAYS ONE CONTROL.
//
// THE MEASURED FAILURE. A template is a STRUCTURAL class — everything rendering through one CSS path — and
// on a component library that is not the same thing as one control. Measured on a shadcn/Radix target:
// `/settings` renders SEVEN different sections (`settings-category-general`, `-access_control`, `-absences`,
// `-ai`, …) through a single template, because every `<Button>` there produces an identical path. The
// frontier walked instance[0] and filed the other six under `drillSkipped`, a bucket whose own comment
// promises "the other rows of one list". They were six different sections of the application, reported as
// counted-and-represented, never opened. 127 DOM elements on one page collapsed to 16 templates.
//
// That is the same defect class as the coverage numbers retracted earlier in this project: a counter that
// looks honest while hiding something other than what it claims.
//
// THE AUTHOR ALREADY ANSWERED IT. A distinct `data-testid` is a distinct control; a shared prefix
// (`employee-row-${id}`) is one control with many rows. Nothing in the DOM distinguishes those two cases on
// a component library — the authored id is the only signal that does.
//
// Guards:
//   (1) Distinct authored ids in one template are walked SEPARATELY.
//   (2) A per-row family collapses — 50 table rows do not become 50 obligations.
//   (3) NO AUTHORED IDS AT ALL → behaviour is exactly as before (one representative). This is the guard
//       that matters most for generalisation: most targets have no test attributes, and this mechanism
//       must never make those worse. The operator asked for this explicitly.
//   (4) The cap bounds the walk, because in explore-all every extra instance is an extra real write.
//   (5) Identity is untouched — the authored id is additive metadata, never a key.
//
// FAIL-ON-REVERT:
//   (1) restore `const limit = node.opener ? … : 1` → the seven sections collapse to one → red.
//   (2) drop the content-key stem from `siteKeyOf` → each row becomes its own site → red.
//   (3) make `walkableIndexes` return [] when no testids → an unmarked app stops being walked → red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextBatch } from '../../lib/recon/frontier.mjs';

const graphOf = (instances) => ({
  elements: {
    1: { role: 'button', name: '', route: '/settings', instances },
  },
});

test('distinct authored controls in one template are walked separately', () => {
  // The measured shape: one structural template, seven authored sections.
  const sections = ['general', 'configurations', 'access_control', 'absences', 'forms', 'ai'];
  const graph = graphOf(sections.map((s, i) => ({
    instanceKey: `#${i}`, instanceSelector: `#s${i}`, testid: `settings-category-${s}`,
  })));

  const batch = nextBatch(graph, { size: 20 });
  assert.equal(batch.length, 6,
    'six authored sections are six obligations — walking one and calling the rest "other rows" is the bug');
  assert.deepEqual(batch.map((b) => b.instance.testid).sort(),
    sections.map((s) => `settings-category-${s}`).sort());
});

test('a per-row family stays ONE control, however many rows it has', () => {
  // (2) The case the template abstraction gets RIGHT, and which must not regress: 50 rows of one table are
  // one control. Reversing that would turn a data grid into 50 phantom obligations and wreck the
  // denominator in the opposite direction.
  const rows = Array.from({ length: 50 }, (_, i) => ({
    instanceKey: `#${i}`, instanceSelector: `#r${i}`, testid: `employee-row-${i}`,
  }));
  assert.equal(nextBatch(graphOf(rows), { size: 20 }).length, 1, 'fifty rows, one control');

  // Same for uuid-suffixed ids, which is what most real row keys look like.
  const uuidRows = ['a1b2c3d4-1111-2222-3333-444455556666', 'f0e1d2c3-9999-8888-7777-666655554444']
    .map((u, i) => ({ instanceKey: `#${i}`, instanceSelector: `#u${i}`, testid: `project-card-${u}` }));
  assert.equal(nextBatch(graphOf(uuidRows), { size: 20 }).length, 1, 'uuid row keys collapse too');
});

test('an application with NO test attributes behaves exactly as before', () => {
  // (3) THE GENERALISATION GUARD. Most targets carry no testids. This mechanism is an ENHANCEMENT where the
  // author left a signal and must be a no-op where they did not — never a regression, and never a silent
  // dependency on markup that usually is not there.
  const bare = Array.from({ length: 5 }, (_, i) => ({ instanceKey: `#${i}`, instanceSelector: `#b${i}` }));
  const batch = nextBatch(graphOf(bare), { size: 20 });
  assert.equal(batch.length, 1, 'one representative, exactly as before the authored-site split existed');
  assert.equal(batch[0].instance.instanceSelector, '#b0');

  // A PARTIALLY marked template: the marked ones are walked, and the unmarked tail does not vanish into a
  // silent zero — it falls back to the representative behaviour it already had.
  const mixed = [
    { instanceKey: '#0', instanceSelector: '#m0', testid: 'toolbar-save' },
    { instanceKey: '#1', instanceSelector: '#m1', testid: 'toolbar-delete' },
    { instanceKey: '#2', instanceSelector: '#m2' },
  ];
  assert.equal(nextBatch(graphOf(mixed), { size: 20 }).length, 2, 'both authored controls are walked');
});

test('the walk is capped — every extra instance is a real write in explore-all', () => {
  // (4) Twenty distinct authored controls in one template is pathological but possible; the cap is a safety
  // rail, not a performance tweak, because this mode genuinely creates and deletes on the operator's stand.
  const many = Array.from({ length: 20 }, (_, i) => ({
    instanceKey: `#${i}`, instanceSelector: `#c${i}`, testid: `widget-action-${String.fromCharCode(97 + i)}`,
  }));
  assert.equal(nextBatch(graphOf(many), { size: 50 }).length, 8, 'bounded by SITE_INSTANCE_CAP');
});
