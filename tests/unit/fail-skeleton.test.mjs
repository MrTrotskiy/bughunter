// THE FAILED ACT'S ONLY VISUAL EVIDENCE.
//
// Measured on the completed run raw1 (287 acts): key-frames exist on 140 of 141 SUCCESSFUL acts and
// 0 of 146 FAILURES. That is structural, not sampling — actStep takes `capture.before` at the BOTTOM
// of its pre-click gate stack, so DANGER_FLOOR / NOT_VISIBLE / NO_INSTANCE / DISABLED / ALIAS_COLLISION
// all throw above it, and the reveal failures (REVEAL_WRITE_BLOCKED 43, REVEAL_STALE 12,
// REVEAL_NAVIGATED 2 in that run) throw from applyReveal before the capture collaborator even exists.
// So the half of the run an operator most needs to see — "what did the crawler SEE when it could not
// find that control?" — had no evidence at all. The DOM skeleton (lib/graph/dom-skeleton.mjs) is that
// evidence, written by the drivers' `recordFail`.
//
// Guards, all on the STATEFUL driver (the one that produces the project's runs; the cold driver shares
// the same helper and the same payload field):
//   1. A failed act's `act.failed` payload carries a `skeleton` REF and the file exists on disk with
//      the captured nodes in it.
//   2. A capture that FAILS changes nothing: the original error re-throws with its identity and its
//      granular code intact, and the payload carries `skeleton: null` rather than a disk error.
//   3. CAUSAL PROOF. `captureSkeleton` is a page.evaluate, so it may run ONLY while the cause token is
//      `__idle__` — a capture inside a live causal window is how a background fire inherits a control's
//      token, which is the attribution bug that killed this project's predecessor. The stub models the
//      real token protocol (beginCause writes the cause, endCause/resetCause write `__idle__`) and
//      records the token AT THE INSTANT of capture. The fixture is a POST-CLICK failure, so a window is
//      genuinely opened and closed — asserting idle would otherwise be vacuous.
//   4. A SUCCESSFUL act gets NO skeleton and writes no bytes: it already carries `shots`, and a second
//      artifact there is pure cost.
//
// FAIL-ON-REVERT (each lever independently verified):
//   1. drop `skeleton: skel` from stateful-step.mjs recordFail (or the `captureFailureSkeleton` call)
//      → "a failed act must carry a skeleton ref" reds.
//   2. make the capture NON-best-effort — delete `captureFailureSkeleton`'s catch AND let a null ref
//      propagate (`if (!ref) throw`) → "the original error survives a failed capture" reds, because the
//      rejection becomes the capture's error instead of ALIAS_COLLISION. NOTE the catch alone is
//      defense-in-depth: captureSkeleton and writeSkeleton each already swallow, so removing only the
//      catch changes nothing — which is exactly why the guarded property is asserted on the OUTCOME
//      (the error that arrives) rather than on the presence of a try block. Lever 1 also reds this
//      test's `skeleton: null` assertion, since a dropped field reads `undefined`, not `null`.
//   3. delete `await resetCause(page)` from step.mjs's causal-window catch → the token is still the
//      template id at capture time → "captureSkeleton ran under a LIVE cause token" reds.
//   4. call `captureFailureSkeleton` on the success path too → "a successful act writes no skeleton"
//      reds.
//
// NO BROWSER (tests/CLAUDE.md layer rule), following tests/unit/act-failed-parity.test.mjs: every
// page-level observation on this path is defensively wrapped by its own caller, so a stub that refuses
// to evaluate degrades exactly the way a dead page would. This stub answers three evaluate shapes and
// refuses the rest, keyed on the ARGUMENT the real primitives pass — a number is the skeleton's node
// cap, a string is a cause token, everything else is a DOM read this test does not need.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIGIN = 'https://app.example';
const PAGE_URL = `${ORIGIN}/dash`;
const IDLE = '__idle__';

// What the page returns for a skeleton capture. Shape only — captureSkeleton keeps whatever the page
// hands back as long as `nodes` is an array, so this stands in for a real collect() result.
const SKELETON = { v: 1, w: 1440, h: 900, nodes: [{ d: 0, tag: 'button', name: 'Cancel', x: 1, y: 2, w: 3, h: 4, vis: 1 }], truncated: 0 };

