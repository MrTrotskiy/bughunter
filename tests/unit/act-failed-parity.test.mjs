// THE FAILED ACT'S TRAIL ROW — the 15% of every run the trail could not describe.
//
// Three defects, all in one payload written by `stateful-step.mjs recordFail`, all measured on real runs:
//
//  1. THE WRONG EVENT KIND. `recordFail` wrote `kind:'act'`, but `trace.readActFailed` — the reader
//     `report --unreached` PREFERS over the graph's coarse unreachable reason — filters on
//     `kind:'act.failed'`. Only the agent path (whats-new) ever wrote that kind, so every run produced by
//     the live driver (recon-run → statefulLoop → statefulStep) returned [] from it: `hygge2`, `goal1`,
//     `goal2` and every `explore*` run contain ZERO act.failed events. The granular NO_INSTANCE /
//     NOT_VISIBLE / ALIAS_COLLISION / REVEAL_* codes were computed, written down, and discarded by the one
//     consumer that exists for them.
//
//  2. NO TIMINGS, NO RECT. 54 failed acts of 355 in `hygge2`, 56 of 408 in `goal1` — all with
//     `shots:null` and no `timings` key at all, so the trail could say neither where the element was nor
//     how long the attempt took. The before-frame (shot + rect + viewport) is taken by `actStep` under
//     `__idle__` BEFORE every failure path, so it EXISTS; the throw simply dropped it.
//
//  3. ONE COLUMN, TWO MEANINGS. The success payload writes `route: res.route` (where the act LANDED); the
//     failure payload wrote `route: target.route` (where it was AIMED). Measured divergence: 67 of 301
//     acts in `hygge2`, 199 of 352 in `goal1`. A viewer with a single "route" column was silently mixing
//     intent with fact — the same defect class as the trail that logged an act's INTENDED target instead
//     of the element actually clicked, which hid a wrong-control bug for seven runs. `route` events
//     already carry the aimed URL as `requested` (stateful-loop.mjs), so the vocabulary already existed.
//
// Plus `probeKind` — which battery obligation the act was discharging — computed in this file, threaded
// into every recordProbe call, and emitted on 0 of 355 and 0 of 408 acts.
//
// Guards: the stateful driver's failed-act and successful-act trail rows — that a failure is readable by
//   `readActFailed` with its granular code, carries what the act got as far as (numeric timings + the
//   captured rect), names the AIMED route as `requested` and never as `route`, and that a success names
//   the probe obligation it was discharging.
// FAIL-ON-REVERT (four levers, each independently verified):
//   - `traceEvent(runId,'act.failed',…)` → `'act'` in recordFail → "readActFailed must return the
//     stateful driver's failures" reds (readActFailed goes back to []).
//   - drop the `beforeFrame` capture wrapper (or the `shots` field) → "a failed act must carry the rect
//     the before-frame already captured" reds.
//   - `requested: target.route` → `route: target.route` → "the AIMED route is `requested`" reds.
//   - drop `probeKind` from the success payload → "a successful act names the obligation it discharged"
//     reds.
//
// NO BROWSER (tests/CLAUDE.md layer rule). The page is a stub, and it works because this codebase is
// defensive about observation: every `page.evaluate` on these two paths is `.catch`-wrapped or inside a
// try/catch by its own caller (liveRegionTexts → [], domFingerprint → null, readOutcome → swallowed by
// recordProbe, clickIntercepted → false), so a stub that refuses to evaluate degrades exactly the way a
// dead page would. Only `handle.evaluate` is answered, because actStep reads the href and the alias claim
// off it unguarded — which is precisely the seam that lets one stub reach BOTH a granular failure and a
// success without a causal window or a DOM snapshot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIGIN = 'https://app.example';
const PAGE_URL = `${ORIGIN}/dash`;
const RECT = { x: 12, y: 34, width: 56, height: 78 };

// A stub page. `evaluate` REFUSES — see the header: every page-level observation on these paths is
// defensively wrapped, so refusing is the honest stand-in for "no browser here" and never fabricates an
// observation. `handle.evaluate` answers the two unguarded reads actStep performs: the anchor href, and
// the alias claim (recognised by act-alias.mjs's own `prop` argument).
function stubPage({ href = null, claim = { ok: true, heldBy: null } } = {}) {
  const handle = {
    evaluate: async (_fn, arg) => (arg && arg.prop ? claim : href),
    isVisible: async () => true,
    isEnabled: async () => true,
    boundingBox: async () => ({ ...RECT }),
    click: async () => {},
  };
  return {
    on: () => {},
    url: () => PAGE_URL,
    viewportSize: () => ({ width: 1440, height: 900 }),
    $: async () => handle,
    $$: async () => [handle],
    evaluate: async () => { throw new Error('no page in a unit stub'); },
    keyboard: { press: async () => {} },
    waitForTimeout: async () => {},
  };
}

// One template + one instance, hand-built so the test states exactly what the step reads. `fieldFacts`
// is what makes the script pick a battery rung, which is what `probeKind` reports.
function stubGraph({ templateId, name, role, fieldFacts = null }) {
  const instance = { instanceKey: '#1', instanceSelector: `main > ${role}:nth-child(1)` };
  const node = {
    templateId, name, role, route: '/dash',
    templateSelector: `main > ${role}`,
    instances: [instance],
  };
  if (fieldFacts) node.fieldFacts = fieldFacts;
  return { graph: { schemaVersion: 6, routes: {}, elements: { [templateId]: node }, requests: {}, edges: [] }, instance, node };
}

