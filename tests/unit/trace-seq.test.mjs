// trace.mjs derives an event `seq` and uses it as the graph-snapshot FILENAME. The agent path runs
// whats-new / observe / route-cli / frontier-cli as SEPARATE processes joined only by
// BUGHUNTER_RUN_ID, with NO lock — so the old read-the-whole-file-then-append could hand two
// processes the SAME seq. The appends survived that (each is one O_APPEND write), the snapshots did
// not: `graph/<seq>.json` meant the second copyFileSync silently DESTROYED the first process's graph
// state. A graph state vanished with no error, no warning, and no way to notice from the trail. That
// is DATA LOSS, not a perf nit; the O(n^2) re-read it also removes is the cheaper half of the fix.
//
// Guards: (a) concurrent trace writers on one run each keep their own graph snapshot — N appends
//   yield N snapshot files, never fewer; (b) events.ndjson still receives every append; (c) seq is
//   SEEDED from the lines already on disk, so a second process resuming a run continues the count
//   instead of restarting at 0 (which would collide the trail's step indices from the first event).
// FAIL-ON-REVERT: restore `graph/${seq}.json` in trace.mjs snapshotGraph (drop the pid suffix) →
//   the tied seqs overwrite each other → "every concurrent append kept its own graph snapshot"
//   goes red with the surviving file count. Restore the per-append full-file read (delete the
//   seqByRun memo) → the seed assertion still passes, so the snapshot assertion is the load-bearing
//   one; deleting the seed read instead (`let seq = 0` with no readFileSync) → "a resumed run
//   continues the seq" goes red with seq 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openRun, traceEvent, runDir } from '../../lib/debug/trace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACE_URL = pathToFileURL(path.join(HERE, '..', '..', 'lib', 'debug', 'trace.mjs')).href;

// The child: import trace.mjs, wait on the start barrier (so the writers genuinely overlap rather
// than being serialized by process spawn latency), then append N events and snapshot each one.
const CHILD = [
  "const fs = await import('node:fs');",
  "const m = await import(process.env.TRACE_URL);",
  "const runId = process.env.RUN_ID, n = Number(process.env.N);",
  "if (process.env.GO_FILE) {",
  "  fs.writeFileSync(process.env.READY_DIR + '/' + process.pid, '');",
  "  const sab = new Int32Array(new SharedArrayBuffer(4));",
  "  const t0 = Date.now();",
  "  while (!fs.existsSync(process.env.GO_FILE) && Date.now() - t0 < 20000) Atomics.wait(sab, 0, 0, 2);",
  "}",
  "let last = -1;",
  "for (let i = 0; i < n; i++) { last = m.traceEvent(runId, 'probe', { i, pid: process.pid }); m.snapshotGraph(runId, last); }",
  "process.stdout.write(String(last));",
].join('\n');

function spawnWriter(env) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', CHILD], { env },
      (err, stdout, stderr) => (err ? reject(new Error(`${err.message} :: ${stderr}`)) : resolve(stdout.trim())));
  });
}

test('concurrent trace writers never overwrite each other\'s graph snapshot', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-traceseq-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  t.after(() => { if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState; });

  // snapshotGraph only copies an EXISTING graph.json — give it one, else it is a silent no-op and
  // the file-count assertion would be vacuous (0 === 0).
  fs.writeFileSync(path.join(stateDir, 'graph.json'), JSON.stringify({ elements: {}, edges: [] }));

  const runId = 'r-20260720000000-cc01';
  openRun({ runId, target: 'http://example.test/' });

  const readyDir = path.join(stateDir, 'ready');
  fs.mkdirSync(readyDir, { recursive: true });
  const goFile = path.join(stateDir, 'go');

  const WRITERS = 4, PER_WRITER = 50;
  const base = { ...process.env, BUGHUNTER_STATE_DIR: stateDir, TRACE_URL, RUN_ID: runId,
    N: String(PER_WRITER), GO_FILE: goFile, READY_DIR: readyDir };
  const children = Array.from({ length: WRITERS }, () => spawnWriter(base));

  // Release the barrier once every writer is up, so all four hammer the same trail at once.
  const t0 = Date.now();
  while (fs.readdirSync(readyDir).length < WRITERS && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 5));
  assert.equal(fs.readdirSync(readyDir).length, WRITERS, 'all writers reached the barrier (else the race is untested)');
  fs.writeFileSync(goFile, '');
  await Promise.all(children);

  const total = WRITERS * PER_WRITER;

  // (b) every append landed — the event stream itself was never the broken half.
  const lines = fs.readFileSync(path.join(runDir(runId), 'events.ndjson'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, total, `every concurrent append landed in events.ndjson (got ${lines.length}/${total})`);
  assert.ok(lines.every((l) => JSON.parse(l).kind === 'probe'), 'every line parses as a probe event');

  // (a) THE BUG. One snapshot per append, or a graph state was silently destroyed.
  // FAIL-ON-REVERT: every concurrent append kept its own graph snapshot
  const snaps = fs.readdirSync(path.join(runDir(runId), 'graph'));
  assert.equal(new Set(snaps).size, snaps.length, 'snapshot filenames are distinct');
  assert.equal(snaps.length, total,
    `every concurrent append kept its own graph snapshot — ${total} expected, ${snaps.length} survived (${total - snaps.length} silently overwritten)`);
});

test('a resumed run continues the seq instead of restarting at 0', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-traceseed-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  t.after(() => { if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState; });

  const runId = 'r-20260720000000-cc02';
  openRun({ runId, target: 'http://example.test/' });
  assert.equal(traceEvent(runId, 'route', {}), 0, 'a fresh run starts at 0');
  assert.equal(traceEvent(runId, 'act', {}), 1);
  assert.equal(traceEvent(runId, 'observe', {}), 2, 'the in-memory counter increments without re-reading');

  // A NEW process (the agent path: whats-new hands off to observe) must SEED from the 3 lines on
  // disk. Without the seed read it would restart at 0 and re-use step indices 0..2.
  const seq = await spawnWriter({ ...process.env, BUGHUNTER_STATE_DIR: stateDir, TRACE_URL, RUN_ID: runId, N: '1' });
  assert.equal(Number(seq), 3, `a resumed run continues the seq — expected 3, got ${seq}`);

  const lines = fs.readFileSync(path.join(runDir(runId), 'events.ndjson'), 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(lines.map((l) => JSON.parse(l).seq), [0, 1, 2, 3], 'the trail carries a gap-free step index');
});
