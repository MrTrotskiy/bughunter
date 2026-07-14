// Live proof of the fire-path danger gate (security H1). The coarse floor is only a
// real safeguard if it stops the ACT, not just the post-hoc record: whats-new must
// REFUSE to click an obvious destructive control, and the destructive request must
// never leave the browser. We assert both — the DANGER_FLOOR refusal AND zero server
// hits — against a real chromium + a fixture whose Delete button POSTs /api/delete.
//
// Guards: the fire path (actStep) refuses to click a destructive/auth/payment control,
//   so a mis-judging caller (or a manual --act-template) cannot trigger its effect.
// FAIL-ON-REVERT: drop the FIRE_BLOCKED gate in lib/recon/step.mjs → whats-new clicks
//   Delete → /api/delete fires → the promise resolves (no rejection) and deleteHits()
//   becomes 1 → "acting on a destructive control must reject" + the hits assertion go red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/danger-app/server.mjs';
import { run as whatsNew } from '../../lib/recon/whats-new.mjs';
import { emit } from '../../lib/recon/frontier-cli.mjs';

test('the fire path refuses to click a destructive control and fires no request', async (t) => {
  const server = await start(0);
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-danger-'));
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  t.after(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });

  // Baseline seeds the graph with the Delete template; the frontier surfaces it.
  await whatsNew({ url });
  const del = emit().batch.find((b) => b.name === 'Delete');
  assert.ok(del, 'the Delete control must be discovered in the frontier');

  // Acting on it must be REFUSED before the click — the whole point of the gate.
  await assert.rejects(
    () => whatsNew({ url, actTemplate: del.templateId }),
    (err) => err?.envelope?.code === 'DANGER_FLOOR',
    'acting on a destructive control must reject with DANGER_FLOOR',
  );

  // And the destructive effect never reached the server: the gate stopped the click,
  // not merely the record. This is the assertion the token-only design could not make.
  assert.equal(server.deleteHits(), 0, 'no /api/delete request may fire for a refused control');
});
