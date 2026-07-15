// contextOptions — the single newContext() option builder (session.mjs), applied at both
// the cold-launch and daemon-attach sites so ONE change authenticates the whole crawl.
// Pure w.r.t. env + filesystem existence, so it is unit-tested without a browser.
//
// Guards: BUGHUNTER_STORAGE_STATE injects a Playwright storageState into newContext (the
//   authed-crawl mechanism); a set-but-MISSING path fails loud (never a silent logged-out
//   fallback); opts.anonymous forces a clean context regardless of the env (login.mjs must
//   not inherit a prior session).
// FAIL-ON-REVERT (a): drop the `fs.existsSync` throw in contextOptions() → the missing-file
//   case returns { storageState } instead of throwing → "a missing state file must throw".
// FAIL-ON-REVERT (b): drop the `if (opts.anonymous) return {}` short-circuit → anonymous
//   returns { storageState } → "anonymous ignores the env storageState".

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

test('no BUGHUNTER_STORAGE_STATE → an empty (anonymous) context', (t) => {
  withStorageEnv(t, undefined);
  assert.deepEqual(contextOptions(), {});
});

test('an existing state file → newContext gets storageState: <path>', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bughunter-ctx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'storage-state.json');
  fs.writeFileSync(file, JSON.stringify({ cookies: [], origins: [] }));
  withStorageEnv(t, file);
  assert.deepEqual(contextOptions(), { storageState: file });
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
  assert.deepEqual(contextOptions({ anonymous: true }), {}, 'anonymous ignores the env storageState');
});

// anonymous must short-circuit BEFORE the existsSync check — login.mjs is always anonymous
// and a stale/missing BUGHUNTER_STORAGE_STATE in the operator's env must not make it throw.
test('opts.anonymous short-circuits before the existsSync check (a missing env path is fine)', (t) => {
  withStorageEnv(t, path.join(tmpdir(), 'bughunter-anon-missing-xyz.json'));
  assert.deepEqual(contextOptions({ anonymous: true }), {}, 'anonymous returns {} even when the env path is missing');
});
