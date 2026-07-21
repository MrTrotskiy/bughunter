// row-vocabulary — every event kind a real run emits renders a Russian SENTENCE that names the
// action, the alternatives and the rule, from its OWN payload. node:test, NO browser, NO DOM.
//
// The defect this guards: the «Конвейер» tab styled 3 of 13 kinds; the other ten fell to a default
// badge and rendered their RAW ENGLISH kind name (`pick`, `drain-outcome`, `route-choice`, …) as the
// whole label in a Russian UI, and 337 `policy-verdict` rows carried a `name` so a script DECISION
// rendered as a bare control name, mistakable for a click. The crawler's own decision protocol was
// captured in full and shown as noise.
//
// Payloads below are representative run shapes (the field shapes a real run emits), not synthetic
// happy-path stubs — a stub would render whatever the code prints and prove nothing.
//
// Guards:
//  - every one of the 13 kinds renders a non-empty Russian sentence carrying its DECISION content
//    (the chosen route + what it passed over; the candidate count + ranking rule; the gate + evidence),
//    and never a bare English kind name.
//  - a policy-verdict is visibly a VERDICT and never mistakable for an act (opens «Вердикт:», never
//    «Нажали», and is not the bare control name).
//  - a field the sentence wants but the payload lacks degrades to «… не записан(а)», never invented,
//    never a throw.
// FAIL-ON-REVERT (each verified by hand):
//  - make the policy-verdict branch return `Нажали ${name}…` → «verdict is not an act» reds.
//  - drop the `chosen`/`rejected` read in route-choice (return a kind-only string) → «names the
//    alternative it took and what it skipped» reds.
//  - remove a kind's case so it hits `default` («Событие <kind>.») → «no sentence is a bare English
//    kind name» reds naming that kind.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rowSentence, PROTOCOL_KINDS, SPOKEN_KINDS } from '../../lib/debug/row-vocabulary.mjs';
import { KIND_STYLE } from '../../lib/debug/pipeline-view.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '../fixtures/trail-golden');

// The 13 kinds a real run emits, with a representative payload for each.
const P = {
  route: { route: '/', total: 87, new: 115, opaque: 1, overlayDismissed: null },
  'drain-outcome': { route: '/dashboard', outcome: 'drained', acts: 0, barren: 1, visits: 0 },
  'drain-outcome-budget': { route: '/form-a', outcome: 'budget', acts: 20, barren: 0, visits: 1 },
  retire: { route: '/dashboard', final: false, rule: 'revisits-remain', judged: 0, reachable: 0, reopened: 0, churned: 0, unreachable: 0, deferred: 0 },
  'route-choice': { trigger: 'drained', from: '/section-a', source: 'queue', rule: 'bfs-queue', chosen: '/section-b', visitsOfChosen: 0, withWork: 5, eligible: 4, rejected: [{ route: '/section-a', why: 'current' }], rejectedTotal: 1, backtracks: 10 },
  pick: { route: '/dashboard', candidates: 58, chosen: { templateId: 1100, instanceKey: '#1', name: 'Control A', rank: 0, rule: 'revealed-recency', revealedAt: 184 }, probed: 1, outranked: 57, rejected: [], rejectedTotal: 0 },
  'policy-verdict': { code: 'ALLOWED', allow: true, rule: 'explore-all: safe permitted on none target', floor: 'safe', ownership: 'none', name: 'Control B', route: '/notices', needsRestore: false, needsRelogin: false, calls: 1 },
  'policy-verdict-refused': { code: 'OUTWARD_REFUSED', allow: false, rule: 'reaches a person or a third party outside the app — refused on every tier', floor: 'safe', ownership: 'none', name: 'Control 1 Control 2 Control 3 Control 4 Control 5', route: '/profile/abc', needsRestore: false, needsRelogin: false, calls: 381 },
  'policy-verdict-foreign': { code: 'FOREIGN_ADDITIVE', allow: true, rule: "additive act on another user's item", floor: 'safe', ownership: 'foreign', name: 'Control C', route: '/account-delete', needsRestore: false, needsRelogin: false, calls: 13 },
  act: { templateId: 116, instanceKey: '#1', name: 'Control B', role: 'button', route: '/dashboard', requests: [{ method: 'GET', urlPattern: '/api/chats' }, { method: 'POST', urlPattern: '/api/listitems' }], revealed: 0, verdict: 'navigate' },
  'act.failed': { templateId: 427, instanceKey: '#1', name: '', role: 'combobox', requested: '/form-a', instanceSelector: '#device', code: 'ACT_FAILED', clicked: false, message: 'elementHandle.click: Timeout 5000ms exceeded.', error: 'elementHandle.click: Timeout 5000ms exceeded.' },
  reopen: { templateId: 230, instanceKey: '#1', name: null, route: '/section-a', ok: false, code: 'REOPEN_UNVERIFIED', failedHop: { i: 0, templateId: 228, name: 'Control D', resolved: true, error: null }, hopsResolved: 1, hopsTotal: 1, attemptsTried: 2 },
  'reopen-delivered': { templateId: 770, instanceKey: '2829301234', name: '2026-06-28', route: '/route-a', delivered: true, code: null, error: null },
  'retire-answered': { templateId: 427, instanceKey: '#1', name: null, route: '/form-a', rule: 'no-progress', code: null, rows: 4, answer: 'click:ACT_FAILED', finding: null },
  'reloc-census': { attempted: 38, succeeded: 9, refusedRepeat: 164, distinctFailed: 29, pending: 0, deliveredNothing: 4 },
};

