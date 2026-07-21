// The failure-explanation layer: does every way an act can fail have a human explanation, and do the
// four tones say the right thing about what happened?
//
// WHY THIS TEST EXISTS. The viewer used to classify failures by guessing at message TEXT with an
// ordered pile of regexes inside admin.html. It decayed exactly the way an untested lookup decays:
// five distinct causes collapsed onto one label, and the label was wrong. Measured on the completed
// run `state/runs/raw1` (287 acts, 146 failures), its first probe `/refus/` matched the words
// "firewall-refused", so all 43 REVEAL_FIREWALL acts were reported as danger-floor refusals —
// including a `button "Close"` that danger-floor classifies as SAFE. A separate branch printed
// «инстанс контрола не удалось найти на странице» directly above a message stating the element IS
// present but not visible: found and not-found at once.
//
// The PARITY case below is the load-bearing one, copied in mechanism from the operator's other
// project (aeye-os paper/tests/unit/debugKitLlmHints.test.js): it enumerates the failure codes the
// SOURCE can actually throw and asserts each is either explained or explicitly declared not to be an
// act outcome. A new failure class with no explanation FAILS THE BUILD; that is the whole point.
//
// FAIL-ON-REVERT (five levers, each independently verified):
//  1. add a `code: 'WHATEVER_NEW'` envelopeError under lib/recon/ without touching failure-hints.mjs
//     → "every failure code has an explanation" fails.
//  2. move DISABLED to any non-FINDING tone → "DISABLED is a finding" fails.
//  3. move DANGER_REFUSED or REVEAL_FIREWALL to a failure tone → "the guard working is not breakage" fails.
//  4. reorder CLASSES so /refus/-style matching precedes the firewall rule → "a Close button" fails.
//  5. drop the graph join from the NO_INSTANCE branch → "the split" fails.
//  6. put a «откройте вкладку …» clause back into any sentence → "NO SENTENCE EVER TELLS THE READER
//     TO NAVIGATE" fails, naming the class. The operator read that exact hedge while on the very tab
//     it sent him to.
//  7. make displayName ignore the anchor chain for a nameless control → "a control with no
//     accessible name still gets an anchor" fails: the row falls back to a bare ROLE, which
//     identifies nothing on a page with forty buttons.
//  8. restore a fixed cause trio in ANY refusal sentence ("это защита от logout / удаления /
//     оплаты") → "no refusal sentence names a cause belonging to another rule" fails, naming the
//     class AND the foreign family. This is the THIRD instance of one bug class in a session: a
//     generic boilerplate label printed in place of the actual cause.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TONES, CLASSES, NOT_AN_ACT_OUTCOME, classify, explainFailure,
  interceptingOf, revealPathFor, displayName, anchorOf, anchorSource, revealKnowledge,
  REFUSAL_RULES, refusalRuleOf, refusalSentence, controlPhrase, roleRu, ancestorClass,
} from '../../lib/debug/failure-hints.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

/* ------------------------------------------------------------------ parity */

// Every `code:` literal thrown as an envelopeError under lib/recon/ — the real, current inventory,
// read from the source rather than from a list that would drift the moment someone adds a throw.
function thrownCodes() {
  const dir = path.join(REPO, 'lib/recon');
  const codes = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // envelopeError({ ... code: 'X' ... }) — the code may sit a few lines below the call.
    for (const m of src.matchAll(/envelopeError\(\{[\s\S]{0,240}?code:\s*'([A-Z_0-9]+)'/g)) codes.add(m[1]);
  }
  return codes;
}

// The recordFail FALLBACK codes — the ones a live driver stamps on the act.failed row when an act throws
// with NO envelope of its own: `code: err?.envelope?.code || (err?.clicked ? 'POST_CLICK_FAILED' :
// 'ACT_FAILED')` (recon-run.persistentStep, stateful-step.recordFail). `thrownCodes` above scans only
// `envelopeError({code:'X'})` LITERALS, so these two slipped the same door OUTWARD_REFUSED did — the THIRD
// instance of this blind spot. This is the LOAD-BEARING half of the fix: a fourth fallback code cannot be
// added without a CLASSES entry, because the parity test scans this pattern across lib/recon/*.mjs too.
function fallbackCodes() {
  const dir = path.join(REPO, 'lib/recon');
  const codes = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // code: err<...> ? 'X' : 'Y' — capture BOTH literals of the ternary fallback.
    for (const m of src.matchAll(/code:\s*err[^']*'([A-Z_0-9]+)'[^']*'([A-Z_0-9]+)'/g)) { codes.add(m[1]); codes.add(m[2]); }
  }
  return codes;
}

test('every failure code the crawler can throw has an explanation (or is declared not an act outcome)', () => {
  const explained = new Set();
  for (const c of CLASSES) for (const src of c.codes) explained.add(src);
  const orphans = [];
  // BOTH the envelopeError literals AND the recordFail ternary fallbacks — the second scan is what closes
  // the door POST_CLICK_FAILED / ACT_FAILED slipped through (they are not envelope literals).
  const allCodes = new Set([...thrownCodes(), ...fallbackCodes()]);
  for (const code of allCodes) {
    if (!explained.has(code) && !NOT_AN_ACT_OUTCOME.has(code)) orphans.push(code);
  }
  assert.deepEqual(orphans, [],
    `these codes are thrown under lib/recon/ but have no hint entry and are not declared non-outcomes: ${orphans.join(', ')}. `
    + 'Add a CLASSES entry (preferred) or, if it can never land on an act row, add it to NOT_AN_ACT_OUTCOME with a reason.');
  assert.ok(thrownCodes().size > 15, 'the source scan found suspiciously few codes — the regex probably stopped matching');
  assert.ok(fallbackCodes().size >= 2,
    'the recordFail fallback scan found fewer than the 2 known codes (POST_CLICK_FAILED / ACT_FAILED) — '
    + 'the ternary-fallback regex probably stopped matching, and a future fallback code could slip through unexplained');
});

