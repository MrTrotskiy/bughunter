// The admin's «Конвейер»/Walk tabs must SPEAK the two decision-record kinds, not render their raw
// English name. row-vocabulary.rowSentence is the pure (kind, payload) → Russian sentence the viewer
// draws for a protocol row; a kind absent from PROTOCOL_KINDS + the switch falls to «Событие <kind>.»
// (a bare label in a Russian UI — the exact class the vocabulary module exists to remove).
//
// Guards: the render half of the Stage-6 decision record — a `gate` row states permit/refuse + the
//   RULE that decided + the ownership-proof cost, and a `driver.open` row states WHO drove the run;
//   both are in PROTOCOL_KINDS so the row LABEL is the sentence.
// FAIL-ON-REVERT: remove 'gate' (or 'driver.open') from PROTOCOL_KINDS in row-vocabulary.mjs → the
//   kind is no longer a protocol row and rowSentence's switch still speaks it, but the pipeline renders
//   it via the default badge with its raw kind — OR delete the `case 'gate':` arm → rowSentence returns
//   «Событие gate.» → the assertion on the permit/refuse wording reds. (Verified by hand per tests/CLAUDE.md.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowSentence, PROTOCOL_KINDS } from '../../lib/debug/row-vocabulary.mjs';

test('gate and driver.open are protocol rows whose label IS their sentence', () => {
  assert.ok(PROTOCOL_KINDS.has('gate'), 'gate must be a protocol row (its label is the decision sentence)');
  assert.ok(PROTOCOL_KINDS.has('driver.open'), 'driver.open must be a protocol row');
});

test('a gate PERMIT names the control, the cleared stage, the owner and the proof cost', () => {
  const s = rowSentence('gate', { name: 'Save', stage: 'cleared', decision: 'permit', ownership: 'own', resolveMs: 42 });
  assert.match(s, /Пропустили к нажатию/, 'a permit reads as "let through to click", never a bare kind');
  assert.match(s, /Save/, 'names the control');
  assert.match(s, /наш/, 'names the live ownership verdict');
  assert.match(s, /42 мс/, 'names the ownership-proof cost (resolveMs)');
});

test('a gate REFUSE names the control, the rule that declined, and the code', () => {
  const s = rowSentence('gate', { name: 'Logout', stage: 'href-route', decision: 'refuse', code: 'DANGER_FLOOR', resolveMs: 7 });
  assert.match(s, /Не нажали/, 'a refusal reads as "did not press", never a failure');
  assert.match(s, /Logout/, 'names the control');
  assert.match(s, /ссылка на опасный адрес/, 'names the RULE (href-route) in Russian, not the raw stage');
  assert.match(s, /DANGER_FLOOR/, 'carries the code');
});

test('a gate SKIP (off-origin) reads as "not pressed, leads outward"', () => {
  const s = rowSentence('gate', { name: 'Docs', stage: 'off-origin', decision: 'skip', href: 'https://x.example/y' });
  assert.match(s, /ссылка наружу/, 'names the off-origin rule');
  assert.match(s, /не нажимали/, 'states it was not pressed');
});

test('driver.open states WHO drove the run and the mode', () => {
  const agent = rowSentence('driver.open', { driver: 'agent', flags: { url: 'http://x/', authed: true } });
  assert.match(agent, /АГЕНТ/, 'an agent-driven run says АГЕНТ');
  assert.match(agent, /под логином/, 'authed flag surfaces');
  const script = rowSentence('driver.open', { driver: 'script', flags: { url: 'http://x/', exploreAll: true, steps: 20 } });
  assert.match(script, /СКРИПТ/, 'a script-driven run says СКРИПТ');
  assert.match(script, /explore-all/, 'the mode surfaces');
});

test('an unknown gate stage degrades to the raw stage, never crashes or invents', () => {
  const s = rowSentence('gate', { name: 'X', stage: 'future-rule', decision: 'refuse', code: 'X_CODE' });
  assert.match(s, /future-rule/, 'an unmapped stage falls back to its own name, not a crash');
});
