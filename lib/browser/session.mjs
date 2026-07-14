// Browser lifecycle for recon: launch (or CONNECT to a shared daemon) chromium, open
// one page with the causal init-script installed BEFORE navigation, and gate every
// target URL through the SSRF host-policy.
//
// Two entry points, ONE wiring: launch() spawns a private chromium; attach() connects
// to a running browser daemon (state/session.json) when present so a whole run spends
// ONE chromium process, not one per act, and falls back to a cold launch when absent.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { isPrivateHost } from './host-policy.mjs';
import { stateProbeInitScript } from './probe.mjs';
import { attachCausalTracker } from './causal.mjs';
import { envelopeError } from '../core/envelope.mjs';

function sessionFile() {
  const stateDir = process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state');
  return path.join(stateDir, 'session.json');
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

// The daemon's endpoint if one is published, readable, AND loopback, else null. Never
// throws — a missing/corrupt session file just means "no daemon, cold-launch". The
// loopback check is a trust boundary: a tampered session.json pointing wsEndpoint at a
// remote/rogue Playwright server would otherwise route every page we drive (and any
// credentials typed into it) through the attacker's browser. The daemon only ever binds
// loopback, so a non-loopback endpoint is never ours — refuse it and cold-launch instead.
export function readSessionEndpoint() {
  try {
    const s = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
    const ws = typeof s.wsEndpoint === 'string' ? s.wsEndpoint : '';
    if (!ws) return null;
    let host;
    try { host = new URL(ws).hostname; } catch { return null; }
    if (!(LOOPBACK.has(host) || host.startsWith('127.'))) return null;
    return ws;
  } catch { return null; }
}

// Wire a fresh page for causal capture on a context. TWO things are installed BEFORE
// any navigation: the probe init-script (the fire-recording substrate) and the CDP
// initiator tracker. Both must precede the first navigation — the probe so it patches
// fetch before the first request, and the tracker so CDP async call stacks are on
// before the page schedules its timers (otherwise a load-time setInterval's polls
// carry no timer parent and get misclassified as foreground).
async function wire(context) {
  await context.addInitScript(stateProbeInitScript());
  const page = await context.newPage();
  await attachCausalTracker(page);
  return page;
}

function chromiumArgs() {
  // --no-sandbox REMOVES chromium's OS-level renderer sandbox. bughunter navigates
  // untrusted, hostile pages, so keep the sandbox ON by default; only drop it where the
  // environment cannot initialize it (root/CI containers) via PW_NO_SANDBOX=1.
  const args = ['--disable-dev-shm-usage'];
  if (process.env.PW_NO_SANDBOX === '1') args.push('--no-sandbox');
  return args;
}

// Spawn a PRIVATE chromium and open a wired page. Returns { browser, context, page }.
export async function launch(opts = {}) {
  const browser = await chromium.launch({ headless: opts.headless !== false, args: chromiumArgs() });
  try {
    const context = await browser.newContext();
    const page = await wire(context);
    return { browser, context, page };
  } catch (err) {
    await close(browser); // never leak the browser process on a partial-wiring failure
    throw err;
  }
}

// The resource-cheap entry callers should prefer. If a browser daemon is running
// (state/session.json with a live wsEndpoint), CONNECT to it and open a fresh
// context+page on the shared browser PROCESS — one chromium for the whole run, not one
// per act. Otherwise cold-launch a private browser (identical behavior to today), so a
// caller works with or without a daemon. Returns { browser, context, page, release,
// mode } — release() disconnects (daemon) or closes (cold). The causal wiring is
// IDENTICAL either way: fresh context → probe → page → tracker, all BEFORE navigation.
export async function attach(opts = {}) {
  const ws = readSessionEndpoint();
  if (ws) {
    let browser;
    try {
      browser = await chromium.connect(ws);
      const context = await browser.newContext();
      const page = await wire(context);
      return {
        browser, context, page, mode: 'attached',
        release: async () => { try { await browser.close(); } catch { /* connection already gone */ } },
      };
    } catch {
      // Stale/unreachable endpoint OR a partial failure after connect — close any
      // half-open connection so we never leak it, then self-heal to a cold launch.
      try { await browser?.close(); } catch { /* ignore */ }
    }
  }
  const cold = await launch(opts);
  return { ...cold, mode: 'cold', release: () => close(cold.browser) };
}

// Navigate through the SSRF gate. A private/loopback host is refused UNLESS
// PW_ALLOW_PRIVATE=1 (localhost fixtures need it). Throws an envelope-carrying
// Error so the CLI emits a structured refusal.
export async function gotoGated(page, url) {
  let host;
  try { host = new URL(url).hostname; }
  catch { throw envelopeError({ code: 'BAD_URL', message: `not a valid URL: ${url}`, exit: 'USAGE' }); }
  if (isPrivateHost(host) && process.env.PW_ALLOW_PRIVATE !== '1') {
    throw envelopeError({
      code: 'PRIVATE_HOST',
      message: `refusing private/loopback host "${host}"; set PW_ALLOW_PRIVATE=1 to allow local fixtures`,
      exit: 'USAGE',
    });
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

export async function close(browser) {
  try { await browser?.close(); } catch { /* nothing left to clean up */ }
}
