// The AGENT path may not write the graph without claiming the state dir.
//
// WHY THIS TEST EXISTS. `state-lock.mjs` was added after three concurrent crawls destroyed each other's
// graph for half an hour — one run's element count oscillated 265 → 73 → 302 → 263 → 349 between ADJACENT
// snapshots, and every graph-derived number of that session had to be retracted. `recon-run` and
// `whats-new` were given the claim; `observe` and `route-cli` were not, though both call `saveGraph`
// (three call sites each) — a whole-file overwrite with no merge.
//
// /recon happens to invoke them sequentially. That is a property of one caller's ordering, not of the
// code: nothing stopped a second `observe`, a stray `route-cli`, or an overlapping `recon-run` from
// writing the same dir. The gap was on the ONE path the operator's rule targets — the path where an
// LLM subagent drives the CLIs.
//
// FAIL-ON-REVERT: remove the `acquireStateDir` wrapper from either CLI and its case here goes green-to-red
// — the call returns/throws something other than STATE_DIR_BUSY, i.e. it wrote the graph unclaimed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireStateDir } from '../../lib/recon/state-lock.mjs';
import { observe } from '../../lib/recon/observe.mjs';
import { run as routeCli } from '../../lib/recon/route-cli.mjs';

// A state dir already owned by a LIVE process — the exact condition the lock exists to refuse.
// Held by this pid, so the liveness probe (`process.kill(pid, 0)`) genuinely says "alive".
function withBusyStateDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-lock-'));
  const prev = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = dir;
  const release = acquireStateDir(dir, { runId: 'holder' });
  try {
    return fn(dir);
  } finally {
    release();
    if (prev === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// `assert.throws` returns undefined, so it cannot be used to INSPECT the envelope — the whole point
// here is which code came back, not merely that something threw.
function caught(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}

test('observe refuses a state dir owned by a live crawl', () => {
  withBusyStateDir(() => {
    // Deliberately valid-looking arguments: the refusal must come from the LOCK, before any
    // validation or graph read, so a broken-args error cannot masquerade as the guard working.
    const err = caught(() => observe({
      template: '1', purpose: 'x', danger: 'safe', effect: 'none', acted: 'true',
    }));
    assert.equal(err?.envelope?.code, 'STATE_DIR_BUSY', `expected STATE_DIR_BUSY, got ${err?.envelope?.code || err?.message}`);
  });
});

test('route-cli refuses a state dir owned by a live crawl', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-lock-'));
  const prev = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = dir;
  const release = acquireStateDir(dir, { runId: 'holder' });
  try {
    // No browser is ever acquired: the claim is taken before attach(), so this stays a unit test.
    const err = await routeCli({ url: 'http://example.test/' }).then(
      (v) => new Error(`expected a refusal, resolved with ${JSON.stringify(v)}`),
      (e) => e,
    );
    assert.equal(err?.envelope?.code, 'STATE_DIR_BUSY', `expected STATE_DIR_BUSY, got ${err?.envelope?.code || err?.message}`);
  } finally {
    release();
    if (prev === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the claim is released, so a second sequential call succeeds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-lock-'));
  const prev = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = dir;
  try {
    // Guards the other failure direction: a lock that is never released would make /recon deadlock
    // against itself on the second act, which is worse than the hole it closes. observe throws
    // NO_TEMPLATE here (empty graph) — the point is that it got PAST the claim, twice.
    for (const pass of [1, 2]) {
      const err = caught(() => observe({ template: '999', purpose: 'x', danger: 'safe', effect: 'none' }));
      assert.equal(err?.envelope?.code, 'NO_TEMPLATE', `pass ${pass} was blocked by a stale claim, not by the graph`);
    }
  } finally {
    if (prev === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
