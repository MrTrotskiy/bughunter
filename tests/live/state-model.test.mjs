// Live proof of the STATE MODEL / per-instance opener DFS on a CONSTANT-URL SPA (decisions.md
// 2026-07-15 "whole-site reach") — the reach the depth-1 slice could not deliver on rawcaster.
// A crawl of the state-app fixture (URL never changes; nav = 3 instances of ONE template, each
// swapping content client-side) must walk EVERY nav instance and follow a depth-2 reveal chain.
//
// Guards:
//   (a) PER-INSTANCE OPENER — the nav template has 3 instances (Alpha/Beta/Gamma); acting the first
//       flags it an opener, so the frontier walks ALL THREE, not just instance[0]. All 3 explored.
//   (b) INSTANCE-LEVEL REVEAL — the control revealed by Alpha and the one revealed by Beta are two
//       INSTANCES of ONE template, each carrying a DISTINCT reveal path (the instance-not-template
//       gap: the template-level stamp gave only the first a reveal; the instance-level stamp gives both).
//   (c) DEPTH-2 REACH — Save (revealed by Create, itself revealed by Gamma) is genuine coverage with
//       a 2-hop reveal path [Gamma, Create], and its GET /save is causally attributed at depth-2.
//   (d) CAUSAL SURVIVAL AT DEPTH-2 — the background GET /api/poll is attributed to NOTHING (pollHits>0
//       liveness; the rigorous in-window proof lives in stay-on-page.test.mjs).
//   (e) MUTATION GATE AT DEPTH — "Chosen", revealed by the POST /choose (mutation) opener, gets NO
//       reveal path on the node loop and stays honestly unreachable (never replayed).
// FAIL-ON-REVERT:
//   (a) revert frontier.nextBatch to template-level (only instance[0]) → Beta/Gamma never acted →
//       their controls never discovered → (a) count < 3 and Create/Save absent.
//   (b) revert the mergeSnapshot instance-level `inst.reveal` stamp → the second act-instance has no
//       reveal → (b)'s "two distinct reveals" goes red.
//   (c) drop the markOpener call in step.mjs → the nav never becomes an opener → siblings unwalked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/state-app/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';

const find = (graph, name) => Object.values(graph.elements).find((n) => n.name === name);

test('state model: per-instance opener DFS walks every nav instance and a depth-2 reveal chain', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/app`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-state-model-'));
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

  const res = await crawl({ url, steps: 30 });
  assert.equal(res.ok, true, 'crawl completed');
  const graph = loadGraph(path.join(stateDir, 'graph.json'));

  // (a) PER-INSTANCE OPENER: the nav is ONE template with 3 instances; all three are explored.
  const nav = Object.values(graph.elements).find((n) => n.role === 'button' && n.instances.length === 3);
  assert.ok(nav, 'the nav template (3 instances of one control) exists');
  assert.equal(nav.instances.filter((i) => i.explored).length, 3, 'all 3 nav instances were walked (per-instance opener), not just instance[0]');

  // (b) INSTANCE-LEVEL REVEAL: the act control revealed by Alpha and by Beta are two instances of
  // one template, each with a DISTINCT reveal path (distinct opening nav instance).
  const actNode = find(graph, 'Alpha detail');
  assert.ok(actNode, 'the revealed act control template exists');
  assert.equal(actNode.instances.length, 2, 'Alpha and Beta each revealed a distinct instance of the act template');
  const reveals = actNode.instances.map((i) => i.reveal && i.reveal.statePath && i.reveal.statePath[0] && i.reveal.statePath[0].instanceKey);
  assert.ok(reveals.every(Boolean), 'both act instances carry an instance-level reveal path');
  assert.notEqual(reveals[0], reveals[1], 'the two instances carry DISTINCT reveal paths (opened by different nav instances)');

  // (c) DEPTH-2 REACH + causal attribution at depth-2.
  const save = find(graph, 'Save');
  assert.ok(save, 'the depth-2 Save control (Gamma -> Create -> Save) was discovered');
  assert.ok(save.explored && !save.unreachable, 'Save is genuine coverage, reached by replaying the 2-hop path');
  assert.equal(save.reveal.statePath.length, 2, 'Save carries a 2-hop reveal path [Gamma, Create]');
  assert.ok(graph.requests['GET /save'], 'the /save request node exists');
  assert.ok(
    graph.edges.some((e) => e.from === `element:${save.templateId}` && e.to === 'request:GET /save'),
    'GET /save is causally attributed to Save at depth-2',
  );

  // (d) CAUSAL SURVIVAL AT DEPTH-2: the background poll is credited to nothing.
  assert.equal(graph.requests['GET /api/poll'], undefined, 'the background poll is never a request node');
  assert.ok(!graph.edges.some((e) => e.to === 'request:GET /api/poll'), 'no control is credited the background poll');
  assert.ok(server.pollHits() >= 2, `the poll fired during the crawl (liveness, got ${server.pollHits()})`);

  // (e) MUTATION GATE AT DEPTH: Chosen, revealed by the POST /choose opener, stays unreachable.
  const chosen = find(graph, 'Chosen');
  assert.ok(chosen, 'the POST-opened Chosen control was discovered');
  assert.ok(chosen.unreachable, 'Chosen stays unreachable (a mutation opener child is never replayed on the node loop)');
});
