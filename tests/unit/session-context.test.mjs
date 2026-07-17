// contextOptions — the single newContext() option builder (session.mjs), applied at both
// the cold-launch and daemon-attach sites so ONE change authenticates the whole crawl.
// Pure w.r.t. env + filesystem existence, so it is unit-tested without a browser.
//
// Guards: BUGHUNTER_STORAGE_STATE injects a Playwright storageState into newContext (the
//   authed-crawl mechanism); a set-but-MISSING path fails loud (never a silent logged-out
//   fallback); opts.anonymous forces a clean context regardless of the env (login.mjs must
//   not inherit a prior session); every context carries a FIXED desktop viewport (reproducible
//   NOT_VISIBLE denominator, not Playwright's implicit default).
// FAIL-ON-REVERT (a): drop the `fs.existsSync` throw in contextOptions() → the missing-file
//   case returns { storageState } instead of throwing → "a missing state file must throw".
// FAIL-ON-REVERT (b): drop the `if (opts.anonymous) return base` short-circuit → anonymous
//   returns { storageState } → "anonymous ignores the env storageState".
// FAIL-ON-REVERT (c): drop `viewport` from the returned base → the fixed-viewport asserts go red.
//
// Also guards readSessionEndpoint() — the daemon-attach trust boundary. A published
// session.json is trusted ONLY when its wsEndpoint host is loopback; a bracketed IPv6
// loopback (ws://[::1]:PORT, the macOS launchServer form) MUST be accepted, and a LAN
// endpoint MUST be refused (null → cold-launch).
// FAIL-ON-REVERT (d): restore the bracket-blind `LOOPBACK.has(host) || host.startsWith('127.')`
//   check → the '[::1]' endpoint returns null instead of the string → "a loopback [::1]
//   endpoint must be trusted". Neuter isLoopbackHost to always-true → the LAN endpoint is
//   trusted → "a non-loopback LAN endpoint must be refused".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { contextOptions, readSessionEndpoint } from '../../lib/browser/session.mjs';

function withStorageEnv(t, value) {
  const prev = process.env.BUGHUNTER_STORAGE_STATE;
  if (value === undefined) delete process.env.BUGHUNTER_STORAGE_STATE; else process.env.BUGHUNTER_STORAGE_STATE = value;
  t.after(() => {
    if (prev === undefined) delete process.env.BUGHUNTER_STORAGE_STATE; else process.env.BUGHUNTER_STORAGE_STATE = prev;
  });
}

test('no BUGHUNTER_STORAGE_STATE → no storageState (anonymous surface)', (t) => {
  withStorageEnv(t, undefined);
  assert.equal(contextOptions().storageState, undefined);
});

test('an existing state file → newContext gets storageState: <path>', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bughunter-ctx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'storage-state.json');
  fs.writeFileSync(file, JSON.stringify({ cookies: [], origins: [] }));
  withStorageEnv(t, file);
  assert.equal(contextOptions().storageState, file);
});

test('every context carries a fixed desktop viewport (reproducible NOT_VISIBLE denominator)', (t) => {
  withStorageEnv(t, undefined);
  const vp = contextOptions().viewport;
  assert.ok(vp && vp.width >= 1280 && vp.height >= 720, 'a fixed desktop viewport is set');
  // Anonymous (login) contexts get it too — one setting governs the whole crawl.
  assert.deepEqual(contextOptions({ anonymous: true }).viewport, vp, 'anonymous context has the same fixed viewport');
});

// serviceWorkers:'block' (security M2): Playwright's page.route does NOT intercept SW-originated
// requests, so a service worker's background-sync POST would bypass the read-only write-firewall.
// Blocking service workers at the single context builder closes that hole on BOTH newContext sites.
// FAIL-ON-REVERT (e): drop `serviceWorkers:'block'` from base → these asserts go red.
test('every context blocks service workers so a SW request cannot bypass the write-firewall', (t) => {
  withStorageEnv(t, undefined);
  assert.equal(contextOptions().serviceWorkers, 'block', 'the default context blocks service workers');
  assert.equal(contextOptions({ anonymous: true }).serviceWorkers, 'block', 'anonymous (login) contexts block them too');
});

test('a set-but-MISSING state file fails loud (STORAGE_STATE_MISSING), never silent', (t) => {
  withStorageEnv(t, path.join(tmpdir(), 'bughunter-does-not-exist-xyz.json'));
  assert.throws(() => contextOptions(), (err) => err?.envelope?.code === 'STORAGE_STATE_MISSING',
    'a missing state file must throw, not fall back to anonymous');
});

test('opts.anonymous forces a clean context regardless of the env', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bughunter-ctx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'storage-state.json');
  fs.writeFileSync(file, JSON.stringify({ cookies: [], origins: [] }));
  withStorageEnv(t, file);
  assert.equal(contextOptions({ anonymous: true }).storageState, undefined, 'anonymous ignores the env storageState');
});

// anonymous must short-circuit BEFORE the existsSync check — login.mjs is always anonymous
// and a stale/missing BUGHUNTER_STORAGE_STATE in the operator's env must not make it throw.
test('opts.anonymous short-circuits before the existsSync check (a missing env path is fine)', (t) => {
  withStorageEnv(t, path.join(tmpdir(), 'bughunter-anon-missing-xyz.json'));
  assert.equal(contextOptions({ anonymous: true }).storageState, undefined, 'anonymous returns no storageState even when the env path is missing');
});

// readSessionEndpoint reads BUGHUNTER_STATE_DIR/session.json dynamically per call, so a
// temp dir + this env is enough to drive it without a browser or a live daemon.
function withStateDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bughunter-session-'));
  const prev = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('readSessionEndpoint trusts a bracketed IPv6 loopback endpoint (the macOS launchServer form)', (t) => {
  const dir = withStateDir(t);
  const ws = 'ws://[::1]:50798/abc';
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ wsEndpoint: ws }));
  assert.equal(readSessionEndpoint(), ws, 'a loopback [::1] endpoint must be trusted, not force a cold launch');
});

test('readSessionEndpoint refuses a non-loopback LAN endpoint (trust boundary holds)', (t) => {
  const dir = withStateDir(t);
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ wsEndpoint: 'ws://192.168.1.50:9222/x' }));
  assert.equal(readSessionEndpoint(), null, 'a non-loopback LAN endpoint must be refused (cold-launch)');
});
