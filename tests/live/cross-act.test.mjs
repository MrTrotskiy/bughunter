// Live guard for the REUSED-PAGE causal path (recon-run persistentStep). The initiator
// tracker lives for the page's whole lifetime and its per-path verdicts are STICKY
// (a path ever click-rooted is "foreground" forever). On a reused page re-navigated per
// act, that let an EARLIER act's click on a path suppress the timer-rejection of a LATER
// act's same-path BACKGROUND poll — forging a phantom causal edge. This is the exact
// mechanism that killed bughunt-agents, re-introduced by page reuse; persistentStep must
// clear the verdicts between acts (resetTrackerVerdicts).
//
// The cross-act fixture makes /api/shared BOTH clicked (#a) AND polled, and #b's request
// responds slowly so a poll DETERMINISTICALLY ticks inside #b's window.
//
// Guards: on a reused page, an earlier act's foreground path does NOT get a later act's
//   same-path background poll mis-attributed to it — no phantom causal edge.
// FAIL-ON-REVERT: drop `resetTrackerVerdicts(page)` in persistentStep (recon-run.mjs) OR
//   neuter `reset()` in initiator.mjs → /api/shared (foreground via #a) leaks into #b's
//   window → a causal edge "Load other" → GET /api/shared appears →
//   "no phantom cross-act poll edge on Load other" fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/cross-act-app/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';

test('reused page: an earlier act\'s foreground path is not mis-credited to a later act', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-xact-'));
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

  const graph = JSON.parse(readFileSync(path.join(stateDir, 'graph.json'), 'utf8'));
  const entry = (name) => Object.entries(graph.elements).find(([, e]) => e.name === name);
  const aEntry = entry('Load shared');
  const bEntry = entry('Load other');
  assert.ok(aEntry && bEntry, 'both buttons were discovered and acted on');
  const [aId] = aEntry;
  const [bId] = bEntry;
  const edgesFrom = (id) => graph.edges
    .filter((e) => e.from === `element:${id}` && e.provenance === 'causal')
    .map((e) => e.to);

  // Both paths genuinely fired during the crawl (so the guard is not vacuous on absence).
  assert.ok(Object.keys(graph.requests).includes('GET /api/shared'), '/api/shared fired at least once');
  assert.ok(Object.keys(graph.requests).includes('GET /api/other'), '/api/other fired');

  // #a legitimately caused /api/shared; #b legitimately caused /api/other.
  assert.ok(edgesFrom(aId).includes('request:GET /api/shared'), 'Load shared → /api/shared (its real click)');
  assert.ok(edgesFrom(bId).includes('request:GET /api/other'), 'Load other → /api/other (its real click)');

  // THE GUARD: the background /api/shared poll ticking inside #b's window must NOT be
  // credited to #b, even though #a made /api/shared foreground earlier on the same page.
  assert.ok(
    !edgesFrom(bId).includes('request:GET /api/shared'),
    'no phantom cross-act poll edge on Load other',
  );
});
