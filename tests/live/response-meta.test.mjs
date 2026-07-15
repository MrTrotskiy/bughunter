// Live proof that RESPONSE-METADATA capture rides the causal channel WITHOUT weakening the
// invariant. Response data (status / mimeType / resourceType / durationMs) is joined to
// fires that were ALREADY kept by the token + initiator filters — it must never change WHICH
// fires are kept. We prove three things over real chromium + the response-meta fixture:
//   1. a click-caused request gets the correct response status/type joined to it, AND the
//      adversarial in-window background poll is STILL rejected with capture ON (the invariant
//      — the exact gate the decisions.md A1 entry named).
//   2. two same-(method,pathname) requests in one window pair with responses in FIRE ORDER
//      (the ordered takeResponse join).
//   3. the pipeline (actStep → graph) carries status/resourceType onto requests[] and the
//      request node's statuses histogram.
//
// Guards: causal.mjs joins response metadata onto kept fires (status/mimeType/resourceType/
//   durationMs), the kept set is byte-unchanged (poll still rejected), the join is ordered,
//   and step.mjs + graph-store.mjs carry it through.
// FAIL-ON-REVERT (join): remove the takeResponse block in endCause (causal.mjs) → the caused
//   fire has no `status` → "the caused request carries its 201" fails.
// FAIL-ON-REVERT (invariant): neuter classifyInitiator (`return {background:false}`) → the
//   in-window /api/poll leaks into the kept set → "the in-window poll is still rejected" fails.
// FAIL-ON-REVERT (order): drop `e.taken=true` in takeResponse → both /api/seq fires take the
//   first response → "second fire pairs with 202" fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/response-meta-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { beginCause, endCause, waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep, actStep } from '../../lib/recon/step.mjs';
import { makeGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';

test('response metadata joins to the caused request; the in-window poll is STILL rejected with capture ON', async (t) => {
  process.env.PW_ALLOW_PRIVATE = '1';
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browser, page } = await launch();
  t.after(async () => { await close(browser); server.close(); });

  await gotoGated(page, url);
  await waitSettled(page);

  const cause = 'CREATE_BTN';
  const seq0 = await beginCause(page, cause);
  await page.click('#create'); // slow POST 201; the 250ms poll deterministically ticks inside
  const kept = await endCause(page, seq0, cause);

  // Vacuity guard: the TOKEN alone would have miscredited the poll — it carries our cause
  // because it ticked inside the window. (If no poll ticked, this guard is meaningless.)
  const raw = await page.evaluate(({ c, s }) => window.__bughuntFires
    .filter((f) => f.cause === c && f.seq >= s)
    .map((f) => f.url), { c: cause, s: seq0 });
  assert.ok(raw.some((u) => u.includes('/api/poll')), 'a poll must tick inside the window (else this guard is vacuous)');
  assert.ok(raw.some((u) => u.includes('/api/create')), 'the caused request is in the raw window too');

  // INVARIANT: response-capture did not change the kept set — the poll is still rejected.
  const keptUrls = kept.map((f) => f.url);
  assert.ok(!keptUrls.some((u) => u.includes('/api/poll')), 'the in-window poll is still rejected (attribution unchanged)');

  // JOIN: the caused fire carries its real response metadata.
  const createFire = kept.find((f) => f.url.includes('/api/create'));
  assert.ok(createFire, 'the caused request survives attribution');
  assert.equal(createFire.method, 'POST');
  assert.equal(createFire.status, 201, 'the caused request carries its 201');
  assert.ok(typeof createFire.resourceType === 'string' && createFire.resourceType.length > 0, 'a resource type was joined');
  assert.ok(String(createFire.mimeType).includes('application/json'), 'the response mime-type was joined');
  assert.ok(createFire.durationMs === null || typeof createFire.durationMs === 'number', 'a duration is present (number or null)');
});

test('two same-(method,pathname) requests in one window pair with responses in FIRE ORDER', async (t) => {
  process.env.PW_ALLOW_PRIVATE = '1';
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browser, page } = await launch();
  t.after(async () => { await close(browser); server.close(); });

  await gotoGated(page, url);
  await waitSettled(page);

  const cause = 'TWICE_BTN';
  const seq0 = await beginCause(page, cause);
  await page.click('#twice'); // fires GET /api/seq?n=1 then ?n=2, both on pathname /api/seq
  const kept = await endCause(page, seq0, cause);

  const seqFires = kept.filter((f) => f.url.includes('/api/seq'));
  assert.equal(seqFires.length, 2, 'both /api/seq fires are kept (endCause does not dedupe)');
  // Fire order == ring order == ledger order: the first fire pairs with the first response.
  assert.equal(seqFires[0].status, 201, 'first fire pairs with the first response (n=1 → 201)');
  assert.equal(seqFires[1].status, 202, 'second fire pairs with the second response (n=2 → 202)');
});

test('the pipeline carries status/resourceType onto requests[] and the request node', async (t) => {
  process.env.PW_ALLOW_PRIVATE = '1';
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-respmeta-'));
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  const { browser, page } = await launch();
  t.after(async () => {
    await close(browser); server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });

  const graph = makeGraph();
  const ledger = makeLedger();
  await gotoGated(page, url);
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');

  const create = Object.values(graph.elements).find((n) => n.name === 'Create thing');
  assert.ok(create, '#create was discovered');
  const target = { templateId: create.templateId, name: create.name, route: create.route, instance: create.instances[0] };
  const res = await actStep(page, graph, ledger, target, {});

  const req = res.requests.find((r) => r.urlPattern === '/api/create');
  assert.ok(req, 'the caused request rode the returned requests[]');
  assert.equal(req.status, 201, 'step.mjs carried the response status onto the request');
  assert.ok(typeof req.resourceType === 'string' && req.resourceType.length > 0, 'step.mjs carried the resource type');
  assert.ok(req.durationMs === null || typeof req.durationMs === 'number', 'step.mjs carried a duration field');

  // graph-store accumulated the status histogram on the request node (backward-compatible).
  const node = graph.requests['POST /api/create'];
  assert.ok(node, 'the request node exists');
  assert.equal(node.statuses['201'], 1, 'the observed 201 was accumulated on the node');
  assert.ok(node.resourceType, 'the resource type was recorded on the node');
});
