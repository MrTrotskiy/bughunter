// Unit proof of the EXPLORE-ALL policy — the operator's rule set (decisions.md 2026-07-18), stated as
// executable assertions so a later "safety tidy-up" that quietly reinstates a refusal reds the suite.
//
// The rules under test, verbatim from the operator:
//   create / edit / delete / payment / calls: ALLOWED. Unknown controls: CLICKED, never skipped.
//   Accounts: deletable only if THIS run created it. Logout: fired, then re-login.
//   Another user's content: editable WITH restore, NEVER destroyable — the one refusal left.
//
// FAIL-ON-REVERT: in explore-policy.mjs make the FOREIGN branch return `allow: true` for destroysContent
//   → "another user's content is never destroyed" reds. Re-add a blanket `REFUSED.has(floor)` refusal at
//   the top of decide() → the destructive/payment/unknown "allowed" assertions red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, exploreAllArmed, OWNERSHIP } from '../../lib/recon/explore-policy.mjs';
import { destroysContent, editsContent, requiresOwnership } from '../../lib/recon/danger-floor.mjs';

test('destructive / payment / communication all fire on OWN content — no blanket refusal survives', () => {
  for (const name of ['Delete post', 'Pay now', 'Start video call', 'Go live', 'Checkout']) {
    const v = decide({ name, ownership: OWNERSHIP.OWN });
    assert.equal(v.allow, true, `${name} must fire on own content in explore-all`);
  }
});

test('an UNKNOWN control is clicked, not skipped — not knowing is the reason to fire it', () => {
  // An icon-only control: no name, no route → dangerFloor 'unknown'. This is precisely the class the
  // old backstop refused, and precisely the class the mode exists to classify.
  const v = decide({ name: '', route: '', ownership: OWNERSHIP.NONE });
  assert.equal(v.allow, true, 'an unnamed/unknown control must be fired so it can be classified');
});

test('logout is fired and flagged for re-login — never refused', () => {
  const v = decide({ name: 'Log out', ownership: OWNERSHIP.NONE });
  assert.equal(v.allow, true, 'logout must fire — refusing leaves an element that can never be classified');
  assert.equal(v.needsRelogin, true, 'the driver must know to re-authenticate after it');
});

test("another user's content: editable WITH a restore bracket, never destroyable", () => {
  const edit = decide({ name: 'Edit post', ownership: OWNERSHIP.FOREIGN });
  assert.equal(edit.allow, true, "editing another user's content is permitted");
  assert.equal(edit.needsRestore, true, 'and it MUST be bracketed by the restore journal');

  const del = decide({ name: 'Delete post', ownership: OWNERSHIP.FOREIGN });
  assert.equal(del.allow, false, "another user's content is never destroyed — the one refusal left");
  assert.equal(del.code, 'FOREIGN_DESTROY');
});

test('an additive act on a foreign item needs no restore (it destroys nothing of theirs)', () => {
  const v = decide({ name: 'Like', ownership: OWNERSHIP.FOREIGN });
  assert.equal(v.allow, true);
  assert.equal(v.needsRestore, false, 'a like/comment creates nothing to roll back');
});

test('account deletion: only an account THIS run created', () => {
  const foreign = decide({ name: 'Delete account', ownership: OWNERSHIP.NONE, runCreatedAccount: false });
  assert.equal(foreign.allow, false, 'a persistent test-file account is never deleted');
  assert.equal(foreign.code, 'ACCOUNT_PROTECTED');

  const own = decide({ name: 'Delete account', ownership: OWNERSHIP.NONE, runCreatedAccount: true });
  assert.equal(own.allow, true, 'an account the run created is fair game, up to deletion');
});

test('the destroy/edit verb split is disjoint and never wider than requiresOwnership', () => {
  // The split must not invent authority: anything it classifies still needed ownership before.
  for (const name of ['Delete post', 'Edit post', 'Rename item', 'Purge cache', 'Update profile']) {
    const d = destroysContent({ name });
    const e = editsContent({ name });
    assert.ok(!(d && e), `${name}: destroy and edit must be disjoint`);
    if (d || e) assert.equal(requiresOwnership({ name }), true, `${name} must remain ownership-scoped`);
  }
  assert.equal(destroysContent({ name: 'Delete post' }), true);
  assert.equal(editsContent({ name: 'Edit post' }), true);
  // A combined label reads as destroy — the conservative direction (no restore promise we cannot keep).
  assert.equal(editsContent({ name: 'Save and delete' }), false);
});

test('explore-all is operator-armed only, and requires a run id (no marker → no ownership)', () => {
  assert.equal(exploreAllArmed({}, {}), false, 'off by default');
  assert.equal(exploreAllArmed({ BUGHUNTER_EXPLORE_ALL: '1' }, {}), false,
    'without a run id there is no HUNT marker, so "ours vs theirs" is undecidable — must NOT arm');
  assert.equal(exploreAllArmed({ BUGHUNTER_EXPLORE_ALL: '1', BUGHUNTER_RUN_ID: 'r1' }, {}), true);
});