test('the recordFail fallback codes classify with an honest BROKEN sentence', () => {
  // Guards: the two plain-object fallback codes render a real sentence, not the flat-red «сбой» with no
  // words. FAIL-ON-REVERT: remove POST_CLICK_FAILED / ACT_FAILED from CLASSES → both `explainFailure`
  // returns go null → every assertion here reds AND the parity test above reds (fallbackCodes surfaces
  // them unexplained).
  const post = explainFailure({ code: 'POST_CLICK_FAILED', error: 'page.click: Target page has been closed' }, null);
  assert.equal(post.code, 'POST_CLICK_FAILED');
  assert.equal(post.tone, TONES.BROKEN.key, 'a click that fired then failed is a real defect worth a look');
  // The worst case: the click REACHED THE SERVER, so under explore-all a mutation may have committed. The
  // operator must be told, not handed a bare code.
  assert.match(post.sentence, /дошёл до сервера|запрос ушёл/, 'must state the click reached the server');
  assert.match(post.sentence, /записаться|правка|измен/, 'and that something may have been written');

  const act = explainFailure({ code: 'ACT_FAILED', error: 'locator.click: some raw error' }, null);
  assert.equal(act.code, 'ACT_FAILED');
  assert.equal(act.tone, TONES.BROKEN.key);
  // ACT_FAILED is generic — it must NOT borrow POST_CLICK_FAILED's implication that the server was reached.
  assert.doesNotMatch(act.sentence, /дошёл до сервера|записаться|реальная правка/,
    'a generic step failure must not claim a mutation may have committed');
  assert.notEqual(act.sentence, post.sentence, 'the two fallbacks carry different implications');
});

test('every declared class is complete and internally consistent', () => {
  const seen = new Set();
  for (const c of CLASSES) {
    assert.ok(c.code && !seen.has(c.code), `duplicate or missing class code: ${c.code}`);
    seen.add(c.code);
    assert.ok(Object.values(TONES).includes(c.tone), `${c.code} has an unknown tone`);
    assert.ok(c.legacyRe instanceof RegExp, `${c.code} has no legacyRe — runs already on disk carry prose, not codes`);
    assert.ok(c.chip && c.chip.length <= 20, `${c.code} needs a short chip label`);
    // Exactly one of text/explain — both would make the sentence source ambiguous.
    assert.ok(!!c.text !== !!c.explain, `${c.code} must declare either text or explain, not both`);
  }
});

/* ------------------------------------------------------------------ tone sentinels */

test('DISABLED is a FINDING, never a failure', () => {
  // docs/GOAL.md: anomalies are findings. step.mjs already calls a disabled control a finding —
  // "the control announces itself but refuses to be operated". The UI painted it «сбой», the exact
  // inversion. FAIL-ON-REVERT: switch this class to TONES.BROKEN and this case goes green-to-red.
  const ex = explainFailure({ error: 'instance #save is visible but disabled — it cannot be operated in this state' }, null);
  assert.equal(ex.code, 'DISABLED');
  assert.equal(ex.tone, TONES.FINDING.key, 'a disabled control is a result of the study, not a fault in it');
  assert.notEqual(ex.tone, TONES.BROKEN.key);
  assert.notEqual(ex.tone, TONES.UNREACHED.key);
});

test('the guard working is not breakage: DANGER_REFUSED and REVEAL_FIREWALL are ПО ПЛАНУ', () => {
  // FAIL-ON-REVERT: give either class a red tone and this case fails. Painting our own safety rails
  // as damage is misinformation — the operator reads the colour before he reads the words.
  const danger = explainFailure({ error: 'refusing to fire a destructive control "Delete" (template 12)' }, null);
  assert.equal(danger.code, 'DANGER_REFUSED');
  assert.equal(danger.tone, TONES.PLANNED.key);
  const fw = explainFailure({ error: 'reveal step 76 fired a firewall-refused request POST /x/addview (off-origin) at replay time — blocked (account unmutated), path refused' }, null);
  assert.equal(fw.code, 'REVEAL_FIREWALL');
  assert.equal(fw.tone, TONES.PLANNED.key);
  for (const ex of [danger, fw]) assert.notEqual(ex.tone, TONES.BROKEN.key, 'ПО ПЛАНУ must never render red');
});

test('a NOT_VISIBLE message never classifies as NO_INSTANCE', () => {
  // The operator's exact contradiction: «не удалось найти на странице» printed directly above a
  // message saying the element IS present but not visible.
  const msg = 'instance #upload is present but not visible in the current viewport';
  const ex = explainFailure({ error: msg }, null);
  assert.equal(ex.code, 'NOT_VISIBLE');
  assert.notEqual(ex.code, 'NO_INSTANCE');
  assert.ok(!/не нашл|не удалось найти/i.test(ex.sentence),
    'the sentence must not claim the element was not found — the message says it is present');
  assert.ok(/не виден/.test(ex.sentence));
});

