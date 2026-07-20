// THE PROBE BATTERY — learning what a field accepts, without inventing defects.
//
// A field answers nothing on its own. Typing 51 characters into a field that declares a 50-character limit
// produces no request, no error, no observable of any kind — the answer exists only after a COMMIT. That is
// why the previous model could never learn what a field accepts: it clicked fields as if they were buttons,
// and 37 of 53 such acts were inert by construction.
//
// The assertion that matters most here is the NEGATIVE one. Measured on the live target: "Meeting Title"
// declares maxLength 50, the probe typed 51, and the browser truncated to 50 natively. Judging the boundary
// on what we TYPED would have reported a violation against a field that enforced its limit perfectly. A
// probe that invents defects is worse than no probe — every false finding costs a human the time to
// disprove it, and enough of them make the whole report untrustworthy. So the verdict is judged on what the
// field actually HELD.
//
// Guards: a declared boundary that IS enforced yields no conflict; a declared boundary that is NOT enforced
//   does; a field declaring nothing is not probed at all (no meaningless input); an accepted empty commit
//   on a required field is reported.
// FAIL-ON-REVERT (one lever per direction):
//   (a) judge overflow on the typed length instead of the accepted length (`accepted` → `value.length`) →
//       "an enforced limit is not a defect" fails — the false-finding direction.
//   (b) make `valueForProbe('fill-overflow')` return a fixed long string when no maxLength is declared →
//       "a field that declares nothing is not probed" fails — probing without a prediction to falsify.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../fixtures/outcome-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { attachPageSignals } from '../../lib/browser/observables.mjs';
import { probeField, valueForProbe } from '../../lib/recon/probe-battery.mjs';
import { batteryFor, probeStatus } from '../../lib/recon/knowledge.mjs';

test('a declared boundary is judged on what the field HELD, not on what we typed', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const prev = process.env.PW_ALLOW_PRIVATE;
  process.env.PW_ALLOW_PRIVATE = '1';
  const sess = await launch();
  t.after(async () => {
    await close(sess.browser);
    await new Promise((r) => server.close(r));
    if (prev === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prev;
  });

  const { page } = sess;
  attachPageSignals(page);
  await gotoGated(page, url);
  await waitSettled(page);

  // The commit is injected, so the battery never opens a causal window of its own. Here it stands in for
  // the caller's measured act and returns the same shape.
  const commit = async () => {
    await page.click('#commit');
    await waitSettled(page);
    return { requests: [{ method: 'POST', urlPattern: '/api/commit', class: 'write' }], newElements: [] };
  };

  // ENFORCED — the browser truncates at the declared limit. This is the constraint WORKING.
  const capped = await page.$('#capped');
  const enforced = await probeField(page, { handle: capped, facts: { maxLength: 10 }, kind: 'fill-overflow', commit });
  assert.equal(enforced.input.length, 11, 'the probe typed one character past the declaration');
  assert.equal(enforced.input.accepted, 10, 'and the field held exactly its declared limit');
  assert.ok(!enforced.conflict,
    `an enforced limit is not a defect — reported ${JSON.stringify(enforced.conflict)}`);

  // NOT ENFORCED — declares 10 (via a data attribute the browser does not act on), holds 11, and the
  // commit goes through. This is the real defect shape, and the one the battery exists to find.
  const leaky = await page.$('#leaky');
  const violated = await probeField(page, { handle: leaky, facts: { maxLength: 10 }, kind: 'fill-overflow', commit });
  assert.equal(violated.input.accepted, 11, 'the field held more than it declared');
  assert.ok(violated.conflict, 'an UNENFORCED declared limit is reported as a conflict');
  assert.equal(violated.conflict.claim, 'maxLength');
  assert.equal(violated.conflict.declared, 10);
  assert.equal(violated.conflict.accepted, 11);

  // NO DECLARATION, NO PROBE. Without a declared limit there is no prediction to falsify, so a long string
  // would produce a number that means nothing.
  assert.equal(valueForProbe('fill-overflow', {}), null, 'a field that declares nothing is not probed');
  const uncapped = await page.$('#uncapped');
  const skipped = await probeField(page, { handle: uncapped, facts: {}, kind: 'fill-overflow', commit });
  assert.equal(skipped.blocked, 'NOT_APPLICABLE', 'and the row says so rather than inventing an input');

  // REQUIRED, YET AN EMPTY COMMIT SUCCEEDS — the live target's actual behaviour on Create Event.
  const empty = await probeField(page, { handle: uncapped, facts: { required: true }, kind: 'fill-empty', commit });
  assert.equal(empty.verdict, 'write', 'the empty commit went through');
  assert.ok(empty.conflict, 'a required field that accepts empty is reported');
  assert.equal(empty.conflict.claim, 'required');

  assert.ok(server.commitHits() >= 3, 'the commits really reached the server (non-vacuous)');
});