const THIRTEEN = ['route', 'route-choice', 'drain-outcome', 'retire', 'pick', 'pick-empty',
  'policy-verdict', 'act', 'act.failed', 'reopen', 'reopen-delivered', 'retire-answered', 'reloc-census'];

/* ---------------------------------------------------------------- 1. every kind speaks Russian */

test('all 13 kinds render a Russian sentence, never a bare English kind name', () => {
  for (const kind of THIRTEEN) {
    // pick-empty has no entry in P (its own case below); use a real fix1 shape for it here.
    const payload = kind === 'pick-empty'
      ? { route: '/section-a', candidates: 1, inspected: 1, reasons: { 'role-name-only': 1 } }
      : P[kind];
    const s = rowSentence(kind, payload);
    assert.ok(s && s.length > 0, `${kind}: no sentence`);
    // No raw English kind name leaks as the label, and it never falls to the default «Событие …».
    assert.doesNotMatch(s, new RegExp(`^Событие`), `${kind}: fell to the default kind-name label — its case is missing`);
    assert.doesNotMatch(s, new RegExp(kind.replace('.', '\\.')), `${kind}: the raw English kind name «${kind}» leaked into the sentence`);
    assert.match(s, /[А-Яа-яЁё]/, `${kind}: the sentence carries no Cyrillic — it is not in the operator's language`);
  }
});

/* ---------------------------------------------------------------- 2. decision content per kind */

test('route-choice names the route it took, the one it skipped, and the rule', () => {
  const s = rowSentence('route-choice', P['route-choice']);
  assert.match(s, /\/section-b/, 'names the chosen route');
  assert.match(s, /\/section-a/, 'names where it came from / what it rejected');
  assert.match(s, /обход в ширину/, 'names the bfs-queue rule in Russian');
  assert.match(s, /из очереди/, 'names the source');
  assert.match(s, /отклонили 1|уже на ней/, 'names the alternative it passed over and why');
  // The RULE reverting lever: a kind-only string carries none of this.
  assert.ok(!/route-choice/.test(s));
});

test('pick names the candidate count, the choice and the ranking rule', () => {
  const s = rowSentence('pick', P.pick);
  assert.match(s, /58/, 'names how many candidates');
  assert.match(s, /Control A/, 'names the chosen control');
  assert.match(s, /свежераскрытые вперёд/, 'names the revealed-recency rule in Russian');
  assert.match(s, /57 проиграли по рангу/, 'names the alternatives that lost on rank');
});

test('pick-empty names why nothing was pressed', () => {
  const s = rowSentence('pick-empty', { route: '/section-a', candidates: 3, reasons: { 'role-name-only': 2, absent: 1 } });
  assert.match(s, /нажимать некого/, 'states nothing was pressable');
  assert.match(s, /только роль и имя/, 'names a real reason in Russian');
  assert.match(s, /нет на странице/, 'names the second reason');
});

test('drain-outcome distinguishes drained / budget / navigated', () => {
  assert.match(rowSentence('drain-outcome', P['drain-outcome']), /\/dashboard.*исчерпана.*не осталось/);
  assert.match(rowSentence('drain-outcome', P['drain-outcome-budget']), /по лимиту.*изучено не всё/);
  assert.match(rowSentence('drain-outcome', { route: '/x', outcome: 'navigated', acts: 1 }), /ушли на другую страницу/);
});

test('retire names the stop rule and what it deferred', () => {
  const s = rowSentence('retire', P.retire);
  assert.match(s, /страницу отложили/);
  assert.match(s, /остались повторные заходы/, 'the revisits-remain rule in Russian');
  assert.match(s, /недостижимо 0/, 'carries the counts');
});

