// Live end-to-end for the Phase-1 loop-driver. Boots the search fixture and runs the
// real recon loop (baseline → cold-start browser step per act → reconLoop) against
// it. Proves the loop COMPOSES the frontier + causal capture into one graph: it
// drives a real browser, attributes the caused request to the right control, drains
// the frontier, and honestly cannot reach controls behind in-app state (cold-start).
//
// Guards: the loop, driving a real browser, persists the causal search edge to the
//   graph (#search --triggers--> GET /api/search, provenance causal); leaves the
//   load-burst /api/config and background poll /api/ping UNcredited (no request nodes);
//   discovers the revealed Edit template; terminates by draining the frontier; and keeps
//   the denominator HONEST — the cold-start-unreachable Edit is counted as `unreachable`,
//   NOT as explored. This is what the unit tests (fake step) and the keystone (single
//   manual act) do NOT prove: that these COMPOSE against a live browser.
// FAIL-ON-REVERT: (a) remove `addTrigger(graph, tid, req)` in lib/recon/step.mjs — the
//   loop no longer persists the causal edge → "loop must persist the causal search edge"
//   (graph.edges empty); (b) drop `markUnreachable` in lib/recon/recon-loop.mjs → Edit
//   counts as explored → stats.unreachable is 0, the unreachable assertion fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/search-app/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';

test('recon loop: drives a real browser, attributes the caused edge, drains the frontier', async (t) => {
  const server = await start(0);
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-loop-'));
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

  const res = await crawl({ url, steps: 6 });
  assert.equal(res.ok, true);
  assert.ok(res.baseline.total >= 2, `expected >=2 initial controls, got ${res.baseline.total}`);

  // The loop terminated by draining the frontier. The denominator is HONEST: the input
  // and Search were genuinely explored, while the revealed Edit button — unreachable on
  // a cold-start reload — is counted as `unreachable`, NOT as covered.
  assert.equal(res.stopped, 'frontier-drained', `loop should drain, got ${res.stopped}`);
  assert.equal(res.stats.remaining, 0, 'frontier drained');
  assert.equal(res.stats.unreachable, 1, 'cold-start-unreachable Edit is flagged, not counted as explored');
  assert.equal(res.stats.explored, 2, 'only the two genuinely-reached controls count as explored');

  // Inspect the graph the loop built.
  const graph = JSON.parse(readFileSync(path.join(stateDir, 'graph.json'), 'utf8'));

  // The causal edge is rooted at the Search button, persisted by the loop.
  const edge = graph.edges.find((e) => e.to === 'request:GET /api/search?q=:param' && e.provenance === 'causal');
  assert.ok(edge, 'loop must persist the causal search edge');
  const fromTid = Number(edge.from.replace('element:', ''));
  assert.equal(graph.elements[fromTid].name, 'Search', 'edge rooted at the Search button, not the input or a poll');

  // Only the CAUSED request became a node — /api/search. The load-burst /api/config
  // and background poll /api/ping did not, through the whole loop. NOTE: the cold-start
  // window is short, so /api/ping may never tick inside it — this asserts COMPOSITION,
  // not the initiator classifier itself; the initiator's in-window-poll hard case is
  // proven in tests/live/whats-new.test.mjs (which forces the tick).
  assert.deepEqual(
    Object.keys(graph.requests),
    ['GET /api/search?q=:param'],
    'only the click-caused request is recorded; config/ping stay uncredited',
  );

  // The search action revealed the Edit button template (new elements enter the graph).
  const editEl = Object.values(graph.elements).find((e) => e.name === 'Edit');
  assert.ok(editEl, 'search action revealed the Edit button template');
  assert.ok(editEl.instances.length >= 1, 'revealed Edit template carries row instances');
});
