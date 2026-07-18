// Live proof of hunt-cleanup — the DELETE half of the WRITE-HUNT CRUD self-test loop. A hunt run creates
// HUNT-<runId>-marked own content to exercise write endpoints; this removes it, leaving no litter. The ONE
// safety rail: it deletes ONLY an item whose OWN card text carries the exact marker (fail-closed, nested-item
// text stripped — hunt-gate.ownsTarget's scope), NEVER another user's content.
//
// Guards:
//   (A) MARKED-ONLY DELETE: on the hunt-social feed (self-1 marked, other-1 unmarked), cleanup deletes self-1
//       (deleteHits['self-1']===1, gone) and NEVER other-1 (deleteHits['other-1'] absent, still present,
//       forbiddenHits===0 — it never even attempted the unmarked one).
//   (B) DRY-RUN: reports the marked item but deletes nothing (deleted===0, self-1 still present).
//
// FAIL-ON-REVERT:
//   (A) neuter the marker ownership check in tagNextOwned (make `owns` always true) → cleanup also tags +
//       deletes other-1 → deleteHits['other-1']===1 (or forbiddenHits 0→1 as the server 403s a non-owned
//       delete) → the "never the unmarked" assertion reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { start } from '../fixtures/hunt-social-app/server.mjs';
import { huntCleanup } from '../../lib/recon/hunt-cleanup.mjs';

const RUN_ID = 'cleanuptest';
const MARKER = `HUNT-${RUN_ID}`;

function boot(t) {
  const prev = { allow: process.env.PW_ALLOW_PRIVATE, storage: process.env.BUGHUNTER_STORAGE_STATE, state: process.env.BUGHUNTER_STATE_DIR };
  process.env.PW_ALLOW_PRIVATE = '1';
  delete process.env.BUGHUNTER_STORAGE_STATE;   // cleanup attaches with a clean context (no daemon in a test)
  delete process.env.BUGHUNTER_STATE_DIR;       // no session.json → attach cold-launches
  t.after(() => {
    for (const [k, v] of [['PW_ALLOW_PRIVATE', prev.allow], ['BUGHUNTER_STORAGE_STATE', prev.storage], ['BUGHUNTER_STATE_DIR', prev.state]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

test('(A) hunt-cleanup deletes the marked own item, NEVER the unmarked other', async (t) => {
  boot(t);
  const server = await start(0, { marker: MARKER });
  const url = `http://127.0.0.1:${server.address().port}/`;
  t.after(() => server.close());

  const res = await huntCleanup({ url, runId: RUN_ID, max: 10 });

  const c = server.counters();
  assert.equal(res.found, 1, 'exactly one item carries the marker (self-1)');
  assert.equal(res.deleted, 1, 'cleanup deleted the one marked item');
  assert.equal(res.remaining, 0, 'no marked item remains after cleanup');
  assert.equal(c.deleteHits['self-1'], 1, 'our own marked post was deleted (DELETE reached the server, owned)');
  assert.ok(!c.deleteHits['other-1'], "the UNMARKED other user's post was NEVER deleted");
  assert.equal(c.forbiddenHits, 0, 'cleanup never even attempted a non-owned delete (no server 403)');
  assert.ok(server.posts().some((p) => p.id === 'other-1'), "the other user's post is still present, untouched");
});

test('(B) hunt-cleanup --dry-run reports the marked item but deletes nothing', async (t) => {
  boot(t);
  const server = await start(0, { marker: MARKER });
  const url = `http://127.0.0.1:${server.address().port}/`;
  t.after(() => server.close());

  const res = await huntCleanup({ url, runId: RUN_ID, dryRun: true, max: 10 });

  const c = server.counters();
  assert.equal(res.found, 1, 'dry-run found the marked item');
  assert.equal(res.deleted, 0, 'dry-run deleted nothing');
  assert.equal(res.items.length, 1, 'dry-run reported the one marked item');
  assert.ok(!c.deleteHits['self-1'], 'no DELETE reached the server in dry-run');
  assert.ok(server.posts().some((p) => p.id === 'self-1'), 'the marked post is still present after dry-run');
});