test('a Close button blocked by the firewall is not reported as a danger refusal', () => {
  // The regression that produced the operator's second lie, verbatim from raw1: the old classifier's
  // /refus/ probe matched "firewall-refused" and stole all 43 firewall acts. danger-floor classifies
  // "Close" as safe, so «предохранитель» on this row was a fabrication.
  // FAIL-ON-REVERT: move any /refus/-matching class above REVEAL_FIREWALL in CLASSES → this fails.
  const ex = explainFailure({
    error: 'reveal step 76 fired a firewall-refused request POST /api/addview (off-origin) at replay time — blocked (account unmutated), path refused',
    role: 'button', name: 'Close',
  }, null);
  assert.equal(ex.code, 'REVEAL_FIREWALL');
  assert.notEqual(ex.code, 'DANGER_REFUSED');
  assert.ok(!/предохранител|классификатор/.test(ex.sentence));
  assert.ok(/Файрвол/.test(ex.sentence) && /POST \/api\/addview/.test(ex.sentence),
    'the sentence must name the request that was blocked — that is the evidence');
});

/* ------------------------------------------------------------------ WHICH RULE REFUSED */

// Guards: a refusal sentence states the rule that ACTUALLY fired, with that rule's own
// justification and the honest consequence — never a fixed cause list and never "protection".
//
// The defect, verbatim from the panel: «разрушительные». Это защита от logout / удаления / оплаты.
// Two lies in one line. (1) The trio is printed whichever of the SEVEN refusal rules fired —
// danger-floor's four classes plus explore-policy's three, each with a different justification.
// (2) It frames the refusal as protection the operator wants; CLAUDE.md says the opposite ("the
// crawler is a QA tool on the operator's own stand and is MEANT to create/edit/delete/pay"), so on
// a DEFAULT run a danger refusal is LOST COVERAGE and `--explore-all` removes it.
//
// Ground truth from the runs on disk: raw1 refused 7 controls `communication` + 1 `destructive`;
// raw3 has 3 `destructive` DANGER_FLOOR acts and 43 OUTWARD_REFUSED; hunt1 has 14 OUTWARD_REFUSED.

const dangerStep = (floor, name = 'X') => ({
  code: 'DANGER_FLOOR', error: `refusing to fire a ${floor} control "${name}" (template 12)`,
});

test('a communication refusal names communication, and never borrows another rule’s cause', () => {
  // FAIL-ON-REVERT: restore the fixed trio in the DANGER_REFUSED sentence → the удаление/оплата
  // assertions red. The class the live run actually refused most, described by three causes that
  // were all somebody else's.
  const ex = explainFailure(dangerStep('communication', 'Join a meeting'), null);
  assert.equal(ex.code, 'DANGER_REFUSED');
  assert.match(ex.sentence, /связь с людьми/, 'the sentence must NAME the rule that fired');
  assert.match(ex.sentence, /звонок|трансляц|встреч/, 'and state why THAT rule exists');
  assert.doesNotMatch(ex.sentence, /удал|уничтож/, 'a communication refusal is not about deletion');
  assert.doesNotMatch(ex.sentence, /оплат|платёж|платеж/, 'nor about payment');
  assert.doesNotMatch(ex.sentence, /logout|выход из|разлогин/i, 'nor about logout');

  // The OTHER outward rule is a DIFFERENT rule with a different justification, and must not be
  // collapsed into this one: it is refused on every tier, danger-floor's class is not.
  const outward = explainFailure({ code: 'OUTWARD_REFUSED', error: 'reaches a person or a third party outside the app — refused on every tier — "Report content" (template 297)' }, null);
  assert.equal(outward.code, 'OUTWARD_REFUSED');
  assert.notEqual(outward.sentence, ex.sentence, 'two different rules must not produce one sentence');
});

test('a DEFAULT-run danger refusal states the control was NOT studied and that --explore-all removes it', () => {
  // A DANGER_FLOOR act is default-mode BY CONSTRUCTION — step.mjs throws it only in the `!exploreAll`
  // branch — so the consequence is derivable, not guessed. It is a coverage gap, not a success.
  // FAIL-ON-REVERT: drop LIFTED_BY_EXPLORE_ALL from the danger rules → both assertions red.
  for (const floor of ['destructive', 'auth', 'payment', 'communication']) {
    const ex = explainFailure(dangerStep(floor), null);
    assert.match(ex.sentence, /не изучен|дыра в покрытии/,
      `${floor}: the refusal must state the control was not studied — it is lost coverage, not protection`);
    assert.match(ex.sentence, /--explore-all/,
      `${floor}: the refusal must say it is removable by re-running with --explore-all`);
    assert.doesNotMatch(ex.sentence, /защита/, 'a refusal the operator did not ask for is not «защита»');
  }
  // The route-level gate is the same story through a different door (recon-run / whats-new).
  const route = explainFailure({ code: 'ROUTE_DANGER', error: 'refusing to navigate to a danger route /logout' }, null);
  assert.equal(route.code, 'ROUTE_REFUSED');
  assert.match(route.sentence, /\/logout/, 'the route IS the evidence — name it');
  assert.match(route.sentence, /--explore-all/);
});

