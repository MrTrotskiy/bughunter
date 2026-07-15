// Live proof that the AGENT path (whats-new — what /recon actually drives) reaches a control
// behind an in-page reveal, and that a POST-that-READS opener is replayable under the agent's
// judgment. This is the fix for "a /recon run on a constant-URL SPA maps one page": the reveal
// path is now threaded through whats-new (not only the node-loop recon-run), and the GET-only
// stamp gate widens to an agent-judged read POST so a nav opener that fires a POST list query
// stops leaving its content unreachable.
//
// Guards:
//   (A) AGENT-PATH REPLAY — acting the modal control #expand via whats-new RESOLVES and is
//       causally attributed (GET /api/expand → #expand), because whats-new's applyReveal prologue
//       re-opens the modal before the measured act. Without it the per-invocation fresh navigation
//       leaves the modal closed → NO_INSTANCE.
//   (B) POST-READ REPLAYABILITY WIDEN — #expand, revealed by a POST opener (#open-read fires
//       POST /api/list), carries a reveal path ONLY because the act passed openerReplayable=true.
//       The GET-only default would leave it unstamped (proven by the contrast test below).
//   (C) CAUSAL AT DEPTH ON THE AGENT PATH — the opener's POST /api/list, re-fired under __idle__
//       during replay, is NOT attributed to #expand; only #expand's own GET /api/expand is.
// FAIL-ON-REVERT:
//   (A) drop the `applyReveal` prologue in whats-new.mjs run()'s act branch → acting #expand
//       throws NO_INSTANCE → the `await run(... actTemplate: expand ...)` rejects → test red.
//   (B) remove the `|| openerReplayable === true` clause in step.mjs → #expand is never stamped →
//       the reveal.statePath deepEqual (and the contrast test) go red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/modal-app/server.mjs';
import { run } from '../../lib/recon/whats-new.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';

function withEnv(t) {
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-agent-sop-'));
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

test('agent path replays a POST-read opener and reaches + attributes the control behind it', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = withEnv(t);
  const graphFile = path.join(stateDir, 'graph.json');
  t.after(() => server.close());

  // 1. Baseline seeds the load-time controls (including the #open-read opener).
  await run({ url });
  let graph = loadGraph(graphFile);
  const openRead = find(graph, 'Load list');
  assert.ok(openRead, 'the POST-read opener was discovered at baseline');

  // 2. Act the opener WITH the agent's read judgment → its POST reveal is replayable, so #expand
  //    is stamped with the reveal path. openerReplayable=true is the load-bearing widen.
  await run({ url, actTemplate: openRead.templateId, openerReplayable: true });
  graph = loadGraph(graphFile);
  const expand = find(graph, 'Expand');
  assert.ok(expand, '#expand was revealed by the POST-read opener');

  // (B) the widen stamped #expand with the exact one-hop reveal path (the opener).
  assert.deepEqual(
    expand.reveal && expand.reveal.statePath,
    [{ templateId: openRead.templateId, instanceKey: openRead.instances[0].instanceKey }],
    '#expand.reveal.statePath is [the #open-read opener] (POST-read widen stamped it)',
  );

  // 3. Act #expand via the agent path. A fresh whats-new invocation navigates to the default
  //    state (modal closed); applyReveal must replay the opener to make #expand present.
  await run({ url, actTemplate: expand.templateId }); // (A) rejects here if replay is not threaded
  graph = loadGraph(graphFile);

  // (A)/(C) #expand's own GET is attributed to it at depth; the replayed opener's POST is not.
  assert.ok(graph.requests['GET /api/expand'], 'the #expand request node exists (acted successfully)');
  assert.ok(
    graph.edges.some((e) => e.from === `element:${expand.templateId}` && e.to === 'request:GET /api/expand'),
    'GET /api/expand is causally attributed to #expand (agent-path replay reached it)',
  );
  assert.ok(
    !graph.edges.some((e) => e.from === `element:${expand.templateId}` && e.to === 'request:POST /api/list'),
    'the replayed opener read (POST /api/list) is NOT attributed to #expand (causal survival at depth)',
  );
});

test('WITHOUT the read judgment, a POST opener leaves its child unstamped (the safe default holds)', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = withEnv(t);
  const graphFile = path.join(stateDir, 'graph.json');
  t.after(() => server.close());

  await run({ url });
  let graph = loadGraph(graphFile);
  const openRead = find(graph, 'Load list');

  // Act the SAME POST opener but do NOT assert it is a read → no widen → GET-only default →
  // #expand gets no reveal annotation (and would be unreachable), exactly as a mutating opener.
  await run({ url, actTemplate: openRead.templateId }); // openerReplayable omitted (falsey)
  graph = loadGraph(graphFile);
  const expand = find(graph, 'Expand');
  assert.ok(expand, '#expand was still discovered (revealed), just not stamped');
  assert.equal(expand.reveal, undefined, 'without the read judgment a POST opener stamps no reveal path (GET-only default)');
});
