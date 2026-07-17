// resolveWritePolicy — the SINGLE source of truth for the write policy (readOnly + the WRITE-HUNT
// relaxation). Pure over (env, opts). Guards: huntWrites is a STRICT SUBSET of readOnly (never widens an
// anonymous crawl), needs BOTH the explicit opt-in (BUGHUNTER_HUNT / opts.hunt) AND a run id (the
// HUNT-<runId> ownership marker), and is OFF by default so a normal crawl is byte-identical read-only.
// FAIL-ON-REVERT: drop the `readOnly &&` guard on huntWrites → an anonymous hunt crawl arms writes → the
//   "huntWrites requires readOnly" assertion reds. Drop the run-id requirement → hunt without a marker →
//   the "needs a run id" assertion reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWritePolicy } from '../../lib/recon/read-only-firewall.mjs';

test('resolveWritePolicy: readOnly from opt / stateful / storage-state; default is neither', () => {
  assert.deepEqual(resolveWritePolicy({}, {}), { readOnly: false, huntWrites: false }, 'a bare anonymous crawl is neither read-only nor hunt');
  assert.equal(resolveWritePolicy({}, { readOnly: true }).readOnly, true, 'an explicit --read-only opt');
  assert.equal(resolveWritePolicy({}, { stateful: true }).readOnly, true, 'a stateful run is read-only');
  assert.equal(resolveWritePolicy({ BUGHUNTER_STORAGE_STATE: 'state/x.json' }, {}).readOnly, true, 'an authed (storageState) crawl is read-only');
});

test('resolveWritePolicy: huntWrites needs readOnly AND the opt-in AND a run id — a strict subset', () => {
  // The full arm: authed (or explicit read-only) + hunt opt-in + a run id.
  assert.deepEqual(
    resolveWritePolicy({ BUGHUNTER_HUNT: '1', BUGHUNTER_RUN_ID: 'r1' }, { readOnly: true }),
    { readOnly: true, huntWrites: true },
    'readOnly + BUGHUNTER_HUNT + BUGHUNTER_RUN_ID arms huntWrites',
  );
  assert.equal(resolveWritePolicy({}, { readOnly: true, hunt: true, runId: 'r1' }).huntWrites, true, 'opts.hunt + opts.runId arm it too');

  // Missing ANY leg → OFF.
  assert.equal(resolveWritePolicy({ BUGHUNTER_HUNT: '1', BUGHUNTER_RUN_ID: 'r1' }, {}).huntWrites, false, 'hunt opt-in WITHOUT readOnly does NOT arm (subset of readOnly)');
  assert.equal(resolveWritePolicy({ BUGHUNTER_HUNT: '1' }, { readOnly: true }).huntWrites, false, 'hunt WITHOUT a run id (no marker) does NOT arm');
  assert.equal(resolveWritePolicy({ BUGHUNTER_RUN_ID: 'r1' }, { readOnly: true }).huntWrites, false, 'a run id WITHOUT the hunt opt-in does NOT arm');
});
