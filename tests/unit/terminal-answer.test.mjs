// terminal-answer — a control that has already given a TERMINAL answer must leave the frontier, while a
// control still working through its obligation ladder must not. Pure over the graph, no browser.
//
// THE MEASUREMENT THIS PROTECTS (runs state/runs/raw3 + state/runs/hunt1, both on disk):
//   30% of raw3's acts and 34% of hunt1's were REPEATS on a control that had already answered.
//     "Enter your email id"  8 acts — DISABLED all 8        (a terminal code)
//     template 1290          8 acts — NO_INSTANCE all 8     (a TRANSIENT code that proved terminal)
//     template 1143          5 acts — ACT_FAILED all 5      (likewise)
//     template 27            8 acts — `navigate` all 8      (no block code at all)
//   A disabled field does not become enabled on the eighth click, and no code list can see the last case.
//   The rule is therefore about PROGRESS, not about the code: a repeated identical (kind, outcome) answer
//   retires the control; a different question keeps its slot.
//
// Guards: (a) a control returning a terminal refusal is emitted ONCE and never re-emitted, so the act
//   budget stops being spent re-asking an answered question; (b) a form mid-ladder IS still re-emitted and
//   still receives its sequence of DIFFERENT submits (docs/GOAL.md's incremental form study, which the
//   retirement must never collapse); (c) a retired control stays COUNTED in the honest denominator and is
//   disclosed as answered-not-explorable rather than silently vanishing.
//
// FAIL-ON-REVERT (all four proven red, message fragments recorded verbatim):
//   (a) delete `if (terminallyAnswered(node, inst)) return true;` from `instanceDrained` in
//       lib/recon/frontier.mjs → "the same answer 2 times running retires the control" and "a control that
//       navigated identically twice has reproduced its outcome (L4) and must retire" both fail.
//       (The DISABLED case survives this one revert because the battery discharge in (d) also drains it —
//       the two mechanisms overlap there deliberately, and (d) proves that half independently.)
//   (b) widen `answerSig` in lib/recon/knowledge.mjs to drop the probe kind (`${p.blocked || p.verdict}`)
//       → the form's rungs collapse to one signature and the ladder is retired mid-climb:
//       "a form mid-ladder must still be emitted — it still owes submit-req-2" fails. THE CRITICAL GUARD.
//   (c) drop `answeredNotExplorable++` in `frontierInstanceStats` →
//       "a retired control must be disclosed as answered-not-explorable" fails.
//   (d) drop the `elemBlock` expansion in `probeStatus` (lib/recon/knowledge.mjs) →
//       "a DISABLED element must not keep owing fill-valid/fill-overflow it can never be asked" fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGraph, mergeSnapshot } from '../../lib/graph/graph-store.mjs';
import { nextBatch, frontierInstanceStats } from '../../lib/recon/frontier.mjs';
import { answeredTerminally, probeStatus, notOperableFindings, NO_PROGRESS_BLOCKED_LIMIT } from '../../lib/recon/knowledge.mjs';

// One single-instance template, shaped as dom-snapshot would have emitted it.
function seedOne(id, extra = {}) {
  const g = makeGraph();
  mergeSnapshot(g, '/', [{
    templateId: id,
    instanceId: id * 100,
    templateSelector: `input.f${id}`,
    role: 'textbox',
    name: `F${id}`,
    instanceKey: `#${id}`,
    instanceSelector: `input.f${id}:nth-child(1)`,
  }]);
  Object.assign(g.elements[id], extra);
  return g;
}

// Append a probe row the way stateful-step's recordProbe does — blocked rows carry the kind the ACT
// happened to be (`click`), never the kind the battery owes. That mismatch is the original defect.
const push = (g, id, row) => (g.elements[id].probes || (g.elements[id].probes = [])).push({ instanceKey: `#${id}`, ...row });

// ── (a) A TERMINAL REFUSAL IS ASKED ONCE ────────────────────────────────────────────────────────────

test('a control that answered DISABLED is emitted once and never re-emitted', () => {
  // The live shape of template 1141: a required, length-capped field that is rendered but disabled.
  const g = seedOne(1141, { fieldFacts: { kind: 'text', maxLength: 50, required: true } });

  // Before any act it is ordinary frontier work.
  assert.equal(nextBatch(g, { size: 5 }).length, 1, 'an unacted field must be emitted');

  // The act fires and the element refuses to be operated. This is ONE act — the eight the run actually
  // spent are what this test exists to prevent.
  g.elements[1141].explored = true;
  g.elements[1141].instances[0].explored = true;
  push(g, 1141, { kind: 'click', blocked: 'DISABLED' });

  assert.deepEqual(
    nextBatch(g, { size: 5 }).map((t) => t.templateId), [],
    'a control that answered DISABLED must never be re-emitted — measured, "Enter your email id" was acted 8 times and answered DISABLED all 8',
  );
  assert.equal(answeredTerminally(g.elements[1141], g.elements[1141].probes), 'element-blocked');
});

