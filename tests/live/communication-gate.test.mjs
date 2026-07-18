// Live proof of the COMMUNICATION hard-refusal — the fire-path half of the danger-floor classification.
// Initiating a real-time call / livestream / meeting is an IRREVERSIBLE OUTWARD side-effect: a WebRTC
// negotiation rings a real person or goes live to real viewers, and unlike a stray HTTP write there is
// nothing downstream that could undo it. So `communication` sits in REFUSED alongside destructive/auth/
// payment, and the CLICK path refuses it before the request can leave the browser. danger-gate.test.mjs
// guards the `destructive` class the same way; this one guards `communication`, which is the class that
// exists precisely because it CANNOT be caught after the fact.
//
// Guard: acting "Video Call" is refused DANGER_FLOOR and the call-start POST never fires.
// FAIL-ON-REVERT (VERIFIED red, then restored): remove 'communication' from REFUSED (danger-floor.mjs) or
//   drop the `REFUSED.has(floor)` arm in step.mjs actStep → the click goes through → sentinel
//   "Missing expected rejection: a Video Call control must be hard-refused (communication ∈ REFUSED)".
//
// NOTE: this fixture also carries a mutation-NAMED opener ("Create post"). It is NOT refused any more —
// the read-only write posture that used to name-gate it is gone — so no assertion is made about it here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/compose-app/server.mjs';
import { run } from '../../lib/recon/whats-new.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';

function withEnv(t) {
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-comm-gate-'));
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  t.after(() => {
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });
  return stateDir;
}

const find = (graph, name) => Object.values(graph.elements).find((n) => n.name === name);

test('a communication control is hard-refused at click time and fires nothing', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = withEnv(t);
  t.after(() => server.close());

  // Baseline discovers the control; the graph maps it (honest coverage — refused, never hidden).
  await run({ url });
  const videoCall = find(loadGraph(path.join(stateDir, 'graph.json')), 'Video Call');
  assert.ok(videoCall, 'the communication control "Video Call" is discovered and mapped at baseline');

  await assert.rejects(
    run({ url, actTemplate: videoCall.templateId }),
    (err) => err?.envelope?.code === 'DANGER_FLOOR',
    'a Video Call control must be hard-refused (communication ∈ REFUSED)',
  );
  assert.equal(server.callHits(), 0, 'the call-start request never left the browser');
});
