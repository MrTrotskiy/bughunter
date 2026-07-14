// Live proof that a cookie/consent overlay is dismissed so the controls beneath it become
// reachable. A real cookie wall intercepts pointer events; without dismissal every
// underlying control fails its click (bounded timeout) and the page maps almost nothing.
// The fixture's banner covers the page and blocks #target (which fires GET /api/thing);
// the curated dismiss clicks the OneTrust accept id, removes the banner, and #target then
// fires its request when acted on.
//
// Guards: dismissOverlays clicks a known consent-accept control (returns its selector) and
//   that clears the interception, so actStep on the underlying control captures its causal
//   request instead of timing out on the overlay.
// FAIL-ON-REVERT: neuter the click in lib/recon/overlays.mjs (make clickIfLive return false
//   / never call el.click) → dismissOverlays returns null → the "consent control dismissed"
//   assertion fails, and the still-covered #target click times out so /api/thing never fires.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/overlay-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep, actStep } from '../../lib/recon/step.mjs';
import { dismissOverlays } from '../../lib/recon/overlays.mjs';
import { makeGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';

test('a consent overlay is dismissed so the underlying control becomes reachable', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-overlay-'));
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;

  const cold = await launch();
  t.after(async () => {
    await close(cold.browser);
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });

  const page = cold.page;
  const graph = makeGraph();
  const ledger = makeLedger();
  await gotoGated(page, url);
  await waitSettled(page);

  // Dismiss BEFORE snapshot, mirroring the pipeline: the accept control is clicked and the
  // banner removed while cause is still __idle__ (its request can never be a causal edge).
  const dismissed = await dismissOverlays(page);
  assert.equal(dismissed, '#onetrust-accept-btn-handler', 'the curated consent accept control was clicked');

  await snapshotStep(page, graph, ledger, '/');
  const targetNode = Object.values(graph.elements).find((n) => n.name === 'Do thing');
  assert.ok(targetNode, 'the underlying control was discovered after the overlay cleared');
  const target = { templateId: targetNode.templateId, name: targetNode.name, route: targetNode.route, instance: targetNode.instances[0] };

  const res = await actStep(page, graph, ledger, target);
  assert.ok(res.requests.some((r) => r.urlPattern === '/api/thing'), 'the uncovered control fired its request');
  assert.equal(server.thingHits(), 1, 'exactly one /api/thing hit, from the now-reachable control');
});

// Guards: the text fallback NEVER dismisses a real control — an accept-text ("OK") button
//   with no consent-scoped ancestor is left untouched (dismissOverlays returns null). The
//   whole false-positive risk of a text heuristic is that it clicks a genuine control.
// FAIL-ON-REVERT: drop the consent-scoped-ancestor requirement in lib/recon/overlays.mjs
//   (click any accept-text button) → the bare "OK" is clicked → dismissOverlays returns
//   'text:OK' → the "leaves a non-consent OK alone" assertion fails.
test('dismissOverlays leaves a non-consent accept-text control alone', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/plain`;
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  process.env.PW_ALLOW_PRIVATE = '1';
  const cold = await launch();
  t.after(async () => {
    await close(cold.browser);
    server.close();
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
  });

  const page = cold.page;
  await gotoGated(page, url);
  await waitSettled(page);
  const dismissed = await dismissOverlays(page);
  assert.equal(dismissed, null, 'a bare "OK" outside any consent container must not be clicked');
});
