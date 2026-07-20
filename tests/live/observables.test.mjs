// OUTCOME OBSERVABLES — telling REFUSED apart from INERT, on evidence rather than inference.
//
// For most of this project's history an act produced exactly two observations: the requests it caused and
// the elements it revealed. Everything else was inferred, and the inference that mattered most — "the form
// was refused by validation" — had nothing behind it. It was asserted across six runs and then measured to
// be flatly wrong: the submit had never been clicked, so nothing had ever been validated. A verdict that
// nothing can contradict is not a verdict.
//
// The distinction is load-bearing for coverage, not just for tidiness. A submit that fired no request
// because the page rejected it is a WORKING form we failed to satisfy; a submit that fired no request
// because the control is dead is weight in the denominator. Today both score identically.
//
// Measured on the live target and the reason all four channels exist independently: the Create Event form
// answers on NO refusal tier at all — no constraint validation, no aria-invalid, no framework markup — and
// accepts a completely empty submit with a 201. Its only signal of any kind is a live region reading
// "Event was successfully created". A target silent on tiers 1-3 is normal, not broken, so the success
// channel has to stand on its own.
//
// Guards: each refusal tier is readable in isolation; success is recognised from a live region; a page that
//   said nothing is NOT reported as refused (the false-positive direction, which would re-create the very
//   inference this module removes).
// FAIL-ON-REVERT (one lever per direction):
//   (a) drop the tier-3 branch from readOutcome's frameworkErrors query → "the AntD explain text is read"
//       fails (and with it the only tier most React targets answer on).
//   (b) make wasRefused fall back to "no requests fired" → "a silent page is not a refusal" fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../fixtures/outcome-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { attachPageSignals, readOutcome, wasRefused, announcedSuccess, domFingerprint, domChanged } from '../../lib/browser/observables.mjs';

test('each refusal tier is readable on its own, and silence is not a refusal', async (t) => {
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

  // BASELINE — the page has said nothing. This is the false-positive guard: "no request fired" must never
  // by itself read as a refusal, because that is precisely the inference that was wrong for six runs.
  const quiet = await readOutcome(page);
  assert.equal(wasRefused(quiet), false, 'a silent page is not a refusal');
  assert.equal(announcedSuccess(quiet), false, 'and it is not a success either');

  // TIER 1 — WHATWG constraint validation on an empty required field.
  await page.click('#submit-native');
  await waitSettled(page);
  const t1 = await readOutcome(page);
  assert.ok(t1.validity.length >= 1, 'the required field reports a validity failure');
  assert.ok(t1.validity[0].flags.includes('valueMissing'), `the flag names WHY it failed — got ${JSON.stringify(t1.validity[0].flags)}`);
  assert.ok(t1.validity[0].message.length > 0, 'and carries the browser message');
  assert.equal(wasRefused(t1), true, 'tier 1 alone licenses REFUSED');

  // TIER 2 — ARIA. Read the message through aria-errormessage, which is what a screen reader announces.
  await page.click('#aria');
  await waitSettled(page);
  const t2 = await readOutcome(page);
  assert.ok(t2.ariaInvalid.some((a) => /not valid/i.test(a.message)),
    `the aria-errormessage text is read — got ${JSON.stringify(t2.ariaInvalid)}`);

  // TIER 3 — framework markup. The tier most React targets are the ONLY ones to answer on.
  await page.click('#antd');
  await waitSettled(page);
  const t3 = await readOutcome(page);
  assert.ok(t3.frameworkErrors.some((e) => /Phone is required/i.test(e)),
    `the AntD explain text is read — got ${JSON.stringify(t3.frameworkErrors)}`);

  // SUCCESS — the live-region channel, which on the live target is the entire oracle.
  await page.click('#ok');
  await waitSettled(page);
  const ok = await readOutcome(page);
  assert.equal(server.postHits(), 1, 'the act really did reach the server (non-vacuous)');
  assert.equal(announcedSuccess(ok), true,
    `a success toast is recognised — got ${JSON.stringify(ok.liveRegions)}`);
});

// STATE IS AN OBSERVABLE — the ceiling that no number of extra acts could lift.
//
// MEASURED: 22% of probed controls held only `inert` rows, and the knowledge ladder deliberately refuses to
// call an inert-only control understood (a battery completed by "we clicked and the page did nothing" would
// re-import "clicked once and did not throw" one rung higher). So those controls were a HARD ceiling on
// coverage — roughly 78% was the most the metric could ever report on that application.
// A large share of them were not inert at all. `domFingerprint` is a census of TAGS BY DEPTH, deliberately
// text-free so a live feed does not register as a change on every poll. But switching a tab, expanding a
// section, ticking a checkbox or selecting a row changes only ATTRIBUTES — the tag census is byte-identical
// — so the act that did exactly what the control exists to do was recorded as doing nothing.
// The subtle half: COUNTING state-bearing elements is not enough. Switching a tab MOVES `aria-selected`
// from one element to another, so the count stays 1. Each match therefore contributes its POSITION.
//
// Guards: a change that alters NO tags — only state attributes — is observed; and the signature stays
//   content-free, so a text-only rewrite (the live-feed case the census exists to ignore) is NOT a change.
// FAIL-ON-REVERT: drop the `states` array from the fingerprint (tag census alone) → "a tab switch is an
//   observable change" reds with changed:false — the exact reading that produced the 22% inert bucket.
test('a state-only change is observed, and a text-only rewrite still is not', async (t) => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await (await browser.newContext()).newPage();

  // Two tabs. Clicking the second moves aria-selected — no element is added, removed, shown or hidden.
  await page.setContent(`<!doctype html><body>
    <div role="tablist">
      <button id="t1" role="tab" aria-selected="true">One</button>
      <button id="t2" role="tab" aria-selected="false">Two</button>
    </div>
    <div id="panel">identical structure either way</div>
    <script>
      t2.onclick = () => { t1.setAttribute('aria-selected','false'); t2.setAttribute('aria-selected','true'); };
    </script></body>`);

  const before = await domFingerprint(page);
  await page.click('#t2');
  await page.waitForTimeout(150);
  const after = await domFingerprint(page);

  assert.equal(before.nodes, after.nodes, 'the tag census is unchanged — this is the case that fooled it');
  assert.equal(domChanged(before, after).changed, true,
    'a tab switch is an observable change: the control did what it exists to do');

  // THE OTHER DIRECTION. The census is text-free on purpose: a feed rewriting its own text must not read
  // as a change on every poll, or every act near a live region would score client-change spuriously.
  const t0 = await domFingerprint(page);
  await page.evaluate(() => { document.getElementById('panel').textContent = 'completely different text'; });
  const t1s = await domFingerprint(page);
  assert.equal(domChanged(t0, t1s).changed, false, 'a text-only rewrite is NOT a structural change');
});
