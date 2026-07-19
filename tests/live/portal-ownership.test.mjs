// Live proof of the PORTAL-DROPDOWN ownership fix (a real target finding). AntD renders a row's
// Edit/Delete dropdown as a PORTAL appended to <body>, DETACHED from the post card — so ownsTarget on the
// delete button finds no marker in its DOM ancestors and fails closed, blocking a LEGITIMATE delete of OWN
// content. `ownsViaReveal` fixes it: a portal control's ownership is the ownership of its reveal-TRIGGER (the
// row's "…" button, which IS inside the card). It resolves the trigger from the reveal path and runs the same
// marker check on it. FAIL-CLOSED: no reveal path / trigger not in a marked row → refused (never a leak).
//
// FAIL-ON-REVERT: make ownsViaReveal return false unconditionally → the "our marked row → owned" assertion
//   reds. Point it at the WRONG hop / drop the trigger resolution → the other-1 refusal could flip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep } from '../../lib/recon/step.mjs';
import { ownsViaReveal } from '../../lib/recon/hunt-gate.mjs';
import { start } from '../fixtures/portal-app/server.mjs';

const MARKER = 'HUNT-portaltest';

test('portal ownership: ownsViaReveal authorizes a portal control by its reveal-trigger row marker', async (t) => {
  const server = await start(0, { marker: MARKER });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  process.env.PW_ALLOW_PRIVATE = '1';
  const cold = await launch();
  t.after(async () => {
    await close(cold.browser); server.close();
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
  });

  const page = cold.page;
  const graph = makeGraph();
  const ledger = makeLedger();
  await gotoGated(page, url);
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');

  const more = Object.values(graph.elements).find((n) => n.name === 'More');
  assert.ok(more, 'the "More" reveal-trigger template is discovered (one instance per row)');
  const hopFor = (id) => ({ templateId: more.templateId, instanceKey: more.instances.find((i) => String(i.instanceKey).includes(id)).instanceKey });

  // The detached portal Delete's ownership = the marker in its reveal-trigger's ROW.
  assert.equal(await ownsViaReveal(page, graph, [hopFor('self-1')], MARKER), true, 'a portal control opened from OUR marked row IS owned');
  assert.equal(await ownsViaReveal(page, graph, [hopFor('other-1')], MARKER), false, 'a portal control opened from ANOTHER user row is NOT owned (fail-closed)');
  assert.equal(await ownsViaReveal(page, graph, [], MARKER), false, 'no reveal path → fail-closed');
  assert.equal(await ownsViaReveal(page, graph, [hopFor('self-1')], ''), false, 'no marker → fail-closed');
});
