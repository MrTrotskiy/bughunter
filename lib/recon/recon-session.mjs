#!/usr/bin/env node
// recon-session — start/stop/status for the shared browser daemon (browser-daemon.mjs).
// A run brackets its acts with `--start` … `--stop` so every CLI in between connects to
// ONE chromium process instead of launching its own. File-only handoff: the daemon
// publishes state/session.json; recon CLIs read it via session.mjs attach().
//
// Usage:
//   node lib/recon/recon-session.mjs --start    # reap any stale session, boot the daemon
//   node lib/recon/recon-session.mjs --stop     # terminate the daemon + browser
//   node lib/recon/recon-session.mjs --status    # report liveness (no mutation)
// Success → one {ok:true,...} envelope on stdout, exit 0. Failure → {ok:false,...}, non-zero.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeEnvelope, exitCode } from '../core/envelope.mjs';

const DAEMON = fileURLToPath(new URL('./browser-daemon.mjs', import.meta.url));
const READY_TIMEOUT_MS = 15000;
const POLL_MS = 100;
// A pid read back from session.json is signalled ONLY if its process still looks like the
// thing we started — a crash + OS pid-reuse (or a tampered file) must not turn --start/--stop
// into an arbitrary-process-kill primitive.
const DAEMON_RE = /browser-daemon/;
const BROWSER_RE = /chrom(e|ium)|headless/i;

function stateDir() { return process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state'); }
function sessionPath() { return path.join(stateDir(), 'session.json'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readSession() {
  try { return JSON.parse(fs.readFileSync(sessionPath(), 'utf8')); } catch { return null; }
}

// A pid is alive if signal 0 does not throw. EPERM means it exists but is not ours —
// still alive. ESRCH means gone. Reject pid <= 0: process.kill(0,...) signals the WHOLE
// process group (incl. us), and negative pids signal groups — never from a data file.
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// The command line of a pid, or '' if it can't be read. execFile (no shell, fixed argv).
function processCommand(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return '';
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

// Signal `pid` ONLY if it is alive AND its command still matches what we started (re). A
// stale session.json after crash + pid-reuse, or a tampered one, cannot make us kill an
// unrelated process. Returns whether a signal was sent.
function killOwned(pid, re, signal) {
  if (isAlive(pid) && re.test(processCommand(pid))) {
    try { process.kill(pid, signal); return true; } catch { /* ignore */ }
  }
  return false;
}

function removeSession() {
  try { if (fs.existsSync(sessionPath())) fs.unlinkSync(sessionPath()); } catch { /* best effort */ }
}

// Kill a stale daemon/browser (only if the pids are still ours) and drop its session file,
// so --start always begins clean.
function reapStale(session) {
  if (!session) { removeSession(); return; }
  killOwned(session.daemonPid, DAEMON_RE, 'SIGTERM');
  killOwned(session.browserPid, BROWSER_RE, 'SIGTERM');
  removeSession();
}

async function start() {
  const existing = readSession();
  if (existing && isAlive(existing.daemonPid) && isAlive(existing.browserPid)) {
    return { ok: true, started: false, already: true, wsEndpoint: existing.wsEndpoint, daemonPid: existing.daemonPid };
  }
  reapStale(existing); // dead pids or half-written file → clean slate

  fs.mkdirSync(stateDir(), { recursive: true });
  const log = fs.openSync(path.join(stateDir(), 'daemon.log'), 'a', 0o600); // owner-only: holds the ws endpoint
  const child = spawn(process.execPath, [DAEMON], {
    detached: true,
    stdio: ['ignore', log, log], // file fds don't keep this parent alive
    env: process.env,
  });
  child.unref();
  fs.closeSync(log); // the child dup'd the fd; don't leak it (start() is also called programmatically)

  // Readiness = the daemon published a session.json with a live process. Accept either the
  // browser pid or the daemon pid so a platform that reports a null browser pid still boots.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const s = readSession();
    if (s && s.wsEndpoint && (isAlive(s.browserPid) || isAlive(s.daemonPid))) {
      return { ok: true, started: true, wsEndpoint: s.wsEndpoint, daemonPid: s.daemonPid, browserPid: s.browserPid };
    }
    if (Date.now() >= deadline) {
      // Tear down whatever the not-yet-ready daemon left behind: the child we spawned
      // (definitely ours) plus any browser/session it managed to publish.
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* ignore */ }
      reapStale(readSession());
      throw makeEnvelope({ code: 'DAEMON_TIMEOUT', message: `daemon did not become ready in ${READY_TIMEOUT_MS}ms (see ${path.join(stateDir(), 'daemon.log')})`, exit: 'ENV' });
    }
    await sleep(POLL_MS);
  }
}

async function stop() {
  const s = readSession();
  if (!s) return { ok: true, stopped: false, reason: 'no active session' };
  killOwned(s.daemonPid, DAEMON_RE, 'SIGTERM');
  killOwned(s.browserPid, BROWSER_RE, 'SIGTERM');
  // Give the daemon a moment to close the browser and remove its own session file.
  const deadline = Date.now() + 3000;
  while (fs.existsSync(sessionPath()) && Date.now() < deadline) await sleep(POLL_MS);
  // Escalate to SIGKILL anything still alive (a wedged server.close()), so we never leave
  // an unkillable orphan once the session file is gone.
  killOwned(s.daemonPid, DAEMON_RE, 'SIGKILL');
  killOwned(s.browserPid, BROWSER_RE, 'SIGKILL');
  removeSession();
  return { ok: true, stopped: true, daemonPid: s.daemonPid, browserPid: s.browserPid };
}

function status() {
  const s = readSession();
  if (!s) return { ok: true, alive: false };
  const alive = isAlive(s.browserPid) && isAlive(s.daemonPid);
  return { ok: true, alive, wsEndpoint: s.wsEndpoint, daemonPid: s.daemonPid, browserPid: s.browserPid };
}

function emitError(env) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: env.code, message: env.message } }) + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.find((a) => ['--start', '--stop', '--status'].includes(a));
  try {
    if (!cmd) throw makeEnvelope({ code: 'USAGE', message: 'one of --start | --stop | --status is required', exit: 'USAGE' });
    const result = cmd === '--start' ? await start() : cmd === '--stop' ? await stop() : status();
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (err) {
    const env = err?.code && err?.exit ? err : makeEnvelope({ code: 'INTERNAL', message: err?.message || 'unknown error', exit: 'VIOLATION' });
    emitError(env);
    process.exit(exitCode(env));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}

export { start, stop, status, isAlive, reapStale, killOwned };
