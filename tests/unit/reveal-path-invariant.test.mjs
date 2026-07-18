// REVEAL PATH INVARIANTS (INC.6) — a recorded reveal path must be something we can actually WALK.
//
// Measured on the live graph after six runs: 494 recorded paths, of which 493 were stateful provenance
// (the stateful driver's own contract calls them "NOT replay"), 39 were cyclic, and 22 passed through a
// dismiss control — so replaying the path to "Group Name" clicked "cancel" and closed the modal the field
// lives in. Because reveal paths are written first-reveal-wins with no invalidation, every one of those
// was frozen permanently. Both halves are guarded here: the reader refuses a bad path, and the writer
// refuses to record one.
//
// Guards: replayRevealPath rejects a provenance path and a dismiss-bearing path instead of walking it;
//   isDismissControl matches the whole name so "Close" is a dismiss and "Close Account" is not.
// FAIL-ON-REVERT (a): delete the `if (reveal.stateful)` guard in reveal-replay.mjs → the provenance path
//   is walked → "a stateful provenance path must be refused, not replayed" fails.
// FAIL-ON-REVERT (b): delete the dismiss loop in reveal-replay.mjs → the cancel-bearing path is walked →
//   "a path through a dismiss control must be refused" fails.
// FAIL-ON-REVERT (c): drop the `^…$` anchors in DISMISS_RE (danger-floor.mjs) → "Close Account"
//   classifies as a dismiss → "Close Account is a destructive control, not a dismiss" fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayRevealPath } from '../../lib/recon/reveal-replay.mjs';
import { isDismissControl } from '../../lib/recon/danger-floor.mjs';

// A graph carrying the exact shape the live crawl recorded for tpl 933 "Group Name".
const graph = {
  elements: {
    26: { name: 'hey Stierlitz, share some nuggets...' },
    98: { name: 'Create Event' },
    79: { name: 'add' },
    900: { name: 'cancel' },
    902: { name: 'No Results Found' },
  },
};

// A page stub that FAILS the test if anything is clicked: every case below must be refused BEFORE the
// replay loop touches the page.
const noClickPage = {
  url: () => 'https://example.test/dashboard',
  $: () => { throw new Error('replay must not reach the page'); },
  goto: () => { throw new Error('replay must not navigate'); },
};

test('a stateful provenance path must be refused, not replayed', async () => {
  const reveal = {
    route: '/dashboard',
    stateful: true,
    statePath: [{ templateId: 26, instanceKey: '#1' }, { templateId: 98, instanceKey: '#1' }],
  };
  await assert.rejects(
    () => replayRevealPath(noClickPage, graph, reveal),
    (err) => err.code === 'REVEAL_PROVENANCE_ONLY' || /PROVENANCE/.test(err.message),
    'a path stamped stateful:true is a breadcrumb, not a route — walking it is the bug',
  );
});

test('a path through a dismiss control must be refused', async () => {
  // The literal path recorded live for "Group Name": hop 900 is "cancel".
  const reveal = {
    route: '/dashboard',
    statePath: [
      { templateId: 26, instanceKey: '#1' },
      { templateId: 98, instanceKey: '#1' },
      { templateId: 79, instanceKey: '#2' },
      { templateId: 900, instanceKey: '#1' },
      { templateId: 902, instanceKey: '#1' },
    ],
  };
  await assert.rejects(
    () => replayRevealPath(noClickPage, graph, reveal),
    (err) => err.code === 'REVEAL_DISMISS_IN_PATH' || /dismiss/i.test(err.message),
    'replaying this path closes the modal its target lives in',
  );
});

test('a clean path is not refused by the new guards', async () => {
  // Reaches the page (and fails there, on the stub) — proving the guards let a legitimate path through
  // rather than rejecting everything.
  const reveal = {
    route: '/dashboard',
    statePath: [{ templateId: 98, instanceKey: '#1' }],
  };
  await assert.rejects(
    () => replayRevealPath(noClickPage, graph, reveal),
    (err) => !['REVEAL_PROVENANCE_ONLY', 'REVEAL_DISMISS_IN_PATH', 'REVEAL_CYCLE', 'REVEAL_TOO_DEEP'].includes(err.code),
    'a one-hop non-dismiss path must pass the structural guards',
  );
});

test('dismiss classification matches the whole name, never a substring', () => {
  for (const name of ['Close', 'cancel', 'Dismiss', 'Back', 'OK', '×', ' close ']) {
    assert.equal(isDismissControl({ name }), true, `${name} must classify as a dismiss`);
  }
  // The dangerous direction: these must NOT be treated as harmless dismiss controls, because ranking a
  // control as "dismiss" makes the loop act it LAST and keeps it out of reveal paths — both wrong here.
  for (const name of ['Close Account', 'Cancel Subscription', 'Back Up Data', 'OK Google', 'Delete']) {
    assert.equal(isDismissControl({ name }), false, `${name} is not a dismiss control`);
  }
  assert.equal(isDismissControl({}), false, 'an unnamed control is not a dismiss');
});

// A modal's real close control frequently has NO accessible name of its own — it is a bare styled <div> or
// <span> with an icon — so the name synthesizer falls back to the container's concatenated text and emits a
// BLOB. The anchored pattern above cannot match one, so on the live target the Create Event modal's closer
// ranked as an ordinary freshly-revealed candidate and, under recency ordering, was picked FIRST: the pass
// meant to drain the modal shut it instead (seq 66 opened it, seq 67 closed it, seq 69 could no longer
// resolve a field inside). The blob must be recognised WITHOUT loosening the anchored rule, which exists to
// stop "Close Account" being ranked away as harmless.
//
// Guards: a long container-text blob that STARTS with a dismiss verb is classified dismiss, so it ranks last
//   and stays out of reveal paths; a short name and a destructive long name are unaffected.
// FAIL-ON-REVERT: drop the DISMISS_PREFIX_RE/BLOB_MIN arm in danger-floor.isDismissControl → "the modal's
//   blob-named close control must classify as a dismiss" fails.
test('a container-text blob starting with a dismiss verb is a dismiss control', () => {
  // Verbatim from the live graph (tpl 427, role=generic), truncated only in this comment.
  const blob = 'closeSchedule a Meeting EventMeeting TitleEvent TypePublicDateTimeDescriptionCreate Event';
  assert.equal(isDismissControl({ name: blob }), true,
    'the modal\'s blob-named close control must classify as a dismiss, or the drain pass closes the modal');
  assert.equal(isDismissControl({ name: 'Cancel this subscription and delete every record we hold' }), true,
    'a long name led by a dismiss verb is a dismiss');

  // The anchored rule still governs everything short — "Close Account" must NOT be ranked away as harmless.
  assert.equal(isDismissControl({ name: 'Close Account' }), false, 'a short destructive name is still not a dismiss');
  assert.equal(isDismissControl({ name: 'Delete every meeting event you have ever created here' }), false,
    'a long name that does NOT start with a dismiss verb is not a dismiss');
});
