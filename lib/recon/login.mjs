#!/usr/bin/env node
// login — the authenticated-recon PRE-STEP. Drives a clean chromium ONCE to a login
// form, submits operator-supplied credentials, verifies the session started, and writes
// a Playwright storageState file (cookies + localStorage) that every later crawl loads
// via BUGHUNTER_STORAGE_STATE — so the recon loop maps the AUTHENTICATED surface with the
// SAME graph + causal-capture machinery, unchanged. This is SETUP, not a measured act:
// it opens no debug trail and captures no key-frame, so the credential-filled frame is
// never recorded and the causal token/initiator attribution is untouched.
//
// Credentials come from the environment (BUGHUNTER_LOGIN_USER / BUGHUNTER_LOGIN_PASS),
// never argv (world-readable via `ps`) and never a parsed file. The values are filled
// into the form and DISCARDED — they are written to no graph, no trace, and no output
// envelope (which carries counts only). The storageState file may hold session tokens,
// so it lands in the gitignored state/ dir at mode 0600.
//
// Usage: node lib/recon/login.mjs --login-url=<url> [--out=<path>]
//        [--user-selector=<css>] [--pass-selector=<css>] [--submit-selector=<css>] [--success=<urlSubstr|css>]
// env (operator-exported): BUGHUNTER_LOGIN_USER, BUGHUNTER_LOGIN_PASS (required); PW_ALLOW_PRIVATE=1 for localhost.
// Success → {ok:true, out, cookies:<n>, origins:<n>} on stdout, exit 0.
// Failure → {ok:false, error:{code,message}} on stderr, non-zero exit — NEVER contains a credential.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnvelope, envelopeError, exitCode } from '../core/envelope.mjs';
import { launch, gotoGated, close } from '../browser/session.mjs';
import { waitSettled } from '../browser/causal.mjs';
import { dismissOverlays } from './overlays.mjs';

// Heuristic field discovery (flags override). The password field is the ANCHOR — found
// first, then the username + submit are scoped to its enclosing <form>, so a decoy input or
// submit in a DIFFERENT form (a header newsletter/search) is never filled or clicked. The
// username selectors are tried in PRIORITY order (first that resolves wins) — NOT the
// document-order semantics of one comma list, which would pick whichever matched first in
// the DOM regardless of selector specificity.
const PASS_GUESS = 'input[type=password]';
const USER_SELECTORS = [
  'input[type=email]', 'input[autocomplete=username]',
  'input[name*=user i]', 'input[name*=email i]',
  'input[type=text]', 'input[type=tel]',
];
// Analytics/tracking cookie prefixes — their presence NEVER indicates a session. A login that
// "left the form" (SPA redirect) yet set ONLY these is still LOGGED OUT (the silent-guest-crawl bug).
const TRACKING_COOKIE = /^(?:_ga|_gid|_gat|_gcl|_fbp|_fbc|__utm|_hj|_pk_|amplitude|mp_|ajs_|intercom-|optimizely)/i;

// A REAL session artifact exists: a NON-tracking cookie (a session/auth cookie the app set on
// login). This is the load-bearing guard — "left the login form" alone is a false positive, because
// an SPA can redirect post-submit while having set only _ga* trackers (exactly the guest-crawl bug).
// Cookie-based only by default; a site that stores auth ONLY in localStorage (persist:root is present
// for guests too, so a key-name check is worthless) must pass an explicit --success selector/url.
async function hasSessionArtifact(page) {
  try {
    const cookies = await page.context().cookies();
    return cookies.some((c) => c.name && !TRACKING_COOKIE.test(c.name));
  } catch { return false; }
}

