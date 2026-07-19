// PROOF-OR-KILL for the live-session "unified connectome" pivot (decisions.md 2026-07-16).
// The pivot drops per-act re-navigation and walks ONE long-lived stateful page. Its load-
// bearing premise: the causal token + CDP-initiator attribution stays clean WITHOUT re-nav.
// This test isolates the one traffic class that premise ignores — a fetch fired from a
// persistent WebSocket's onmessage handler, ticking inside a control's causal window on a
// REUSED page. classifyInitiator (initiator.mjs) rejects only timer/parser roots; a WS message
// dispatch is neither, so the WS-driven fetch inherits the active cause AND survives the
// initiator filter = a phantom edge. Re-nav only INCIDENTALLY hides this by tearing the socket
// down. the first target is a WS feed, so a no-re-nav crawl would keep every socket alive the whole run.
//
// Guards: on a reused page (no goto between acts), a WS-onmessage-driven fetch ticking inside a
//   control's causal window is NOT credited to that control (no phantom WS causal edge). This
//   closes the initiator's blind spot (CDP reports the WS fetch as a bare type:script frame,
//   indistinguishable from a click's fetch) via the probe's WebSocket depth tag (wsRooted).
// FAIL-ON-REVERT: remove the WebSocket constructor patch in probe.mjs (fires lose wsRooted) OR
//   drop `if (f.wsRooted) continue;` in selectKept (causal.mjs) → the WS-onmessage fetch is
//   credited to #b → "the WebSocket-onmessage-driven fetch must NOT be credited to #b" fails.
//   The adversarial assertion (token alone WOULD miscredit it) must ALWAYS hold, or the whole
//   test is vacuous — it proves the WS request genuinely ticked inside #b's window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/ws-feed-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import {
  beginCause, endCause, waitSettled, attachCausalTracker,
} from '../../lib/browser/causal.mjs';

const hasWsDriven = (fires) => fires.some((f) => String(f.url).includes('/api/ws-driven'));

test('reused page: a WebSocket-onmessage-driven fetch is not mis-credited to a click', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-wsxact-'));
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
  await gotoGated(page, url);
  await waitSettled(page); // WS is up and its first onmessage fetch has fired (total > 0)

  // Act #a — a plain click on a reused page. Establishes the real foreground edge.
  const seq0a = await beginCause(page, 'a');
  await page.click('#a');
  const keptA = await endCause(page, seq0a, 'a');
  assert.ok(keptA.some((f) => String(f.url).includes('/api/a')), '#a is credited its real /api/a click');

  // Act #b — same page, NO goto. /api/b responds slowly so a WS tick dispatches inside the window.
  const seq0b = await beginCause(page, 'b');
  await page.click('#b');
  const keptB = await endCause(page, seq0b, 'b'); // token + initiator (the real attribution)

  // TOKEN-ONLY view from the ring (endCause only sliced it, never cleared it): cause + seq alone,
  // WITHOUT the initiator or the new wsRooted filter — exactly what the raw token would credit. It
  // MUST include the WS-driven fetch, proving the request genuinely ticked inside #b's window.
  const rawFires = await page.evaluate(() => window.__bughuntFires.slice());
  const tokenOnly = rawFires.filter((f) => f.cause === 'b' && Number(f.seq) >= seq0b);

  // Characterize WHY it survives, for the report (not an assertion — it couples to the hole).
  const tracker = await attachCausalTracker(page); // idempotent: returns the same page tracker
  t.diagnostic(`ws-driven initiator verdict: ${JSON.stringify(tracker.verdictFor('/api/ws-driven'))}`);
  t.diagnostic(`#b token-only kept: ${JSON.stringify(tokenOnly.map((f) => f.url))}`);
  t.diagnostic(`#b real kept:       ${JSON.stringify(keptB.map((f) => f.url))}`);

  // NON-TODO: the adversarial condition must actually occur, or the guard is vacuous — the raw
  // token WOULD miscredit the WS-driven fetch into #b's window (it carries #b's cause + seq).
  assert.ok(hasWsDriven(tokenOnly), 'a WS-onmessage fetch ticked inside #b window and inherited its cause (token alone keeps it)');
  // The real edge is still credited.
  assert.ok(keptB.some((f) => String(f.url).includes('/api/b')), '#b is credited its real /api/b');

  // THE GUARD — the probe's wsRooted tag must drop the WebSocket-onmessage-driven fetch, even
  // though the token kept it (adversarial assertion above) and the initiator cannot (script root).
  assert.ok(!hasWsDriven(keptB), 'the WebSocket-onmessage-driven fetch must NOT be credited to #b (no phantom WS edge)');
});
