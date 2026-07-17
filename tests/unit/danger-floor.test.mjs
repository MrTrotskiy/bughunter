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
import { dangerFloor, mutationFloor, routeRefused, REFUSED } from '../../lib/recon/danger-floor.mjs';

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

// COMMUNICATION / MEDIA side-effect — initiating a real-time call / livestream / meeting is an
// irreversible OUTWARD side-effect that does NOT ride the abortable HTTP layer (WebRTC/media), so the
// network write-firewall cannot stop it. It is a HARD refusal (in REFUSED) that reveal-opener never
// exempts — the control is still mapped, but never fired.
// FAIL-ON-REVERT: neuter the COMMUNICATION branch → "Video Call" falls to 'safe' → the agent would fire
//   a real call → "Video Call must be communication" reds. Drop 'communication' from REFUSED → the click
//   gate would no longer hard-refuse it → the REFUSED.has assertion reds.
test('communication / media controls classify communication and are hard-refused', () => {
  for (const name of [
    'Video Call', 'Voice Call', 'Audio Call', 'Start Call', 'Go Live', 'Start Meeting', 'Join Meeting',
    'Live Stream', 'Start Broadcast', 'Dial',
    // article + host variants — real rawcaster labels ("Join a meeting" / "Host a meeting") that the
    // first regex missed, so "Host a meeting" fell to 'safe' and WOULD have been fired (host a real call).
    'Join a meeting', 'Host a meeting', 'Join the meeting', 'Host a call', 'Make a call',
  ]) {
    assert.equal(dangerFloor({ name }), 'communication', `${name} must be communication`);
  }
  assert.equal(REFUSED.has('communication'), true, 'communication must be in the hard-refused set');
});

// A bare "call" is too ambiguous to refuse — refusing "Call to action" / "Recall" / "Callback" would
// bleed coverage on benign controls. The class requires a medium (video/voice/audio) or an explicit
// start/join/host/go-live phrasing, so these — and non-meeting join/host labels — stay non-communication.
test('ambiguous call-like and non-meeting join/host names are NOT over-refused', () => {
  for (const name of ['Call to action', 'Recall', 'Callback settings', 'Install', 'Recall notice', 'Join a group', 'Host name', 'Meeting notes']) {
    assert.notEqual(dangerFloor({ name }), 'communication', `${name} must not be communication`);
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

// routeRefused — the navigation-level gate (recon-run persistentStep). Authed runs can
// reach a GET /logout by NAVIGATING to a control's own route; the name-only click gate
// never sees it, so the route path itself must classify as refused.
// Guards: the crawl will not re-navigate to a destructive/auth/payment route (self-logout
//   / self-delete class). FAIL-ON-REVERT: widen the AUTH regex so 'logout' no longer
//   matches, or make routeRefused always return false → the '/logout' assertion goes red.
test('routeRefused stops danger routes and passes ordinary ones', () => {
  assert.equal(routeRefused('/logout'), true, '/logout must be refused (auth)');
  assert.equal(routeRefused('/account/logout'), true, 'a nested logout route must be refused');
  assert.equal(routeRefused('/sign-off'), true, '/sign-off must be refused (auth)');
  assert.equal(routeRefused('/signoff'), true, '/signoff must be refused (auth)');
  assert.equal(routeRefused('/account/delete'), true, '/account/delete must be refused (destructive)');
  assert.equal(routeRefused('/checkout'), true, '/checkout must be refused (payment)');
  assert.equal(routeRefused('/log%6fut'), true, 'a percent-encoded /logout is decoded then refused');
  assert.equal(routeRefused('/products'), false, 'an ordinary route is not refused');
  assert.equal(routeRefused('/dashboard'), false, 'the dashboard is not refused');
  assert.equal(routeRefused(''), false, 'an empty route is not refused (nothing to classify)');
});

// routeRefused EXCLUDES communication: navigating to a livestream/meeting VIEWING page is a READ
// (watching), not initiating a broadcast — so it must NOT be nav-refused (that would drop real coverage).
// Initiating a call is a CLICK, gated by the full REFUSED set (dangerFloor→'communication'), not here.
// FAIL-ON-REVERT: point routeRefused back at the full REFUSED set → '/livestream/123' becomes refused →
//   the "communication route is navigable" assertion reds.
test('routeRefused does NOT block navigation to a communication (viewing) route', () => {
  assert.equal(dangerFloor({ route: '/livestream/123' }), 'communication', 'the route path itself classifies communication');
  assert.equal(routeRefused('/livestream/123'), false, 'a livestream VIEWING page is navigable (watching is a read)');
  assert.equal(routeRefused('/dial'), false, 'a communication route is not nav-refused (the CLICK to initiate is)');
  assert.equal(routeRefused('/account/delete'), true, 'destructive/auth/payment routes ARE still nav-refused');
});

// mutationFloor — the ADDITIVE name-level mutation gate (read-only firewall defense-in-depth). It does NOT
// widen REFUSED (a benign Follow/Like is NOT refused on the default crawl); it is a separate predicate the
// read-only path opts into. Covers the write the URL-path firewall cannot see (a mutation-NAMED control
// firing a benign-named endpoint), while an ICON control (no name) stays 'unknown' → the network gate
// handles it and the causal edge is preserved.
// Guards: a control literally named Follow/Like/Submit classifies 'mutation' (so refuseMutations can refuse
//   it at click time), an ordinary control classifies 'safe', and an icon (no name) classifies 'unknown'
//   (never refused here — it falls through to the network firewall).
// FAIL-ON-REVERT: neuter MUTATION_NAME_RE (or drop the mutationFloor export's test) → 'Follow' falls to
//   'safe' → "Follow must classify mutation" reds.
test('mutationFloor classifies mutation-named controls, spares ordinary ones, and leaves an icon unknown', () => {
  for (const name of ['Follow', 'Unfollow', 'Like', 'Submit', 'Publish', 'Subscribe', 'Delete', 'followUser', 'like_post']) {
    assert.equal(mutationFloor({ name }), 'mutation', `${name} must classify mutation`);
  }
  assert.equal(mutationFloor({ name: 'Search' }), 'safe', 'an ordinary control is safe');
  assert.equal(mutationFloor({ name: 'Next page' }), 'safe', 'a navigation control is safe');
  assert.equal(mutationFloor({ name: '', route: '/profile' }), 'safe', 'a bland-route icon page is safe (no verb)');
  assert.equal(mutationFloor({ name: '', route: '' }), 'unknown', 'an icon control with nothing to classify is unknown, never mutation');
});