// Find the real submit control. The old `button[type=submit], input[type=submit], button` guess fed
// to a single `.$()` returns the FIRST match in DOCUMENT order across ALL three clauses — so a bare
// button earlier in the DOM (a social "Sign in with Google", a password eye-toggle) wins over the
// actual submit and the credentials are never posted. Prefer a typed submit, THEN a button whose
// accessible name is a submit verb, and only THEN any button.
async function findSubmit(scope) {
  const typed = await scope.$('button[type=submit], input[type=submit]').catch(() => null);
  if (typed) return typed;
  const buttons = await scope.$$('button, [role=button]').catch(() => []);
  for (const b of buttons) {
    const t = (await b.evaluate((e) => (e.textContent || e.getAttribute('aria-label') || '').trim().toLowerCase()).catch(() => '')) || '';
    if (/log\s?in|sign\s?in|continue|submit|next|proceed/.test(t)) return b;
  }
  return buttons[0] || null;
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}

// True when the submit LEFT the login form: the password field is gone OR the pathname
// changed off the login url. An explicit --success (a url substring or a CSS selector)
// overrides the heuristic. Never trusts page text.
async function loginSucceeded(page, loginUrl, passSelector, success) {
  if (success) {
    if (page.url().includes(success)) return true;
    const bySel = await page.$(success).catch(() => null);
    return !!bySel;
  }
  // (1) The submit must have LEFT the login form: password field gone, OR pathname changed off /login.
  const passStillThere = await page.$(passSelector).catch(() => null);
  let left;
  if (passStillThere) {
    try { left = new URL(page.url()).pathname !== new URL(loginUrl).pathname; } catch { left = false; }
  } else {
    left = true;
  }
  if (!left) return false;
  // (2) AND a real (non-tracking) session artifact exists. "Left the form" alone was a false positive:
  // a post-submit SPA redirect that set only analytics cookies read as success and a run then silently
  // crawled the LOGGED-OUT surface. Requiring a session cookie makes that state fail loud instead.
  return await hasSessionArtifact(page);
}

