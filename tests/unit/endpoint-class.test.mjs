// endpoint-class — is an endpoint a READ or a WRITE? Pure.
//
// Guards the instrument itself. The old rule was "write := non-GET", and on the live target — which
// speaks POST-for-read — it reported 18 write endpoints when exactly ONE was a mutation. Several rounds
// of fixes were prioritized off that number. A classifier that cannot tell `POST /listitems` from
// `POST /updateusersettings` makes every downstream verdict about the run untrustworthy.
//
// Guards: a read verb travelling by POST classifies READ; an explicit mutation verb classifies WRITE
//   whatever the method; telemetry never counts as an application write; and a non-GET with no verb at
//   all is classified write but SURFACED as a fallback guess rather than asserted.
// FAIL-ON-REVERT: replace classifyEndpoint's body with the old method test
//   (`method === 'GET' ? 'read' : 'write'`) → "POST /app/listitems is a READ" fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEndpoint, classifyEndpoints } from '../../lib/recon/endpoint-class.mjs';

test('a read travelling by POST is a read, not a write', () => {
  // The exact endpoints the live crawl mis-counted as writes.
  for (const p of ['/app/listitems', '/app/getprofile', '/app/searchusers',
    '/app/getfaq', '/app/listevents', '/app/get_status_detail', '/app/getcountylist',
    '/app/listallfriends', '/app/getusersettings']) {
    assert.equal(classifyEndpoint({ method: 'POST', urlPattern: p }), 'read', `POST ${p} is a READ`);
  }
});

test('an explicit mutation verb is a write, whatever the method', () => {
  for (const p of ['/app/updateusersettings', '/app/followandunfollow', '/api/createpost',
    '/api/delete_comment', '/api/group/invite']) {
    assert.equal(classifyEndpoint({ method: 'POST', urlPattern: p }), 'write', `POST ${p} is a WRITE`);
  }
  // The safe direction: a GET that mutates (a delete-by-link) must not be excused by its method.
  assert.equal(classifyEndpoint({ method: 'GET', urlPattern: '/api/deletePost' }), 'write');
});

test('telemetry is never an application write', () => {
  assert.equal(classifyEndpoint({ method: 'POST', urlPattern: '/g/collect?v=:param' }), 'telemetry');
  assert.equal(classifyEndpoint({ method: 'POST', urlPattern: 'https://www.google-analytics.com/j/collect' }), 'telemetry');
});

test('a verbless non-GET is a GUESS, and says so in its own class', () => {
  // `write-unnamed`, not `write`. On a target that reads over POST this fallback is where most READS land:
  // measured after wiring the classifier into probe rows, 28 acts recorded `write` and two or three were
  // real — `audiocontent` (text-to-speech), `texttoaudio`, `itemlist` all arrived by this path.
  // And so did `contactus`, which genuinely does write. From the name alone they are indistinguishable, so
  // the honest answer is a separate class rather than a confident guess in either direction. This repeats a
  // failure already on record ("18 write endpoints, the truthful count was ONE") and takes the same fix:
  // surface the guess as a guess, and let a caller that needs certainty confirm by reading state back.
  assert.equal(classifyEndpoint({ method: 'POST', urlPattern: '/app/community_dropdown' }), 'write-unnamed');
  // The report contract is unchanged: a fallback guess still counts toward the write SURFACE, and is still
  // listed separately so the operator knows how much of that surface was guessed.
  const out = classifyEndpoints([
    { method: 'POST', urlPattern: '/app/community_dropdown' },
    { method: 'POST', urlPattern: '/app/updateusersettings' },
    { method: 'POST', urlPattern: '/app/listitems' },
    { method: 'POST', urlPattern: '/g/collect' },
  ]);
  assert.equal(out.writes.length, 2, 'two writes');
  assert.equal(out.reads.length, 1, 'listitems is the read');
  assert.equal(out.telemetry.length, 1, 'collect is telemetry');
  assert.deepEqual(out.unnamedWrites, ['POST /app/community_dropdown'],
    'the verbless one must be flagged as classified-by-fallback, not silently counted as a confirmed write');
});

test('endpoints are counted once each, not per call', () => {
  const out = classifyEndpoints(Array.from({ length: 40 }, () => ({ method: 'POST', urlPattern: '/app/listitems' })));
  assert.equal(out.reads.length, 1, '40 calls to one endpoint is ONE endpoint exercised');
});

// A SUBSTRING IS NOT A VERB — the false writes that made the headline count untrustworthy.
//
// MEASURED on one run: 15 endpoints were reported as writes; THREE were false, all the same shape —
// `/settings/company` matched because "settings" CONTAINS "set", and one of the three was a plain GET
// counted as a write. This project has retracted a write count once already ("18 write endpoints, the
// truthful count was ONE"), and an inflated count is worse than none: it sends a human to verify writes
// that never happened.
//
// Guards: short/ambiguous verbs are right-anchored so a longer word that merely STARTS with one is not a
//   write; run-together names (`updateusersettings`) still classify, because that is why the LEFT boundary
//   is deliberately loose.
// FAIL-ON-REVERT: drop `(?![a-z])` from WRITE_VERB_ANCHORED (one undifferentiated verb list again) →
//   "GET /settings/company is a read" reds with got 'write'.
test('a verb that is merely a PREFIX of a longer word is not a write', () => {
  // The exact live trio.
  assert.equal(classifyEndpoint({ method: 'GET', urlPattern: '/api/v1/settings/company' }), 'read',
    'a GET of settings is a read — "set" inside "settings" is not a mutation verb');
  // Non-GETs of the same path are honestly UNNAMED rather than confidently "write": the name carries no verb.
  assert.equal(classifyEndpoint({ method: 'PUT', urlPattern: '/api/v1/settings/company' }), 'write-unnamed');

  // The same shape for other short verbs, all of which appear in real APIs.
  assert.equal(classifyEndpoint({ method: 'GET', urlPattern: '/api/v1/orders' }), 'read', '"orders" is a listing');
  assert.equal(classifyEndpoint({ method: 'GET', urlPattern: '/api/v1/address' }), 'read', '"address" is not "add"');
  assert.equal(classifyEndpoint({ method: 'GET', urlPattern: '/api/v1/newsletter' }), 'read', '"newsletter" is not "new"');
});

test('run-together mutation names still classify as writes', () => {
  // THE OTHER DIRECTION, and the reason the left boundary stays loose: these are the names the classifier
  // exists to catch, and a wholesale right-anchor would have silently dropped them.
  assert.equal(classifyEndpoint({ method: 'POST', urlPattern: '/api/v1/updateusersettings' }), 'write');
  assert.equal(classifyEndpoint({ method: 'POST', urlPattern: '/api/v1/createlist' }), 'write');
  assert.equal(classifyEndpoint({ method: 'POST', urlPattern: '/api/v1/deleteaccount' }), 'write');
});
