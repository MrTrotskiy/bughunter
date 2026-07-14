// Minimal browser lifecycle for this slice: launch chromium, open one page with
// the causal init-script installed BEFORE navigation, and gate every target URL
// through the SSRF host-policy. Only what whats-new needs — no pooling, no reuse.

import { chromium } from '@playwright/test';
import { isPrivateHost } from './host-policy.mjs';
import { stateProbeInitScript } from './probe.mjs';
import { attachCausalTracker } from './causal.mjs';
import { envelopeError } from '../core/envelope.mjs';

// Launch chromium and open a page ready for causal capture. TWO things are wired
// up BEFORE any navigation: the probe init-script (the fire-recording substrate)
// and the CDP initiator tracker. Both must precede the first navigation — the probe
// so it patches fetch before the first request, and the tracker so CDP async call
// stacks are on before the page schedules its timers (otherwise a load-time
// setInterval's polls carry no timer parent and get misclassified as foreground).
export async function launch(opts = {}) {
  // --no-sandbox REMOVES chromium's OS-level renderer sandbox. bughunter navigates
  // untrusted, hostile pages, so keep the sandbox ON by default; only drop it where the
  // environment cannot initialize it (root/CI containers) via PW_NO_SANDBOX=1.
  const args = ['--disable-dev-shm-usage'];
  if (process.env.PW_NO_SANDBOX === '1') args.push('--no-sandbox');
  const browser = await chromium.launch({
    headless: opts.headless !== false,
    args,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(stateProbeInitScript());
  await attachCausalTracker(page);
  return { browser, context, page };
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
