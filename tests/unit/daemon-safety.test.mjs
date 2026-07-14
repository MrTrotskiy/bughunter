// Safety guards for the daemon control layer — pure, no browser. Both close attack
// surfaces the security review flagged on the new session.json trust boundary.
//
// Guards: (1) readSessionEndpoint refuses a NON-loopback wsEndpoint, so a tampered
//   session.json cannot redirect attach() to a remote/rogue Playwright server that would
//   capture every page (and typed credential) we drive; (2) killOwned refuses to signal a
//   live process whose command does not match what we started, so a crash + pid-reuse (or
//   a tampered file) cannot turn --start/--stop into an arbitrary-process-kill primitive.
// FAIL-ON-REVERT (1): drop the loopback check in readSessionEndpoint (session.mjs) →
//   the remote endpoint is returned → "non-loopback endpoint must be refused" fails.
// FAIL-ON-REVERT (2): drop the `re.test(processCommand(pid))` guard in killOwned
//   (recon-session.mjs) → a non-matching live pid is signalled → killOwned returns true →
//   "must NOT signal a live process whose command does not match" fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSessionEndpoint } from '../../lib/browser/session.mjs';
import { killOwned } from '../../lib/recon/recon-session.mjs';

function withState(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bughunter-ds-'));
  const prev = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = dir;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prev;
  });
  return dir;
}

function writeSession(dir, wsEndpoint) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ wsEndpoint, browserPid: 1, daemonPid: 1 }));
}

test('readSessionEndpoint accepts a loopback endpoint, refuses a remote one', (t) => {
  const dir = withState(t);

  writeSession(dir, 'ws://127.0.0.1:55123/abc');
  assert.equal(readSessionEndpoint(), 'ws://127.0.0.1:55123/abc', 'a loopback daemon endpoint is used');

  writeSession(dir, 'ws://10.0.0.9:55123/abc');
  assert.equal(readSessionEndpoint(), null, 'non-loopback endpoint must be refused (rogue-server redirect)');

  writeSession(dir, 'ws://evil.example.com:80/abc');
  assert.equal(readSessionEndpoint(), null, 'a public host endpoint must be refused');
});

test('killOwned only signals a process whose command matches what we started', () => {
  // Our own test process is alive; ps reports a node command. A matching regex + the
  // harmless null signal (0) → true; a non-matching regex → refused (no signal), even
  // though the pid is very much alive. This is the crash+pid-reuse safety.
  assert.equal(killOwned(process.pid, /node|bun|deno/i, 0), true, 'a matching live pid is signalled');
  assert.equal(
    killOwned(process.pid, /this-command-does-not-match-xyz/, 0),
    false,
    'must NOT signal a live process whose command does not match',
  );
  assert.equal(killOwned(2 ** 30, /node/, 0), false, 'a dead/absent pid is never signalled');
});
