// Live proof of the MENU-EVENT SWEEP (event-driven in-app-nav, the Phase-1 close increment): on a
// CONSTANT-URL SPA whose sections are href-less onClick controls inside a <nav> landmark, the frontier
// IDENTIFIES those controls (node.navControl) and FRONT-LOADS them over an equally-eligible non-nav
// control, so the agent hydrates + collects each section by clicking its nav opener — and the section
// child is reachable from a cold re-nav via the already-built reveal-replay (no graph.states{} needed).
//
// Guards:
//   (A) IDENTIFICATION — a control inside <nav>/[role=navigation] is stamped node.navControl; a control
//       in <main> is NOT. Additive landmark signal (mirrors node.listRow), never an identity input.
//   (B) PRIORITY — frontier-cli --emit LEADS with the nav controls; the equally-eligible non-nav control
//       ("Refresh feed") is deferred until the nav sweep drains. This is the sweep: sections first.
//   (C) REACH + ATTRIBUTION — acting a nav opener (openerReplayable, since its section-load is a POST-read)
//       reveals the section child and attributes POST /api/section/groups to the nav control; the child's
//       own GET is attributed after a cold reveal-replay; the 150ms in-window /api/poll is NEVER credited.
// FAIL-ON-REVERT:
//   (A) drop `inNav` in dom-snapshot.mjs (or the `node.navControl` stamp in graph-store.mjs mergeSnapshot)
//       → navControl never set → assertion "nav-groups.navControl === true" red.
//   (B) revert frontier-cli.emit to `nextBatch` unconditionally (drop the navBatch lead) → the batch is
//       templateId-ordered and includes "Refresh feed" among the first controls → assertion "the non-nav
//       control is NOT in the sweep batch" red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/menu-nav-app/server.mjs';
import { run } from '../../lib/recon/whats-new.mjs';
import { emit } from '../../lib/recon/frontier-cli.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';

function withEnv(t) {
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-menu-sweep-'));
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

test('menu-sweep: nav-landmark controls are identified, front-loaded, and collect their section', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = withEnv(t);
  const graphFile = path.join(stateDir, 'graph.json');
  t.after(() => server.close());

  // 1. Baseline seeds the constant-URL /dashboard: two <nav> section openers + one <main> control.
  await run({ url });
  let graph = loadGraph(graphFile);
  const navGroups = find(graph, 'Groups');
  const navEvents = find(graph, 'Events');
  const plain = find(graph, 'Refresh feed');
  assert.ok(navGroups && navEvents, 'both <nav> section openers discovered at baseline');
  assert.ok(plain, 'the non-nav <main> control discovered at baseline');

  // (A) IDENTIFICATION — landmark/ARIA-role containment stamps node.navControl on the nav controls only.
  assert.equal(navGroups.navControl, true, 'nav-groups (in a <nav> landmark) is stamped navControl');
  assert.equal(navEvents.navControl, true, 'nav-events (a div[role=tab] in a [role=tablist], the first-target shape) is stamped navControl');
  assert.notEqual(plain.navControl, true, 'the <main> control is NOT stamped navControl');

  // (B) PRIORITY — the emit batch LEADS with the nav controls; the non-nav control is deferred.
  const e = emit({ size: 5 });
  const batchNames = e.batch.map((b) => b.name);
  assert.ok(batchNames.includes('Groups') && batchNames.includes('Events'), 'the sweep batch surfaces both nav openers');
  assert.ok(!batchNames.includes('Refresh feed'), 'the non-nav control is NOT in the sweep batch (nav swept first)');

  // (C) REACH + ATTRIBUTION — act the nav opener as a read (its section-load is a POST). It reveals the
  //     section child and attributes the section-load POST to the nav control.
  await run({ url, actTemplate: navGroups.templateId, openerReplayable: true });
  graph = loadGraph(graphFile);
  const child = find(graph, 'Open groups');
  assert.ok(child, 'the section child (#groups-item) was revealed by the nav opener');
  assert.ok(
    graph.edges.some((x) => x.from === `element:${navGroups.templateId}` && x.to === 'request:POST /api/section/groups'),
    'the section-load POST is causally attributed to the nav opener',
  );
  assert.deepEqual(
    child.reveal && child.reveal.statePath,
    [{ templateId: navGroups.templateId, instanceKey: navGroups.instances[0].instanceKey }],
    'the section child carries the nav opener as its reveal path (replayable from cold)',
  );

  // Act the child via a fresh (cold) invocation → applyReveal replays the nav click → the child's own
  // GET is attributed to it; the replayed opener POST and the in-window poll are not credited to it.
  await run({ url, actTemplate: child.templateId });
  graph = loadGraph(graphFile);
  assert.ok(
    graph.edges.some((x) => x.from === `element:${child.templateId}` && x.to === 'request:GET /api/groupsinfo'),
    'the section child GET is causally attributed after cold reveal-replay',
  );
  // Sanity (NOT the hard-case proof): this increment adds no causal path, so no control should sprout a
  // spurious edge to the background poll. The adversarial in-window RACE (raw ring would-miscredit, causal
  // drops it) is owned by the causal tests (whats-new / cross-act / ws- / sse-), not re-proven here.
  assert.ok(
    !graph.edges.some((x) => x.to === 'request:GET /api/poll'),
    'the background poll is not credited to any control (the sweep introduces no spurious attribution)',
  );
});