function readEvents(dir, runId) {
  const file = path.join(dir, 'runs', runId, 'events.ndjson');
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// The trail dir is per-test (tests/CLAUDE.md: never repo state/). trace.mjs resolves it at CALL time from
// the env, so the import order does not matter — but statefulStep/trace must be imported AFTER nothing in
// particular; they read process.env on every write.
async function withTrail(t, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-actfailed-'));
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
const { readActFailed } = await import('../../lib/debug/trace.mjs');
const { makeLedger } = await import('../../lib/graph/ids.mjs');

test('a FAILED act is readable as act.failed, with its granular code, its timings and its rect', async (t) => {
  await withTrail(t, async (dir) => {
    const runId = 'r-20260720000000-aaaa';
    // "Cancel" is a dismiss control, so statefulStep stamps NO reveal path (reveal-path-invariant) — which
    // is also why this act never needs a DOM snapshot to compute `preVisible`. The alias ledger then finds
    // the resolved node already claimed by another actor: ALIAS_COLLISION, a granular envelope code thrown
    // AFTER the before-frame was captured. That ordering is the whole point — the frame existed and the
    // old payload threw it away.
    const { graph, instance } = stubGraph({ templateId: 41, name: 'Cancel', role: 'button' });
    const page = stubPage({ claim: { ok: false, heldBy: '99#7' } });
    const step = statefulStep({ page, origin: ORIGIN, ledger: makeLedger(), runId });

    await assert.rejects(
      () => step(graph, { templateId: 41, name: 'Cancel', role: 'button', route: '/settings', instance }),
      /ALIAS_COLLISION|already acted/,
      'the fixture must actually FAIL the act — a passing act would make every assertion below vacuous',
    );

    const failed = readActFailed(runId);
    assert.equal(failed.length, 1,
      'readActFailed must return the stateful driver\'s failures — it filters on kind "act.failed", and the '
      + 'live driver wrote kind "act", so this reader returned [] for every run the project has produced');
    assert.equal(failed[0].code, 'ALIAS_COLLISION',
      'and the GRANULAR code must survive: this is the reason report --unreached prefers the trail over the '
      + 'graph\'s coarse unreachable reason');
    assert.equal(failed[0].templateId, 41, 'the failure is attributable to the template that was acted');

    const [ev] = readEvents(dir, runId).filter((e) => e.kind === 'act.failed');
    assert.ok(ev, 'the failure is written as ONE act.failed event');

    // Defect 2 — what the act got as far as.
    assert.equal(typeof ev.payload.timings?.attemptMs, 'number',
      'a failed act must carry numeric timings — 15% of a run (54 of 355 acts) had no timings key at all, '
      + 'so the trail could not say how long the failed attempt took');
    assert.ok(ev.payload.shots && ev.payload.shots.rect,
      'a failed act must carry the rect the before-frame already captured — actStep takes it under __idle__ '
      + 'BEFORE every failure path, and the throw was dropping it');
    assert.equal(ev.payload.shots.rect.x, RECT.x, 'and it is the acted element\'s own box, not a placeholder');

    // Defect 3 — intent is never written into the column that means fact.
    assert.equal(ev.payload.requested, '/settings',
      'the AIMED route is `requested` — the vocabulary `route` events already use for exactly this meaning');
    assert.ok(!('route' in ev.payload),
      'and there is NO `route` key on a failure: `route` means LANDED on the success payload, and one column '
      + 'with two meanings is how a trail silently mixes intent with fact (67 of 301 acts diverged in hygge2)');
  });
});

test('a SUCCESSFUL act names the obligation it was discharging (probeKind)', async (t) => {
  await withTrail(t, async (dir) => {
    const runId = 'r-20260720000001-bbbb';
    // An off-origin link is the ONE actStep success that returns before any causal window or DOM snapshot,
    // so it reaches the success trail-write with no browser. `fieldFacts` is an independent input: the graph
    // records this node as a field, so the script picks its next outstanding battery rung — which is what
    // `probeKind` is there to report. (A node recorded as a field whose live handle resolves to something
    // else is the ordinary stale/representative case this resolver deals with constantly.)
    const { graph, instance } = stubGraph({
      templateId: 42, name: 'Docs', role: 'link',
      fieldFacts: { kind: 'fill', maxLength: 20, required: true },
    });
    const page = stubPage({ href: 'https://external.example/docs' });
    const step = statefulStep({ page, origin: 'https://elsewhere.example', ledger: makeLedger(), runId });

    const res = await step(graph, { templateId: 42, name: 'Docs', role: 'link', route: '/dash', instance });
    assert.ok(res.external, 'the fixture must actually SUCCEED — an off-origin link is recorded, never fired');

    const [ev] = readEvents(dir, runId).filter((e) => e.kind === 'act');
    assert.ok(ev, 'a successful act is still written as kind "act"');
    assert.equal(ev.payload.probeKind, 'fill-valid',
      'a successful act names the obligation it discharged — probeKind is computed and threaded into every '
      + 'probe row, and rode on 0 of 355 acts in hygge2, so "what was this click asking" was unanswerable');
    assert.equal(ev.payload.route, res.route,
      'and `route` on a success keeps meaning LANDED — the failure event is the one that changed');
  });
});
