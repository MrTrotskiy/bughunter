// OUTWARD-FACING ACTS — refused on every tier, because an environment cannot vouch for the outside world.
//
// THE GAP THIS CLOSES, measured. On another user's content, `decide()` returned allow=true for "Report
// content" and "Block account" — classified FOREIGN_ADDITIVE, "creates nothing of theirs to lose". That is true
// of a like and false of a complaint: a report reaches a moderator and nothing downstream undoes it, and
// unblocking is a separate act the crawler will never perform. The category conflated ADDITIVE-TO-THE-DATA-
// MODEL with HARMLESS-TO-A-PERSON, and on a live social app the second is what matters.
//
// Nothing ever reached a real person, and the reason is the uncomfortable part: the confirmation modals
// were never completed. The probe and episode work removes exactly that accidental protection, which is why
// this guard has to land BEFORE it, not after.
//
// The line is drawn at the SYSTEM BOUNDARY, not at the environment. A dev stand is routinely wired to a
// real SMTP and a real SMS gateway — the mail arrives at a real inbox whichever environment sent it. An
// environment label vouches that the application's OWN DATA are fixtures; it cannot vouch that the outgoing
// integrations are sandboxed, and the crawler has no way to check.
//
// SCOPE, and it is the operator's call, not an oversight: this covers acts aimed at a PERSON and channel
// egress. It does NOT cover payment or real-time calls, which keep firing on the operator's own content —
// explore-all exists to classify every control by actually firing it, and on a disposable test account a
// checkout and a call are precisely the controls that mode is for. The third test below asserts that
// boundary, so a later widening cannot quietly re-impose the blanket refusal the mode was built to remove.
//
// Guards: moderation acts against a person and channel egress are refused regardless of ownership or mode;
//   INTERNAL messaging is NOT caught, because a direct message is a row in the app's own database and one
//   of the six user flows — blocking it would cost a flow and protect nobody.
// FAIL-ON-REVERT (one lever per direction):
//   (a) remove the unconditional block from the head of `decide()` → "a report against a person is refused"
//       fails, restoring FOREIGN_ADDITIVE for moderation acts.
//   (b) widen OUTWARD to catch a bare "send"/"invite" → "an in-app message is not outward" fails, which is
//       the over-refusal direction that would silently delete a target flow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, OWNERSHIP } from '../../lib/recon/explore-policy.mjs';
import { isOutwardFacing } from '../../lib/recon/danger-floor.mjs';

test('acts that leave the system are refused whoever owns the content', () => {
  for (const ownership of [OWNERSHIP.FOREIGN, OWNERSHIP.OWN, OWNERSHIP.NONE]) {
    for (const name of ['Report content', 'Block account', 'Invite by email', 'Send SMS']) {
      const v = decide({ name, route: '/dashboard', ownership });
      assert.equal(v.allow, false, `"${name}" must be refused even on ${ownership} content`);
      assert.equal(v.code, 'OUTWARD_REFUSED', `and refused for the right reason — got ${v.code}`);
    }
  }
  // The one that motivated the whole guard: a complaint reaches a moderator and nothing undoes it.
  const report = decide({ name: 'Report content', route: '/dashboard', ownership: OWNERSHIP.FOREIGN });
  assert.match(report.reason, /outside the app|leaves the system/i,
    'the refusal says WHY, so it reads as a boundary and not as squeamishness');
});

test('an in-app message is not outward — the over-refusal direction', () => {
  // These are rows in the application's own database and four of the six target user flows depend on them.
  // Folding them into the outward class would block the flows while protecting nobody.
  for (const name of ['Send Message', 'Add Friend', 'Comment', 'Like', 'Follow', 'Invite']) {
    assert.equal(isOutwardFacing({ name }), false, `"${name}" is internal — it must not be classified outward`);
    const v = decide({ name, route: '/dashboard', ownership: OWNERSHIP.FOREIGN });
    assert.equal(v.allow, true, `"${name}" stays permitted on another user's content`);
  }
  // But the same act pushed through a real channel is outward.
  assert.equal(isOutwardFacing({ name: 'Invite by email' }), true);
  assert.equal(isOutwardFacing({ name: 'Send SMS' }), true);
});

test('payment and calls are NOT folded in — the operator scoped this deliberately', () => {
  // explore-all exists to classify every control by firing it, and on a disposable test account a checkout
  // and a call are exactly the controls that mode is for. Widening the outward class to swallow them would
  // quietly re-impose the blanket refusal the mode was built to remove — so this asserts the boundary of
  // the guard, not just its content.
  assert.equal(isOutwardFacing({ name: 'Pay now' }), false, 'payment is not classified outward');
  assert.equal(isOutwardFacing({ name: 'Video Call' }), false, 'a call is not classified outward');
  assert.equal(decide({ name: 'Pay now', route: '/checkout', ownership: OWNERSHIP.OWN }).allow, true,
    'and payment still fires on own content under explore-all');
});

test('the surviving refusals are unchanged', () => {
  const destroy = decide({ name: 'Delete post', route: '/dashboard', ownership: OWNERSHIP.FOREIGN });
  assert.equal(destroy.code, 'FOREIGN_DESTROY', "another user's content is still never destroyed");
  const edit = decide({ name: 'Edit post', route: '/dashboard', ownership: OWNERSHIP.FOREIGN });
  assert.equal(edit.allow, true);
  assert.equal(edit.needsRestore, true, 'and an edit still brackets with the restore journal');
  const acct = decide({ name: 'Delete account', route: '/settings', ownership: OWNERSHIP.OWN, runCreatedAccount: false });
  assert.equal(acct.code, 'ACCOUNT_PROTECTED', 'an account this run did not create is still protected');
});