test('a TRANSIENT code that repeats identically retires — a code list alone could not see this', () => {
  // Template 1290: NO_INSTANCE is transient BY PRINCIPLE (a reveal path may be learned later) and returned
  // the identical answer eight times in hunt1. Transient-in-principle, terminal-in-practice.
  const g = seedOne(1290, { fieldFacts: { kind: 'text', required: true } });
  g.elements[1290].instances[0].explored = true;

  // A transient block keeps the retry budget frontier.retryable already granted it (MAX_RETRY_ROWS = 3),
  // because "we never managed to ask" is a different claim from "it answered". This rule does not tighten
  // that bound — it stops `batteryOwing` from OVERRIDING it, which is what carried 1290 from 3 acts to 8.
  push(g, 1290, { kind: 'fill-valid', blocked: 'NO_INSTANCE' });
  assert.equal(nextBatch(g, { size: 5 }).length, 1, 'ONE transient failure must be retried — the panel may open later');
  push(g, 1290, { kind: 'fill-valid', blocked: 'NO_INSTANCE' });
  assert.equal(nextBatch(g, { size: 5 }).length, 1, 'and the established 3-attempt retry budget is NOT tightened by this rule');

  push(g, 1290, { kind: 'fill-valid', blocked: 'NO_INSTANCE' });
  assert.deepEqual(
    nextBatch(g, { size: 5 }).map((t) => t.templateId), [],
    `the same answer ${NO_PROGRESS_BLOCKED_LIMIT} times running retires the control — template 1290 was asked 8 times and said NO_INSTANCE 8 times`,
  );
});

test('an UNBLOCKED repeat retires too — no block code exists for a code list to match on', () => {
  // Template 27 in both runs: acted eight times, verdict `navigate` every time. It never failed, so no
  // terminal-code list could ever have caught it.
  const g = seedOne(27, { fieldFacts: { kind: 'text' } });
  g.elements[27].instances[0].explored = true;
  push(g, 27, { kind: 'click', verdict: 'navigate' });
  push(g, 27, { kind: 'click', verdict: 'navigate' });

  assert.deepEqual(
    nextBatch(g, { size: 5 }).map((t) => t.templateId), [],
    'a control that navigated identically twice has reproduced its outcome (L4) and must retire — measured at 8 acts',
  );
});

test('an answer that CHANGES keeps the control in the frontier', () => {
  // The guard against over-retiring: a Save button disabled until a field is filled, a control whose second
  // act finally reveals something. Two DIFFERENT outcomes are progress, not repetition.
  const g = seedOne(50, { fieldFacts: { kind: 'text' } });
  g.elements[50].instances[0].explored = true;
  push(g, 50, { kind: 'click', verdict: 'inert' });
  push(g, 50, { kind: 'click', verdict: 'reveal' });

  assert.equal(answeredTerminally(g.elements[50], g.elements[50].probes), null, 'a changed answer is not a terminal answer');
  assert.equal(nextBatch(g, { size: 5 }).length, 1, 'a control whose answer changed must keep its slot');
});

// ── (b) THE FORM LADDER SURVIVES ────────────────────────────────────────────────────────────────────

test('a form mid-ladder is re-emitted and receives its full sequence of DIFFERENT submits', () => {
  // docs/GOAL.md: submit EMPTY, then one required field at a time — each submit is a different question.
  // Repeat acts on a form are the POINT, and the retirement must not collapse them.
  const g = seedOne(600, {
    role: 'button',
    formFacts: { total: 3, required: [{ selector: '#a', label: 'A' }, { selector: '#b', label: 'B' }], requiredBeyondCap: 0 },
  });
  g.elements[600].instances[0].explored = true;

  // Climb the ladder one rung per act, asserting the control is STILL emitted before each one.
  const rungs = ['submit-empty', 'submit-req-1', 'submit-req-2'];
  const climbed = [];
  for (const rung of rungs) {
    assert.equal(
      nextBatch(g, { size: 5 }).length, 1,
      `a form mid-ladder must still be emitted — it still owes ${rung}; collapsing this destroys the incremental form study docs/GOAL.md mandates`,
    );
    // Every rung comes back REJECTED — the ordinary shape of an incomplete submit, and the case most at
    // risk of being mistaken for a pointless repeat: same verdict every time, different question each time.
    push(g, 600, { kind: rung, verdict: 'rejected' });
    climbed.push(rung);
  }

  assert.deepEqual(climbed, rungs, 'the form must receive every rung of its ladder, not one submit');
  assert.equal(
    answeredTerminally(g.elements[600], g.elements[600].probes), null,
    'three DIFFERENT questions with the same answer is a completed ladder, never a no-progress repeat',
  );
  // And every RUNG is genuinely discharged rather than merely tolerated. (A completed ladder falls back to
  // owing a plain `click` — batteryFor's `owed.length ? owed : ['click']` — which is pre-existing behaviour
  // and not what this asserts; what matters here is that no submit rung is left outstanding.)
  const st = probeStatus(g.elements[600], g.elements[600].probes);
  assert.deepEqual(st.outstanding.filter((k) => String(k).startsWith('submit')), [], 'every rung of the ladder must end discharged');
  assert.deepEqual(st.done.sort(), rungs.slice().sort(), 'each rung must be recorded as its own answered obligation');
});