test('the explore-all rails read as deliberate and never suggest a flag that would not help', () => {
  // FOREIGN_DESTROY and ACCOUNT_PROTECTED survive explore-all — they ARE the mode's only refusals —
  // and OUTWARD_REFUSED is refused on every tier. Telling the operator to re-run with a flag that
  // changes nothing is the same defect one level down.
  // FAIL-ON-REVERT: mark any of the three `lifted: true` in REFUSAL_RULES → the explore-all
  // assertion reds (the sentence starts advertising a flag that cannot lift it).
  const rails = {
    OUTWARD_REFUSED: 'reaches a person or a third party outside the app — refused on every tier — "Block account" (template 297)',
    FOREIGN_DESTROY: "refusing to destroy another user's content (irreversible) — \"Delete\" (template 44)",
    ACCOUNT_PROTECTED: 'refusing to delete an account this run did not create — "Delete account" (template 51)',
  };
  for (const [code, error] of Object.entries(rails)) {
    const ex = explainFailure({ code, error }, null);
    assert.equal(ex.code, code, `${code} must classify — it lands on act rows`);
    assert.match(ex.sentence, /намеренн/, `${code}: must read as deliberate`);
    assert.match(ex.sentence, /любом режиме|любой режим/, `${code}: must say it survives every mode`);
    assert.doesNotMatch(ex.sentence, /explore-all/,
      `${code}: must NOT point at a flag that would not change the outcome`);
  }
  // And each states its OWN reason, not a shared one.
  const sentences = Object.entries(rails).map(([code, error]) => explainFailure({ code, error }, null).sentence);
  assert.equal(new Set(sentences).size, 3, 'three rails, three justifications');
});

test('NO REFUSAL SENTENCE NAMES A CAUSE BELONGING TO ANOTHER RULE', () => {
  // The generic form of the defect, asserted across the WHOLE taxonomy so a future class cannot
  // reintroduce it — the same shape as "NO SENTENCE EVER TELLS THE READER TO NAVIGATE" above.
  // A sentence may name the cause family of the rule that FIRED and no other; the payload decides
  // which that is, so any family the payload could contradict is a fabrication.
  // FAIL-ON-REVERT: put «Это защита от logout / удаления / оплаты» back on any class → this fails,
  // naming the class and the foreign family.
  const FAMILIES = {
    destroy: /удал\w*|уничтож\w*/i,
    auth: /выход\w*\s+из|логаут|разлогин|неавторизован/i,
    pay: /оплат\w*|платёж|платеж\w*|покупк\w*/i,
    comm: /звонок|звонк\w*|трансляц\w*|созвон\w*|встреч\w*/i,
    outward: /жалоб\w*|блокировк\w*|модератор\w*|письм\w*|SMS/i,
  };
  const familiesIn = (s) => Object.entries(FAMILIES).filter(([, re]) => re.test(s)).map(([k]) => k);

  // Every refusal payload the crawler can produce, with the ONE family each may legitimately name.
  const cases = [
    ...['destructive', 'auth', 'payment', 'communication'].map((f) => ({
      what: `DANGER_FLOOR/${f}`, step: dangerStep(f),
      allow: { destructive: ['destroy'], auth: ['auth'], payment: ['pay'], communication: ['comm'] }[f],
    })),
    { what: 'DANGER_FLOOR/representative', allow: ['destroy'],
      step: { code: 'DANGER_FLOOR', error: 'refusing to fire a destructive live representative "" (template 12)' } },
    { what: 'DANGER_FLOOR/observation', allow: ['pay'],
      step: { code: 'DANGER_FLOOR', error: 'refusing an ACTED observation on a payment control "Pay"; re-run with --acted=false' } },
    { what: 'DANGER_FLOOR/link-route', allow: [],
      step: { code: 'DANGER_FLOOR', error: 'refusing to click a link to a danger route /logout (template 12)' } },
    { what: 'ROUTE_DANGER', allow: [],
      step: { code: 'ROUTE_DANGER', error: 'refusing to navigate to a danger route /account/delete' } },
    { what: 'OUTWARD_REFUSED', allow: ['outward'],
      step: { code: 'OUTWARD_REFUSED', error: 'reaches a person or a third party outside the app — refused on every tier — "Report content" (template 297)' } },
    { what: 'FOREIGN_DESTROY', allow: ['destroy'],
      step: { code: 'FOREIGN_DESTROY', error: "refusing to destroy another user's content (irreversible)" } },
    { what: 'ACCOUNT_PROTECTED', allow: ['destroy'],
      step: { code: 'ACCOUNT_PROTECTED', error: 'refusing to delete an account this run did not create' } },
  ];
  for (const c of cases) {
    const ex = explainFailure(c.step, null);
    assert.ok(ex, `${c.what} must classify`);
    const foreign = familiesIn(ex.sentence).filter((f) => !c.allow.includes(f));
    assert.deepEqual(foreign, [],
      `${c.what} names cause families that are not its own (${foreign.join(', ')}): ${ex.sentence}`);
  }

  // And no NON-refusal class smuggles a danger cause in either — the trio used to be the module's
  // house phrase, and this is where a copy of it would land next.
  const refusalCodes = new Set(['DANGER_REFUSED', 'ROUTE_REFUSED', 'OUTWARD_REFUSED', 'FOREIGN_DESTROY', 'ACCOUNT_PROTECTED']);
  for (const cls of CLASSES) {
    if (refusalCodes.has(cls.code)) continue;
    const probe = { code: cls.codes[0] || null, templateId: 7, role: 'button', name: 'Close',
      error: cls.legacyRe.source.replace(/[\\^$.*+?()[\]{}|]/g, '') };
    const ex = explainFailure(probe, null);
    const fams = ex ? familiesIn(ex.sentence) : [];
    assert.deepEqual(fams, [], `${cls.code} names a danger cause it cannot know about: ${ex && ex.sentence}`);
  }
});

