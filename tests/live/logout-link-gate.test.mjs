// Live proof of the click-time DANGER-ROUTE href gate (security H1) in step.mjs actStep. The name-floor
// only sees a control's NAME, so an ICON-ONLY same-origin <a href="/logout"> (empty accessible name) passes
// it and, as a plain GET link, would NAVIGATE the browser to /logout on click — ending an authed session
// with no click the name gate ever catches. The gate must refuse the click on the href's ROUTE instead.
// Driven through whats-new (the /recon agent path) against a real chromium + fixture — and crucially with
// NO authentication / --read-only, proving this gate protects EVERY path, independent of the write-firewall.
//
// Guards: actStep refuses to CLICK a same-origin link whose href is a danger route (DANGER_FLOOR before the
//   click), so an icon-only /logout / .../delete anchor cannot navigate/destroy on ANY actStep caller.
// FAIL-ON-REVERT: remove the `if (href && routeRefused(routeKey(href)))` gate in lib/recon/step.mjs → acting
//   the icon-only anchor no longer rejects (whats-new resolves) AND the click navigates → GET /logout fires →
//   logoutHits() becomes 1 → both "acting on an icon-only danger link must reject" and "no /logout navigation
//   may fire" go red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/logout-link-app/server.mjs';
import { run as whatsNew } from '../../lib/recon/whats-new.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';

test('the fire path refuses to click an icon-only same-origin link to a danger route, and never navigates to it', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-logout-link-'));
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

  // Baseline seeds the graph with the icon-only anchor (role 'link', empty name) + the benign button.
  await whatsNew({ url });
  const graph = loadGraph(path.join(stateDir, 'graph.json'));
  const link = Object.values(graph.elements).find((n) => n.role === 'link');
  assert.ok(link, 'the icon-only <a href="/logout"> was discovered as a link template');
  // The name-floor missed it: it has no accessible name, so it is NOT in the always-refused danger set.
  assert.ok(!link.name, 'the anchor has an empty accessible name (the name-floor cannot classify it)');

  // Acting it must be REFUSED before the click by the href-route gate — the whole point of H1.
  await assert.rejects(
    () => whatsNew({ url, actTemplate: link.templateId }),
    (err) => err?.envelope?.code === 'DANGER_FLOOR',
    'acting on an icon-only danger link must reject with DANGER_FLOOR (the href route, not the name)',
  );

  // And the browser never navigated to /logout: the gate stopped the click, not merely the record.
  assert.equal(server.logoutHits(), 0, 'no /logout navigation may fire for a refused icon-only danger link');
});