// A stub page that MODELS THE CAUSE TOKEN. `causeLog` records the token held at every skeleton
// capture, which is the whole causal proof: beginCause writes the control id, endCause and resetCause
// write `__idle__`, and the skeleton must only ever see the latter.
function stubPage({ claim = { ok: true, heldBy: null }, onClick = null, skeletonThrows = false } = {}) {
  const state = { cause: IDLE, causeLog: [], skeletons: 0 };
  const handle = {
    evaluate: async (_fn, arg) => (arg && arg.prop ? claim : null), // alias claim, else the anchor href
    isVisible: async () => true,
    isEnabled: async () => true,
    boundingBox: async () => ({ x: 12, y: 34, width: 56, height: 78 }),
    click: async () => { if (onClick) throw onClick; },
  };
  const page = {
    on: () => {},
    url: () => PAGE_URL,
    viewportSize: () => ({ width: 1440, height: 900 }),
    $: async () => handle,
    $$: async () => [handle],
    keyboard: { press: async () => {} },
    waitForTimeout: async () => {},
    evaluate: async (_fn, arg) => {
      // captureSkeleton(collect, cap) — the ONE numeric-arg evaluate on this path.
      if (typeof arg === 'number') {
        state.skeletons += 1;
        state.causeLog.push(state.cause);
        if (skeletonThrows) throw new Error('page gone mid-capture');
        return SKELETON;
      }
      // beginCause(page, cause) / endCause(page, …, IDLE) / resetCause(page) — all string-arg.
      if (typeof arg === 'string') {
        state.cause = arg;
        return arg === IDLE ? [] : 0; // endCause reads the fire ring; beginCause returns seq0
      }
      throw new Error('no page in a unit stub');
    },
  };
  return { page, state };
}

// One template + one instance, hand-built so the test states exactly what the step reads.
function stubGraph({ templateId, name, role }) {
  const instance = { instanceKey: '#1', instanceSelector: `main > ${role}:nth-child(1)` };
  const node = { templateId, name, role, route: '/dash', templateSelector: `main > ${role}`, instances: [instance] };
  return { graph: { schemaVersion: 6, routes: {}, elements: { [templateId]: node }, requests: {}, edges: [] }, instance };
}

function readEvents(dir, runId) {
  const file = path.join(dir, 'runs', runId, 'events.ndjson');
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// The trail dir is per-test (tests/CLAUDE.md: never repo state/). trace.mjs resolves it at CALL time.
async function withTrail(t, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-skel-'));
  const prev = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BUGHUNTER_STATE_DIR;
    else process.env.BUGHUNTER_STATE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return fn(dir);
}

const { statefulStep } = await import('../../lib/recon/stateful-step.mjs');
const { makeLedger } = await import('../../lib/graph/ids.mjs');

// "Cancel" is a dismiss control, so statefulStep stamps NO reveal path — which is also why this act
// never needs a DOM snapshot for `preVisible`, keeping the stub honest about what it can answer.
const TARGET = { templateId: 41, name: 'Cancel', role: 'button', route: '/dash' };

test('a FAILED act carries a DOM skeleton — the evidence 146 of 146 failures had none of', async (t) => {
  await withTrail(t, async (dir) => {
    const runId = 'r-20260720000100-skel';
    // The alias ledger finds the resolved node already claimed: ALIAS_COLLISION, a PRE-CLICK gate that
    // throws with the cause token never having been opened.
    const { graph, instance } = stubGraph(TARGET);
    const { page, state } = stubPage({ claim: { ok: false, heldBy: '99#7' } });
    const step = statefulStep({ page, origin: ORIGIN, ledger: makeLedger(), runId });

    await assert.rejects(
      () => step(graph, { ...TARGET, instance }),
      /ALIAS_COLLISION|already acted/,
      'the fixture must actually FAIL the act — a passing act would make every assertion below vacuous',
    );

    const [ev] = readEvents(dir, runId).filter((e) => e.kind === 'act.failed');
    assert.ok(ev, 'the failure is written as one act.failed event');
    assert.equal(typeof ev.payload.skeleton, 'string',
      'a failed act must carry a skeleton ref — this gate throws ABOVE actStep\'s capture.before, so '
      + '`shots` is structurally null and the skeleton is the only visual evidence that can exist');
    assert.match(ev.payload.skeleton, /^skel\/.+\.json$/,
      'and it is a REF into the run\'s skel/ dir, never the bytes themselves (a 1000-node skeleton in '
      + 'events.ndjson would bloat the one stream every consumer reads)');

    const file = path.join(dir, 'runs', runId, ev.payload.skeleton);
    assert.ok(fs.existsSync(file), 'the referenced file must actually exist — a dangling ref is worse than no ref');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).nodes, SKELETON.nodes,
      'and it holds what the page returned, so the viewer can draw what the crawler saw');
    assert.equal(state.skeletons, 1, 'exactly ONE capture per failed act — the failure path is not a place to pay twice');
    assert.ok(ev.payload.shots === null || !ev.payload.shots?.before,
      'the premise holds: this failure has no key-frame, which is why the skeleton exists at all');
  });
});

