// REVEAL-BACKFILL preVisible transition (Fable design) — the fix for in-app-state reach of a PORTAL
// dropdown that MOUNTS on open. Such a menuitem is never in the DOM while hidden, so it can only ever be
// captured `visible===true` → the write-once `hiddenWhenSeen` is structurally always false → the OLD
// `fillRevealIfHidden` never backfills its reveal path → NO_INSTANCE on cold replay. The per-act `preVisible`
// transition (a control NOT visible immediately before this act, visible after → revealed by this act)
// supersedes it. Tested through mergeSnapshot (fillRevealIfHidden is private) on a KNOWN instance — the
// rawcaster case (the menuitem was captured in an earlier crawl, so it is not "new" this act).
//
// FAIL-ON-REVERT: revert `revealedNow` to `inst.hiddenWhenSeen` → the known, first-captured-visible menuitem
//   never backfills → the "acquired a reveal path" assertion reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGraph, mergeSnapshot } from '../../lib/graph/graph-store.mjs';

// A portal menuitem captured VISIBLE (as it always is — it mounts on open). Same identity each merge.
const copyEl = () => ({
  templateId: 5, templateSelector: '.copy', role: 'button', name: 'Copy link',
  instanceId: 50, instanceKey: 'copy-1', instanceSelector: '#portal-menu > .copy', visible: true,
});
const moreHop = { templateId: 9, instanceKey: 'more-1' };

test('reveal-backfill: preVisible transition backfills a KNOWN mount-on-reveal menuitem (hiddenWhenSeen=false)', () => {
  const graph = makeGraph();
  // First capture (an earlier crawl / unstamped pass): the menuitem exists, VISIBLE → hiddenWhenSeen=false,
  // no reveal path. This is the "locked" state the write-once gate can never escape.
  mergeSnapshot(graph, '/', [copyEl()]);
  const inst0 = graph.elements[5].instances.find((i) => i.instanceKey === 'copy-1');
  assert.ok(inst0 && !inst0.reveal && inst0.hiddenWhenSeen === false, 'captured visible → known, no reveal, hiddenWhenSeen=false');

  // A later STAMPED opener act reveals it again. preVisible = the set visible IMMEDIATELY BEFORE this act —
  // it does NOT contain the menuitem (the dropdown was closed pre-click), so it was revealed by this act.
  mergeSnapshot(graph, '/', [copyEl()], { revealPath: [moreHop], preVisible: new Set(['.other::x1']) });
  const inst1 = graph.elements[5].instances.find((i) => i.instanceKey === 'copy-1');
  assert.ok(inst1.reveal && Array.isArray(inst1.reveal.statePath), 'the mount-on-reveal menuitem ACQUIRED a reveal path (the fix)');
  assert.deepEqual(inst1.reveal.statePath, [moreHop], 'the path ends at the "…" opener that revealed it');
});

test('reveal-backfill: NO backfill when the control was ALREADY visible pre-act (in preVisible) — not revealed by this act', () => {
  const graph = makeGraph();
  mergeSnapshot(graph, '/', [copyEl()]);
  // preVisible CONTAINS the menuitem → it was already visible before the act → this act did NOT reveal it →
  // no reveal path (guards against attributing a coincidentally-present control to the opener).
  mergeSnapshot(graph, '/', [copyEl()], { revealPath: [moreHop], preVisible: new Set(['.copy::copy-1']) });
  const inst = graph.elements[5].instances.find((i) => i.instanceKey === 'copy-1');
  assert.ok(!inst.reveal, 'a control already visible before the act is NOT backfilled (not this act\'s reveal)');
});

test('reveal-backfill: legacy fallback — no preVisible threaded → the write-once hiddenWhenSeen still governs', () => {
  const graph = makeGraph();
  // A control captured HIDDEN first (hiddenWhenSeen=true) — the panel-reach class — still backfills via the
  // legacy path when a caller does not thread preVisible (byte-compatible: existing behavior preserved).
  mergeSnapshot(graph, '/', [{ ...copyEl(), visible: false }]);
  const inst0 = graph.elements[5].instances.find((i) => i.instanceKey === 'copy-1');
  assert.equal(inst0.hiddenWhenSeen, true, 'captured hidden → hiddenWhenSeen=true (the legacy panel-reach signal)');
  mergeSnapshot(graph, '/', [copyEl()], { revealPath: [moreHop] }); // no preVisible → legacy hiddenWhenSeen path
  const inst1 = graph.elements[5].instances.find((i) => i.instanceKey === 'copy-1');
  assert.ok(inst1.reveal, 'the legacy hiddenWhenSeen backfill still works when preVisible is not threaded');
});