export async function login(opts) {
  const loginUrl = opts.loginUrl;
  if (!loginUrl) throw envelopeError({ code: 'USAGE', message: 'missing required --login-url=<url>', exit: 'USAGE' });
  const user = process.env.BUGHUNTER_LOGIN_USER;
  const pass = process.env.BUGHUNTER_LOGIN_PASS;
  // Never echo the values; the message names only the missing env var.
  if (!user || !pass) {
    throw envelopeError({ code: 'USAGE', message: 'set BUGHUNTER_LOGIN_USER and BUGHUNTER_LOGIN_PASS in the environment', exit: 'USAGE' });
  }

  const stateDir = process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state');
  const out = opts.out || path.join(stateDir, 'storage-state.json');
  const passSelector = opts.passSelector || PASS_GUESS;
  // Remove any stale session up front: a failed login then leaves no old storageState a
  // later crawl would reuse believing this run refreshed it.
  fs.rmSync(out, { force: true });

  // Body capture must be STRUCTURALLY impossible during the credential exchange, not merely
  // because /recon happens to mint the runId later. The double gate reads these from THIS
  // process's env when the tracker is wired (attachInitiatorTracker), so clear them HERE —
  // login then captures no request/response body regardless of run ordering.
  delete process.env.BUGHUNTER_RUN_ID;
  delete process.env.BUGHUNTER_CAPTURE_BODIES;

  // A CLEAN, private context — never inherit a prior session or an existing storageState.
  // The child env is SCRUBBED of the credentials so the chromium process (and its renderer
  // children) cannot read the plaintext password from /proc/<pid>/environ.
  const childEnv = { ...process.env };
  delete childEnv.BUGHUNTER_LOGIN_USER;
  delete childEnv.BUGHUNTER_LOGIN_PASS;
  const { browser, context, page } = await launch({ anonymous: true, env: childEnv });
  try {
    await gotoGated(page, loginUrl);        // SSRF gate preserved
    await waitSettled(page);
    await dismissOverlays(page);            // a consent wall can hide the form
    await waitSettled(page);

    // Password is the anchor; scope the username + submit to ITS <form> so a decoy field in
    // another form is never touched. An explicit --user/--submit-selector is trusted page-wide.
    const passHandle = await page.$(passSelector);
    if (!passHandle) throw envelopeError({ code: 'LOGIN_FAILED', message: 'password field not found on the login page', exit: 'VIOLATION' });
    const formHandle = await passHandle.evaluateHandle((el) => el.closest('form'));
    const scope = formHandle.asElement() || page; // no <form> → fall back to page-wide

    // Refuse to submit the credentials to an OFF-ORIGIN form action — checked BEFORE typing
    // them, so a compromised/XSS'd login page whose form POSTs to an attacker never receives
    // the password. form.action resolves to an absolute url (the document url when unset).
    if (scope !== page) {
      const action = await scope.evaluate((f) => f.action || '');
      if (action) {
        let same = false;
        try { same = new URL(action).origin === new URL(page.url()).origin; } catch { same = false; }
        if (!same) throw envelopeError({ code: 'LOGIN_FAILED', message: 'refusing to submit credentials to an off-origin form action', exit: 'VIOLATION' });
      }
    }

    // Username: --user-selector (page-wide) else the first priority selector resolving in the form.
    let userHandle = opts.userSelector ? await page.$(opts.userSelector) : null;
    if (!userHandle && !opts.userSelector) {
      for (const sel of USER_SELECTORS) { userHandle = await scope.$(sel); if (userHandle) break; }
    }
    if (!userHandle) throw envelopeError({ code: 'LOGIN_FAILED', message: 'username/email field not found on the login page', exit: 'VIOLATION' });

    await userHandle.fill(user, { timeout: 5000 });
    await passHandle.fill(pass, { timeout: 5000 });

    // Submit: --submit-selector (page-wide, operator was explicit) else scoped to the form.
    const submitHandle = opts.submitSelector ? await page.$(opts.submitSelector) : await findSubmit(scope);
    if (submitHandle) await submitHandle.click({ timeout: 5000 });
    else await passHandle.press('Enter');
    await waitSettled(page);

    // SPA logins commonly resolve auth via an async XHR and THEN client-navigate / re-render —
    // which lands AFTER the network goes idle (waitSettled returns). Checking success ONCE here
    // reads a slow redirect as a false LOGIN_FAILED, so poll the signal over a bounded window
    // (early-exit on the first success — no added latency for a fast login). Verification
    // semantics are unchanged: loginSucceeded still gates persistence, never a fixed sleep.
    let started = false;
    for (let i = 0; i < 32 && !started; i++) {
      started = await loginSucceeded(page, loginUrl, passSelector, opts.success);
      if (!started) await new Promise((r) => setTimeout(r, 250));
    }
    if (!started) {
      // Verify BEFORE persisting — never write a storageState for an unauthenticated
      // session (a run would then silently crawl the logged-out surface believing it is in).
      throw envelopeError({ code: 'LOGIN_FAILED', message: 'login did not start a session (still on the form / no success signal)', exit: 'VIOLATION' });
    }

    // Persist with NO world-readable window: pre-create the file 0600 so Playwright's
    // truncate-write preserves the mode (its default write would be 0644 until the chmod).
    // path.dirname covers a custom --out in a not-yet-existing dir.
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, '', { mode: 0o600 });
    const state = await context.storageState({ path: out });
    fs.chmodSync(out, 0o600);               // belt-and-suspenders; the file may hold a session token
    // Counts only — never the values.
    return { ok: true, out, cookies: state.cookies.length, origins: state.origins.length };
  } finally {
    await close(browser);
  }
}

function emitError(env) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: env.code, message: env.message } }) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['login-url']) {
    emitError(makeEnvelope({ code: 'USAGE', message: 'missing required --login-url=<url>', exit: 'USAGE' }));
    process.exit(64);
  }
  try {
    const result = await login({
      loginUrl: args['login-url'], out: args.out,
      userSelector: args['user-selector'], passSelector: args['pass-selector'],
      submitSelector: args['submit-selector'], success: args.success,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (err) {
    let env = err && err.envelope;
    if (!env) {
      const code = typeof err?.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(err.code) ? err.code : 'INTERNAL';
      env = makeEnvelope({ code, message: err?.message || 'unknown error', exit: 'VIOLATION' });
    }
    emitError(env);
    process.exit(exitCode(env));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
