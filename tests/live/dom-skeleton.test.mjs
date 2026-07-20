// DOM SKELETON — the schematic stand-in for a screenshot on the act FAILURE path.
//
// Measured on the completed run raw1 (287 acts): key-frames exist on 140 of 141 SUCCESSFUL acts
// and 0 of 146 FAILURES, because every pre-click gate in step.mjs throws before `capture.before`
// is ever reached. The skeleton is what a failed act leaves behind instead, and it is only worth
// looking at if it AGREES with what the crawler considered visible — hence guard (A).
//
// Guards:
//   (A) VISIBILITY PARITY. The skeleton's `vis` verdict equals dom-snapshot's `visible` for the
//       SAME element, across every branch where two restated predicates could drift:
//       display:none, visibility:hidden, opacity:0 (VISIBLE — it has a box), a zero-AREA box, and
//       an ancestor-hidden child (visibility inherits). The skeleton cannot import dom-snapshot's
//       isVisible (that copy is a closure inside another page.evaluate payload), so THIS TEST is
//       the only thing stopping the two definitions from forking.
//   (B) THE CAP NEVER DROPS SILENTLY. On an over-cap page nodes.length === cap exactly AND
//       truncated > 0 and accounts for the remainder; the score-ranked cap keeps the page's one
//       control rather than the filler divs that outnumber it 1200:1.
//   (C) IDENTITY GATE. Capturing skeletons leaves mergeSnapshot's output BYTE-IDENTICAL and the
//       id ledger unmoved — including across a SCROLL, which moves every rect the skeleton
//       carries. Rects in the identity path would churn templates the way transient CSS-motion
//       classes once did (148 phantom templates, decisions.md INC.4).
//   (D) NEVER THROWS. It is called from a catch block, so a closed page returns null rather than
//       replacing the real act error with its own.
//
// FAIL-ON-REVERT:
//   (A) change `return r.width > 0 && r.height > 0` to `r.width >= 0 && r.height >= 0` in
//       dom-skeleton.mjs visOf (drop the zero-area rule) → #zeroarea reads visible in the skeleton
//       and hidden in dom-snapshot → "must agree with dom-snapshot" goes red. Equivalently, adding
//       an `opacity === '0'` clause reds #opacity0.
//   (B) replace the `slice(0, cap)` in dom-skeleton.mjs with an unbounded emit → nodes.length
//       exceeds the cap → "emits exactly the cap" goes red; hard-code `truncated: 0` → "the drop
//       is COUNTED, never silent" goes red.
//   (C) push the skeleton's nodes into dom-snapshot's `elements` array (or pass them to
//       mergeSnapshot) before the merge → rect/vis enter the identity path → the byte-identical
//       graph assertion and diffIdentity ok both go red.
//   (D) delete the try/catch in captureSkeleton → the closed-page call rejects instead of
//       returning null → "returns null, never throws" goes red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../fixtures/skeleton-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotDom } from '../../lib/graph/dom-snapshot.mjs';
import { captureSkeleton, SKELETON_NODE_CAP } from '../../lib/graph/dom-skeleton.mjs';
import { makeGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';
import { snapshotStep } from '../../lib/recon/step.mjs';
import { diffIdentity } from '../../lib/graph/identity-diff.mjs';

// The six controls that pin every branch of the visibility predicate, and the verdict each MUST
// receive. Listed here rather than derived, so a predicate that changes both implementations at
// once still fails: the expectation is Playwright's, not either module's.
const EXPECTED_VIS = {
  'Visible': true,
  'Display none': false,
  'Visibility hidden': false,
  'Opacity zero': true,      // opacity:0 still has a box — Playwright parity, NOT hidden
  'Zero area': false,        // zero-AREA box reads hidden
  'Inherited': false,        // visibility inherits from the parent
};

test('the DOM skeleton agrees with dom-snapshot on visibility, caps honestly, and never touches identity', async (t) => {
  const server = await start(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  process.env.PW_ALLOW_PRIVATE = '1';

  const sess = await launch();
  t.after(async () => {
    await close(sess.browser);
    await new Promise((r) => server.close(r));
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
  });
  const { page } = sess;

  // ---- (A) VISIBILITY PARITY -------------------------------------------------------------
  await gotoGated(page, `${base}/`);
  await waitSettled(page);

  const snap = await snapshotDom(page);
  const skel = await captureSkeleton(page);
  assert.ok(skel, 'a skeleton was captured (non-vacuous)');
  assert.equal(skel.v, 1, 'schema version rides the artifact');
  assert.ok(skel.w > 0 && skel.h > 0, 'the viewport is recorded');

  const byName = (list, key) => new Map(list.map((e) => [e[key] || '', e]));
  const snapByName = byName(snap.elements, 'name');
  const skelByName = byName(skel.nodes, 'name');

  for (const [name, expected] of Object.entries(EXPECTED_VIS)) {
    const s = snapByName.get(name);
    const k = skelByName.get(name);
    assert.ok(s, `dom-snapshot must have captured "${name}" (non-vacuous)`);
    assert.ok(k, `the skeleton must have captured "${name}" (non-vacuous)`);
    // Both must match the INDEPENDENT expectation, and each other. Asserting only "they agree"
    // would pass with both wrong in the same direction.
    assert.equal(s.visible, expected, `dom-snapshot's verdict for "${name}"`);
    assert.equal(k.vis === 1, expected,
      `the skeleton's visibility verdict for "${name}" must agree with dom-snapshot (got vis=${k.vis}, dom-snapshot=${s.visible})`);
  }

  // The skeleton describes STRUCTURE too, not just the controls dom-snapshot collects — that is
  // the point of a schematic. A nav landmark and a table row are present.
  const tags = new Set(skel.nodes.map((n) => n.tag));
  assert.ok(tags.has('nav') && tags.has('tr'),
    'the skeleton carries page structure (nav/tr), not only interactive elements');
  assert.equal(skel.truncated, 0, 'a small page truncates nothing');

  // ---- (B) THE CAP NEVER DROPS SILENTLY --------------------------------------------------
  // The filler count is derived from the cap, so this guard keeps working if the cap is retuned.
  const FILLER = SKELETON_NODE_CAP * 3;
  const bigUrl = `${base}/big?n=${FILLER}`;
  await gotoGated(page, bigUrl);
  await waitSettled(page);

  const bigSkel = await captureSkeleton(page);
  assert.ok(bigSkel, 'a skeleton was captured on the over-cap page');
  assert.equal(bigSkel.nodes.length, SKELETON_NODE_CAP,
    `an over-cap page emits exactly the cap (${SKELETON_NODE_CAP}), got ${bigSkel.nodes.length}`);
  assert.ok(bigSkel.truncated > 0,
    'the drop is COUNTED, never silent — truncated must be non-zero on an over-cap page');
  // The counter is the REAL remainder, not a token 1: every filler div past the cap is accounted
  // for, so nodes.length + truncated recovers the describable population.
  assert.ok(bigSkel.truncated >= FILLER - SKELETON_NODE_CAP,
    `truncated must account for the whole remainder (>= ${FILLER - SKELETON_NODE_CAP}), got ${bigSkel.truncated}`);
  // Score-ranked, so the one CONTROL survives a cap that 1200 filler divs are competing for.
  assert.ok(bigSkel.nodes.some((n) => n.id === 'only-control'),
    'the score-ranked cap keeps the control and drops filler — the least informative goes first');

  // ---- (C) IDENTITY GATE -----------------------------------------------------------------
  // Same page, same state, twice: once merged clean, once with skeleton captures interleaved
  // around the snapshot — and, between them, a SCROLL, which moves every rect the skeleton
  // carries. If any of that reached the identity path the two graphs would diverge.
  await gotoGated(page, bigUrl);
  await waitSettled(page);

  const graphA = makeGraph(); const ledgerA = makeLedger();
  await snapshotStep(page, graphA, ledgerA, '/big');

  const graphB = makeGraph(); const ledgerB = makeLedger();
  const before = await captureSkeleton(page);
  await page.evaluate(() => window.scrollTo(0, 600));
  const after = await captureSkeleton(page);
  await snapshotStep(page, graphB, ledgerB, '/big');
  await captureSkeleton(page);
  await page.evaluate(() => window.scrollTo(0, 0));

  // NON-VACUOUS: prove the rects actually MOVED, else the churn test is asserting nothing.
  const yOf = (s) => (s.nodes.find((n) => n.id === 'only-control') || {}).y;
  assert.ok(typeof yOf(before) === 'number' && typeof yOf(after) === 'number', 'the control is in both skeletons');
  assert.notEqual(yOf(before), yOf(after),
    'the scroll must actually move the skeleton rects (non-vacuous churn test)');

  assert.deepEqual(ledgerB.ids, ledgerA.ids,
    'capturing skeletons mints IDENTICAL template/instance ids — the skeleton is never an identity input');
  assert.equal(JSON.stringify(graphB), JSON.stringify(graphA),
    'mergeSnapshot output is BYTE-IDENTICAL with and without skeleton captures');
  const d = diffIdentity({ ledger: ledgerA, graph: graphA }, { ledger: ledgerB, graph: graphB });
  assert.equal(d.ok, true, 'identity-diff reports ok (no churn) across a skeleton-capturing run');
  assert.deepEqual(d.churnedTemplates, [], 'no template ids churned by a skeleton capture');
  assert.deepEqual(d.churnedInstances, [], 'no instance ids churned by a skeleton capture');

  // ---- (D) NEVER THROWS ------------------------------------------------------------------
  // It runs inside a catch block: a dead page must degrade to null, never replace the real error.
  const doomed = await sess.browser.newContext();
  const dead = await doomed.newPage();
  await dead.close();
  await doomed.close();
  const none = await captureSkeleton(dead);
  assert.equal(none, null, 'a closed page returns null, never throws (it is called from a catch)');
});
