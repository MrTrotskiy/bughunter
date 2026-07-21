// Live proof of the APP-MODAL-COVER retry (stateful-step.mjs FIX 1) — the fix for the live dashboard
// regression where a modal left OPEN by a PRIOR act covered the NEXT opener. On this fixture the loop
// acts "Show Notice" (opens blocking modal A, which ignores Escape and has only a text Cancel — so
// dismissBlockingOverlay CANNOT close it), then acts "Create Event" (B) while A obscures it: B's click
// times out with `intercepts pointer events`. Without the fix B is marked unreachable and modal C's
// 7-field "Schedule a Meeting" form is never reached. WITH the fix the interception-only fallback closes
// A by its own Cancel affordance, retries B ONCE — B fires GET /api/event, opens C, and C's fields are
// studied. The close runs under __idle__, so it forges no request node and the background poll ticking
// during it is never credited.
//
// Guards (crawl):
//   (a) REACH — "Create Event" (B) is `explored` and NOT `unreachable` (it fired after A was closed).
//   (b) FORM STUDIED — modal C's fields resolve and get a probe row (not REFUSED/unreachable).
//   (c) CAUSAL ATTRIBUTION — GET /api/event is attributed to B (edge present).
//   (d) CAUSAL CLEANLINESS — the modal-close forged NO request: the background poll is never credited,
//       and the server saw NO extra request from the Cancel close (a pure client-side hide).
//
// FAIL-ON-REVERT (sentinel: "Create Event (B) fired after the blocking modal was closed"):
//   In stateful-step.mjs remove the app-modal fallback block (the `if (!dismissed) { … closeAppModal … }`
//   in the interception-retry catch), leaving only dismissBlockingOverlay. dismissBlockingOverlay cannot
//   close A (Escape-ignoring, text-Cancel-only), so `dismissed` stays false → no retry → B is re-thrown
//   and marked unreachable → guard (a) reds and (c)'s GET /api/event edge is absent.
//   (Verified by hand: reverted → RED with "Create Event (B) fired after the blocking modal was closed";
//   restored → GREEN.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/modal-cover-app/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';
import { findingsOf } from '../../lib/recon/findings.mjs';

test('the loop closes a leftover blocking modal and reaches the obscured opener + its form', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-modal-cover-'));
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

  const res = await crawl({ url, steps: 25, stateful: true });
  assert.equal(res.ok, true, 'stateful crawl completed');

  const graph = loadGraph(path.join(stateDir, 'graph.json'));
  const create = Object.values(graph.elements).find((n) => n.name === 'Create Event');
  assert.ok(create, 'the Create Event opener was discovered at baseline');

  // (a) REACH — the obscured opener fired after the blocking modal was closed.
  assert.ok(
    create.explored && !create.unreachable,
    'Create Event (B) fired after the blocking modal was closed',
  );

  // (b) FORM STUDIED — modal C's fields resolve and get probed (the whole point of the fix).
  const fieldNodes = Object.values(graph.elements).filter(
    (n) => (n.instances || []).some((i) => typeof i.instanceSelector === 'string' && /#f-/.test(i.instanceSelector)),
  );
  assert.ok(fieldNodes.length >= 3, `modal C's form fields were discovered (got ${fieldNodes.length})`);
  const studied = fieldNodes.filter((n) => n.explored && !n.unreachable && (n.probes || []).length > 0);
  assert.ok(
    studied.length >= 3,
    `modal C's fields were STUDIED, not REFUSED/unreachable (got ${studied.length} studied of ${fieldNodes.length})`,
  );

  // (c) CAUSAL ATTRIBUTION — the reached opener binds its request.
  assert.ok(graph.requests['GET /api/event'], 'the /api/event request node exists (B fired)');
  assert.ok(
    graph.edges.some((e) => e.from === `element:${create.templateId}` && e.to === 'request:GET /api/event'),
    'GET /api/event is attributed to Create Event',
  );

  // (d) CAUSAL CLEANLINESS — the modal-close forged no request. The poll is never credited, and the
  // Cancel close (a pure client-side hide) put NO extra request on the wire.
  assert.equal(graph.requests['GET /api/poll'], undefined, 'the background poll is not a credited request node');
  assert.ok(!graph.edges.some((e) => e.to === 'request:GET /api/poll'), 'no control is credited the background poll');
  assert.ok(server.pollHits() >= 2, `the poll must have fired during the crawl (got ${server.pollHits()})`);
  assert.deepEqual(
    server.nonPollPaths().filter((p) => p.startsWith('/api/')),
    ['/api/event'],
    'the modal-close forged no server request — only Create Event hit the server',
  );

  // (e) CLASS 1b FINDING — the obstruction is SURFACED, not silently recovered. A prior act's modal covered
  // Create Event; the crawler closed it and reached the control, but the app leaving a dialog over an
  // unrelated control is a defect the operator must see (docs/GOAL.md — the interesting event must not
  // vanish once reach is recovered). FAIL-ON-REVERT: remove the `node.obstructions` record block at the
  // interception site in stateful-step.mjs → no obstruction recorded → this finding is absent → reds.
  const { findings } = findingsOf(graph);
  const obstruction = findings.find((f) => f.kind === 'obstructed-control' && f.where && f.where.name === 'Create Event');
  assert.ok(obstruction, 'the leftover-modal obstruction of Create Event is surfaced as an obstructed-control finding');
});
