// Live proof of the REVEAL-BACKFILL fix (Fable design) — in-app-state reach for a PORTAL dropdown that
// MOUNTS on open. The menuitem is never in the DOM while closed, so it can only ever be captured visible →
// the write-once `hiddenWhenSeen` is structurally always false → the OLD reveal-backfill never gave it a
// path → NO_INSTANCE on cold re-navigation (the live target Delete-in-dropdown gap). The per-act
// `preVisible` transition (not-visible-before-the-act + visible-after = revealed by this act) fixes it.
//
// SCOPE (bughunter review): this test guards END-TO-END REACH of a mount-on-reveal portal menuitem — it is
// FIRST seen during the opener act, so its reveal path is stamped by mergeSnapshot's NEW-instance branch, NOT
// by `fillRevealIfHidden`. So it is NOT a revert-guard for the `preVisible` transition (it passes reverted).
// The preVisible fix's revert-proof guard is the UNIT test (tests/unit/reveal-backfill.test.mjs), which
// re-captures the menuitem first so the second merge hits the KNOWN-instance fillRevealIfHidden path.
//
// Guards HERE: (1) a portal "Copy link" absent at baseline acquires a reveal path when its "…" opener is
// acted; (2) a fresh whats-new act on it REPLAYS that path (re-opens the dropdown) and GENUINELY explores it
// (its GET /copy is causally attributed), so it is real coverage — not NO_INSTANCE-unreachable; (3) the 150ms
// background GET /poll is never causally credited to the measured act (the causal-survival discipline).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/portal-menu-app/server.mjs';
import { run } from '../../lib/recon/whats-new.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';

const find = (graph, name) => Object.values(graph.elements).find((n) => n.name === name);

test('reveal-backfill: a mount-on-reveal portal menuitem acquires a reveal path and becomes reachable', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-portalmenu-'));
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

  // Baseline: the "…" trigger is present (inside a card); the portal "Copy link" is NOT mounted yet.
  await run({ url });
  let graph = loadGraph(graphFile);
  const more = find(graph, 'More');
  assert.ok(more, 'the "…" (More) opener is discovered at baseline');
  assert.ok(!find(graph, 'Copy link'), 'the portal menuitem is NOT in the DOM while the menu is closed');

  // Act the "…" opener (its caused GET /menu-open makes the act all-GET → it STAMPS a reveal path). The
  // portal mounts, "Copy link" appears — NOT in the pre-act preVisible set → its reveal path is backfilled.
  await run({ url, actTemplate: more.templateId, instance: more.instances[0].instanceKey });
  graph = loadGraph(graphFile);
  const copy = find(graph, 'Copy link');
  assert.ok(copy, 'acting the opener revealed the portal "Copy link"');
  const copyInst = copy.instances.find((i) => i.reveal);
  assert.ok(copyInst && copyInst.reveal && Array.isArray(copyInst.reveal.statePath) && copyInst.reveal.statePath.length >= 1,
    'the mount-on-reveal menuitem ACQUIRED a reveal path (preVisible transition backfill) — the fix');
  assert.equal(copyInst.reveal.statePath[copyInst.reveal.statePath.length - 1].templateId, more.templateId,
    'the reveal path ends at the "…" opener that revealed it');

  // REACH: a fresh cold act on "Copy link" replays the reveal path (re-opens the dropdown) and genuinely
  // explores it — its GET /copy is causally attributed, proving real coverage (not NO_INSTANCE-unreachable).
  const acted = await run({ url, actTemplate: copy.templateId, instance: copyInst.instanceKey });
  assert.ok(acted.acted, 'the portal menuitem was reached + acted via reveal-replay (not NO_INSTANCE)');
  assert.ok((acted.acted.requests || []).some((r) => /\/copy/.test(r.urlPattern)), 'acting it caused GET /copy (genuine coverage)');
  assert.ok(!(acted.acted.requests || []).some((r) => /\/poll/.test(r.urlPattern)), 'the 150ms background /poll is never causally credited to the act');
});
