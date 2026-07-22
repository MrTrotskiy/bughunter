// The run-log audit of a REAL explore-all crawl (hunt-social-app) named three trail blind spots the
// admin could not speak: the crawl's TERMINAL reason lived only in run.json (reconstructed from four tail
// rows), the ownership own↔foreign FLIP on one post had no recorded BASIS, and a resolve failure rendered
// the constant «no-live-handle» instead of a diagnosis. Plus a bare «Событие relogin.» A row the admin
// cannot speak fails the operator's where/what/how/why bar as surely as an absent event.
//
// Guards: the RENDER half of the three completeness fixes — a `loop-terminal` states WHY the run stopped;
//   a `gate` states the ownership BASIS (ownershipVia), so an own-vs-foreign flip is explainable; a `pick`
//   names the resolve REASON of a rejected candidate; a `relogin` states outcome, not a bare kind.
// FAIL-ON-REVERT (each verified by hand): drop the `case 'loop-terminal'` arm → «Событие loop-terminal.»
//   → the terminal assertion reds; drop the `via` interpolation in the gate case → the ownership-basis
//   assertion reds; drop `RESOLVE_WHY_RU[...]` in the pick case → the reject-reason assertion reds; remove
//   'relogin' from PROTOCOL_KINDS or its case → the relogin assertion reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowSentence, PROTOCOL_KINDS } from '../../lib/debug/row-vocabulary.mjs';

test('loop-terminal states WHY the run stopped, with what was and was not reached', () => {
  assert.ok(PROTOCOL_KINDS.has('loop-terminal'), 'loop-terminal is a protocol row (its label is the reason)');
  const s = rowSentence('loop-terminal', { reason: 'frontier-drained', steps: 10, stats: { explored: 8, unreachable: 2 } });
  assert.match(s, /остановлен/, 'reads as a stop, not a bare kind');
  assert.match(s, /фронтир исчерпан/, 'names the terminal reason in Russian');
  assert.match(s, /изучено 8/, 'says what was reached');
  assert.match(s, /недостижимо 2/, 'says what was not');
});

test('a gate names the ownership BASIS so an own↔foreign flip is explainable', () => {
  const own = rowSentence('gate', { name: 'Edit', stage: 'cleared', decision: 'permit', ownership: 'own', ownershipVia: 'marker-on-handle', resolveMs: 25 });
  assert.match(own, /наш маркер на самом контроле/, 'an own verdict names the marker that proved it');
  const foreign = rowSentence('gate', { name: 'Delete', stage: 'ownership-rail', decision: 'refuse', code: 'FOREIGN_DESTROY', ownershipVia: 'no-marker-in-item', resolveMs: 11 });
  assert.match(foreign, /элемент без нашего маркера/, 'a foreign refusal names WHY it is foreign');
  assert.match(foreign, /FOREIGN_DESTROY/, 'and carries the code');
});

test('a pick names the resolve REASON of a reject, not the old constant', () => {
  const s = rowSentence('pick', {
    candidates: 5, chosen: { name: 'Like', rule: 'revealed-recency' }, outranked: 3,
    rejectedTotal: 1, rejected: [{ templateId: 15, name: '', why: 'gone-from-dom' }],
  });
  assert.match(s, /исчез из DOM/, 'the reject reason is a diagnosis, not «no-live-handle»');
});

test('a relogin states its outcome, never a bare «Событие relogin.»', () => {
  assert.ok(PROTOCOL_KINDS.has('relogin'), 'relogin is a protocol row');
  const failed = rowSentence('relogin', { after: 5, name: 'Delete account', ok: false });
  assert.match(failed, /Повторный вход/, 'names the re-entry');
  assert.match(failed, /Delete account/, 'names what triggered it');
  assert.doesNotMatch(failed, /^Событие/, 'never the bare-kind fallback');
  const okd = rowSentence('relogin', { after: 7, name: 'Logout', ok: true });
  assert.match(okd, /сессия восстановлена/, 'a successful re-entry says so');
});
