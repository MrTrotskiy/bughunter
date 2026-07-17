// Live proof that an AUTHENTICATED run is write-protected on BOTH Phase-1 driver paths — the fix for the
// security gap a live authed crawl exposed (it FIRED a real POST /rawcaster/followandunfollow because the
// read-only firewall was wired into recon-run but ABSENT on the /recon → whats-new path the operator runs).
// DEFAULT-ON when authenticated: with BUGHUNTER_STORAGE_STATE set, readOnly is true regardless of flags, so
// the firewall installs itself and the account cannot be mutated. Driven through a real chromium + the
// read-only-app fixture (a benign-named non-GET write, a mutation-NAMED control, a write-verb POST, a read).
//
// Guards:
//   (C1) whats-new (the /recon agent path) installs the read-only firewall + refuseMutations when authed:
//        a benign-named POST write (D "Process" → POST /api/dostuff, no verb) is ABORTED (server hits 0)
//        yet its causal control→endpoint edge SURVIVES; a Follow-NAMED control (F → benign POST /api/x123)
//        is refused at CLICK time (MUTATION_FLOOR), the account never mutated.
//   (H2) recon-run couples readOnly to authentication: a crawl with BUGHUNTER_STORAGE_STATE set but NO
//        --stateful/--read-only STILL installs the firewall (result.readOnly present) and aborts the
//        write-verb POST (writeHits 0).
// FAIL-ON-REVERT:
//   (C1-i)  remove the `installReadOnlyFirewall` call in whats-new.mjs → D's POST /api/dostuff reaches the
//           server → "the benign POST was ABORTED (dostuffHits===0)" reds.
//   (C1-ii) drop `refuseMutations: readOnly` in whats-new's actStep call → acting F no longer rejects →
//           "acting a Follow-named control must reject (MUTATION_FLOOR)" reds.
//   (H2)    remove `|| !!process.env.BUGHUNTER_STORAGE_STATE` from recon-run's readOnly → the firewall is
//           not installed → result.readOnly is undefined AND writeHits becomes 1 → both H2 asserts red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/read-only-app/server.mjs';
import { run as whatsNew } from '../../lib/recon/whats-new.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';

const findByName = (graph, name) => Object.values(graph.elements).find((n) => n.name === name);

// Set up a throwaway storageState (never repo state/) + the loopback + isolated-state env so the run reads
// as AUTHENTICATED (BUGHUNTER_STORAGE_STATE set) without real creds. Restores every env var in t.after.
function authedEnv(t) {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-authed-fw-'));
  const statePath = path.join(stateDir, 'throwaway-storage-state.json');
  writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));
  const prev = {
    allow: process.env.PW_ALLOW_PRIVATE,
    state: process.env.BUGHUNTER_STATE_DIR,
    storage: process.env.BUGHUNTER_STORAGE_STATE,
  };
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  process.env.BUGHUNTER_STORAGE_STATE = statePath;
  t.after(() => {
    rmSync(stateDir, { recursive: true, force: true });
    for (const [k, v] of [['PW_ALLOW_PRIVATE', prev.allow], ['BUGHUNTER_STATE_DIR', prev.state], ['BUGHUNTER_STORAGE_STATE', prev.storage]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  return stateDir;
}

test('C1: the /recon whats-new path is write-protected on an authed run (benign POST aborted, Follow refused, edge survives)', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = authedEnv(t);
  t.after(() => server.close());

  // Baseline (authed → firewall on) seeds the four controls. A no-act run still carries a blocked ledger
  // (asserted below, after the core safety property, so a reverted firewall reds on the server-hit first).
  const base = await whatsNew({ url });
  const graph0 = loadGraph(path.join(stateDir, 'graph.json'));
  const d = findByName(graph0, 'Process');
  const f = findByName(graph0, 'Follow');
  assert.ok(d && f, 'D (Process) and F (Follow) were discovered at baseline');

  // (C1-i) Act the BENIGN-named write D → the network firewall ABORTS POST /api/dostuff (empty allowlist),
  //        yet the causal D→endpoint edge is STILL recorded (the API map survives the abort).
  const dRes = await whatsNew({ url, actTemplate: d.templateId });
  assert.equal(server.dostuffHits(), 0, 'the benign POST was ABORTED (dostuffHits===0) — the account cannot be mutated');
  assert.ok(base.blocked, 'an authed run surfaces the firewall refusal ledger even with no --act-template');
  const graph1 = loadGraph(path.join(stateDir, 'graph.json'));
  assert.ok(
    graph1.edges.some((e) => e.type === 'triggers' && e.from === `element:${d.templateId}` && e.to === 'request:POST /api/dostuff'),
    'the D→POST /api/dostuff triggers edge IS recorded — the causal map survives the network abort',
  );
  assert.ok(
    dRes.blocked && dRes.blocked.refusedPatterns.includes('POST /api/dostuff'),
    'the aborted benign write is surfaced in the run result blocked ledger (honesty)',
  );

  // (C1-ii) Act the Follow-NAMED control F → refuseMutations refuses it at CLICK time (MUTATION_FLOOR),
  //         before its benign-named POST /api/x123 can fire. The account is never mutated.
  await assert.rejects(
    () => whatsNew({ url, actTemplate: f.templateId }),
    (err) => err?.envelope?.code === 'MUTATION_FLOOR',
    'acting a Follow-named control must reject at click time (MUTATION_FLOOR) on an authed read-only run',
  );
  assert.equal(server.xHits(), 0, 'the Follow-named control never fired its benign-endpoint write — account unmutated');
});

test('H2: recon-run couples readOnly to authentication — BUGHUNTER_STORAGE_STATE alone installs the firewall', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  authedEnv(t); // BUGHUNTER_STORAGE_STATE set; NO --stateful / --read-only flag passed to crawl
  t.after(() => server.close());

  const result = await crawl({ url }); // stateful:undefined, readOnly:undefined — env coupling alone
  assert.ok(result.readOnly, 'an authed crawl installs the firewall from the env alone (result.readOnly present)');
  assert.equal(server.writeHits(), 0, 'the write-verb POST /api/followandunfollow was ABORTED — the authed account is unmutated');
});
