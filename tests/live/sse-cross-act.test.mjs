// PROOF-OR-KILL for the SSE (EventSource) leg of the causal substrate — the documented SYMMETRIC
// follow-up to the WebSocket hole (decisions.md 2026-07-16, "HONEST RESIDUAL: SSE has the same shape
// and is NOT yet covered"). probe.mjs instrumented fetch+XHR+WebSocket but NOT EventSource; a fetch
// fired from an EventSource message handler is script-rooted (no timer, no parser), so
// classifyInitiator (initiator.mjs) KEEPS it and it inherits the active cause on a REUSED page = a
// phantom edge (the exact class that killed bughunt-agents). On a long-lived authed run the SSE
// stream stays open the whole crawl, maximizing in-window contamination.
//
// Guards: on a reused page (no goto between acts), a fetch fired from a persistent EventSource's
//   message handler ticking inside a control's causal window is NOT credited to that control — for
//   BOTH the unnamed 'message' event AND a NAMED ('feed') event. The named case is the SSE-specific
//   proof: per WHATWG HTML "server-sent events" / MDN EventSource a server event with an `event:`
//   field dispatches to a NAMED listener, not 'message', so the probe must wrap ALL function listener
//   types, not just 'message'. The drop rides the probe's __bughuntWsDepth/wsRooted tag (shared with
//   WS — no parallel counter); the CDP initiator cannot help (a bare type:script frame).
// FAIL-ON-REVERT (two levers):
//   A) neutralize the EventSource wrap in probe.mjs (e.g. `if (false && ESP)`) → the sse-driven fetch
//      loses wsRooted → it is credited to #b → "the SSE message-driven fetch must NOT be credited to
//      #b" fails.
//   B) restrict the ES addEventListener wrap back to `type === 'message'` only → the NAMED 'feed'
//      listener is left unwrapped → /api/sse-driven-named is credited to #b → "the SSE NAMED
//      ('feed')-driven fetch must NOT be credited to #b" fails. This proves the all-types wrap is
//      load-bearing.
//   The adversarial assertion (token alone WOULD miscredit both) must ALWAYS hold, or the whole test
//   is vacuous — it proves the SSE requests genuinely ticked inside #b's window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/sse-feed-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import {
  beginCause, endCause, waitSettled, attachCausalTracker,
} from '../../lib/browser/causal.mjs';

// Exact-pathname match: '/api/sse-driven' is a substring of '/api/sse-driven-named', so a naive
// includes() would conflate the two. Key on the URL pathname.
const isPath = (f, p) => { try { return new URL(String(f.url), 'http://x').pathname === p; } catch { return false; } };
const hasSseDriven = (fires) => fires.some((f) => isPath(f, '/api/sse-driven'));
const hasSseNamed = (fires) => fires.some((f) => isPath(f, '/api/sse-driven-named'));

test('reused page: an EventSource message/named-event fetch is not mis-credited to a click', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-ssexact-'));
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
  await waitSettled(page); // SSE is up and its first message-driven fetch has fired (total > 0)

  // Act #b — same page, NO goto. /api/b responds slowly so several SSE ticks dispatch inside the window.
  const seq0b = await beginCause(page, 'b');
  await page.click('#b');
  const keptB = await endCause(page, seq0b, 'b'); // token + initiator + wsRooted (the real attribution)

  // TOKEN-ONLY view from the ring (endCause only sliced it, never cleared it): cause + seq alone,
  // WITHOUT the initiator or the wsRooted filter — exactly what the raw token would credit. It MUST
  // include BOTH SSE-driven fetches, proving they genuinely ticked inside #b's window.
  const rawFires = await page.evaluate(() => window.__bughuntFires.slice());
  const tokenOnly = rawFires.filter((f) => f.cause === 'b' && Number(f.seq) >= seq0b);

  // Characterize WHY they survive the initiator, for the report (not an assertion — it couples to the hole).
  const tracker = await attachCausalTracker(page); // idempotent: returns the same page tracker
  t.diagnostic(`sse-driven initiator verdict:       ${JSON.stringify(tracker.verdictFor('/api/sse-driven'))}`);
  t.diagnostic(`sse-driven-named initiator verdict: ${JSON.stringify(tracker.verdictFor('/api/sse-driven-named'))}`);
  t.diagnostic(`#b token-only kept: ${JSON.stringify(tokenOnly.map((f) => f.url))}`);
  t.diagnostic(`#b real kept:       ${JSON.stringify(keptB.map((f) => f.url))}`);

  // NON-VACUOUS: the adversarial condition must actually occur, or the guard is vacuous — the raw
  // token WOULD miscredit BOTH SSE-driven fetches into #b's window (they carry #b's cause + seq).
  assert.ok(hasSseDriven(tokenOnly), 'an SSE message-driven fetch ticked inside #b window and inherited its cause (token alone keeps it)');
  assert.ok(hasSseNamed(tokenOnly), 'an SSE NAMED-event-driven fetch ticked inside #b window and inherited its cause (token alone keeps it)');
  // The real edge is still credited.
  assert.ok(keptB.some((f) => isPath(f, '/api/b')), '#b is credited its real /api/b');

  // THE GUARD — the probe's wsRooted tag (shared with WS) must drop BOTH the unnamed and the NAMED
  // SSE-driven fetch, even though the token kept them (adversarial above) and the initiator cannot.
  assert.ok(!hasSseDriven(keptB), 'the SSE message-driven fetch must NOT be credited to #b (no phantom SSE edge)');
  // LEVER B proof: the NAMED ('feed') event dispatches to a named listener; a 'message'-only wrap
  // would leave it unwrapped and this would fail.
  assert.ok(!hasSseNamed(keptB), 'the SSE NAMED (feed)-driven fetch must NOT be credited to #b (all-types wrap, no phantom SSE edge)');
});
