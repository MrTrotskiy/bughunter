// RECORD THE ATTEMPT, NOT ONLY THE OUTCOME — the evidence a decision was made on, which the trail
// destroyed at the exact moment it became interesting.
//
// Measured on run `raw1` (287 acts, 146 failures), the completed run that motivated this:
//   - ZERO events of kind `act.failed`, so `trace.readActFailed` returned [] and `report --unreached`
//     fell back to the graph's COARSE reason for the entire run. The granular NO_INSTANCE /
//     NOT_VISIBLE / REVEAL_* / DANGER_FLOOR codes were computed and then discarded, because
//     `recon-run.persistentStep` wrote `kind:'act'` with 8 fields where its sibling
//     `stateful-step.recordFail` writes 16 — the sibling documents this exact defect class, fixed it
//     in that file, and the fix was never propagated to the driver that produces the default crawl.
//   - ZERO failures carrying `code`, and `shots` HARDCODED null, though actStep captures the
//     before-frame under `__idle__` BEFORE every failure path.
//   - `via` absent on 141 of 141 SUCCESSFUL acts, so the trail could not say how ANY element in the
//     run was located — the blind spot that let "clicked the opener, recorded the submit" survive
//     seven runs.
//   - `resolveHandle` returned a bare `null`: six strategies ran, each measured its own match counts,
//     and every number was thrown away. So "getByRole found ZERO" (a coverage gap) and "getByRole
//     found THREE and the structural guard rejected all three" (a resolver bug) were indistinguishable
//     — opposite diagnoses, one bucket.
//
// Guards: the resolver's attempt record (which strategies ran vs were SKIPPED, with raw/visible/
//   sameTemplate counts); that a node-loop failure is readable by `readActFailed` with its granular
//   code; that a successful node-loop act names HOW the element was found; and that a NO_INSTANCE
//   envelope carries structured evidence through `envelope.target` — including `hadRevealPath`, the
//   field separating "we never knew how to reach it" from "the recorded path broke".
//
// FAIL-ON-REVERT (four levers, each independently verified):
//   - `resolve-handle.mjs`: `blankAttempts()` → `[]` (the shape survives, the evidence is discarded —
//     precisely the defect) → "the resolver must report WHAT IT TRIED" reds with 4 of 5. Returning a
//     bare `null` from the failure exits also reds, but as a TypeError one frame up rather than as the
//     recorded message, so the emptied-record lever is the one to use.
//   - `recon-run.mjs`: `traceEvent(runId,'act.failed',…)` → `'act'` in recordFail → "readActFailed must
//     return the NODE loop's failures" reds (readActFailed goes back to [], as it was for all of raw1).
//   - `recon-run.mjs`: drop `via: res.via || null` from the success payload → "a successful act must
//     name HOW the element was found" reds.
//   - `step.mjs`: drop the `target:` evidence from the NO_INSTANCE throw → "a NO_INSTANCE envelope must
//     carry structured evidence" reds.
//
// NO BROWSER (tests/CLAUDE.md layer rule). The page is a stub, and it works because this codebase is
// defensive about observation: waitSettled, dismissOverlays, harvestRoutes and harvestLinks each
// swallow a refusing `page.evaluate`, so a stub that refuses to evaluate degrades exactly the way a
// dead page would. Only `handle.evaluate` is answered — actStep reads the anchor href and the alias
// claim off it unguarded, which is the seam that reaches a real success with no causal window.
//
// CAUSAL DISCIPLINE: nothing here opens a causal window. Every assertion below is about what is
// RECORDED, never about what is attributed — the resolve/visibility throws all precede `beginCause`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIGIN = 'https://app.example';
const PAGE_URL = `${ORIGIN}/dash`;

const { resolveWithAttempts, resolveHandle } = await import('../../lib/recon/resolve-handle.mjs');
const { actStep } = await import('../../lib/recon/step.mjs');
const { persistentStep } = await import('../../lib/recon/recon-run.mjs');
const { readActFailed } = await import('../../lib/debug/trace.mjs');
const { makeLedger } = await import('../../lib/graph/ids.mjs');

