// Live proof that the off-origin skip is HTTP-scheme-gated: a `javascript:` anchor (opaque
// origin, but an in-page control) is FIRED, not misclassified as an off-origin link and
// dropped. Without the scheme gate, `sameOrigin(page, "javascript:void(0)")` is false, so a
// naive "!same-origin → external" would record the control as an off-origin link never
// fired — inflating coverage with a control never exercised and losing its causal capture.
//
// Guards: actStep clicks a `javascript:` anchor (returns NO `external` marker), because the
//   off-origin refusal only applies to http(s) cross-origin links (isOffOriginHttp).
// FAIL-ON-REVERT: change the gate in lib/recon/step.mjs back to `!sameOrigin(startUrl, href)`
//   (drop the scheme check) → the javascript: anchor is returned as `external` → the
//   "javascript: anchor is fired, not skipped as external" assertion goes red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/scheme-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep, actStep } from '../../lib/recon/step.mjs';
import { makeGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';

test('a javascript: anchor is fired, not skipped as an off-origin link', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-scheme-'));
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
  await snapshotStep(page, graph, ledger, '/');

  const jsNode = Object.values(graph.elements).find((n) => n.name === 'JS action');
  assert.ok(jsNode, 'the javascript: anchor was discovered');
  const target = { templateId: jsNode.templateId, name: jsNode.name, route: jsNode.route, instance: jsNode.instances[0] };

  const res = await actStep(page, graph, ledger, target);
  assert.ok(!res.external, 'the javascript: anchor is fired (no external marker), not dropped as off-origin');
});