test('a capture that FAILS never replaces the error it was meant to explain', async (t) => {
  await withTrail(t, async (dir) => {
    const runId = 'r-20260720000200-skel';
    const { graph, instance } = stubGraph(TARGET);
    // The skeleton evaluate throws — the closed/navigating-page case the module degrades on.
    const { page } = stubPage({ claim: { ok: false, heldBy: '99#7' }, skeletonThrows: true });
    const step = statefulStep({ page, origin: ORIGIN, ledger: makeLedger(), runId });

    let caught = null;
    await assert.rejects(() => step(graph, { ...TARGET, instance }), (err) => { caught = err; return true; });

    assert.equal(caught?.envelope?.code, 'ALIAS_COLLISION',
      'the original error survives a failed capture with its GRANULAR code intact — report --unreached '
      + 'and failure-hints.mjs bucket on exactly this code, so a capture that rewrote it would silently '
      + 're-classify the failure taxonomy of a whole run');
    assert.match(String(caught.message), /already acted/,
      'and its identity too: the thrown value is still the act\'s own envelope error, not a disk error about its illustration');

    const [ev] = readEvents(dir, runId).filter((e) => e.kind === 'act.failed');
    assert.equal(ev.payload.skeleton, null,
      'the payload says so honestly — null, never a ref to a file that was never written');
    assert.equal(ev.payload.code, 'ALIAS_COLLISION',
      'and the trail\'s own code is unchanged, so a failed capture costs evidence and never accuracy');
  });
});

test('captureSkeleton runs ONLY under __idle__ — never inside a live causal window', async (t) => {
  await withTrail(t, async () => {
    const runId = 'r-20260720000300-skel';
    const { graph, instance } = stubGraph(TARGET);
    // A POST-CLICK failure: the act passes every gate, opens the causal window (beginCause writes the
    // template id as the token), and the click throws. actStep's catch calls resetCause BEFORE
    // re-throwing, so the driver's recordFail — and the capture inside it — must find `__idle__`.
    const boom = new Error('elementHandle.click: Timeout 5000ms exceeded');
    const { page, state } = stubPage({ onClick: boom });
    const step = statefulStep({ page, origin: ORIGIN, ledger: makeLedger(), runId });

    await assert.rejects(() => step(graph, { ...TARGET, instance }), /Timeout 5000ms/);

    assert.ok(state.causeLog.includes(String(TARGET.templateId)) === false,
      `captureSkeleton ran under a LIVE cause token (${state.causeLog.join(',')}) — a page.evaluate inside `
      + 'an open causal window lets a background fire inherit this control\'s token, which is the phantom-edge '
      + 'attribution bug that killed this project\'s predecessor');
    assert.ok(state.causeLog.length > 0 && state.causeLog.every((c) => c === IDLE),
      `every capture must see the token at __idle__, saw [${state.causeLog.join(',')}]`);
    // Non-vacuity: prove a window really was opened and closed, so the assertion above had something to catch.
    assert.equal(state.cause, IDLE, 'and the token is left idle afterwards');
    assert.equal(boom.clicked, false,
      'the fixture is genuinely POST-beginCause / PRE-click — actStep stamped `clicked` on the way out, which '
      + 'it only does inside the causal window\'s catch');
  });
});

test('a SUCCESSFUL act writes no skeleton — it already has its key-frame', async (t) => {
  await withTrail(t, async (dir) => {
    const runId = 'r-20260720000400-skel';
    // An off-origin link is the ONE actStep success that returns before any causal window or DOM
    // snapshot, so it reaches the success trail-write with no browser.
    const { graph, instance } = stubGraph({ templateId: 42, name: 'Docs', role: 'link' });
    const { page, state } = stubPage();
    page.$ = async () => ({
      evaluate: async (_fn, arg) => (arg && arg.prop ? { ok: true } : 'https://external.example/docs'),
      isVisible: async () => true, isEnabled: async () => true,
      boundingBox: async () => null, click: async () => {},
    });
    const step = statefulStep({ page, origin: 'https://elsewhere.example', ledger: makeLedger(), runId });

    const res = await step(graph, { templateId: 42, name: 'Docs', role: 'link', route: '/dash', instance });
    assert.ok(res.external, 'the fixture must actually SUCCEED — an off-origin link is recorded, never fired');

    const [ev] = readEvents(dir, runId).filter((e) => e.kind === 'act');
    assert.ok(ev, 'a successful act is still written as kind "act"');
    assert.ok(!('skeleton' in ev.payload),
      'a success carries NO skeleton field — skeletons are for the evidence-free path, and a second artifact '
      + 'beside `shots` is pure cost on the 141 acts that already have one');
    assert.equal(state.skeletons, 0, 'and no capture was even attempted — the cost is not paid, not merely discarded');
    const skelDir = path.join(dir, 'runs', runId, 'skel');
    assert.deepEqual(fs.existsSync(skelDir) ? fs.readdirSync(skelDir) : [], [],
      'so the run\'s skel/ dir stays empty: no bytes on disk for a success');
  });
});