// A handle that is visible and answers `evaluate` with a fixed value. `sameTemplate` calls
// `h.evaluate(fn, tsel)` expecting a boolean; `matches` is that answer.
function stubHandle({ matches = true, href = null, claim = { ok: true, heldBy: null } } = {}) {
  return {
    evaluate: async (_fn, arg) => {
      if (arg && arg.prop) return claim;      // act-alias claim
      if (typeof arg === 'string') return matches; // sameTemplate structural guard
      return href;                            // actStep's anchor-href read
    },
    isVisible: async () => true,
    isEnabled: async () => true,
    boundingBox: async () => ({ x: 1, y: 2, width: 3, height: 4 }),
    click: async () => {},
  };
}

function stubPage({ dollar = async () => null, dollarAll = async () => [], byRole = [], byText = [] } = {}) {
  return {
    on: () => {},
    url: () => PAGE_URL,
    goto: async () => ({}),
    viewportSize: () => ({ width: 1440, height: 900 }),
    $: dollar,
    $$: dollarAll,
    getByRole: () => ({ elementHandles: async () => byRole }),
    getByText: () => ({ elementHandles: async () => byText }),
    evaluate: async () => { throw new Error('no page in a unit stub'); },
    keyboard: { press: async () => {} },
    waitForTimeout: async () => {},
  };
}

function stubGraph({ templateId, name, role, reveal = null }) {
  const instance = { instanceKey: '#1', instanceSelector: `main > ${role}:nth-child(1)` };
  if (reveal) instance.reveal = reveal;
  const node = {
    templateId, name, role, route: '/dash',
    templateSelector: `main > ${role}.card`,
    instances: [instance],
  };
  return { graph: { schemaVersion: 6, routes: {}, elements: { [templateId]: node }, requests: {}, edges: [] }, instance, node };
}

