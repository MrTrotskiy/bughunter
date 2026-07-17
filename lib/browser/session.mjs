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
import { isPrivateHost, isLoopbackHost } from './host-policy.mjs';
import { stateProbeInitScript } from './probe.mjs';
import { attachCausalTracker } from './causal.mjs';
import { envelopeError } from '../core/envelope.mjs';

function sessionFile() {
  const stateDir = process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state');
  return path.join(stateDir, 'session.json');
}

// The daemon's endpoint if one is published, readable, AND loopback, else null. Never
// throws — a missing/corrupt session file just means "no daemon, cold-launch". The
// loopback check is a trust boundary: a tampered session.json pointing wsEndpoint at a
// remote/rogue Playwright server would otherwise route every page we drive (and any
// credentials typed into it) through the attacker's browser. The daemon only ever binds
// loopback, so a non-loopback endpoint is never ours — refuse it and cold-launch instead.
// isLoopbackHost() is the ONE canonical loopback classifier (host-policy.mjs): it strips
// IPv6 brackets, so a macOS daemon publishing ws://[::1]:PORT is trusted, and it rejects a
// look-alike hostname like "127.evil.com" that a naive `startsWith('127.')` would accept.
export function readSessionEndpoint() {
  try {
    const s = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
    const ws = typeof s.wsEndpoint === 'string' ? s.wsEndpoint : '';
    if (!ws) return null;
    let host;
    try { host = new URL(ws).hostname; } catch { return null; }
    if (!isLoopbackHost(host)) return null;
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

// The single newContext() option builder — applied at BOTH context-creation sites
// (cold launch + daemon attach) so ONE change authenticates the whole crawl. When
// BUGHUNTER_STORAGE_STATE points at a login.mjs-written Playwright storageState file
// (cookies + localStorage), every cold re-navigate in the crawl is already logged in.
// opts.anonymous forces a clean context (login.mjs itself creates the session and must
// not inherit a prior one). A set-but-missing state path FAILS LOUD (never a silent
// anonymous fallback): a run the operator believes is authenticated must not quietly
// crawl the logged-out surface. The attach→cold self-heal re-invokes this on the cold
// path, so the throw surfaces rather than being swallowed.
// A FIXED desktop viewport, set at this single newContext injection point. Playwright's default
// is an implicit 1280x720; leaving it unset lets a responsive layout collapse its nav differently
// run-to-run, so the NOT_VISIBLE coverage denominator drifts. Freezing one desktop size makes
// coverage reproducible. Applied to EVERY context (authed, anonymous, login) so one setting
// governs the whole crawl. Set once, then keep stable — changing it shifts which controls are
// `not-visible` (a one-time denominator move, not per-run noise).
const VIEWPORT = { width: 1440, height: 900 };

export function contextOptions(opts = {}) {
  // serviceWorkers:'block' — Playwright's page.route does NOT intercept Service-Worker-originated
  // requests, so a SW background-sync POST would BYPASS the read-only write-firewall; blocking service
  // workers closes that hole. Applies at BOTH newContext sites (this is the single option builder).
  const base = { viewport: { ...VIEWPORT }, serviceWorkers: 'block' };
  if (opts.anonymous) return base;
  const p = process.env.BUGHUNTER_STORAGE_STATE;
  if (!p) return base;
  if (!fs.existsSync(p)) {
    throw envelopeError({
      code: 'STORAGE_STATE_MISSING',
      message: `BUGHUNTER_STORAGE_STATE points at a missing file: ${p}; run lib/recon/login.mjs first`,
      exit: 'ENV',
    });
  }
  return { ...base, storageState: p };
}

// Spawn a PRIVATE chromium and open a wired page. Returns { browser, context, page }.
// opts.env (when provided) REPLACES the child process environment — login.mjs passes a
// credential-scrubbed copy so the browser subprocess never inherits the plaintext password.
export async function launch(opts = {}) {
  const launchOpts = { headless: opts.headless !== false, args: chromiumArgs() };
  if (opts.env) launchOpts.env = opts.env;
  const browser = await chromium.launch(launchOpts);
  try {
    const context = await browser.newContext(contextOptions(opts));
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
      const context = await browser.newContext(contextOptions(opts));
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

// The SSRF host gate, factored so gotoGated AND navigateGated share ONE definition — a new
// nav helper can never bypass it. A private/loopback host is refused UNLESS PW_ALLOW_PRIVATE=1
// (localhost fixtures need it). Throws an envelope-carrying Error so the CLI emits a structured refusal.
function ssrfGate(url) {
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
}

// Navigate through the SSRF gate and RETURN the navigation Response (page.goto's return), so a
// caller needing the HTTP status — route-frontier's reachability check (404 / redirect) — can read
// it. Same gate as gotoGated, no bypass. Returns { page, response } (response is null on some
// same-document navigations, per Playwright). gotoGated is the response-discarding sibling.
export async function navigateGated(page, url) {
  ssrfGate(url);
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { page, response };
}

// Navigate through the SSRF gate. Backward-compatible thin wrapper over navigateGated — every
// existing caller ignores the return, so keeping the `page` return keeps them all working.
export async function gotoGated(page, url) {
  await navigateGated(page, url);
  return page;
}

export async function close(browser) {
  try { await browser?.close(); } catch { /* nothing left to clean up */ }
}