test('an unidentifiable refusal names the MISSING INPUT instead of inventing a rule', () => {
  // The fallback IS the defect: «категория «опасные». Это защита от logout / удаления / оплаты» was
  // what a payload carrying no class at all produced. When the rule cannot be established the
  // sentence must say which input would have answered it — and `floor` genuinely is absent from an
  // act payload (only `policy-verdict` events carry it), so that is the honest name to give.
  // FAIL-ON-REVERT: return a generic rule from refusalRuleOf's tail → the "не восстановить"
  // assertion reds and a fabricated cause reappears.
  const blind = refusalRuleOf({ code: 'DANGER_FLOOR', error: 'refusing to fire (template 12)' });
  assert.equal(blind.rule, null, 'no rule is derivable from this payload');
  assert.match(blind.missing, /floor/, 'the missing input must be NAMED');
  const s = refusalSentence({ code: 'DANGER_FLOOR', error: 'refusing to fire (template 12)' });
  assert.match(s, /не восстановить/);
  assert.doesNotMatch(s, /удал|оплат|logout/i, 'and must not fall back to a plausible-sounding cause');

  // An unknown floor word is EVIDENCE, not a reason to guess: report it verbatim.
  const odd = refusalRuleOf({ code: 'DANGER_FLOOR', error: 'refusing to fire a biohazard control "X" (template 9)' });
  assert.equal(odd.rule, null);
  assert.match(odd.missing, /biohazard/);
});

test('every explore-policy REFUSAL is an act outcome with an explanation', () => {
  // The parity test above scans for `code: 'LITERAL'` inside envelopeError(), and step.mjs throws
  // `code: pre.code` — a VARIABLE. So the three explore-policy refusals were invisible to it, sat in
  // NOT_AN_ACT_OUTCOME as "verdicts, not errors", and produced 57 unexplained act rows across raw3
  // and hunt1. This reads them from explore-policy's own source so a fourth cannot be added silently.
  // FAIL-ON-REVERT: move any of the three back to NOT_AN_ACT_OUTCOME → it reds, naming the code.
  const src = fs.readFileSync(path.join(REPO, 'lib/recon/explore-policy.mjs'), 'utf8');
  const refusals = new Set();
  for (const m of src.matchAll(/allow:\s*false,\s*code:\s*'([A-Z_0-9]+)'/g)) refusals.add(m[1]);
  assert.ok(refusals.size >= 3, `expected explore-policy to declare at least 3 refusals, found ${refusals.size}`);

  const explained = new Set();
  for (const c of CLASSES) for (const src2 of c.codes) explained.add(src2);
  for (const code of refusals) {
    assert.ok(explained.has(code),
      `${code} is an explore-policy REFUSAL — the caller throws it and it lands on an act row — but it has no CLASSES entry`);
    assert.ok(!NOT_AN_ACT_OUTCOME.has(code), `${code} is thrown onto act rows; it is not a non-outcome`);
    assert.ok(REFUSAL_RULES[refusalRuleOf({ code, error: '' }).rule], `${code} must resolve to a refusal rule`);
  }
});

/* ------------------------------------------------------------------ the NO_INSTANCE split */

const graphWith = (statePath) => ({
  elements: { 7: { templateId: 7, role: 'menu', name: 'Share', instances: [{ instanceKey: '#1', reveal: { statePath } }] } },
});

test('the NO_INSTANCE reveal-path split returns different text for path-present vs path-absent', () => {
  // The single most explanatory thing on the page: on raw1, 33 of 53 NO_INSTANCE acts had no path
  // recorded at all (the crawler never knew how to reach the control) and 20 had one that broke.
  // Same message, opposite diagnoses — knowable only from the graph.
  // FAIL-ON-REVERT: ignore the graph in that branch and both sentences collapse into one → fails.
  const step = { error: 'cannot resolve instance #a > #b', templateId: 7, role: 'menu', name: 'Share' };
  const absent = explainFailure(step, graphWith([]));
  const present = explainFailure(step, graphWith([{ templateId: 3, instanceKey: '#1' }, { templateId: 4, instanceKey: '#1' }]));
  assert.equal(absent.code, 'NO_INSTANCE');
  assert.equal(present.code, 'NO_INSTANCE');
  assert.notEqual(absent.sentence, present.sentence, 'the split must produce two different diagnoses');
  assert.ok(/путь к нему не записан/.test(absent.sentence));
  assert.ok(/Путь был записан \(2 шага\)/.test(present.sentence), `got: ${present.sentence}`);
  assert.equal(absent.revealSteps, 0);
  assert.equal(present.revealSteps, 2);
});

test('NO SENTENCE EVER TELLS THE READER TO NAVIGATE', () => {
  // The operator read «Был ли записан путь к нему — здесь не проверить, откройте шаг во вкладке
  // «Прогоны»» WHILE ON the Прогоны tab. A hedge that sends the reader where he already is
  // explains nothing; when a fact cannot be established the sentence must name the MISSING INPUT
  // and stop. Asserted over the WHOLE taxonomy, in every branch, so a future class cannot
  // reintroduce it.
  // FAIL-ON-REVERT: put any «откройте / перейдите / смотри вкладку» clause back into a sentence
  // (or a static `text`) → this fails, naming the class.
  const NAV_INSTRUCTION = /откр(о|ы)(й|йте|ыть)|перейди|перейдите|смотри(те)?\s+(во?\s+)?вкладк|вкладке\s*«|нажмите\s+на\s+вкладк/i;
  const probes = [
    { error: 'cannot resolve instance #a', templateId: 7 },                                  // no graph
    { error: 'cannot resolve instance #a', templateId: 7, target: { hadRevealPath: true } },
    { error: 'cannot resolve instance #a', templateId: 7, target: { hadRevealPath: false } },
  ];
  for (const cls of CLASSES) {
    const step = { error: 'x', code: cls.codes[0] || null, templateId: 7, role: 'button', name: 'Close' };
    const ex = explainFailure({ ...step, error: cls.legacyRe.source.replace(/[\\^$.*+?()[\]{}|]/g, '') }, null);
    const sentences = [cls.text, ex && ex.sentence].filter(Boolean);
    for (const sent of sentences) {
      assert.doesNotMatch(sent, NAV_INSTRUCTION, `${cls.code} instructs the reader to navigate: ${sent}`);
    }
  }
  for (const p of probes) {
    assert.doesNotMatch(explainFailure(p, null).sentence, NAV_INSTRUCTION,
      'the NO_INSTANCE branch must never send the reader to another tab');
  }
});

