// Guards: the ownership marker (a zero-width unicode run) is stamped onto TEXT values a human reads, and
// NEVER onto a SHAPED input the browser parses by type (number/range/date/color/…). Appending the mark to
// a shaped value produces a string that is no longer valid for that type, so `handle.fill` throws
// "Malformed value" and the probe fails on a purely cosmetic marker — the exact failure class the trails
// showed (every malformed-fill was a shaped field carrying the mark). This unit test pins the pure decision
// in `stampOwnership`; the live drain it restores is proven in tests/live/marker-shape-fill.test.mjs.
//
// FAIL-ON-REVERT: delete `if (isShapedType(factsKind)) return field;` in step.stampOwnership → a shaped
// field is marked again → "a shaped field is left UNMARKED" reds (the value gains the invisible mark).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampOwnership } from '../../lib/recon/step.mjs';
import { invisibleMark } from '../../lib/recon/hunt-gate.mjs';

const MARKER = 'run-shape';
const MARK = invisibleMark(MARKER);

test('a TEXT value carries the ownership mark (hunt-gate reads it back)', () => {
  const out = stampOwnership({ value: 'hello' }, MARKER);              // undefined kind → treated as text
  assert.equal(out.value, 'hello' + MARK, 'a text fill is stamped with the invisible mark');
  const outText = stampOwnership({ value: 'hi' }, MARKER, 'text');
  assert.equal(outText.value, 'hi' + MARK, 'an explicit text kind is stamped too');
});

test('a SHAPED field is left UNMARKED — the mark would malform its typed value', () => {
  for (const kind of ['range', 'number', 'date', 'color', 'time', 'datetime-local', 'month', 'week', 'email', 'url']) {
    const out = stampOwnership({ value: '0' }, MARKER, kind);
    assert.equal(out.value, '0', `a ${kind} value must not carry the mark (got a mark: ${out.value !== '0'})`);
    assert.ok(!out.value.includes(MARK), `a ${kind} value must be free of the invisible mark`);
  }
});

test('the no-marker / no-value / non-fill guards are unchanged', () => {
  assert.deepEqual(stampOwnership({ value: 'x' }, null), { value: 'x' }, 'no marker → value untouched');
  assert.deepEqual(stampOwnership({ value: '' }, MARKER), { value: '' }, 'empty value → untouched');
  const sel = { value: 'a', kind: 'select' };
  assert.deepEqual(stampOwnership(sel, MARKER), sel, 'a non-fill kind (select) has no string for a mark');
  const already = { value: 'x' + MARK };
  assert.equal(stampOwnership(already, MARKER).value, 'x' + MARK, 'an already-marked value is not double-stamped');
});
