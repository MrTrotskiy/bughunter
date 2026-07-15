// Live proof of INC.1 framework-id de-fragmentation (decisions.md 2026-07-15 "whole-site reach").
// Framework-generated wrapper ids (Ant Design `rc-*`, hashed CSS-in-JS ids) SHIFT across reloads
// and, under the pre-INC.1 identity, anchor each control on its OWN id — so three antd tabs that
// are one logical control fragment into THREE templates, and the reset-and-replay reveal chain
// (which depends on a stable selector across reloads) breaks. INC.1 rejects the framework id as a
// path anchor AND as a sole-locator, so the tabs collapse to ONE structural template with three
// addressable instances, each with a stable role+name locator. This is the identity fix behind the
// antd tabs staying NOT_VISIBLE/NO_INSTANCE on rawcaster.
//
// Guards:
//   (a) DE-FRAGMENTATION — the 3 role=tab controls collapse to ONE template with 3 instances
//       (not 3 one-instance templates), and its selector is structural, not `rc-tabs`-anchored.
//   (b) DURABLE LOCATOR — a tab's locator falls to role+name (stable across reloads), not the
//       shifting framework #id.
//   (c) HASHED-ID BRANCH — a `#btn-<hex>` id does not anchor the selector either.
//   (d) SCOPING (negative control) — a plain SEMANTIC #id (`#save`) STILL anchors + stays the
//       durable locator, proving the rejection is scoped to framework noise, not all ids.
// FAIL-ON-REVERT: drop the `|| isFrameworkNoiseId(id)` clause from isGeneratedId in
//   dom-snapshot.mjs → each tab re-anchors on its own `#rc-tabs-0-tab-*` → 3 separate templates →
//   (a) `tabTemplates.length === 1` and `instances.length === 3` go red. Separately, drop
//   `!isFrameworkNoiseId(id)` from stableIdForLocator → (b) the tab locator reports type 'id'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/framework-id-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep } from '../../lib/recon/step.mjs';
import { makeGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';

test('framework-generated ids de-fragment: 3 antd tabs = ONE template, 3 instances, role+name locator', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-frameworkid-'));
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
  const graph = makeGraph();
  const ledger = makeLedger();
  await gotoGated(page, url);
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');

  // (a) DE-FRAGMENTATION: the three role=tab controls are ONE template with three instances,
  // and its selector is structural (no framework-id anchor).
  const tabTemplates = Object.values(graph.elements).filter((e) => e.role === 'tab');
  assert.equal(tabTemplates.length, 1, 'the 3 antd tabs collapse to ONE template (framework id de-fragmented)');
  assert.equal(tabTemplates[0].instances.length, 3, 'the one tab template has 3 addressable instances');
  assert.ok(
    !/rc-tabs/.test(tabTemplates[0].templateSelector),
    `the tab template selector is structural, not framework-id-anchored (got ${tabTemplates[0].templateSelector})`,
  );

  // (b) DURABLE LOCATOR: a tab's handle is role+name (stable across reloads), not the shifting id.
  assert.equal(tabTemplates[0].locator.type, 'role-name', 'a tab\'s durable locator is role+name, not the framework #id');

  // (c) HASHED-ID BRANCH: a hashed `#btn-<hex>` id does not anchor the selector.
  const hashed = Object.values(graph.elements).find((e) => e.name === 'Go');
  assert.ok(hashed, 'the hashed-id control was captured');
  assert.ok(
    !/a1b2c3d4e5/.test(hashed.templateSelector),
    `a hashed id does not anchor the selector (got ${hashed.templateSelector})`,
  );

  // (d) SCOPING (negative control): a plain SEMANTIC id STILL anchors + stays the durable locator,
  // proving INC.1's rejection is scoped to framework noise — it does not nuke all ids.
  const save = Object.values(graph.elements).find((e) => e.name === 'Save');
  assert.ok(save, 'the semantic-id control was captured');
  assert.equal(save.locator.type, 'id', 'a plain semantic #id is STILL the durable locator (rejection is scoped)');
  assert.ok(/#save/.test(save.templateSelector), 'a plain semantic id still anchors its template');
});
