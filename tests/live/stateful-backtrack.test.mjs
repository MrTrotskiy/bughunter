// Live proof of the STATEFUL BACKTRACKING driver (stateful-loop.mjs) — the operator's in-session walk
// with PER-LOCATION memory. On /a the greedy driver acts cA1 then follows the /b nav (LEAVING cA2
// unexplored), drains cB on /b, and ONLY a BACKTRACK navigation back to /a finishes cA2 — /b carries no
// link home, so nothing but the driver's own cross-page move reaches cA2. Every caused request is
// causally attributed at its own route; the background poll is never credited even ticking in-window.
//
// Guards (one crawl):
//   (a) FULL DRAIN — cA1, cA2, AND cB are all explored (not unreachable); the loop terminated frontier-drained.
//   (b) CAUSAL ATTRIBUTION — GET /api/a1→cA1, POST /api/a2→cA2, GET /api/b→cB are all causal edges.
//   (c) NON-VACUOUS BACKTRACK — cA2 (/api/a2) fired AFTER cB (/api/b): finishing it REQUIRED returning to /a.
//   (d) CAUSAL CLEANLINESS — the /api/poll background poll (ticking inside cA2's slow window) is never credited.
//
// FAIL-ON-REVERT: neuter the backtrack in stateful-loop.mjs — force the backtrack pick to null (drain the
//   CURRENT page only), e.g. replace the `next = routesWithWork(...)` line with `const next = null;`.
//   cA2 is then stranded on /a (the greedy walk left it for the /b nav and never returns) → it stays
//   unexplored → guard (a) "cA2 was explored" goes red. Restore to green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/backtrack-app/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';

test('stateful driver backtracks in-session to finish a page left unfinished, attributing every caused request', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/a`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-backtrack-'));
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

  // This fixture is a TRUSTED target: cA2 fires a benign POST /api/a2 (no write verb) which the read-only
  // WRITE-FIREWALL (default-ON for --stateful) now ABORTS by default (the CTO blocker-1 inversion). This test
  // guards BACKTRACKING, not the firewall, so --allow-benign-post restores the benign-POST reach (the operator
  // override) — the write-verb gate still aborts an obvious mutation, so the safety of the default is intact.
  const res = await crawl({ url, steps: 20, stateful: true, allowBenignPost: true });
  assert.equal(res.ok, true, 'stateful crawl completed');
  assert.equal(res.stopped, 'frontier-drained', 'the loop drained every route (no stall / budget stop)');

  const graph = loadGraph(path.join(stateDir, 'graph.json'));
  const cA1 = Object.values(graph.elements).find((n) => n.name === 'Action A1');
  const cA2 = Object.values(graph.elements).find((n) => n.name === 'Action A2');
  const cB = Object.values(graph.elements).find((n) => n.name === 'Action B');
  assert.ok(cA1 && cA2 && cB, 'all three controls were discovered');
  assert.equal(cA2.route, '/a', 'cA2 is attributed to /a');
  assert.equal(cB.route, '/b', 'cB is attributed to /b (reached by the nav act)');

  // (a) FULL DRAIN — every control genuine coverage, none marked unreachable.
  for (const [nm, n] of [['cA1', cA1], ['cA2', cA2], ['cB', cB]]) {
    assert.ok(n.explored, `${nm} was explored`);
    assert.ok(!n.unreachable, `${nm} is genuine coverage, not unreachable`);
  }

  // (b) CAUSAL ATTRIBUTION — each caused request is a causal edge from its control.
  const edge = (n, key) => graph.edges.some((e) => e.from === `element:${n.templateId}` && e.to === `request:${key}`);
  assert.ok(graph.requests['GET /api/a1'] && edge(cA1, 'GET /api/a1'), 'GET /api/a1 is attributed to cA1');
  assert.ok(graph.requests['POST /api/a2'] && edge(cA2, 'POST /api/a2'), 'POST /api/a2 is attributed to cA2');
  assert.ok(graph.requests['GET /api/b'] && edge(cB, 'GET /api/b'), 'GET /api/b is attributed to cB');

  // (c) NON-VACUOUS BACKTRACK — cA2 fired AFTER cB, so finishing it REQUIRED returning to /a.
  const order = server.order();
  assert.ok(order.includes('a2') && order.includes('b'), `both a2 and b fired (order: ${order.join(',')})`);
  assert.ok(order.indexOf('a2') > order.indexOf('b'), `cA2 (a2) fired AFTER cB (b): ${order.join(',')}`);

  // (d) CAUSAL CLEANLINESS — the background poll is never credited (even ticking inside cA2's slow window).
  assert.equal(graph.requests['GET /api/poll'], undefined, 'the background poll is not a request node');
  assert.ok(!graph.edges.some((e) => e.to === 'request:GET /api/poll'), 'no control is credited the background poll');
  assert.ok(server.pollHits() >= 2, `the poll must have fired during the crawl (got ${server.pollHits()})`);
});