// ── (c) RETIRED IS COUNTED, NOT DROPPED ─────────────────────────────────────────────────────────────

test('a retired control stays in the denominator and is disclosed as answered-not-explorable', () => {
  const g = seedOne(1141, { fieldFacts: { kind: 'text', maxLength: 50, required: true } });
  const before = frontierInstanceStats(g);

  g.elements[1141].explored = true;
  g.elements[1141].instances[0].explored = true;
  push(g, 1141, { kind: 'click', blocked: 'DISABLED' });
  const after = frontierInstanceStats(g);

  // The denominator NEVER collapses — the project's standing rule.
  assert.equal(after.walkable, before.walkable, 'retiring a control must not shrink walkable — the denominator never collapses');
  assert.equal(after.walkable, 1, 'the control is still counted');
  assert.equal(after.remaining, 0, 'it is no longer outstanding work');
  assert.equal(
    after.answeredNotExplorable, 1,
    'a retired control must be disclosed as answered-not-explorable, never silently dropped from the count',
  );
  // Every retired instance is still accounted for as walked-or-unreachable, so the books balance.
  assert.equal(after.walked + after.unreachable, 1, 'the retired instance must remain accounted for');
});

test('DISABLED discharges the obligations it blocks, with the reason named — and is recorded as a finding', () => {
  // The original defect: the blocked row is filed under `click` while the battery owes `fill-valid` /
  // `fill-overflow`, so the obligation stood forever against a control that could never discharge it.
  const g = seedOne(1141, { fieldFacts: { kind: 'text', maxLength: 50, required: true } });
  push(g, 1141, { kind: 'click', blocked: 'DISABLED' });

  const st = probeStatus(g.elements[1141], g.elements[1141].probes);
  assert.deepEqual(
    st.outstanding, [],
    'a DISABLED element must not keep owing fill-valid/fill-overflow it can never be asked — measured, two fields owed them through 8 consecutive DISABLED acts',
  );
  // Every kind the field owed is named in the blocked list with its reason — plus the `click` the act was
  // filed under. Nothing is quietly dropped; each obligation carries WHY it can never be answered.
  const blockedKinds = st.blocked.map((b) => b.kind).sort();
  assert.deepEqual(
    blockedKinds, ['click', 'fill-empty', 'fill-overflow', 'fill-valid'],
    'each owed kind is honestly recorded as unanswerable WITH ITS REASON (docs/GOAL.md), never quietly dropped',
  );
  assert.ok(st.blocked.every((b) => b.code === 'DISABLED'), 'and the reason is the code the element actually returned');

  // docs/GOAL.md: the control announces itself and refuses to be operated — that is a FINDING to record,
  // not a failure to discard along with the retired control.
  const found = notOperableFindings(g);
  assert.equal(found.length, 1, 'retiring a DISABLED control must record the finding, not discard it');
  assert.equal(found[0].kind, 'control-not-operable');
  assert.equal(found[0].code, 'DISABLED');
});

test('a POLICY refusal retires the control but is NOT reported as an application defect', () => {
  // DANGER_FLOOR is our own choice not to fire; reporting it as a bug would bury the real findings.
  const g = seedOne(900, { role: 'button', name: 'Delete account' });
  g.elements[900].instances[0].explored = true;
  push(g, 900, { kind: 'click', blocked: 'DANGER_FLOOR' });

  assert.deepEqual(nextBatch(g, { size: 5 }).map((t) => t.templateId), [], 'a policy refusal is permanent — asking again cannot change it');
  assert.deepEqual(notOperableFindings(g), [], 'our own refusal is coverage accounting, not an application finding');
});
