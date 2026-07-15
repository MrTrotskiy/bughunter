// Unit test for selectKept — the PURE, SYNCHRONOUS kept-set decision extracted from endCause.
// The two-pass fix hinges on this: the decision (token cause+seq0, initiator verdict, static
// filter) contains NO await, so response-body enrichment can never change WHICH fires are kept
// (the phantom-edge class that killed bughunt-agents). This pins the filter logic without a
// browser; the live seam test proves endCause runs it BEFORE any body await.
//
// Guards: selectKept applies cause + seq0 + initiator verdict + static-asset filters, synchronously.
// FAIL-ON-REVERT (initiator): drop the `verdict.background` continue → "a background-verdict fire
//   is rejected" fails (the poll leaks into kept).
// FAIL-ON-REVERT (seq): drop the seq0 continue → "a pre-click fire is rejected" fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectKept } from '../../lib/browser/causal.mjs';

const fire = (url, { cause = 'C', seq = 5, method = 'GET' } = {}) => ({ cause, method, url, seq });

test('selectKept keeps only same-cause, post-seq0, foreground, non-static fires', () => {
  const fires = [
    fire('/api/click', { seq: 5 }),                 // kept: foreground, this cause, after seq0
    fire('/api/poll', { seq: 6 }),                  // dropped: background verdict
    fire('/api/early', { seq: 1 }),                 // dropped: before seq0
    fire('/api/other', { seq: 7, cause: 'OTHER' }), // dropped: different cause
    fire('/assets/app.js', { seq: 8 }),             // dropped: static asset
  ];
  const verdictFor = (u) => (String(u).includes('/api/poll') ? { background: true } : { background: false });
  const kept = selectKept(fires, 'C', 4, verdictFor);
  const urls = kept.map((f) => f.url);
  assert.ok(Array.isArray(kept), 'returns an array synchronously (not a promise)');
  assert.deepEqual(urls, ['/api/click'], 'exactly the one real caused edge survives');
});

test('a background-verdict fire is rejected (the initiator filter)', () => {
  const kept = selectKept([fire('/api/poll', { seq: 9 })], 'C', 0, () => ({ background: true }));
  assert.equal(kept.length, 0, 'a timer/parser-rooted fire is dropped even though the token matches');
});

test('a pre-click fire (seq < seq0) is rejected (the token seq filter)', () => {
  const kept = selectKept([fire('/api/load', { seq: 2 })], 'C', 5, () => ({ background: false }));
  assert.equal(kept.length, 0, 'a load-burst fired before the click is dropped');
});

test('no verdictFor (inert CDP) → token + static filters still apply, foreground kept', () => {
  const kept = selectKept([fire('/api/x', { seq: 5 }), fire('/x.css', { seq: 6 })], 'C', 0, null);
  assert.deepEqual(kept.map((f) => f.url), ['/api/x'], 'degrades to token-only, static still dropped');
});
