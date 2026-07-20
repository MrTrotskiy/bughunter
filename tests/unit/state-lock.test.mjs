// ONE CRAWL PER STATE DIR.
//
// THE MEASURED FAILURE. "One incremental graph is the source of truth" was a founding invariant that
// NOTHING enforced. `saveGraph` writes the whole file with no lock and `recon-run` re-reads the graph at
// the start of every round, so two crawls sharing a state dir adopt and overwrite each other once per
// round. Three crawls were started against one target without `BUGHUNTER_STATE_DIR` and destroyed each
// other's data for half an hour: ONE run's element count read 265 → 73 → 302 → 263 → 349 across ADJACENT
// snapshots — file clobbering, not discovery. Every graph-derived comparison from that day was retracted.
// Nothing warned; each run printed rising coverage throughout.
//
// Guards: a second crawl cannot claim a state dir a LIVE crawl owns, and the refusal names the holder;
//   a stale lock (owner process gone) is reclaimed rather than blocking forever; release is scoped to the
//   owner, so a reclaiming crawl can never delete a different live crawl's claim.
// FAIL-ON-REVERT: make `acquireStateDir` always succeed (drop the EEXIST branch) → "a second crawl is
//   refused" reds, which is exactly the silence that cost the retracted day.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireStateDir, releaseStateDir, stateDirOwner } from '../../lib/recon/state-lock.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bh-lock-'));

test('a second crawl is refused while a live crawl owns the state dir', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const release = acquireStateDir(dir, { runId: 'first' });
  assert.equal(stateDirOwner(dir).runId, 'first', 'the first crawl owns it');

  // A second crawl in ANOTHER process (a different, live pid — this test process stands in for it).
  assert.throws(
    () => acquireStateDir(dir, { runId: 'second', pid: process.pid }),
    (err) => {
      assert.equal(err.envelope?.code, 'STATE_DIR_BUSY', 'refused with a named code');
      assert.match(err.message, /BUGHUNTER_STATE_DIR/, 'and the message tells the operator the fix');
      assert.match(err.message, /first/, 'and names the holder, so "which one?" is answerable');
      return true;
    },
    'two crawls must never share a state dir — that is the retracted-day defect',
  );

  release();
  assert.equal(stateDirOwner(dir), null, 'released');
  acquireStateDir(dir, { runId: 'third' })();   // free again
});

test('a stale lock is reclaimed, not obeyed forever', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // A crawl that was kill -9'd: the owner file outlives the process. pid 2^31-1 is not running.
  fs.writeFileSync(path.join(dir, 'OWNER.json'),
    JSON.stringify({ runId: 'crashed', pid: 2147483647, startedAt: '2026-01-01T00:00:00.000Z' }));

  const release = acquireStateDir(dir, { runId: 'after-crash' });
  assert.equal(stateDirOwner(dir).runId, 'after-crash',
    'a dead owner must not block the next crawl — the lock is a fact about a LIVE process');
  release();
});

test('release only ever removes OUR claim', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  acquireStateDir(dir, { runId: 'owner', pid: process.pid });
  // Someone else's release attempt must be a no-op, or a reclaiming crawl could delete a live claim.
  assert.equal(releaseStateDir(dir, { pid: process.pid + 1 }), false, 'not ours, not removed');
  assert.ok(stateDirOwner(dir), 'the real owner still holds it');
  assert.equal(releaseStateDir(dir, { pid: process.pid }), true, 'ours, removed');
});

test('a corrupt owner file counts as stale', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'OWNER.json'), '{ not json');
  const release = acquireStateDir(dir, { runId: 'ok' });
  assert.equal(stateDirOwner(dir).runId, 'ok', 'nobody can prove they hold an unreadable lock');
  release();
});
