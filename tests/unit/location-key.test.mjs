// location-key — the pure LOCATION discriminator derived from a control's reveal path. This is the
// route-collapse split a single-URL SPA hides: routeKey collapses every POST-nav section to one
// string, but two controls behind DIFFERENT opener paths have DIFFERENT statePaths → different keys.
//
// Guards: locationKey is deterministic, root-collapses an empty statePath to the bare route,
//   turns distinct opener paths under the SAME route into DISTINCT keys (the split) while identical
//   paths collapse to one key (dedup), AND is collision-safe against separator chars in the raw
//   row-text instanceKey. This is the signal frontierInstanceStats.locations counts on.
// FAIL-ON-REVERT: make locationKey ignore statePath (return `route` always) → the two-different-
//   statePaths-under-one-route case yields EQUAL keys → the `notEqual` assertion reds; make it
//   non-deterministic (append a random/timestamp) → the identical-paths `equal` assertion reds;
//   revert the JSON tuple encoding back to the `templateId:instanceKey` join on '>' → statePath
//   [{1,'2>3:4'}] and [{1,'2'},{3,'4'}] both encode to '/|1:2>3:4' → the collision `notEqual` reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locationKey } from '../../lib/recon/location-key.mjs';

test('locationKey: empty statePath collapses to the bare route (root location)', () => {
  assert.equal(locationKey('/'), '/');
  assert.equal(locationKey('/', []), '/');
  assert.equal(locationKey('/app', undefined), '/app');
});

test('locationKey: 1-hop and 2-hop statePaths yield distinct deterministic strings', () => {
  const one = locationKey('/', [{ templateId: 10, instanceKey: '#1' }]);
  const two = locationKey('/', [{ templateId: 10, instanceKey: '#1' }, { templateId: 20, instanceKey: '#2' }]);
  assert.equal(one, '/|[[10,"#1"]]');
  assert.equal(two, '/|[[10,"#1"],[20,"#2"]]');
  assert.notEqual(one, two, 'a deeper path is a distinct location');
  // Deterministic — same input, same output (no randomness / timestamp).
  assert.equal(locationKey('/', [{ templateId: 10, instanceKey: '#1' }]), one);
});

test('locationKey: two DIFFERENT statePaths under the SAME route are DIFFERENT keys (the split)', () => {
  const a = locationKey('/', [{ templateId: 10, instanceKey: '#1' }]);
  const b = locationKey('/', [{ templateId: 20, instanceKey: '#1' }]);
  assert.notEqual(a, b, 'controls reached via different openers live in different locations');
  // Identical statePaths collapse to one key (dedup — the same section is counted once).
  const c = locationKey('/', [{ templateId: 10, instanceKey: '#1' }]);
  assert.equal(a, c, 'identical paths under the same route are the same location');
});

test('locationKey: separator chars in the raw row-text instanceKey cannot forge a hop boundary', () => {
  // instanceKey is `rowKey` — up to 48 chars of RAW page textContent — so it can itself contain
  // '>' / ':' / '|'. A 1-hop path whose instanceKey embeds the join separators must NOT collide
  // with a genuine 2-hop path. The old `templateId:instanceKey` join on '>' collided both to
  // '/|1:2>3:4', silently under-counting locations; the JSON tuple encoding keeps them distinct.
  const embedded = locationKey('/', [{ templateId: 1, instanceKey: '2>3:4' }]);
  const twoHop = locationKey('/', [{ templateId: 1, instanceKey: '2' }, { templateId: 3, instanceKey: '4' }]);
  assert.notEqual(embedded, twoHop, 'a hop-boundary char inside the row text must not collide with a real hop');
});