test('retire-answered names the probe, the answer and the rule', () => {
  const s = rowSentence('retire-answered', P['retire-answered']);
  assert.match(s, /закрыт/);
  assert.match(s, /клик → ACT_FAILED/, 'the probe glossed to Russian, the code kept as data');
  assert.match(s, /нет прогресса/, 'the rule in Russian');
});

test('reopen distinguishes success from a broken path and names the failing hop', () => {
  assert.match(rowSentence('reopen', P.reopen), /Не смогли снова открыть.*путь не подтвердился.*Control D/);
  assert.match(rowSentence('reopen', { name: 'Row', route: '/x', ok: true, hops: 1 }), /Снова открыли.*1 шаг пути/);
  assert.match(rowSentence('reopen-delivered', P['reopen-delivered']), /снова доступен.*воспроизведён/);
});

test('reloc-census reports the run-end relocation tally', () => {
  const s = rowSentence('reloc-census', P['reloc-census']);
  assert.match(s, /из 38 попыток удалось 9/);
  assert.match(s, /повторных отказов 164/);
  assert.match(s, /не разрешено 29/);
});

test('act and act.failed read as prose', () => {
  assert.match(rowSentence('act', P.act), /Нажали Control B: вызвано 2 запроса/);
  // A nameless failed control anchors on its id, not on a bare role, and names the code.
  assert.match(rowSentence('act.failed', P['act.failed']), /Клик по без имени · #device не удался \(ACT_FAILED\)/);
});

/* ---------------------------------------------------------------- 3. a verdict is never an act */

test('policy-verdict is a VERDICT and never mistakable for a click', () => {
  for (const key of ['policy-verdict', 'policy-verdict-refused', 'policy-verdict-foreign']) {
    const p = P[key];
    const s = rowSentence('policy-verdict', p);
    assert.match(s, /^Вердикт:/, `${key}: a verdict must announce itself`);
    assert.doesNotMatch(s, /^Нажали/, `${key}: a verdict must not read as an act`);
    // It is NOT the bare control name (the exact defect: 337 verdicts rendered as a control name).
    assert.notEqual(s.trim(), String(p.name).trim(), `${key}: rendered as a bare control name`);
    assert.match(s, /разрешено|ЗАПРЕЩЕНО/, `${key}: states the ruling`);
  }
  // The refusal names the gate and the evidence; the permit names the owner.
  assert.match(rowSentence('policy-verdict', P['policy-verdict-refused']), /ЗАПРЕЩЕНО — уходит к живому человеку/);
  assert.match(rowSentence('policy-verdict', P['policy-verdict-foreign']), /дополняющее действие над чужим/);
  assert.match(rowSentence('policy-verdict', P['policy-verdict']), /контрол безопасен, владелец не определён/);
});

/* ---------------------------------------------------------------- 4. honest degradation */

test('a missing field degrades to «не записан(а)», never invented, never a throw', () => {
  assert.match(rowSentence('route-choice', { from: '/a', chosen: '/b' }), /причина не записана/, 'no rule → said so');
  assert.match(rowSentence('retire-answered', { name: 'x', route: '/r', rule: 'no-progress' }), /ответ не записан/, 'no answer → said so');
  // A null/empty payload still renders the kind's own honest sentence (never a throw, never the
  // English-kind default): pick with no candidates says it chose a control under an unrecorded rule.
  assert.match(rowSentence('pick', null), /Выбрали контрол.*причина не записана/, 'a null payload degrades, never throws');
  assert.doesNotThrow(() => rowSentence('drain-outcome', {}));
  assert.doesNotThrow(() => rowSentence('policy-verdict', {}));
});

/* ---------------------------------------------------------------- 5. the sets are consistent */

test('every protocol kind is spoken, and every styled kind that occurs is spoken', () => {
  for (const k of PROTOCOL_KINDS) assert.ok(SPOKEN_KINDS.has(k), `${k} is a protocol kind but not spoken`);
  // Every kind in the golden trail must be styled AND spoken — the two lists cannot drift apart.
  const events = fs.readFileSync(path.join(FIX, 'events.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const kinds = new Set(events.map((e) => e && e.kind));
  for (const k of kinds) {
    assert.ok(KIND_STYLE[k], `golden trail kind «${k}» has no KIND_STYLE`);
    assert.ok(SPOKEN_KINDS.has(k), `golden trail kind «${k}» has no sentence`);
  }
});
