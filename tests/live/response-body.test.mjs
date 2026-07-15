// Live proof that REQUEST/RESPONSE BODY capture (opt-in, redacted, trail-scoped) rides the
// causal channel WITHOUT weakening the invariant. Bodies attach to fires ALREADY kept by the
// token + initiator filters; getResponseBody is a passive read, so the kept set is unchanged.
// Over real chromium + the response-meta fixture we prove:
//   1. with BUGHUNTER_CAPTURE_BODIES=1 + a run, the caused request's REDACTED request+response
//      bodies land in the run TRAIL (files under bodies/), the secret values are [REDACTED] and
//      the real fields survive, the bodies are NOT in res.requests[] (which flows to stdout +
//      the graph node), and the adversarial in-window poll is STILL rejected (invariant, WITH
//      body capture on — the exact gate decisions.md named).
//   2. with the flag OFF (default), NO body is captured (metadata still joins — the gate is
//      body-specific). This is also the login pre-step state (login opens no run → gate closed).
//   3. an off-allowlist content-type (text/html) → NO body captured, even with capture on.
//
// Guards: initiator.mjs fetches the body at loadingFinished (gated); response-ledger.mjs
//   redacts+caps at store time; causal.mjs attaches bodies to kept fires only; step.mjs writes
//   refs to the trail and keeps requests[] body-free; the double gate defaults OFF.
// FAIL-ON-REVERT (trail): make step.mjs push reqBody/respBody into the `req` object → "requests[]
//   is body-free" fails. FAIL-ON-REVERT (invariant): neuter classifyInitiator → the in-window
//   poll leaks → "the in-window poll is still rejected" fails. FAIL-ON-REVERT (gate): default
//   captureBodies to true in initiator → "no body captured by default" fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/response-meta-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { beginCause, endCause, waitSettled, attachCausalTracker } from '../../lib/browser/causal.mjs';
import { snapshotStep, actStep } from '../../lib/recon/step.mjs';
import { makeGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';
import { makeCapture, runDir } from '../../lib/debug/trace.mjs';

// Save + restore the body-capture env so a test's gate never leaks into the next (the gate is
// read once at launch()/wire time, so each test sets it BEFORE launch and restores after).
function snapEnv() {
  return {
    cap: process.env.BUGHUNTER_CAPTURE_BODIES,
    run: process.env.BUGHUNTER_RUN_ID,
    state: process.env.BUGHUNTER_STATE_DIR,
  };
}
function restoreEnv(s) {
  for (const [k, v] of [['BUGHUNTER_CAPTURE_BODIES', s.cap], ['BUGHUNTER_RUN_ID', s.run], ['BUGHUNTER_STATE_DIR', s.state]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

test('bodies ON: redacted request+response bodies reach the trail; requests[] stays body-free; the poll is still rejected', async (t) => {
  process.env.PW_ALLOW_PRIVATE = '1';
  const saved = snapEnv();
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-body-'));
  const runId = 'r-body-test';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  process.env.BUGHUNTER_CAPTURE_BODIES = '1';
  process.env.BUGHUNTER_RUN_ID = runId;

  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browser, page } = await launch(); // the double gate is read HERE
  t.after(async () => {
    await close(browser); server.close();
    rmSync(stateDir, { recursive: true, force: true });
    restoreEnv(saved);
  });

  const graph = makeGraph();
  const ledger = makeLedger();
  await gotoGated(page, url);
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');

  const secret = Object.values(graph.elements).find((n) => n.name === 'Reveal secret');
  assert.ok(secret, '#secret was discovered');
  const tid = secret.templateId;
  const target = { templateId: tid, name: secret.name, route: secret.route, instance: secret.instances[0] };
  const res = await actStep(page, graph, ledger, target, { capture: makeCapture(runId, tid) });

  // VACUITY: a poll must have ticked inside #secret's window (its cause token = String(tid)),
  // else the invariant assertion below is meaningless.
  const ring = await page.evaluate(() => window.__bughuntFires.slice());
  assert.ok(ring.some((f) => f.cause === String(tid) && String(f.url).includes('/api/poll')),
    'a poll ticked inside the window (else the invariant guard is vacuous)');
  // INVARIANT: response/body capture did not change the kept set — the poll is still rejected.
  assert.ok(!res.requests.some((r) => r.urlPattern === '/api/poll'),
    'the in-window poll is still rejected with body capture ON (attribution unchanged)');

  // requests[] (→ stdout + the graph node) carries NO body fields.
  const req = res.requests.find((r) => r.urlPattern === '/api/secret');
  assert.ok(req, 'the caused /api/secret request rode requests[]');
  assert.equal(req.status, 200, 'metadata still present on the request');
  assert.ok(!('reqBody' in req) && !('respBody' in req), 'requests[] is body-free (no bytes to stdout/graph)');

  // res.debug.bodies carries REFS (file paths), not bytes.
  assert.ok(Array.isArray(res.debug.bodies), 'res.debug.bodies present');
  const ref = res.debug.bodies.find((b) => b.method === 'POST' && b.urlPattern === '/api/secret');
  assert.ok(ref, 'a body ref for POST /api/secret');
  assert.ok(typeof ref.respBody === 'string' && ref.respBody.startsWith('bodies/'), 'respBody is a file ref');
  assert.ok(typeof ref.reqBody === 'string' && ref.reqBody.startsWith('bodies/'), 'reqBody is a file ref');
  assert.ok(!JSON.stringify(res.debug.bodies).includes('neo'), 'the refs carry paths only, no body bytes');

  // The trail FILES hold the REDACTED bodies (secret stripped, real fields kept).
  const respFile = readFileSync(path.join(runDir(runId), ref.respBody), 'utf8');
  assert.ok(respFile.includes('[REDACTED]'), 'the response JWT (under a non-secret `data` key) is redacted');
  assert.ok(!/eyJhbGc/.test(respFile), 'the JWT never lands in the trail (VALUE-level detection)');
  assert.ok(respFile.includes('neo') && respFile.includes('items'), 'real response fields are present');

  const reqFile = readFileSync(path.join(runDir(runId), ref.reqBody), 'utf8');
  assert.ok(reqFile.includes('[REDACTED]') && !reqFile.includes('trinity123'), 'the request password is redacted in the trail');
  assert.ok(reqFile.includes('neo'), 'the request non-secret field is present');
});

test('bodies OFF (default / login state): no body is captured, metadata still joins', async (t) => {
  process.env.PW_ALLOW_PRIVATE = '1';
  const saved = snapEnv();
  // The default: flag unset AND no run — exactly the login pre-step's wiring (opens no run).
  delete process.env.BUGHUNTER_CAPTURE_BODIES;
  delete process.env.BUGHUNTER_RUN_ID;

  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browser, page } = await launch(); // gate closed at wire time
  t.after(async () => { await close(browser); server.close(); restoreEnv(saved); });

  await gotoGated(page, url);
  await waitSettled(page);
  const cause = 'SECRET';
  const seq0 = await beginCause(page, cause);
  await page.click('#secret'); // POST with a password body; slow 200 with a token body
  const kept = await endCause(page, seq0, cause);

  const fire = kept.find((f) => f.url.includes('/api/secret'));
  assert.ok(fire, 'the caused request survives attribution');
  assert.equal(fire.status, 200, 'response METADATA still joins — the gate is body-specific');
  assert.ok(!('reqBody' in fire), 'no request body captured by default');
  assert.ok(!('respBody' in fire), 'no response body captured by default');
});

test('bodies content-type gate: a text/html response body is NOT captured (capture ON)', async (t) => {
  process.env.PW_ALLOW_PRIVATE = '1';
  const saved = snapEnv();
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-body-html-'));
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  process.env.BUGHUNTER_CAPTURE_BODIES = '1';
  process.env.BUGHUNTER_RUN_ID = 'r-html-test';

  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browser, page } = await launch();
  t.after(async () => {
    await close(browser); server.close();
    rmSync(stateDir, { recursive: true, force: true });
    restoreEnv(saved);
  });

  await gotoGated(page, url);
  await waitSettled(page);
  const cause = 'HTML';
  const seq0 = await beginCause(page, cause);
  await page.click('#html'); // GET → text/html body carrying a secret
  const kept = await endCause(page, seq0, cause);

  const fire = kept.find((f) => f.url.includes('/api/html'));
  assert.ok(fire, 'the /api/html request survives attribution');
  assert.equal(fire.status, 200, 'metadata still joins for the html request');
  assert.ok(!('respBody' in fire), 'a text/html body is off the allowlist → never captured');
});

// The CAUSAL INVARIANT under body capture: the kept-set must be frozen with ZERO await, so a
// verdict that flips DURING a response-body await can never add a phantom edge. A real-traffic
// repro is impossible to make deterministic (a real foreground request to a path legitimately
// un-suppresses its polls in BOTH one-pass and two-pass), so this WHITE-BOX test drives a real
// page + real fires + real CDP, and controls ONLY bughunter's OWN tracker seam (not chromium):
// an earlier fire's body await flips a later poll-path's `anyForeground` latch. Two-pass reads
// all verdicts before that await → poll rejected; one-pass reads it after → poll kept (phantom).
// Guards: endCause freezes the kept-set (selectKept) BEFORE any body await.
// FAIL-ON-REVERT: inline the body await back into the kept loop (one-pass) → /api/poll2 is kept.
test('endCause freezes the kept-set BEFORE awaiting any body — a mid-await verdict flip adds no phantom edge', async (t) => {
  process.env.PW_ALLOW_PRIVATE = '1';
  const saved = snapEnv();
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-twopass-'));
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  process.env.BUGHUNTER_CAPTURE_BODIES = '1';
  process.env.BUGHUNTER_RUN_ID = 'r-twopass';

  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browser, page } = await launch();
  t.after(async () => {
    await close(browser); server.close();
    rmSync(stateDir, { recursive: true, force: true });
    restoreEnv(saved);
  });

  await gotoGated(page, url);
  await waitSettled(page);
  const tracker = await attachCausalTracker(page); // idempotent → the live page tracker

  // Seam (bughunter's own tracker interface, NOT CDP): /api/poll2's verdict is `background`
  // until `flip`; /api/lead's body promise sets `flip` after 30ms. Everything else — the page,
  // the fires, the real verdicts for other paths — is untouched.
  let flip = false;
  const realVerdict = tracker.verdictFor.bind(tracker);
  tracker.verdictFor = (u) => {
    let p; try { p = new URL(u, 'http://x').pathname; } catch { p = u; }
    if (p === '/api/poll2') return { background: !flip, reason: 'seam-poll' };
    return realVerdict(u);
  };
  const realTake = tracker.takeResponse.bind(tracker);
  tracker.takeResponse = (m, p) => {
    const meta = realTake(m, p);
    if (p === '/api/lead') {
      return { ...(meta || {}), bodyPromise: new Promise((r) => setTimeout(() => { flip = true; r('lead-body'); }, 30)) };
    }
    return meta;
  };

  const cause = 'ACT';
  const seq0 = await beginCause(page, cause);
  // lead (foreground, has a body) fires BEFORE poll2 (lower seq), so a one-pass loop awaits
  // lead's body — flipping poll2's latch — BEFORE it reads poll2's verdict.
  await page.evaluate(() => { fetch('/api/lead').catch(() => {}); fetch('/api/poll2').catch(() => {}); });
  const kept = await endCause(page, seq0, cause);

  // VACUITY GUARD: poll2 must actually have fired under this cause in the window, else
  // `!kept.some(poll2)` could pass for the wrong reason (poll2 never fired at all).
  const ring = await page.evaluate(() => window.__bughuntFires.slice());
  assert.ok(ring.some((f) => String(f.url).includes('/api/poll2') && f.cause === 'ACT'),
    'poll2 fired in the window under this cause (else the rejection is vacuous)');
  assert.ok(kept.some((f) => f.url.includes('/api/lead')), 'the foreground lead is kept (sanity)');
  assert.ok(!kept.some((f) => f.url.includes('/api/poll2')),
    'poll2 stays REJECTED: the kept-set was frozen before lead\'s body await flipped its verdict');
});
