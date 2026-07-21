// WHAT DID IT DO TO FIND THAT BUTTON — the stateful driver's half, which the fix for the node loop missed.
//
// `resolveWithAttempts` was added to resolve-handle.mjs and wired into `step.mjs`'s throw sites, but
// `stateful-step.mjs` — the driver a `--stateful` run actually executes — was outside that change's allowed
// files. It kept calling the thin `resolveHandle` projection, which DISCARDS the per-strategy record, and its
// `recordFail` never persisted `err.envelope.target`. Measured on run `raw3` (in progress, stateful):
//   - `via` (how a control was FOUND) present on 119 of 119 successful acts — the sibling fix landed;
//   - the attempt record (what was TRIED when a control could NOT be found) present on 0 of 31 failures.
// So the half of the run that needs explaining was the half with no evidence, and the trail could say only
// "не нашли" — collapsing three opposite diagnoses into one bucket:
//   - the stored positional selector went stale and the durable locator was never even tried,
//   - role+name matched ZERO elements — a genuine coverage gap,
//   - role+name matched THREE and the `sameTemplate` structural guard rejected all three — a resolver bug,
//     and a live suspect: that guard compares a full ancestor path of median depth 8 while its own comment
//     promises to tolerate an element that "moved", which is exactly what changes an ancestor path.
//
// TWO EVIDENCE SOURCES, ONE VOCABULARY. `step.mjs` attaches structured evidence to the envelope on the
// resolution failures (NO_INSTANCE / NOT_VISIBLE); every OTHER code it throws carries none — on raw3 that is
// ALIAS_COLLISION 13, DISABLED 8, ACT_FAILED 6, i.e. 30 of the 31 failures. `stateful-step` fills those from
// the resolution it ALREADY performs before acting (its click-interception check), under the SAME field names
// so the viewer needs one renderer rather than two.
//
// Guards: a stateful failure carries `target.attempts` naming EVERY strategy with {ran, raw, visible,
//   sameTemplate}, on BOTH evidence sources; `hadRevealPath` in both directions (33 vs 20 on the previous
//   run, and the single most explanatory field an unreached control has); and the truthiness contract that
//   keeps the two resolver exports non-interchangeable.
//
// FAIL-ON-REVERT (three levers, each independently verified):
//   - `stateful-step.mjs`: drop `target: evidence` from recordFail's traceEvent payload → "a failed act must
//     record WHAT THE RESOLVER TRIED" reds (this is the 0-of-31 state exactly).
//   - `stateful-step.mjs`: revert the pre-act `resolveWithAttempts` to `resolveHandle` (and drop the
//     `preResolve` assignment) → the ALIAS_COLLISION case loses its only evidence source → "the attempt
//     record survives on a failure whose envelope carries none" reds.
//   - `resolve-handle.mjs`: make `resolveHandle` return the widened object directly (`return r;` — the
//     one-line "simplification") → "the projection must stay FALSY on failure" reds.
//
// NO BROWSER (tests/CLAUDE.md layer rule). The page is a stub, and it works because every page-level
// observation on these paths is catch-wrapped, so a refusing `page.evaluate` degrades exactly as a dead page
// would; only `handle.evaluate` is answered, which is the seam actStep reads the alias claim and the
// structural guard through.
//
// CAUSAL DISCIPLINE: nothing here opens a causal window, and nothing added by this change could. Both
// evidence sources are read under `__idle__` — the pre-act resolution precedes actStep's `beginCause`, the
// envelope one is built inside actStep's pre-click gate stack — and recordFail adds no page call at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORIGIN = 'https://app.example';
const PAGE_URL = `${ORIGIN}/dash`;

const { statefulStep } = await import('../../lib/recon/stateful-step.mjs');
const { resolveHandle, resolveWithAttempts } = await import('../../lib/recon/resolve-handle.mjs');
const { makeLedger } = await import('../../lib/graph/ids.mjs');

