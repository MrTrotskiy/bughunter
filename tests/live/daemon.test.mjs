// Live tests for the shared browser daemon (browser-daemon.mjs + recon-session.mjs +
// session.mjs attach()). The daemon hosts ONE chromium process for a whole run; recon
// CLIs connect to it via attach() so N acts spend one process, not N. Two theses:
//   1. attach() actually USES the daemon when it is up (mode 'attached'), and the same
//      browser process serves multiple connections.
//   2. The causal substrate survives the connection: a background poll that ticks inside
//      a control's window is still rejected by the CDP initiator classifier over a
//      chromium.connect() session — the exact mechanism that must not degrade remotely.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start as startSession, stop as stopSession, isAlive } from '../../lib/recon/recon-session.mjs';
import { attach, gotoGated, readSessionEndpoint } from '../../lib/browser/session.mjs';
import { beginCause, endCause, waitSettled } from '../../lib/browser/causal.mjs';
import { start } from '../fixtures/search-app/server.mjs';

async function withDaemon(t) {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-daemon-'));
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  const started = await startSession();
  t.after(async () => {
    await stopSession();
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });
  return { url, started };
}

// Guards: with a daemon up, attach() CONNECTS to it (mode 'attached') instead of
//   launching a private browser, and the daemon's single browser process serves
//   multiple sequential connections (one chromium for the whole run, not one per act).
// FAIL-ON-REVERT: force the cold branch in attach() (session.mjs) — change `if (ws)` to
//   `if (false)` → attach() never connects even though a daemon is up → mode is 'cold' →
//   "attach must connect to the running daemon" fails.
test('daemon: attach connects to the shared browser, one process serves N acts', async (t) => {
  const { started } = await withDaemon(t);
  assert.ok(readSessionEndpoint(), 'a daemon endpoint is published');
  assert.ok(isAlive(started.browserPid), 'the daemon browser process is alive');

  // Two sequential attaches model two acts. Both must connect to the daemon, and the
  // daemon browser process must be the SAME and still alive after both.
  for (let i = 0; i < 2; i++) {
    const s = await attach();
    try {
      assert.equal(s.mode, 'attached', `attach must connect to the running daemon (act ${i})`);
    } finally {
      await s.release(); // always release, even if the assertion throws, so node can exit
    }
    assert.ok(isAlive(started.browserPid), `daemon browser survives connection ${i} closing`);
  }
});

// Guards: the CDP-initiator classifier still works OVER a chromium.connect() session —
//   a setInterval-rooted poll that ticks inside a control's causal window carries the
//   control's cause token, so the token alone would miscredit it; the initiator (attached
//   before navigation on the connected page) rejects it. Proves the daemon path does not
//   silently degrade causal capture. Chromium-specific (CDP async call stacks).
// FAIL-ON-REVERT: remove `await attachCausalTracker(page)` from wire() in session.mjs →
//   the connected page has no initiator tracker → the in-window poll leaks into the
//   attributed set → "initiator rejected the in-window poll over the daemon" fails.
test('daemon path: in-window poll rejected by initiator over a connected session', async (t) => {
  const { url } = await withDaemon(t);

  const s = await attach();
  const { page, release } = s;
  t.after(async () => { await release(); }); // register cleanup BEFORE any assertion can throw
  assert.equal(s.mode, 'attached', 'this guard must run on the connected page, not a cold fallback');

  await gotoGated(page, url);
  await waitSettled(page);
  await page.fill('#q', 'hello');

  const cause = 'SEARCH_BTN';
  const seq0 = await beginCause(page, cause);
  await page.click('#search');
  await new Promise((r) => setTimeout(r, 1000)); // force >=2 poll ticks into the window
  const kept = await endCause(page, seq0, cause);

  // Token alone WOULD miscredit: search + the in-window pings all carry our cause.
  const raw = await page.evaluate(({ c, sq }) => window.__bughuntFires
    .filter((f) => f.cause === c && f.seq >= sq)
    .map((f) => f.url), { c: cause, sq: seq0 });
  assert.ok(raw.some((u) => u.includes('/api/ping')), 'a ping must tick inside the window (else this guard is vacuous)');
  assert.ok(raw.some((u) => u.includes('/api/search')), 'search is in the raw window too');

  // Attribution (token + initiator over the connection) keeps search, drops every poll.
  const keptUrls = kept.map((f) => f.url);
  assert.ok(keptUrls.some((u) => u.includes('/api/search')), 'search survives attribution over the daemon');
  assert.ok(!keptUrls.some((u) => u.includes('/api/ping')), 'initiator rejected the in-window poll over the daemon');
});
