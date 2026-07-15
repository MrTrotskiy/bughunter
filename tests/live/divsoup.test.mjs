// Live proof of role-less "div-soup" capture (dom-snapshot.mjs). Modern SPAs bind clicks to
// <div>/<span> via addEventListener with no role/tag the SEL pass matches; we capture them by
// computed `cursor: pointer`, gated for safety + noise. Crawl the divsoup-app via the NODE loop
// (deterministic, no LLM) and assert every gate.
//
// Guards:
//   (a) CAPTURE + ATTRIBUTION — the named cursor:pointer div "Ace" (role-less, no href/role) is a
//       genuine control and its addEventListener GET /profile is causally attributed to it.
//   (b) NAME-GATE — the UNNAMED pointer icon is NOT captured (no template anchors on `.icon-nameless`):
//       an unnamed div cannot be danger-judged, so it is honestly uncaptured, never blind-clicked.
//   (c) WRAPPER-SKIP — the pointer div WRAPPING a real <button> is skipped; the <button> (name
//       "Real Button", role=button) is the one captured — no duplicate role-less twin.
//   (d) OUTERMOST-POINTER — the ".card" container is captured; its inner pointer-inheriting span is
//       dropped (no template anchors on `.card-icon`).
//   (e) CAUSAL SURVIVAL — the background GET /api/poll is attributed to nothing.
// FAIL-ON-REVERT: delete the role-less pass in dom-snapshot.mjs collect() (the
//   `for (const el of document.querySelectorAll('*'))` block that pushes cursor:pointer elements) →
//   "Ace" is never captured, GET /profile earns no control edge → (a) goes red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/divsoup-app/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';

test('div-soup: a named cursor:pointer div is captured + causally attributed; the gates hold', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/app`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-divsoup-'));
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

  const res = await crawl({ url, steps: 20 });
  assert.equal(res.ok, true, 'crawl completed');
  const graph = loadGraph(path.join(stateDir, 'graph.json'));
  const nodes = Object.values(graph.elements);
  const sel = (n) => n.templateSelector || '';

  // (a) CAPTURE + ATTRIBUTION: the role-less "Ace" connection div is a control, GET /profile is its edge.
  const ace = nodes.find((n) => n.name === 'Ace');
  assert.ok(ace, 'the named cursor:pointer div "Ace" was captured (role-less)');
  assert.equal(ace.role, 'generic', 'a role-less div keeps role=generic (honest — no declared role)');
  assert.ok(graph.requests['GET /profile?u=:param'], 'the /profile request node exists');
  assert.ok(
    graph.edges.some((e) => e.from === `element:${ace.templateId}` && e.to === 'request:GET /profile?u=:param'),
    'GET /profile is causally attributed to the role-less "Ace" div',
  );

  // (b) NAME-GATE: the unnamed pointer icon is honestly uncaptured (never blind-clickable).
  assert.ok(!nodes.some((n) => sel(n).includes('icon-nameless')), 'the UNNAMED pointer icon is not captured');

  // (c) WRAPPER-SKIP: the real <button> is captured; the pointer wrapper div is not a duplicate.
  const realButtons = nodes.filter((n) => n.name === 'Real Button');
  assert.equal(realButtons.length, 1, 'exactly one "Real Button" node (the <button>, not the wrapper div)');
  assert.equal(realButtons[0].role, 'button', 'the captured "Real Button" is the real <button> (role=button)');

  // (d) OUTERMOST-POINTER: the card is captured; its inner pointer-inheriting span is dropped.
  assert.ok(nodes.some((n) => n.name === 'Open card'), 'the outermost ".card" pointer div is captured');
  assert.ok(!nodes.some((n) => sel(n).includes('card-icon')), 'the inner ".card-icon" span (pointer ancestor) is dropped');

  // (e) CAUSAL SURVIVAL: the background poll is credited to nothing.
  assert.equal(graph.requests['GET /api/poll'], undefined, 'the background poll is never a request node');
  assert.ok(!graph.edges.some((e) => e.to === 'request:GET /api/poll'), 'no control is credited the background poll');
  assert.ok(server.pollHits() >= 2, `the poll fired during the crawl (liveness, got ${server.pollHits()})`);
});