// THE WRONG-SHAPE PROBE (docs/GOAL.md rung 4) — letters into a number, driven through the real browser.
// Two directions, both terminal: a NATIVE typed input REFUSES the fill (the type is enforced, recorded as
// NOT_FILLABLE and never retried away), while a text input rendered as that type HOLDS the wrong value, and
// committing it through is the "declared type not enforced" defect.
//
// Guards: the field owes `fill-invalid` from its declared type alone; the value is genuinely wrong for the
//   declaration; a native type=number refusing the fill is a NOT_FILLABLE terminal on the `fill-invalid`
//   kind (so the obligation DRAINS, not loops); a text input that accepts+commits the wrong shape yields a
//   conflict naming the type.
// FAIL-ON-REVERT: make `valueForProbe('fill-invalid', {kind:'number'})` return a numeric string → the native
//   number input accepts the fill → "a native type=number REFUSES the wrong shape (NOT_FILLABLE)" reds; drop
//   the `fill-invalid` conflict arm in `probeField` → "an accepted wrong-shape value is a conflict" reds.
test('a wrong-shape probe: a native number refuses it, a text input that accepts it is a conflict', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const prev = process.env.PW_ALLOW_PRIVATE;
  process.env.PW_ALLOW_PRIVATE = '1';
  const sess = await launch();
  t.after(async () => {
    await close(sess.browser);
    await new Promise((r) => server.close(r));
    if (prev === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prev;
  });

  const { page } = sess;
  attachPageSignals(page);
  await gotoGated(page, url);
  await waitSettled(page);

  const commit = async () => {
    await page.click('#commit');
    await waitSettled(page);
    return { requests: [{ method: 'POST', urlPattern: '/api/commit', class: 'write' }], newElements: [] };
  };

  // The field owes the probe from its declared TYPE alone, and the value is genuinely non-numeric.
  assert.ok(batteryFor({ role: 'textbox', fieldFacts: { kind: 'number' } }).includes('fill-invalid'),
    'a type=number field owes a wrong-shape probe');
  assert.ok(Number.isNaN(Number(valueForProbe('fill-invalid', { kind: 'number' }))),
    'the wrong-shape value for a number is genuinely non-numeric');

  // NATIVE type=number — the browser refuses letters at fill time. That refusal IS the answer, recorded as
  // NOT_FILLABLE on the fill-invalid kind, and the obligation drains rather than being retried away.
  const numberEl = await page.$('#number');
  const enforced = await probeField(page, { handle: numberEl, facts: { kind: 'number' }, kind: 'fill-invalid', commit });
  assert.equal(enforced.kind, 'fill-invalid', 'the row is filed under the obligation it was answering');
  assert.equal(enforced.blocked, 'NOT_FILLABLE', 'a native type=number REFUSES the wrong shape (NOT_FILLABLE) — the type is enforced');
  const st = probeStatus(
    { role: 'textbox', fieldFacts: { kind: 'number' } },
    [{ kind: 'fill-valid', verdict: 'write' }, enforced],
  );
  assert.deepEqual(st.outstanding, [], 'so the wrong-shape obligation DRAINS — minted, valued, terminal — never sitting owed');

  // A TEXT input handed the same declared type HOLDS the letters, and committing them through is the defect.
  const textEl = await page.$('#uncapped');
  const violated = await probeField(page, { handle: textEl, facts: { kind: 'number' }, kind: 'fill-invalid', commit });
  assert.equal(violated.verdict, 'write', 'the wrong-shape value was committed');
  assert.ok(violated.conflict, 'an accepted wrong-shape value is a conflict — declared type NOT enforced');
  assert.equal(violated.conflict.claim, 'type');
  assert.equal(violated.conflict.declared, 'number');
});