test('the payload flag answers the reveal-path split with no graph at all', () => {
  // Runs written after `target.hadRevealPath` was stamped (raw2 and later) carry the answer in the
  // act itself: "we never knew how to reach it" vs "the recorded path BROKE" under one code. The
  // Конвейер tab has no snapshot for most rows, so without this the split would still degrade.
  // FAIL-ON-REVERT: drop the `target.hadRevealPath` arm from revealKnowledge → both sentences
  // collapse back onto the unknown hedge → this fails.
  const base = { error: 'cannot resolve instance #a', templateId: 7, role: 'button' };
  const absent = explainFailure({ ...base, target: { hadRevealPath: false } }, null);
  const present = explainFailure({ ...base, target: { hadRevealPath: true } }, null);
  assert.equal(absent.revealKnown, true, 'the flag IS an answer');
  assert.equal(present.revealKnown, true);
  assert.notEqual(absent.sentence, present.sentence, 'and it produces the two opposite diagnoses');
  assert.match(absent.sentence, /путь к нему не записан/);
  assert.match(present.sentence, /Путь к контролу был записан/);
  assert.equal(absent.revealSteps, 0);
  // The graph still wins when both are available: it also knows HOW LONG the path was.
  const g = graphWith([{ templateId: 3, instanceKey: '#1' }]);
  assert.equal(explainFailure({ ...base, target: { hadRevealPath: true } }, g).revealSteps, 1);
});

/* ------------------------------------------------------------------ the nameless control */

test('a control with no accessible name still gets an anchor a human can act on', () => {
  // Rows read «клик · button», «клик · textbox», «клик · radio» — ROLES, not names, identifying
  // nothing on a page with forty buttons. Measured on raw1: 38 of 287 acts carry an empty name.
  // FAIL-ON-REVERT: make anchorOf return `{text:'',kind:'none'}` for a nameless object (the old
  // displayName behaviour) → every assertion below fails.
  assert.equal(displayName({ name: 'Save', role: 'button' }).text, 'Save', 'a named control is unchanged');

  const testid = displayName({ name: '', role: 'button', locator: { type: 'testid', value: 'submit-btn' } });
  assert.equal(testid.kind, 'testid');
  assert.match(testid.text, /submit-btn/);

  const byId = displayName({ name: '', role: 'textbox', error: 'cannot resolve instance #video_upload' });
  assert.equal(byId.kind, 'id', 'the archived runs embed the selector in the failure message');
  assert.equal(byId.text, 'без имени · #video_upload');

  const byClass = displayName({ name: '', role: 'button', instanceSelector: 'div:nth-child(1) > button.ant-btn.ant-btn-primary:nth-child(2)' });
  assert.equal(byClass.kind, 'class');
  assert.equal(byClass.text, 'без имени · .ant-btn-primary', 'the LAST class is the specific one the author wrote');

  // A CSS-module hash is noise, and a STATE class names the moment rather than the control.
  assert.equal(displayName({ name: '', instanceSelector: 'a.Layout_logopart__bCbTu:nth-child(1)' }).text, 'без имени · .Layout_logopart');
  assert.equal(displayName({ name: '', instanceSelector: 'button.owl-dot.active:nth-child(1)' }).text, 'без имени · .owl-dot',
    'a transient state class (.active) addresses nothing tomorrow');

  const byPos = displayName({ name: '', role: 'link', instanceSelector: 'div > a:nth-child(4)' });
  assert.equal(byPos.kind, 'position');
  assert.equal(byPos.text, 'без имени · a:nth-child(4)');

  // Nothing but a template number is still addressable — it is the key the graph and report use.
  assert.equal(displayName({ name: '', role: 'combobox', templateId: 313 }).text, 'без имени · t313');
  // And the bare ROLE is never the answer: that is what the defect looked like.
  assert.doesNotMatch(displayName({ name: '', role: 'button', templateId: 1 }).text, /^button$/);
  // Genuinely nothing → an honest absence, never a fake label.
  assert.equal(displayName({ name: '', role: 'button' }).text, 'без имени');
  // The original string contract is untouched.
  assert.equal(displayName(null).text, '');
  assert.equal(displayName('Close').text, 'Close');
});

