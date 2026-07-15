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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { contextOptions } from '../../lib/browser/session.mjs';

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
