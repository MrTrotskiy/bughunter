// Live proof of the PORTAL-MENU IDENTITY fix (INC.2; decisions.md 2026-07-18). A body-portal dropdown
// (Ant Design `.ant-dropdown-menu-item`, shared by Radix/MUI/HeadlessUI) mounts its items into a BARE
// <body>-child div DETACHED from the trigger. Under the OLD identity model buildPath emits the IDENTICAL
// structural templateSelector for every action and rowKey()===null forces an open-order `#N` key, so
// Delete/Edit/Share/Block/Report/Fan ALL collapse onto ONE template and different actions COLLIDE on the
// same `#N` (Share-Link#1 == Edit#1) — mergeSnapshot's key-dedup then DROPS the loser, lumping N endpoints
// on one connectome node. The fix folds the menuitem's NAME into the TEMPLATE selector only.
//
// Guards: portal-menu action identity — detached body-portal menuitems get distinct templates (name folded)
// + no positional `#N` collision; the name normalization (count-badge strip, value-enum) and end-to-end reach.
// FAIL-ON-REVERT: revert templateSelectorOf's `@menu(...)` fold → every menuitem shares one templateId and
// the distinct-template + no-collision assertions below fail; the count-badge stability + value-enum +
// reveal-reach assertions pin the normalization and the end-to-end reach.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/portal-menu-multi-app/server.mjs';
import { run } from '../../lib/recon/whats-new.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';

const menuitems = (graph) => Object.values(graph.elements).filter((n) => n.role === 'menuitem');
const byName = (graph, name) => menuitems(graph).find((n) => n.name === name);
const moreInstance = (graph, dataId) => {
  const more = Object.values(graph.elements).find((n) => n.name === 'More');
  return { more, key: more.instances.find((i) => i.instanceKey === `data-id:${dataId}`)?.instanceKey };
};

test('portal-menu identity: distinct-name menuitems get distinct templates, collisions gone, names stable, reachable', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-portalmulti-'));
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  const graphFile = path.join(stateDir, 'graph.json');
  t.after(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });

  // Baseline: two `.more` "…" triggers (instances of ONE template, keyed by their card's data-id), no menu yet.
  await run({ url });
  let graph = loadGraph(graphFile);
  assert.equal(menuitems(graph).length, 0, 'no portal menuitems in the DOM while every menu is closed');
  const { more, key: ownKey } = moreInstance(graph, 'own');
  assert.ok(more && ownKey, 'the "…" opener is discovered with a stable per-card instance key');

  // Act the OWN post's "…": GET /menu-open is a read → the opener act STAMPS a reveal path onto the revealed
  // menuitems. Own menu = Edit / Delete / Share Link → each must become its OWN template (name folded).
  await run({ url, actTemplate: more.templateId, instance: ownKey });
  graph = loadGraph(graphFile);
  const edit = byName(graph, 'Edit');
  const del = byName(graph, 'Delete');
  const share = byName(graph, 'Share Link');
  assert.ok(edit && del && share, 'Edit, Delete and Share Link were all captured (none dropped by key-collision)');
  const ids = new Set([edit.templateId, del.templateId, share.templateId]);
  assert.equal(ids.size, 3, 'the three distinct actions are three DISTINCT templates (name folded), not one collapsed template');
  assert.match(edit.templateSelector, /@menu\(edit\)$/, 'Edit template carries its name discriminator');
  assert.match(del.templateSelector, /@menu\(delete\)$/, 'Delete template carries its name discriminator');
  assert.match(share.templateSelector, /@menu\(share link\)$/, 'Share Link template carries its name discriminator');

  // Act the OTHER post's "…": Share Link / Block User / Report Abuse / Become a Fan (N) / My Events.
  const otherKey = moreInstance(graph, 'other').key;
  await run({ url, actTemplate: more.templateId, instance: otherKey });
  graph = loadGraph(graphFile);
  // Share Link is the SAME action → SAME template across both menus (folded name is identical).
  assert.equal(byName(graph, 'Share Link').templateId, share.templateId, 'Share Link is ONE template across both menus (same folded action)');
  // COLLISION GUARD: Delete (own) and Block User (other) both sat at open-order position #2 → under the old
  // model they would share instanceId #2 and one would be dropped. With the fold each is its own instance.
  const block = byName(graph, 'block Block User');
  assert.ok(block, 'Block User survived (own menu already held a template at its old #N slot)');
  assert.notEqual(del.instances[0].instanceId, block.instances[0].instanceId, 'Delete and Block User are DISTINCT instances (positional collision gone)');
  // value-enum fold: My Events carries value="MY_EVENTS" → folds from the enum, not the visible text.
  assert.match(byName(graph, 'My Events').templateSelector, /@menu\(my_events\)$/, 'a semantic value enum folds the template, not the visible label');

  // Count-badge STABILITY: re-open the other menu (fan count grows 12→13). The stripped name must keep ONE
  // "Become a Fan" template — a per-render count in the key would mint a new template every open (explosion).
  const fanTemplatesBefore = menuitems(graph).filter((n) => /become a fan/i.test(n.name)).length;
  await run({ url, actTemplate: more.templateId, instance: otherKey });
  graph = loadGraph(graphFile);
  const fanTemplatesAfter = menuitems(graph).filter((n) => /become a fan/i.test(n.name)).length;
  assert.equal(fanTemplatesBefore, 1, 'exactly one Become-a-Fan template after the first open');
  assert.equal(fanTemplatesAfter, 1, 'STILL one Become-a-Fan template after re-open with a grown count — the badge is stripped, no per-render explosion');

  // REACH end-to-end: a cold whats-new act on Share Link REPLAYS its stamped reveal path ([own "…"]),
  // re-opens the dropdown, and the durable role-name locator resolves it despite the positional selector
  // going stale → its GET /share is causally attributed (genuine coverage, not NO_INSTANCE-unreachable).
  const shareNow = byName(graph, 'Share Link');
  const acted = await run({ url, actTemplate: shareNow.templateId, instance: shareNow.instances[0].instanceKey });
  assert.ok(acted.acted, 'the portal menuitem was reached + acted via reveal-replay (not NO_INSTANCE)');
  assert.ok((acted.acted.requests || []).some((r) => /\/share/.test(r.urlPattern)), 'acting Share Link caused GET /share (genuine coverage)');
  assert.ok(!(acted.acted.requests || []).some((r) => /\/poll/.test(r.urlPattern)), 'the 120ms background /poll is never causally credited to the measured act');
});
