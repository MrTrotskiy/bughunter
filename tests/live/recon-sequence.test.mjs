// Live end-to-end for the recon TOOL CHAIN the Sonnet agent drives. We cannot invoke
// Claude from node, but we CAN prove the tools the agent calls compose correctly on a
// real browser: baseline → frontier-cli emit → whats-new act → observe. The judgment
// itself (which/what/how-dangerous) is a prompt, guarded elsewhere by dangerFloor +
// human inspection — never asserted here as "the agent said something".
//
// Guards: the recon tool chain persists BOTH the causal edge (whats-new) AND the
//   semantic annotation (observe) for the acted template, and observing it DRAINS it
//   from the frontier — so the agent makes honest forward progress over one graph.
// FAIL-ON-REVERT: drop `markExplored` in observe.mjs → frontier-cli still emits Search
//   after it was observed → "observed template not drained from the frontier".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/search-app/server.mjs';
import { run as whatsNew } from '../../lib/recon/whats-new.mjs';
import { emit } from '../../lib/recon/frontier-cli.mjs';
import { observe } from '../../lib/recon/observe.mjs';

test('recon tool chain: baseline → emit → act → observe composes on a live page', async (t) => {
  const server = await start(0);
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-seq-'));
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

  // 1. baseline — seed the frontier with the initially-present controls.
  await whatsNew({ url });

  // 2. emit — the agent's receptive field; find the Search button in it.
  const batch = emit().batch;
  const search = batch.find((b) => b.name === 'Search');
  assert.ok(search, 'Search must be in the emitted frontier batch');

  // 3. act — the existing causal step persists the #search -> GET /api/search edge.
  const acted = await whatsNew({ url, actTemplate: search.templateId, fill: 'hello' });
  assert.ok(
    acted.acted.requests.some((r) => r.urlPattern === '/api/search?q=:param'),
    'acting on Search must cause GET /api/search',
  );

  // 4. observe — record the semantics and mark explored (agent path).
  const obs = observe({
    template: search.templateId, purpose: 'runs a search query', danger: 'safe', effect: 'reveal',
  });
  assert.equal(obs.explored, true);

  // The graph carries BOTH the causal edge AND the semantic annotation.
  const graph = JSON.parse(readFileSync(path.join(stateDir, 'graph.json'), 'utf8'));
  const node = graph.elements[search.templateId];
  assert.equal(node.semantics.effect, 'reveal', 'observe persisted the semantic annotation');
  assert.equal(node.explored, true);
  const edge = graph.edges.find((e) => e.to === 'request:GET /api/search?q=:param' && e.provenance === 'causal');
  assert.ok(edge, 'the causal search edge is still present alongside the semantics');

  // Observing drains Search from the frontier — forward progress.
  assert.ok(
    !emit().batch.some((b) => b.templateId === search.templateId),
    'observed template not drained from the frontier',
  );
});
