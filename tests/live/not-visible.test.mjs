// Live proof that the fire path FAST-FAILS on a DOM-present-but-invisible control
// instead of stalling on Playwright's 30s actionability timeout. Real sites are full
// of these — a responsive layout keeps its mobile menu in the DOM but display:none on
// desktop; dom-snapshot captures them (it does not filter by visibility, on purpose),
// so the recon loop WILL hand one to actStep. Without the isVisible() pre-check every
// such control costs 30s of wall clock; on a real site that alone cripples a run.
//
// Guards: actStep rejects a not-visible instance promptly with envelope code
//   NOT_VISIBLE, and it does so an order of magnitude faster than the click timeout —
//   so hidden/duplicated controls cost milliseconds, not the full actionability wait.
// FAIL-ON-REVERT: delete the isVisible() fast-fail in lib/recon/step.mjs → actStep
//   instead calls handle.click({timeout:5000}) on #hid → the click waits the full 5s
//   and throws a Playwright TimeoutError whose envelope code is NOT 'NOT_VISIBLE' →
//   the code assertion goes red (and the <2s elapsed assertion also goes red).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/hidden-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep, actStep } from '../../lib/recon/step.mjs';
import { makeGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';

function targetFor(graph, name) {
  const node = Object.values(graph.elements).find((n) => n.name === name);
  assert.ok(node, `template "${name}" must be discovered by the baseline snapshot`);
  return { templateId: node.templateId, name: node.name, route: node.route, instance: node.instances[0] };
}

test('the fire path fast-fails NOT_VISIBLE on a hidden control instead of hanging', async (t) => {
  const server = await start(0);
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-hidden-'));
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

  // Both controls are captured — dom-snapshot does not filter by visibility.
  const hidden = targetFor(graph, 'Hidden');
  const visible = targetFor(graph, 'Visible');

  // The hidden one must be REFUSED fast: NOT_VISIBLE, well under the 5s click timeout.
  const started = process.hrtime.bigint();
  await assert.rejects(
    () => actStep(page, graph, ledger, hidden),
    (err) => err?.envelope?.code === 'NOT_VISIBLE',
    'acting on a display:none control must reject with NOT_VISIBLE',
  );
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 2000, `NOT_VISIBLE must fast-fail (<2s), took ${elapsedMs.toFixed(0)}ms`);

  // The visible sibling still acts normally (no handler → no requests, no throw): the
  // gate rejects invisibility, not every click.
  const res = await actStep(page, graph, ledger, visible);
  assert.equal(res.requests.length, 0, 'the visible control fires no request but does not throw');
});
