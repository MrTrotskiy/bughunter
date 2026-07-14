#!/usr/bin/env node
// browser-daemon — hosts ONE chromium process for a whole recon run. Started detached
// by recon-session --start; it holds a chromium.launchServer alive and publishes its
// wsEndpoint to state/session.json. Recon CLIs (session.mjs attach()) connect to that
// endpoint, so a run that fires N acts spends ONE chromium process, not N. Exits
// cleanly on SIGTERM/SIGINT (and if the browser dies on its own), removing session.json.
// NOT meant to be run by hand — use recon-session.
//
// Emits one line "DAEMON_READY <wsEndpoint>" on stdout once published, so the parent
// (recon-session --start) can wait for readiness. Env: PW_HEADFUL=1 → headed;
// PW_NO_SANDBOX=1 → drop the sandbox; BUGHUNTER_STATE_DIR redirects session.json.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

function sessionPath() {
  const stateDir = process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state');
  return path.join(stateDir, 'session.json');
}

function removeSession(file) {
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* best effort */ }
}

async function main() {
  const args = ['--disable-dev-shm-usage'];
  if (process.env.PW_NO_SANDBOX === '1') args.push('--no-sandbox');
  const server = await chromium.launchServer({ headless: process.env.PW_HEADFUL !== '1', args });

  const file = sessionPath();
  const info = {
    wsEndpoint: server.wsEndpoint(),
    browserPid: server.process()?.pid ?? null,
    daemonPid: process.pid,
    startedAt: new Date().toISOString(),
  };
  // Publish the control endpoint. If this fails, tear the browser down rather than
  // orphan it. The file holds the browser control channel, so write it owner-only (0600)
  // and atomically (tmp + rename) — rename replaces even a pre-planted symlink at `file`
  // instead of following it, and readers never see a torn write.
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(info) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    process.stdout.write(`DAEMON_READY ${info.wsEndpoint}\n`);
  } catch (err) {
    try { await server.close(); } catch { /* already gone */ }
    process.stderr.write(`daemon publish failed: ${err?.message || err}\n`);
    process.exit(1);
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try { await server.close(); } catch { /* browser already gone */ }
    removeSession(file);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  // If the browser process dies on its own, don't leave a stale session file behind.
  server.process()?.on('exit', () => { removeSession(file); process.exit(0); });
}

main().catch((err) => {
  process.stderr.write(`daemon error: ${err?.message || err}\n`);
  process.exit(1);
});
