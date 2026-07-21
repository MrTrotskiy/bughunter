// Live proof of the ANTD WIDGET DURABLE LOCATOR (CLASS 2 — the biggest real-coverage NO_INSTANCE fix).
// An antd Select's inner <input> is bare: no testid, no stable id, empty role/name — so its recorded
// locator is the POSITIONAL css path. When antd re-mounts the widget's internals between reveal and act,
// that path goes stale and resolveHandle returns null → NO_INSTANCE, and the control is retired unreachable
// even though a user opens it every day. The fix classifies a durable `type:'widget'` locator (the
// `.ant-select-selector` clickable affordance scoped by the form-item LABEL text) and resolves THAT at act
// time, so the select is reached, acted, and its request attributed. Resolving to the clickable also clears
// the click-interception (the display span over the inner input) — one durable locator, two failure classes.
//
// Guards:
//   (a) DURABLE CLASSIFICATION — at baseline the bare antd Select input is classified locator.type
//       'widget' (not the positional css it would otherwise fall to).
//   (b) DURABLE REACH — after a re-mount makes the stored positional selector STALE (page.$ === null,
//       non-vacuous), the select template is EXPLORED, not unreachable.
//   (c) ATTRIBUTION AT THE DURABLE ACT — GET /api/options (opening the select) is causally attributed to
//       the select template.
//   (d) CAUSAL CLEANLINESS — the in-window /api/poll background tick is never credited (no node, no edge),
//       kept non-vacuous by pollHits.
//
// FAIL-ON-REVERT: in resolve-handle.mjs delete the `loc.type === 'widget'` branch → the bare input has no
//   testid/id/role-name/label/text handle → resolveHandle null → actStep NO_INSTANCE → statefulLoop marks
//   the select unreachable → guard (b) "explored" / "NOT unreachable" and guard (c) attribution go RED.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/antd-select-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep } from '../../lib/recon/step.mjs';
import { statefulStep } from '../../lib/recon/stateful-step.mjs';
import { statefulLoop } from '../../lib/recon/stateful-loop.mjs';
import { makeGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';

test('an antd Select with a stale positional selector is reached via its durable widget locator and attributed', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-antd-widget-'));
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

  const select = Object.values(graph.elements).find((e) => e.fieldFacts?.kind === 'select' && e.fieldFacts?.label === 'Category');
  assert.ok(select, 'the antd Select was discovered at baseline with fieldFacts.kind "select" and its label');

  // (a) DURABLE CLASSIFICATION — the bare inner input is given the widget locator, not the positional css.
  assert.equal(select.instances[0].locator?.type, 'widget', 'the bare antd Select input is classified locator.type "widget"');
  const storedSel = select.instances[0].instanceSelector;

  // Re-mount the select's inner subtree AFTER baseline so the stored positional selector goes stale.
  await page.evaluate(() => window.__reshuffle());

  // NON-VACUOUS: the stored positional selector no longer resolves, while the durable label-scoped
  // `.ant-select-selector` still does.
  assert.equal(await page.$(storedSel), null, 'the stored positional selector for the antd input is STALE after re-mount');
  const liveClickable = await page.locator('.ant-form-item').filter({ has: page.getByText('Category', { exact: true }) })
    .locator('.ant-select-selector').elementHandles();
  assert.ok(liveClickable.length >= 1, 'the durable label-scoped .ant-select-selector still resolves live');

  // Drive the stateful loop in place: it picks the select, resolves via the widget locator, acts it.
  const step = statefulStep({ page, origin, baselineUrl: url, ledger });
  const loop = await statefulLoop(graph, { page, origin, ledger, step, budget: { steps: 20 } });
  assert.equal(loop.stopped, 'frontier-drained', 'the stateful walk drained the frontier');

  // (b) DURABLE REACH.
  assert.ok(select.explored, 'the antd Select was explored (reached via the durable widget locator)');
  assert.ok(!select.unreachable, 'the antd Select is genuine coverage, NOT unreachable');

  // (c) ATTRIBUTION AT THE DURABLE ACT — opening the select fires GET /api/options, bound to the control.
  assert.ok(graph.requests['GET /api/options'], 'the options request node exists');
  assert.ok(
    graph.edges.some((e) => e.from === `element:${select.templateId}` && e.to === 'request:GET /api/options'),
    'GET /api/options is causally attributed to the antd Select control',
  );

  // (d) CAUSAL CLEANLINESS — the in-window background poll is never credited.
  assert.equal(graph.requests['GET /api/poll'], undefined, 'the background poll is never a request node');
  assert.ok(!graph.edges.some((e) => e.to === 'request:GET /api/poll'), 'no control is credited the background poll');
  assert.ok(server.pollHits() >= 1, `the poll must have fired during the crawl (got ${server.pollHits()})`);
});