// A handle that answers the two unguarded reads actStep performs: the alias claim (recognised by
// act-alias.mjs's own `prop` argument) and the `sameTemplate` structural guard (a string argument).
function stubHandle({ matches = true, claim = { ok: true, heldBy: null } } = {}) {
  return {
    evaluate: async (_fn, arg) => {
      if (arg && arg.prop) return claim;
      if (typeof arg === 'string') return matches;
      return null;                              // the anchor-href read
    },
    isVisible: async () => true,
    isEnabled: async () => true,
    boundingBox: async () => ({ x: 12, y: 34, width: 56, height: 78 }),
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-stateful-attempt-'));
  const prev = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BUGHUNTER_STATE_DIR;
    else process.env.BUGHUNTER_STATE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return fn(dir);
}

// Mirrors resolve-handle.mjs STRATEGIES — `widget` (antd Select/Picker durable locator) sits after `id`.
const STRATEGIES = ['selector', 'testid', 'id', 'widget', 'role-name', 'label', 'text'];

test('a failed stateful act records WHAT THE RESOLVER TRIED, even when the envelope carries no evidence', async (t) => {
  await withTrail(t, async (dir) => {
    const runId = 'r-20260720120000-aaaa';
    // The case that carries the whole lever. The stored positional selector matches NOTHING (`$` → null), the
    // durable role+name fallback finds the control, and the alias ledger then reports the resolved node as
    // already acted for another instance → ALIAS_COLLISION. That code is thrown with NO envelope `target`, and
    // it is the LARGEST failure class of run raw3 (13 of 31) — so this is exactly the failure that had no
    // evidence at all, and the pre-act resolution is its only possible source.
    //
    // "Close" is a dismiss control, so statefulStep stamps no reveal path and actStep therefore skips the
    // `preVisible` DOM snapshot — the one page-level read on this path that is not catch-wrapped.
    const { graph, instance } = stubGraph({ templateId: 51, name: 'Close', role: 'button' });
    const page = stubPage({ byRole: [stubHandle({ claim: { ok: false, heldBy: '99#7' } })] });
    const step = statefulStep({ page, origin: ORIGIN, ledger: makeLedger(), runId });

    await assert.rejects(
      () => step(graph, { templateId: 51, name: 'Close', role: 'button', route: '/settings', instance }),
      /ALIAS_COLLISION|already acted/,
      'the fixture must actually FAIL the act — a passing act would make every assertion below vacuous',
    );

    const [ev] = readEvents(dir, runId).filter((e) => e.kind === 'act.failed');
    assert.ok(ev, 'the failure is written as ONE act.failed event');
    assert.equal(ev.payload.code, 'ALIAS_COLLISION', 'and the granular code is unchanged — failure-hints keys its taxonomy on it');

    const tg = ev.payload.target;
    assert.ok(tg && typeof tg === 'object',
      'a failed act must record WHAT THE RESOLVER TRIED — measured on run raw3, `via` rode 119 of 119 '
      + 'SUCCESSFUL acts and the attempt record rode 0 of 31 FAILURES, so the trail could say only "не нашли"');

    assert.ok(Array.isArray(tg.attempts),
      'the attempt record survives on a failure whose envelope carries none — ALIAS_COLLISION, DISABLED and '
      + 'ACT_FAILED are 30 of raw3\'s 31 failures and step.mjs attaches evidence to none of them, so the '
      + 'resolution this step already performed before acting is the only source there will ever be');
    assert.deepEqual(tg.attempts.map((a) => a.strategy), STRATEGIES,
      'and it names EVERY strategy, so a strategy that never ran is distinguishable from one that ran and '
      + 'found nothing — collapsing "we never looked" into "we looked and it is not there" is half the defect');
    for (const a of tg.attempts) {
      assert.equal(typeof a.ran, 'boolean', `${a.strategy} reports whether its gate opened`);
      assert.equal(typeof a.raw, 'number', `${a.strategy} reports how many raw matches it found`);
      assert.equal(typeof a.visible, 'number', `${a.strategy} reports how many of those were visible`);
      assert.ok(a.sameTemplate === null || typeof a.sameTemplate === 'number',
        `${a.strategy} reports the structural-guard count, or null where the guard does not apply — a `
        + 'fabricated 0 would read as a rejection that never happened');
    }

    const by = Object.fromEntries(tg.attempts.map((a) => [a.strategy, a]));
    assert.equal(by.selector.ran, true, 'the stored positional selector was attempted first');
    assert.equal(by.selector.raw, 0, 'and matched nothing — the stale-path story, told as a number');
    assert.equal(by.testid.ran, false, 'a strategy whose locator gate never opened is recorded as NOT RUN');
    assert.equal(by['role-name'].ran, true, 'the durable role+name fallback DID run — so "never tried" is excluded');
    assert.equal(by['role-name'].raw, 1, 'and it found the control: this failure is a collision, not a coverage gap');
    assert.equal(by['role-name'].sameTemplate, 1,
      'which the structural guard accepted — "found three and the guard rejected all three" is the OPPOSITE '
      + 'diagnosis, one number apart, and both rendered identically before this record existed');

    // The rest of step.mjs's evidence vocabulary, so the viewer needs one renderer and not two.
    assert.equal(tg.templateId, 51, 'the evidence names the template');
    assert.equal(tg.instanceKey, '#1', 'and the instance');
    assert.equal(tg.selector, instance.instanceSelector, 'and the selector that was tried');
    assert.equal(tg.locatorType, null, 'and the durable locator type recorded for the instance (none here)');
  });
});

test('the failure says whether a reveal path was EVER recorded (hadRevealPath), in both directions', async (t) => {
  await withTrail(t, async (dir) => {
    const runId = 'r-20260720120001-bbbb';
    const ledger = makeLedger();

    // (a) a path WAS recorded → this failure is a path that BROKE (a reach regression).
    {
      const { graph, instance } = stubGraph({
        templateId: 61, name: 'Filter results', role: 'button',
        reveal: { route: '/dash', statePath: [{ templateId: 3, instanceKey: '#1' }] },
      });
      const step = statefulStep({ page: stubPage({}), origin: ORIGIN, ledger, runId });
      await assert.rejects(
        () => step(graph, { templateId: 61, name: 'Filter results', role: 'button', route: '/dash', instance }),
        /NO_INSTANCE|cannot resolve/,
        'the fixture must actually FAIL to resolve',
      );
    }
    // (b) no path was ever recorded → we never knew how to open this (a discovery gap). SAME code.
    {
      const { graph, instance } = stubGraph({ templateId: 62, name: 'Filter results', role: 'button' });
      const step = statefulStep({ page: stubPage({}), origin: ORIGIN, ledger, runId });
      await assert.rejects(
        () => step(graph, { templateId: 62, name: 'Filter results', role: 'button', route: '/dash', instance }),
        /NO_INSTANCE|cannot resolve/,
      );
    }

    const failures = readEvents(dir, runId).filter((e) => e.kind === 'act.failed');
    assert.equal(failures.length, 2, 'both failures were recorded');
    const [withPath, without] = failures;

    assert.equal(withPath.payload.target?.hadRevealPath, true,
      'hadRevealPath must be TRUE when the element carried a recorded path: measured 33 of the previous '
      + 'run\'s failures, and it is the single most explanatory field an unreached control has — this one is '
      + 'a path that BROKE, not a control we never knew how to open');
    assert.equal(without.payload.target?.hadRevealPath, false,
      'and FALSE when no path was ever recorded — 20 on that same run. One NO_INSTANCE code, two opposite '
      + 'stories, and without this field they are one undifferentiated bucket');

    // The resolution failed outright here, so the envelope carried its OWN evidence — which must win, being
    // measured at the failing instant rather than moments earlier, while keeping the identical field names.
    assert.equal(withPath.payload.code, 'NO_INSTANCE', 'the granular code is untouched by carrying evidence');
    assert.ok(Array.isArray(withPath.payload.target.attempts) && withPath.payload.target.attempts.some((a) => a.ran),
      'and the attempt record rides the envelope source too — one shape, whichever source supplied it');
  });
});

test('the two resolver exports agree on the handle and DISAGREE on truthiness — the trap that must not be repeated', async () => {
  // `stateful-step.mjs` still calls the `resolveHandle` PROJECTION at three sites that test its result for
  // bare truthiness or read `.handle` off it (the post-act field-outcome read, the explore-all prefill, the
  // overlay-retry re-resolve), exactly as `stateful-loop.mjs` does for reachability and retirement. The
  // widened form ALWAYS returns an object, so collapsing the two exports into one would make every
  // unreachable control read as reachable and silently invert the retire/churn logic.
  const { node, instance } = stubGraph({ templateId: 71, name: 'Ghost', role: 'button' });

  const failing = stubPage({});
  const projected = await resolveHandle(failing, instance, node);
  const widened = await resolveWithAttempts(failing, instance, node);
  assert.equal(projected, null,
    'the projection must stay FALSY on failure — several call sites test it with `!!` and `if (…)`, so a '
    + 'truthy failure husk would report every unreachable control as reachable');
  assert.ok(widened && typeof widened === 'object',
    'while the widened form is ALWAYS an object, which is precisely why the two cannot be interchanged');
  assert.equal(widened.handle, null, 'its handle is the null the projection collapses to');
  assert.ok(Array.isArray(widened.attempts) && widened.attempts.length === STRATEGIES.length,
    'and the evidence the projection throws away is the only difference between them');

  const hit = stubHandle({});
  const succeeding = stubPage({ dollar: async () => hit });
  const pOk = await resolveHandle(succeeding, instance, node);
  const wOk = await resolveWithAttempts(succeeding, instance, node);
  assert.equal(pOk.handle, wOk.handle,
    'on success the two must resolve the SAME handle — the widen adds a record, it must never change which '
    + 'element is acted, or an act could become reachable or unreachable because of a logging change');
  assert.equal(pOk.via, wOk.via, 'and report the same `via`');
  assert.equal(wOk.via, 'selector', 'namely the stored positional selector, resolved first and cheapest');
});
