// endpoint-class — is an endpoint a READ or a WRITE? Pure.
//
// Guards the instrument itself. The old rule was "write := non-GET", and on the live target — which
// speaks POST-for-read — it reported 18 write endpoints when exactly ONE was a mutation. Several rounds
// of fixes were prioritized off that number. A classifier that cannot tell `POST /listnuggets` from
// `POST /updateusersettings` makes every downstream verdict about the run untrustworthy.
//
// Guards: a read verb travelling by POST classifies READ; an explicit mutation verb classifies WRITE
//   whatever the method; telemetry never counts as an application write; and a non-GET with no verb at
//   all is classified write but SURFACED as a fallback guess rather than asserted.
// FAIL-ON-REVERT: replace classifyEndpoint's body with the old method test
//   (`method === 'GET' ? 'read' : 'write'`) → "POST /rawcaster/listnuggets is a READ" fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEndpoint, classifyEndpoints } from '../../lib/recon/endpoint-class.mjs';

test('a read travelling by POST is a read, not a write', () => {
  // The exact endpoints the live crawl mis-counted as writes.
  for (const p of ['/rawcaster/listnuggets', '/rawcaster/getothersprofile', '/rawcaster/searchrawcasterusers',
    '/rawcaster/getfaq', '/rawcaster/listevents', '/rawcaster/get_status_detail', '/rawcaster/getcountylist',
    '/rawcaster/listallfriends', '/rawcaster/getusersettings']) {
    assert.equal(classifyEndpoint({ method: 'POST', urlPattern: p }), 'read', `POST ${p} is a READ`);
  }
});

test('an explicit mutation verb is a write, whatever the method', () => {
  for (const p of ['/rawcaster/updateusersettings', '/rawcaster/followandunfollow', '/api/createpost',
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
  // real — `nuggetcontentaudio` (text-to-speech), `texttoaudio`, `influencerlist` all arrived by this path.
  // And so did `contactus`, which genuinely does write. From the name alone they are indistinguishable, so
  // the honest answer is a separate class rather than a confident guess in either direction. This repeats a
  // failure already on record ("18 write endpoints, the truthful count was ONE") and takes the same fix:
  // surface the guess as a guess, and let a caller that needs certainty confirm by reading state back.
  assert.equal(classifyEndpoint({ method: 'POST', urlPattern: '/rawcaster/community_dropdown' }), 'write-unnamed');
  // The report contract is unchanged: a fallback guess still counts toward the write SURFACE, and is still
  // listed separately so the operator knows how much of that surface was guessed.
  const out = classifyEndpoints([
    { method: 'POST', urlPattern: '/rawcaster/community_dropdown' },
    { method: 'POST', urlPattern: '/rawcaster/updateusersettings' },
    { method: 'POST', urlPattern: '/rawcaster/listnuggets' },
    { method: 'POST', urlPattern: '/g/collect' },
  ]);
  assert.equal(out.writes.length, 2, 'two writes');
  assert.equal(out.reads.length, 1, 'listnuggets is the read');
  assert.equal(out.telemetry.length, 1, 'collect is telemetry');
  assert.deepEqual(out.unnamedWrites, ['POST /rawcaster/community_dropdown'],
    'the verbless one must be flagged as classified-by-fallback, not silently counted as a confirmed write');
});

test('endpoints are counted once each, not per call', () => {
  const out = classifyEndpoints(Array.from({ length: 40 }, () => ({ method: 'POST', urlPattern: '/rawcaster/listnuggets' })));
  assert.equal(out.reads.length, 1, '40 calls to one endpoint is ONE endpoint exercised');
});
