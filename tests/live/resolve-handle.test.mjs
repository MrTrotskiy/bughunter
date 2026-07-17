// Live proof of DURABLE-LOCATOR act-time resolution (resolve-handle.mjs) — the fix that makes the
// stateful walk actually work on a DYNAMIC page. The fixture feed RE-RENDERS (reshuffle) AFTER the
// baseline snapshot, so the walked representative's stored POSITIONAL nth-child instanceSelector goes
// STALE. A positional-only resolver would throw NO_INSTANCE and retire the control unreachable (stateful
// WORSE than stateless — the live rawcaster smoke drained at 7 vs 31). With durable resolution the control
// is re-located via its role+name locator (a LIVE representative), genuinely explored, its request
// causally attributed, and the honest viaRepresentative marker recorded. The exact-match #refresh (stored
// selector survives) is reached via that selector and is NOT flagged a representative (no over-counting).
//
// Guards:
//   (a) DURABLE REACH — the feed's walked instance[0] (Like Alpha) is explored, NOT unreachable, even
//       though its stored nth-child selector is proven stale (page.$ === null, non-vacuous).
//   (b) ATTRIBUTION AT THE DURABLE ACT — GET /api/like/alpha is causally attributed to the feed template.
//   (c) HONEST MARKER — the acted instance carries viaRepresentative (reached via a live role-name
//       representative, not the exact stored positional handle); report() surfaces it.
//   (d) NO OVER-COUNT — #refresh, whose stored selector survived the reshuffle, is reached via:'selector'
//       and is NOT flagged a representative; a genuinely-gone control with no live representative would
//       stay unreachable (the resolveHandle-null path).
//   (e) CAUSAL CLEANLINESS — the /api/poll background poll ticking inside alpha's (slow) window is never
//       credited (no request node, no edge); pollHits>=2 keeps the guard non-vacuous.
//
// FAIL-ON-REVERT: in resolve-handle.mjs remove the durable-locator branch (b) — after strategy (a),
//   `return null` — so a stale positional selector is the only resolver. Then Like Alpha's stale selector
//   → resolveHandle null → actStep NO_INSTANCE → statefulLoop marks it unreachable → guard (a) "explored"
//   and "NOT unreachable" and guard (c) "viaRepresentative" all go RED.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/resolve-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep } from '../../lib/recon/step.mjs';
import { statefulStep } from '../../lib/recon/stateful-step.mjs';
import { statefulLoop } from '../../lib/recon/stateful-loop.mjs';
import { makeGraph, saveGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger, saveLedger } from '../../lib/graph/ids.mjs';
import { report } from '../../lib/recon/report.mjs';

test('the stateful walk reaches a re-rendered control via its durable locator, attributes it, marks it honestly', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-resolve-'));
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;

  const cold = await launch();
  t.after(async () => {
    await close(cold.browser);
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });

  const page = cold.page;
  const origin = new URL(url).origin;
  const graph = makeGraph();
  const ledger = makeLedger();

  await gotoGated(page, url);
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');

  const byName = (n) => Object.values(graph.elements).find((e) => e.name === n);
  // The three like buttons collapse into ONE template (name = the first instance's text, "Like Alpha");
  // its walked representative is instance[0] = alpha. #refresh is its own single-instance template.
  const feed = byName('Like Alpha');
  const refresh = byName('Refresh feed');
  assert.ok(feed, 'the feed like template was discovered at baseline');
  assert.ok(refresh, 'the standalone Refresh control was discovered at baseline');
  const alphaSel = feed.instances[0].instanceSelector;
  const refreshSel = refresh.instances[0].instanceSelector;

  // Re-render the feed AFTER the baseline snapshot so the stored positional selectors go stale.
  await page.evaluate(() => window.__reshuffle());

  // NON-VACUOUS: the walked representative's stored positional selector is now STALE, while its durable
  // role+name locator still resolves it live, and #refresh's stored selector SURVIVES.
  assert.equal(await page.$(alphaSel), null, 'the stored nth-child selector for the walked feed control is STALE');
  const liveByRole = await page.getByRole('button', { name: 'Like Alpha' }).elementHandles();
  assert.ok(liveByRole.length >= 1, 'the durable role+name locator still resolves the control live');
  assert.ok(await page.$(refreshSel), 'the exact-match #refresh selector survives the reshuffle');

  // Drive the LOCATION-AWARE stateful loop in place (no cold re-nav): drainRoute → resolvesLive uses
  // resolveHandle, so the stale-selector control is picked and acted via its durable representative.
  const step = statefulStep({ page, origin, baselineUrl: url, ledger });
  const loop = await statefulLoop(graph, { page, origin, ledger, step, budget: { steps: 20 } });
  assert.equal(loop.stopped, 'frontier-drained', 'the stateful walk drained the frontier');

  // (a) DURABLE REACH — genuine coverage via the durable locator where the positional selector failed.
  assert.ok(feed.explored, 'the feed control was explored (reached via the durable role+name representative)');
  assert.ok(!feed.unreachable, 'the feed control is genuine coverage, NOT unreachable (durable resolution)');

  // (b) ATTRIBUTION AT THE DURABLE ACT — the representative act binds request→control.
  assert.ok(graph.requests['GET /api/like/alpha'], 'the alpha like request node exists');
  assert.ok(
    graph.edges.some((e) => e.from === `element:${feed.templateId}` && e.to === 'request:GET /api/like/alpha'),
    'GET /api/like/alpha is causally attributed to the feed control',
  );

  // (c) HONEST MARKER — the acted instance is flagged reached-via-representative (not the exact instance).
  assert.equal(feed.instances[0].viaRepresentative, true, 'the acted instance carries the honest representative marker');

  // (d) NO OVER-COUNT — the exact-match control is reached via its surviving selector, NOT a representative.
  assert.ok(refresh.explored, 'the exact-match Refresh control was explored');
  assert.ok(!refresh.instances[0].viaRepresentative, 'Refresh is NOT flagged representative (exact stored selector resolved)');
  assert.ok(
    graph.edges.some((e) => e.from === `element:${refresh.templateId}` && e.to === 'request:GET /api/refresh'),
    'GET /api/refresh is attributed to the Refresh control',
  );

  // (e) CAUSAL CLEANLINESS — the in-window background poll is never credited at the durable act.
  assert.equal(graph.requests['GET /api/poll'], undefined, 'the background poll is never a request node');
  assert.ok(!graph.edges.some((e) => e.to === 'request:GET /api/poll'), 'no control is credited the background poll');
  assert.ok(server.pollHits() >= 2, `the poll must have fired during the crawl (got ${server.pollHits()})`);

  // report() reads the marker (the honesty surface Phase-2 / the operator see).
  saveGraph(path.join(stateDir, 'graph.json'), graph);
  saveLedger(path.join(stateDir, 'element-ids.json'), ledger);
  const rep = report({ json: true });
  const repFeed = rep.routes.flatMap((r) => r.templates).find((tpl) => tpl.templateId === feed.templateId);
  const repRefresh = rep.routes.flatMap((r) => r.templates).find((tpl) => tpl.templateId === refresh.templateId);
  assert.equal(repFeed.viaRepresentative, true, 'report() surfaces the representative marker (honesty input)');
  assert.equal(repRefresh.viaRepresentative, false, 'report() shows the exact-match control is not a representative');
});
