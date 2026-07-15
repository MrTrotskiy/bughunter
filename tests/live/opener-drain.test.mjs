// Live proof of the opener-drain guard on the AGENT path (review follow-up; decisions.md 2026-07-15
// "review-driven follow-ups"). whats-new must REFUSE acting a PROVEN multi-instance opener when
// --instance is omitted — otherwise it silently acts the representative instances[0], which is the
// WRONG control (not the frontier's emitted sibling), and the caller then records its observation
// against an instance that was never clicked. The node loop is immune (it always threads the
// frontier target's key); this guards the agent path (/recon), where the worker types the command.
//
// Guards: after one act proves the state-app nav an opener (3 instances of one template), a second
//   whats-new act on the SAME template WITHOUT --instance throws USAGE — it does not silently act
//   instances[0].
// FAIL-ON-REVERT: drop the opener-drain guard in whats-new.mjs (the `node.opener && instances>1 &&
//   --instance==null` throw) → the no-instance act proceeds on instances[0] (no throw) → the
//   assert.rejects(USAGE) goes red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/state-app/server.mjs';
import { run } from '../../lib/recon/whats-new.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';

test('whats-new REFUSES acting a proven multi-instance opener without --instance', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/app`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-opener-drain-'));
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  t.after(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });

  // 1. Baseline — the nav template (3 instances of one control) is present but not yet an opener.
  await run({ url });
  const g1 = loadGraph(path.join(stateDir, 'graph.json'));
  const nav = Object.values(g1.elements).find((n) => n.instances.length === 3);
  assert.ok(nav, 'the nav template (3 instances) is in the baseline');
  assert.ok(!nav.opener, 'the nav is not yet a proven opener at baseline');

  // 2. Act instance #1 (WITH --instance) → it reveals content → markOpener flags the template.
  await run({ url, actTemplate: nav.templateId, instance: nav.instances[0].instanceKey });
  const g2 = loadGraph(path.join(stateDir, 'graph.json'));
  assert.ok(g2.elements[nav.templateId].opener, 'acting a nav instance proved the template an opener');

  // 3. Now act the SAME opener with NO --instance → refused (would else act the wrong instance).
  await assert.rejects(
    () => run({ url, actTemplate: nav.templateId }),
    (e) => e.code === 'USAGE',
    'acting a proven multi-instance opener without --instance must be refused',
  );
});