function readEvents(dir, runId) {
  const file = path.join(dir, 'runs', runId, 'events.ndjson');
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// The trail dir is per-test (tests/CLAUDE.md: never repo state/). trace.mjs resolves it at CALL time.
async function withTrail(t, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-attempt-'));
  const prev = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BUGHUNTER_STATE_DIR;
    else process.env.BUGHUNTER_STATE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return fn(dir);
}

test('a FAILED resolution reports WHAT IT TRIED: which strategies ran, and what each one found', async () => {
  // THE CASE THAT MATTERS. Three candidates carry the right role+name and the structural guard rejects
  // all three, so the resolver fails — but for a reason that is the OPPOSITE of a coverage gap. Without
  // the counts, this is indistinguishable from "nothing on the page matched".
  const { node, instance } = stubGraph({ templateId: 7, name: 'Create Event', role: 'button' });
  const impostors = [stubHandle({ matches: false }), stubHandle({ matches: false }), stubHandle({ matches: false })];
  const page = stubPage({ byRole: impostors });

  const res = await resolveWithAttempts(page, instance, node);
  assert.equal(res.handle, null, 'the fixture must actually FAIL to resolve — a hit makes every assertion below vacuous');

  assert.ok(Array.isArray(res.attempts) && res.attempts.length > 0,
    'the resolver must report WHAT IT TRIED — it returned a bare null, so which strategies ran, how many '
    + 'raw matches each found, and how many the structural guard rejected were all destroyed at the '
    + 'moment of failure, which is the moment they became interesting');

  const by = Object.fromEntries(res.attempts.map((a) => [a.strategy, a]));

  // Ran and found nothing.
  assert.equal(by.selector.ran, true, 'the stored positional selector is always attempted first');
  assert.equal(by.selector.raw, 0, 'and it matched nothing — the fact that decides NO_INSTANCE vs NOT_VISIBLE');

  // SKIPPED, not failed. Each durable strategy is gated on the instance locator type, and collapsing
  // "we never looked" into "we looked and it is not there" is half the defect.
  assert.equal(by.testid.ran, false, 'a strategy whose gate never opened is recorded as NOT RUN, never as a miss');
  assert.equal(by.id.ran, false, 'same for the stable-#id strategy — the instance carries no such locator');

  // The discriminator: found three, guard rejected three.
  assert.equal(by['role-name'].ran, true, 'role+name ran — the node carries both');
  assert.equal(by['role-name'].raw, 3,
    'and it FOUND THREE. "getByRole found zero" is a coverage gap; "getByRole found three and the '
    + 'structural guard rejected all of them" is a resolver bug — one number apart, opposite diagnoses, '
    + 'and nobody could tell which');
  assert.equal(by['role-name'].visible, 3, 'all three were visible, so visibility is not the explanation either');
  assert.equal(by['role-name'].sameTemplate, 0,
    'and ZERO survived the sameTemplate guard — the count that names the guard as the cause');

  // The guard does not apply to identity-exact strategies, and a fabricated 0 there would read as a
  // rejection that never happened.
  assert.equal(by.selector.sameTemplate, null,
    'sameTemplate is null where the structural guard does not apply — a 0 would claim a rejection that never occurred');
});

test('the legacy resolveHandle contract is unchanged — null on failure, not a truthy husk', async () => {
  // stateful-loop.mjs tests this return value for BARE TRUTHINESS twice (reachability at :90, retirement
  // at :389). An always-object `{handle:null,…}` would make every unreachable control read as reachable
  // and silently invert the retire/churn logic in a file this change is not allowed to touch.
  const { node, instance } = stubGraph({ templateId: 8, name: 'Ghost', role: 'button' });
  const missing = await resolveHandle(stubPage({}), instance, node);
  assert.equal(missing, null,
    'resolveHandle must stay FALSY on failure — two call sites test it with `!!` and `if (…)`, so a '
    + 'truthy failure object would report every unreachable control as reachable');

  const found = await resolveHandle(stubPage({ dollar: async () => stubHandle({}) }), instance, node);
  assert.equal(found.via, 'selector', 'and a success still projects to the {handle, via, representative} shape');
});

test('a NO_INSTANCE envelope carries STRUCTURED evidence, including hadRevealPath', async () => {
  const ledger = makeLedger();

  // (a) the element HAD a recorded reveal path — so the path BROKE.
  {
    const { graph, instance } = stubGraph({
      templateId: 11, name: 'Filter results', role: 'button',
      reveal: { route: '/dash', statePath: [{ templateId: 3, instanceKey: '#1' }] },
    });
    const err = await actStep(stubPage({}), graph, ledger, { templateId: 11, name: 'Filter results', role: 'button', route: '/dash', instance })
      .then(() => null, (e) => e);
    assert.ok(err, 'the fixture must actually FAIL to resolve');
    assert.equal(err.envelope?.code, 'NO_INSTANCE', 'nothing resolved and nothing was present → NO_INSTANCE');

    const ev = err.envelope.target;
    assert.ok(ev && typeof ev === 'object',
      'a NO_INSTANCE envelope must carry structured evidence — `target` is a free structured slot and every '
      + 'recon failure left it null, rendering all evidence into message prose that no consumer can read by key');
    assert.equal(ev.templateId, 11, 'the evidence names the template');
    assert.equal(ev.selector, instance.instanceSelector, 'and the selector that was tried');
    assert.ok(Array.isArray(ev.attempts) && ev.attempts.some((a) => a.ran),
      'and it carries the resolver attempt record — the answer to "what did it DO to find it"');
    assert.equal(ev.hadRevealPath, true,
      'hadRevealPath must be TRUE when the element carried a recorded path: this failure is a path that '
      + 'BROKE, not a control we never knew how to reach — one NO_INSTANCE code, two opposite stories');
  }

  // (b) no recorded path — so we never knew how to reach it. Same code, different diagnosis.
  {
    const { graph, instance } = stubGraph({ templateId: 12, name: 'Filter results', role: 'button' });
    const err = await actStep(stubPage({}), graph, ledger, { templateId: 12, name: 'Filter results', role: 'button', route: '/dash', instance })
      .then(() => null, (e) => e);
    assert.equal(err.envelope?.code, 'NO_INSTANCE');
    assert.equal(err.envelope.target.hadRevealPath, false,
      'and FALSE when no path was ever recorded — without this field the two are one undifferentiated bucket');
  }
});

test('a FAILED node-loop act is readable as act.failed, with its granular code and its evidence', async (t) => {
  await withTrail(t, async (dir) => {
    const runId = 'r-20260720100000-aaaa';
    const { graph, instance } = stubGraph({ templateId: 21, name: 'Sign out', role: 'link' });
    // The pre-nav ROUTE_DANGER guard: a self-logout refusal, thrown before any navigation, and exactly
    // the class of failure whose granular code `report --unreached` prefers over the graph's coarse reason.
    const step = persistentStep({ page: stubPage({}), origin: ORIGIN, ledger: makeLedger(), runId });

    await assert.rejects(
      () => step(graph, { templateId: 21, name: 'Sign out', role: 'link', route: '/logout', instance }),
      /ROUTE_DANGER|danger route/,
      'the fixture must actually FAIL — a passing act would make every assertion below vacuous',
    );

    const failed = readActFailed(runId);
    assert.equal(failed.length, 1,
      'readActFailed must return the NODE loop\'s failures — it filters on kind "act.failed" and this driver '
      + 'wrote kind "act", so run raw1 produced 146 failures and this reader saw 0 of them');
    assert.equal(failed[0].code, 'ROUTE_DANGER',
      'and the GRANULAR code must survive — it is the reason report --unreached prefers the trail over the '
      + 'graph\'s coarse unreachable reason');
    assert.equal(failed[0].templateId, 21, 'the failure is attributable to the template that was aimed at');

    const [ev] = readEvents(dir, runId).filter((e) => e.kind === 'act.failed');
    assert.ok(ev, 'the failure is written as ONE act.failed event');
    assert.equal(typeof ev.payload.timings?.attemptMs, 'number',
      'a failed act carries numeric timings — raw1 recorded none, so the trail could not say how long a '
      + 'failed attempt cost');
    assert.equal(ev.payload.instanceSelector, instance.instanceSelector,
      'and the instanceSelector, absent on every raw1 failure — 11 of 20 failures in an audited run were '
      + 'resolver COLLISIONS, the class whose diagnosis needs to know what was resolved and onto what');
    assert.equal(ev.payload.requested, '/logout',
      'the AIMED route is `requested` — `route` means LANDED on the success payload, and one column with '
      + 'two meanings is how a trail mixes intent with fact');
    assert.ok(!('route' in ev.payload), 'so there is NO `route` key on a failure');
  });
});

test('a SUCCESSFUL node-loop act names HOW the element was found (via)', async (t) => {
  await withTrail(t, async (dir) => {
    const runId = 'r-20260720100001-bbbb';
    const graphPath = path.join(dir, 'graph.json');
    const { graph, instance } = stubGraph({ templateId: 31, name: 'Docs', role: 'link' });
    // An off-origin link is the ONE actStep success that returns before any causal window or DOM
    // snapshot, so it reaches the success trail-write with no browser.
    const page = stubPage({ dollar: async () => stubHandle({ href: 'https://external.example/docs' }) });
    const step = persistentStep({ page, origin: ORIGIN, ledger: makeLedger(), runId, graphPath });

    const res = await step(graph, { templateId: 31, name: 'Docs', role: 'link', route: '/dash', instance });
    assert.ok(res.external, 'the fixture must actually SUCCEED — an off-origin link is recorded, never fired');

    const [ev] = readEvents(dir, runId).filter((e) => e.kind === 'act');
    assert.ok(ev, 'a successful act is still written as kind "act"');
    assert.equal(ev.payload.via, 'selector',
      'a successful act must name HOW the element was found — `via` was absent on 141 of 141 successful acts '
      + 'in raw1, so the trail could not say how ANY element in the run was located, and an act that resolved '
      + 'a same-named control from another template read as a clean hit');
    assert.equal(ev.payload.representative, false,
      'and whether it is the stored instance or a live stand-in — an `inert` verdict from a representative '
      + 'describes whatever node the fallback landed on');
    assert.equal(ev.payload.instanceKey, '#1', 'the acted instance is named, not just its template');
    assert.equal(ev.payload.route, res.route, '`route` on a success keeps meaning LANDED');
  });
});