test('anchorSource lifts the selector out of the graph when the payload carried none', () => {
  // A raw1-era SUCCESSFUL act stamps only templateId/name/role/route, so a nameless one bottoms
  // out at «без имени · t313» — while the graph the viewer already loads holds its selector.
  // FAIL-ON-REVERT: make anchorSource return `step` unconditionally → the id assertion fails.
  const graph = { elements: { 313: { templateId: 313, name: '', role: 'combobox',
    templateSelector: 'div > select#device', instances: [{ instanceKey: '#1', instanceSelector: 'div:nth-child(2) > #device' }] } } };
  const step = { templateId: 313, name: '', role: 'combobox' };
  assert.equal(displayName(step).text, 'без имени · t313', 'without the graph, the template number');
  assert.equal(displayName(anchorSource(step, graph)).text, 'без имени · #device', 'with it, the authored id');
  // A NAMED control is never touched, and a missing graph/element degrades to the step itself.
  assert.equal(anchorSource({ name: 'Save' }, graph).name, 'Save');
  assert.equal(anchorSource(step, null), step);
  assert.equal(anchorSource({ templateId: 999, name: '' }, graph).templateId, 999);
});

test('without a graph the split says UNKNOWN, never "no path recorded"', () => {
  // Unknown is not absent. A caller that never looked (the Конвейер tab has no snapshot) must not be
  // handed an assertion about the graph — that is the same species of lie this module exists to end.
  const ex = explainFailure({ error: 'cannot resolve instance #a', templateId: 7 }, null);
  assert.ok(!/не записан/.test(ex.sentence), `must not assert absence when nothing was checked: ${ex.sentence}`);
  assert.equal(ex.revealSteps, null);
});

test('revealPathFor reads a path off the element or any instance, and reports none honestly', () => {
  assert.equal(revealPathFor(graphWith([{ templateId: 3, instanceKey: '#1' }]), 7).path.length, 1);
  assert.equal(revealPathFor(graphWith([]), 7).path.length, 0);
  assert.equal(revealPathFor(graphWith([]), 999), null, 'a template absent from the graph is null, not an empty path');
  assert.equal(revealPathFor(null, 7), null);
});

/* ------------------------------------------------------------------ evidence extraction */

test('the intercepting element is lifted out of the Playwright timeout log', () => {
  // Free data already sitting in the error string, and the most useful sentence in the table.
  const msg = 'elementHandle.click: Timeout 5000ms exceeded.\nCall log:\n[2m  - attempting click action[22m\n'
    + '[2m      - <span title="All" class="ant-select-selection-item">All</span> intercepts pointer events[22m\n';
  assert.equal(interceptingOf(msg), '<span> «All»');
  const ex = explainFailure({ error: msg }, null);
  assert.equal(ex.code, 'CLICK_TIMEOUT');
  assert.equal(ex.tone, TONES.BROKEN.key);
  assert.ok(/сверху лежал <span> «All»/.test(ex.sentence), `got: ${ex.sentence}`);
  assert.ok(/Ждали 5 секунд/.test(ex.sentence));
});

test('a timeout with no named interceptor does not invent one', () => {
  const ex = explainFailure({ error: 'elementHandle.click: Timeout 5000ms exceeded.\nCall log:\n  - attempting click action' }, null);
  assert.equal(ex.code, 'CLICK_TIMEOUT');
  assert.ok(/что-то перехватывало/.test(ex.sentence));
  assert.ok(!/<[a-z]/.test(ex.sentence), 'no fabricated element');
});

test('a stamped code wins over message text', () => {
  // Runs written after trace gained payload.code must not be re-guessed from prose.
  const ex = explainFailure({ code: 'DISABLED', error: 'some prose that looks like cannot resolve instance #x' }, null);
  assert.equal(ex.code, 'DISABLED');
  assert.equal(ex.tone, TONES.FINDING.key);
});

test('a successful act has no failure class', () => {
  assert.equal(classify({ error: null }), null);
  assert.equal(explainFailure({ error: null }, null), null);
  assert.equal(classify(null), null);
});

/* ------------------------------------------------------------------ plain language */

// Guards: a line that stays on screen can be read by someone who does not know this project.
// The operator's words: «меня интересует понятность», «я просил понятные логи». A term in brackets
// beside a human phrase is allowed; a term INSTEAD OF a phrase is not.

test('a control is described in words, never as an ARIA role plus a CSS position', () => {
  // What he was shown: «combobox без имени · input:nth-child(1)». Two internal vocabularies (the
  // accessibility tree and a CSS selector) and no statement of what the thing is.
  // FAIL-ON-REVERT: make controlPhrase return `${src.role} ${anchorOf(src).text}` → every assertion
  // here reds; drop the `container` rung from anchorOf → the modal case falls back to the ordinal.
  assert.equal(roleRu('combobox'), 'выпадающий список');
  assert.equal(roleRu('textbox'), 'поле ввода');
  assert.equal(roleRu('generic'), 'блок');
  assert.equal(roleRu(''), 'элемент', 'an absent role is still described, never blank');
  assert.equal(roleRu('treegrid'), 'treegrid', 'an unmapped role passes through rather than being invented');

  const named = controlPhrase({ role: 'button', name: 'Create Event' });
  assert.equal(named.text, 'кнопка «Create Event»');

  // The live case, verbatim from run raw3's graph (template 1290): the author named the REGION even
  // though the input itself carries nothing, and the chain used to stop at the leaf.
  const modal = controlPhrase({ role: 'combobox', name: '',
    instanceSelector: 'div.ant-modal > div > div.Connection_modalContainer__pGFst > div.row > div.Connection_modalInput__aA\\+iF > div.ant-select > div.ant-select-selector > span.ant-select-selection-search > input' });
  assert.equal(modal.kind, 'container');
  assert.equal(modal.text, 'выпадающий список в блоке Connection_modalInput',
    'the authored region names it; the CSS-module hash and the widget-library classes are noise');
  assert.doesNotMatch(modal.text, /nth-child|combobox/, 'no CSS position, no ARIA role');

  // A widget-library class is an anchor but not a description: every AntD button is in `.ant-btn`.
  const fw = controlPhrase({ role: 'button', name: '',
    instanceSelector: 'div.prayer_popup > button.ant-btn.ant-btn-default' });
  assert.equal(fw.text, 'кнопка в блоке prayer_popup', `got: ${fw.text}`);

  // Nothing authored anywhere → say so in words, and locate it the way a person would.
  const bare = controlPhrase({ role: 'radio', name: '', instanceSelector: 'div > div > input' },
    { ordinal: 2, pageLabel: 'Profile' });
  assert.equal(bare.kind, 'ordinal');
  assert.match(bare.text, /переключатель без подписи — второе/);
  assert.match(bare.text, /Profile/, 'the page is part of the address');
  // …and with no context at all it still refuses to print a selector.
  assert.equal(controlPhrase({ role: 'textbox', name: '' }).text, 'поле ввода без подписи');
});

