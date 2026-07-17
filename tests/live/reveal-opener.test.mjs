// Live proof of REVEAL-OPENER (collect a compose UI as a READ without committing a write) + the
// COMMUNICATION hard-refusal. On a read-only authed crawl a mutation-NAMED control ("Create post") is
// name-refused BEFORE the click, so the composer modal it opens is never collected. The fix lets the
// AGENT judge such a control a form-opener (--reveal-opener) → the click is allowed, the revealed modal
// is COLLECTED, and the network write-firewall stays the HARD net that ABORTS any actual write the click
// fires. Initiating a real call ("Video Call") is an irreversible OUTWARD side-effect off the abortable
// HTTP layer, so it stays hard-refused EVEN under --reveal-opener.
//
// Guards:
//   (A) DEFAULT — acting "Create post" read-only WITHOUT --reveal-opener is refused (MUTATION_FLOOR).
//   (B) REVEAL-OPENER — acting it WITH --reveal-opener clicks, the composer modal is revealed + collected
//       ("Post" child appears), the draft-create POST it fires is ABORTED by the firewall (no server side-
//       effect), the causal control→endpoint edge is still recorded (the map is preserved), AND the
//       RPC-over-GET mutation it fires (GET /api/follow) is ALSO aborted by the reveal-opener strict-GET
//       gate (security review H1: the write-firewall nets non-GET only, so a GET-commit must be caught).
//   (C) COMMUNICATION — acting "Video Call" WITH --reveal-opener is STILL hard-refused (DANGER_FLOOR):
//       reveal-opener exempts only the softer mutation class, never the REFUSED (destructive/auth/payment/
//       communication) gate.
// FAIL-ON-REVERT:
//   (B) drop the `!revealOpener` guard in step.mjs actStep → "Create post" is refused even with the flag
//       → the "composer modal revealed" assertion reds.
//   (H1) drop the strict-GET flip in whats-new.mjs (or the strict.get branch in read-only-firewall.mjs) →
//       the RPC-over-GET `/api/follow` is CONTINUED → the "GET-commit aborted" assertion reds.
//   (C) remove 'communication' from REFUSED (or let revealOpener exempt the REFUSED gate) → "Video Call"
//       clicks → the assert.rejects(DANGER_FLOOR) reds.

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
  const prevStorage = process.env.BUGHUNTER_STORAGE_STATE;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-reveal-opener-'));
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  delete process.env.BUGHUNTER_STORAGE_STATE; // readOnly comes from the explicit opt, not a storageState
  t.after(() => {
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
    if (prevStorage !== undefined) process.env.BUGHUNTER_STORAGE_STATE = prevStorage;
  });
  return stateDir;
}

const find = (graph, name) => Object.values(graph.elements).find((n) => n.name === name);

test('reveal-opener: a compose opener is collected as a read; a call control stays hard-refused', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = withEnv(t);
  const graphFile = path.join(stateDir, 'graph.json');
  t.after(() => server.close());

  // Baseline (read-only) discovers the three controls.
  await run({ url, readOnly: true });
  let graph = loadGraph(graphFile);
  const createPost = find(graph, 'Create post');
  const videoCall = find(graph, 'Video Call');
  assert.ok(createPost, 'the mutation-named opener "Create post" is discovered at baseline');
  assert.ok(videoCall, 'the communication control "Video Call" is discovered at baseline');

  // (A) DEFAULT — read-only, no reveal-opener → the mutation-named opener is refused BEFORE the click.
  await assert.rejects(
    run({ url, actTemplate: createPost.templateId, readOnly: true }),
    (err) => err?.envelope?.code === 'MUTATION_FLOOR',
    'acting a mutation-named opener read-only without --reveal-opener must be refused',
  );

  // (B) REVEAL-OPENER — the agent judges it a form-opener → click allowed → composer modal collected,
  //     the draft-create write aborted, the causal edge still recorded.
  const acted = await run({ url, actTemplate: createPost.templateId, readOnly: true, revealOpener: true });
  graph = loadGraph(graphFile);
  const child = find(graph, 'Post');
  assert.ok(child, 'the composer modal was revealed and its "Post" submit collected (opener read, not a write)');
  assert.ok(acted.blocked && acted.blocked.writeBlocked >= 1, 'the draft-create POST the opener fired was ABORTED by the write-firewall (no server side-effect)');
  assert.ok(
    graph.edges.some((x) => x.from === `element:${createPost.templateId}` && x.to === 'request:POST /api/draft'),
    'the aborted write is still in the causal control→endpoint map (map preserved, only the side-effect prevented)',
  );
  // H1 — the RPC-over-GET mutation the opener fired is ALSO aborted (strict-GET), so reveal-opener cannot
  // leak a GET-committed mutation the POST-scoped firewall would miss.
  assert.ok(
    acted.blocked.refusedPatterns.some((p) => p.includes('/api/follow')),
    'the RPC-over-GET mutation (GET /api/follow) was aborted by the reveal-opener strict-GET gate (H1)',
  );

  // (C) COMMUNICATION — reveal-opener does NOT exempt the hard REFUSED gate; initiating a call stays refused.
  await assert.rejects(
    run({ url, actTemplate: videoCall.templateId, readOnly: true, revealOpener: true }),
    (err) => err?.envelope?.code === 'DANGER_FLOOR',
    'a Video Call control must stay hard-refused even with --reveal-opener (communication ∈ REFUSED)',
  );
});
