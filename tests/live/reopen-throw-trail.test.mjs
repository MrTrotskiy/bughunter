// Live proof that a reopen which THROWS records its exception to the trail (stateful-loop.mjs FIX 2).
// recoverGated used to wrap reopenContainer in `.catch(() => null)`, so a reopen that threw (a gotoGated
// navigation aborted, a page detached mid-walk) emitted `code: REOPEN_THREW` with NO message and NO
// failedHop — measured, 45% of one run's reopen failures carried zero evidence, which the project's log
// rule treats as a defect in the trail itself.
//
// We force the throw the cleanest deterministic way. A hand-built graph holds ONE unexplored control (B)
// that does not resolve on the live DOM but carries a reveal.statePath through an already-explored opener
// (A). statefulLoop drains the route (B is unpickable), then recoverGated tries to reopen B: its in-place
// hops are stale, so it falls to the reload-replay rung and calls gotoGated on the route. The fixture
// serves the baseline once and then answers every re-navigation with an aborting attachment download, so
// page.goto REJECTS → reopenContainer throws → recoverGated's catch fires. The `reopen` event must carry
// the message.
//
// Guards: the recoverGated reopen-throw seam — a reopen that threw records its exception `error` to
//   state/runs/<id>/events.ndjson, not a bare REOPEN_THREW with no evidence.
// FAIL-ON-REVERT: restore `const re = await reopenContainer(...).catch(() => null);` (drop the try/catch
//   and the `error: reThrew` payload field) → the reopen event's `error` is null/absent while `code` is
//   REOPEN_THREW → the `assert.ok(reopen.payload.error, …)` below reds.
//   (Verified by hand: reverted → RED "the reopen-threw event carries the exception message"; restored → GREEN.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/reopen-throw-app/server.mjs';
import { statefulLoop } from '../../lib/recon/stateful-loop.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';

test('a reopen that throws records its exception message to the trail', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const origin = new URL(url).origin;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-reopen-throw-'));
  const runId = 'r-reopen-throw-test';
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  const { browser, page } = await launch();
  t.after(async () => {
    await close(browser);
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });

  // Baseline load — GET #1 of '/', served the real HTML. Every later navigation aborts as a download.
  await gotoGated(page, url);

  // Hand-built graph: A is an already-explored opener; B is an unexplored control that does NOT resolve on
  // the live DOM but records a reveal path through A. recoverGated will try to reopen B, hit the reload
  // rung, and gotoGated will throw on the aborting re-navigation.
  const graph = {
    schemaVersion: 2,
    routes: {},
    requests: {},
    edges: [],
    elements: {
      1: {
        role: 'button', name: 'Open Panel', route: '/', explored: true,
        instances: [{ instanceKey: 'a-1', instanceSelector: '#nonexistent-a', explored: true }],
      },
      2: {
        role: 'button', name: 'Deep Control', route: '/',
        instances: [{
          instanceKey: 'b-1', instanceSelector: '#nonexistent-b',
          reveal: { statePath: [{ templateId: 1, instanceKey: 'a-1' }], stateful: true },
        }],
      },
    },
  };

  const result = await statefulLoop(graph, {
    page, origin, ledger: {}, step: async () => ({}), budget: { steps: 30 }, runId,
  });
  assert.ok(result && result.stopped, 'statefulLoop returned a terminal verdict');
  // The fixture must actually have re-navigated (else the throw path was never exercised).
  assert.ok(server.rootGets() >= 2, `a reopen re-navigation must have been attempted (rootGets=${server.rootGets()})`);

  const eventsPath = path.join(stateDir, 'runs', runId, 'events.ndjson');
  assert.ok(existsSync(eventsPath), `events.ndjson must exist at ${eventsPath}`);
  const events = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const reopen = events.find((e) => e.kind === 'reopen' && e.payload && e.payload.code === 'REOPEN_THREW');
  assert.ok(reopen, 'a REOPEN_THREW reopen event was written to the trail');
  assert.ok(
    typeof reopen.payload.error === 'string' && reopen.payload.error.length > 0,
    'the reopen-threw event carries the exception message',
  );
});