test('a field the author captioned is named by its caption, not by its markup', () => {
  // `fieldFacts.label` / `.placeholder` were recorded by dom-snapshot and persisted by graph-store,
  // and the anchor chain never read either. HONEST SCOPE: 0 of the 10 nameless controls in both runs
  // on disk carry one, so this rung fixes the class rather than today's screen.
  // FAIL-ON-REVERT: drop the `caption` rung from anchorOf → the phrase falls to the id/selector.
  const byLabel = controlPhrase({ role: 'textbox', name: '', fieldFacts: { label: 'Дата рождения' },
    instanceSelector: 'div.x > input' });
  assert.equal(byLabel.kind, 'caption');
  assert.equal(byLabel.text, 'поле ввода с подписью «Дата рождения»');
  const byPlaceholder = anchorOf({ name: '', fieldFacts: { placeholder: 'Search items' } });
  assert.equal(byPlaceholder.kind, 'caption');
  assert.equal(byPlaceholder.text, 'Search items');
  // A real name still wins, and an empty fieldFacts changes nothing.
  assert.equal(anchorOf({ name: 'Save', fieldFacts: { label: 'X' } }).kind, 'name');
  assert.equal(anchorOf({ name: '', fieldFacts: {}, templateId: 5 }).kind, 'template');
});

test('a CSS-module hash never survives into a label, even when the selector escaped it', () => {
  // `Connection_modalInput__aA\+iF` truncated to `.Connection_modalInput__aA`: the class pattern
  // stopped at the backslash and the hash-strip then missed, so a strip that RAN still left noise.
  // FAIL-ON-REVERT: restore `/\.[A-Za-z_][\w-]*/g` as the class pattern → the escaped cases red.
  assert.equal(ancestorClass('div.Profile_claimAccountBox__\\+cOsk > div.row > input'), '.Profile_claimAccountBox');
  assert.equal(ancestorClass('div.Connection_modalInput__aA\\+iF > div.ant-select > input'), '.Connection_modalInput');
  assert.equal(ancestorClass('div.Layout_topheader__ZgCfW > div > a'), '.Layout_topheader');
  // Framework and state classes are skipped on the way up; a bare-tag chain yields nothing at all.
  assert.equal(ancestorClass('div.ant-modal > div.ant-modal-body > span.rc-thing > input'), '',
    'a chain of widget-library classes names nothing about this control');
  assert.equal(ancestorClass('div > div > input'), '');
  // The element's OWN segment is never the answer here — that rung already ran and failed.
  assert.equal(ancestorClass('div.outer > input.inner'), '.outer');
});

/* ------------------------------------------------------------------ the name blob */

test('a subtree-text name is truncated for display and keeps the full string', () => {
  // The operator was shown this as if it were a label.
  const blob = 'Control A Control B Control C (0)No dataNo results found';
  const d = displayName(blob, 44);
  assert.ok(d.truncated);
  assert.ok(d.text.length <= 44);
  assert.ok(d.text.endsWith('…'));
  assert.equal(d.full, blob, 'the full string must survive for the tooltip');
  const short = displayName('Close', 44);
  assert.equal(short.text, 'Close');
  assert.equal(short.truncated, false);
  assert.equal(displayName(null).text, '');
});

/* ------------------------------------------------------------------ the real run */

test('every failure in the completed run raw1 classifies, and the census matches', { skip: !fs.existsSync(path.join(REPO, 'state/runs/raw1/events.ndjson')) }, () => {
  // Ground truth, not a fixture. If a real trail contains a failure this module cannot name, the
  // module is incomplete — which is exactly how REVEAL_NAVIGATED was found missing from the first
  // hand-written census of this run (it counted 144 of 146 failures).
  const ev = fs.readFileSync(path.join(REPO, 'state/runs/raw1/events.ndjson'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const census = {};
  let unclassified = 0, failures = 0;
  for (const e of ev) {
    const p = e.payload || {};
    if (!p.error) continue;
    failures++;
    const cls = classify({ error: p.error, code: p.code || null });
    if (!cls) { unclassified++; continue; }
    census[cls.code] = (census[cls.code] || 0) + 1;
  }
  assert.equal(unclassified, 0, 'a real trail must not contain a failure this module cannot name');
  assert.equal(failures, 146);
  assert.deepEqual(census, {
    NO_INSTANCE: 53, REVEAL_FIREWALL: 43, NOT_VISIBLE: 16, REVEAL_HOP_MISSING: 12,
    CLICK_TIMEOUT: 9, DANGER_REFUSED: 8, DISABLED: 2, REVEAL_NAVIGATED: 2, DETACHED: 1,
  });
});
