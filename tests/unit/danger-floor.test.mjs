// danger-floor — the deterministic safety BACKSTOP for recon (not the judge). Pure.
// Guards that the obvious destructive / auth / payment controls are classified as
// dangerous from name+route, so observe.mjs can refuse to let a mis-judging agent fire
// them. The floor is a coarse net; the LLM does the rich call (decisions.md).
//
// Guards: recon's last-line defense — Delete/Logout/Pay-style controls classify as
//   destructive/auth/payment (never safe), so the observe backstop + the fire-path gate
//   can block an act. Also guards the camelCase/snake/kebab NORMALIZATION, without which
//   an attribute-derived label like `deleteAccount` slips past the whole-word matcher.
// FAIL-ON-REVERT (a): neuter the DESTRUCTIVE branch in danger-floor.mjs → "Delete" falls
//   through to 'safe' → "Delete must be destructive".
// FAIL-ON-REVERT (b): drop the `.replace(/([a-z0-9])([A-Z])/g, '$1 $2')` normalization
//   → "deleteAccount" stays one token, no word boundary, falls to 'safe' →
//   "deleteAccount must be destructive".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dangerFloor } from '../../lib/recon/danger-floor.mjs';

test('destructive control names classify destructive', () => {
  for (const name of ['Delete', 'Delete row', 'Remove item', 'Discard changes', 'Reset', 'Purge cache']) {
    assert.equal(dangerFloor({ name }), 'destructive', `${name} must be destructive`);
  }
});

test('logout / signout classify auth', () => {
  for (const name of ['Log out', 'Logout', 'Sign out', 'Log off']) {
    assert.equal(dangerFloor({ name }), 'auth', `${name} must be auth`);
  }
});

test('payment controls classify payment', () => {
  for (const name of ['Pay now', 'Checkout', 'Place order', 'Subscribe', 'Buy']) {
    assert.equal(dangerFloor({ name }), 'payment', `${name} must be payment`);
  }
});

test('a route can flag danger even when the name is bland', () => {
  assert.equal(dangerFloor({ name: 'Go', route: '/account/delete' }), 'destructive');
});

test('an ordinary control is safe; nothing to classify is unknown', () => {
  assert.equal(dangerFloor({ name: 'Search', route: '/' }), 'safe');
  assert.equal(dangerFloor({ name: 'Next page' }), 'safe');
  assert.equal(dangerFloor({}), 'unknown');
});

// A real control name often comes from an attribute (id/data-testid/aria) in camelCase,
// snake_case, or kebab-case. Normalization must expose the words so the whole-word floor
// still fires — otherwise the gate is trivially bypassed by naming.
test('camelCase / snake / kebab labels still classify', () => {
  assert.equal(dangerFloor({ name: 'deleteAccount' }), 'destructive', 'deleteAccount must be destructive');
  assert.equal(dangerFloor({ name: 'removeUser' }), 'destructive', 'removeUser must be destructive');
  assert.equal(dangerFloor({ name: 'delete_account' }), 'destructive', 'delete_account must be destructive');
  assert.equal(dangerFloor({ name: 'logoutBtn' }), 'auth', 'logoutBtn must be auth');
  assert.equal(dangerFloor({ name: 'pay-now' }), 'payment', 'pay-now must be payment');
});

// Extended vocabulary — the coarse net covers more of the obvious hard-stops.
test('extended destructive / payment vocabulary classifies', () => {
  for (const name of ['Deactivate account', 'Terminate', 'Revoke access', 'Unpublish']) {
    assert.equal(dangerFloor({ name }), 'destructive', `${name} must be destructive`);
  }
  for (const name of ['Send money', 'Transfer', 'Order now', 'Donate']) {
    assert.equal(dangerFloor({ name }), 'payment', `${name} must be payment`);
  }
});

// An icon-only control (no accessible name, bland route) is NOT provably safe —
// it must fall to 'unknown', never 'safe', so the agent is forced to judge it.
test('an icon-only control with no name is unknown, not safe', () => {
  assert.equal(dangerFloor({ name: '', route: '/' }), 'unknown');
  assert.equal(dangerFloor({ name: '   ', route: '' }), 'unknown');
});
