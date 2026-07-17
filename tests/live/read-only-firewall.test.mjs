// Live proof of the SESSION-WIDE read-only WRITE-FIREWALL (lib/recon/read-only-firewall.mjs), now
// ABORT-BY-DEFAULT (CTO blocker-1). A live authed stateful rawcaster run fired POST /rawcaster/followandunfollow
// (a real follow/unfollow) AND — the residual the OLD default left open — any benign-named non-GET reached the
// server. The inverted firewall aborts EVERY non-GET by default and re-opens ONLY an AGENT-JUDGED read-allowlist,
// WITHOUT breaking reads-over-POST (the way content loads on rawcaster). Driven through the real actStep with the
// firewall installed session-wide (the deterministic model of "an act fires a mutation on the live page").
//
// Guards:
//   (1) WRITE-VERB ABORT, MAP PRESERVED — acting W (POST /api/followandunfollow) ABORTS the mutation
//       (writeHits 0 — account unmutated) YET the causal W→endpoint edge is STILL recorded (the API map
//       survives the network abort), surfaced blocked write-verb.
//   (2) INVERSION: BENIGN NON-GET ABORTED BY DEFAULT — acting D ("Process" → POST /api/dostuff, no write verb,
//       benign name) with an EMPTY allowlist ABORTS by default (dostuffHits 0 — the OLD default let this reach
//       a live server) YET its causal D→endpoint edge is STILL recorded, surfaced blocked write-blocked.
//   (3) ALLOWLIST OPENS THE READ — after the agent (judge-endpoint) records POST /api/dostuff as `read`, the
//       SAME act CONTINUES (dostuffHits>=1, content returned), surfaced blocked read-allowed. And the existing
//       read-over-POST R (POST /api/listthings), once allowlisted, is CONTINUED (readHits>=1) — a blanket
//       non-GET block would red this.
//   (4) NAME-GATE — acting F ("Follow", a mutation-NAMED control) under refuseMutations is refused at CLICK
//       time (MUTATION_FLOOR, xHits 0), before its benign-named POST /api/x123 fires; without the name gate
//       under the DEFAULT firewall, /api/x123 is now ABORTED too (xHits stays 0 — the residual CLOSED).
//   (5) OPERATOR OVERRIDE — --allow-benign-post restores the old benign-non-GET continue: acting F without the
//       name gate lets /api/x123 reach the server (xHits 1), while the write-verb gate STILL aborts W under the
//       override (writeHits 0 — an obvious mutation is never continued).
//
// FAIL-ON-REVERT:
//   (2) restore branch (d) to continue-by-default in makeReadOnlyHandler → D's POST /api/dostuff reaches the
//       server on the EMPTY allowlist → dostuffHits>0 → "aborted by default (dostuffHits===0)" reds.
//   (1)/(5) drop the WRITE_VERB_RE abort branch (b) → W is aborted by the DEFAULT branch (d) instead, so it is
//       surfaced 'write-blocked' not 'write-verb' → "the write-verb abort is surfaced in the blocked ledger"
//       reds first (and had the test reached Phase B, W's /api/followandunfollow would continue under the
//       override → writeHits>0). Branch (b) is the ONLY gate that aborts an obvious mutation under the override.
//   (4) remove the refuseMutations mutationFloor gate in step.mjs actStep (throw removed) → acting F with
//       refuseMutations no longer rejects → the "MUTATION_FLOOR / xHits stays 0" assertion reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/read-only-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep, actStep } from '../../lib/recon/step.mjs';
import { installReadOnlyFirewall } from '../../lib/recon/read-only-firewall.mjs';
import { loadReadAllowlist } from '../../lib/recon/read-allowlist.mjs';
import { judge } from '../../lib/recon/judge-endpoint.mjs';
import { makeGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';

const findByName = (graph, name) => Object.values(graph.elements).find((n) => n.name === name);
const targetOf = (node) => ({ templateId: node.templateId, name: node.name, route: node.route, instance: node.instances[0] });

test('the read-only firewall aborts non-GETs by default, opens only an agent-judged read-allowlist, name-gates mutation-named controls, and honors the operator override', async (t) => {
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevStateDir = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  // Isolate the read-allowlist store to a temp dir (never repo state/). judge-endpoint + loadReadAllowlist honor it.
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ro-firewall-'));
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browser, page } = await launch();
  // Cleanup registered BEFORE any assertion that can throw (doctrine: t.after first).
  t.after(async () => {
    await close(browser);
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevStateDir === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevStateDir;
  });

  const graph = makeGraph();
  const ledger = makeLedger();
  await gotoGated(page, url);
  await waitSettled(page);

  // ── Phase A: the DEFAULT firewall (abort-by-default, allowlist loaded from the empty temp state). ──
  const { blocked, readAllow, teardown } = await installReadOnlyFirewall(page);
  assert.equal(readAllow.size, 0, 'the allowlist starts empty (no endpoint judged a read yet)');
  await snapshotStep(page, graph, ledger, '/');

  // (1) W — a write-verb POST is ABORTED, the causal edge survives.
  const w = findByName(graph, 'Toggle');
  assert.ok(w, 'W (#w-toggle) was discovered');
  const wRes = await actStep(page, graph, ledger, targetOf(w));
  assert.equal(server.writeHits(), 0, 'the mutation POST /api/followandunfollow was ABORTED — the live account is unmutated');
  assert.ok(
    wRes.requests.some((r) => r.method === 'POST' && r.urlPattern === '/api/followandunfollow'),
    'the aborted write is STILL in the acted requests (the causal control→endpoint edge survives the abort)',
  );
  assert.ok(
    graph.edges.some((e) => e.type === 'triggers' && e.from === `element:${w.templateId}` && e.to === 'request:POST /api/followandunfollow'),
    'the W→POST /api/followandunfollow triggers edge IS recorded in the graph — the API map is preserved',
  );
  assert.ok(
    blocked.some((b) => b.reason === 'write-verb' && b.urlPattern === '/api/followandunfollow'),
    'the write-verb abort is surfaced in the blocked ledger',
  );

  // (2) D — a BENIGN-named non-GET with NO write verb. THE INVERSION: aborted by DEFAULT (the OLD firewall
  // let this reach a live server), yet its causal edge is STILL recorded.
  const d = findByName(graph, 'Process');
  assert.ok(d, 'D (#d-dostuff) was discovered');
  const dTarget = targetOf(d);
  const dRes1 = await actStep(page, graph, ledger, dTarget);
  assert.equal(server.dostuffHits(), 0, 'a benign-named non-GET is ABORTED by default (dostuffHits===0) — the closed residual');
  assert.ok(
    dRes1.requests.some((r) => r.method === 'POST' && r.urlPattern === '/api/dostuff'),
    'the aborted benign write is STILL in the acted requests (the causal edge survives the default abort)',
  );
  assert.ok(
    graph.edges.some((e) => e.type === 'triggers' && e.from === `element:${d.templateId}` && e.to === 'request:POST /api/dostuff'),
    'the D→POST /api/dostuff triggers edge IS recorded — the API map survives the default abort too',
  );
  assert.ok(
    blocked.some((b) => b.reason === 'write-blocked' && b.urlPattern === '/api/dostuff'),
    'the default abort is surfaced in the blocked ledger (write-blocked)',
  );

  // (3a) The AGENT opens the read: judge-endpoint records POST /api/dostuff as a read → the loader picks it up
  // → we mutate the live Set the handler consults (an appended read takes effect without re-install).
  const verdict = judge({ endpoint: 'POST /api/dostuff', class: 'read' });
  assert.equal(verdict.allowed, true, 'a POST judged read opens the gate');
  loadReadAllowlist().forEach((k) => readAllow.add(k));
  assert.ok(readAllow.has('POST /api/dostuff'), 'the loader surfaces the agent-judged read into the firewall Set');
  const dRes2 = await actStep(page, graph, ledger, dTarget);
  assert.ok(server.dostuffHits() >= 1, 'once allowlisted, the SAME act CONTINUES to the server (content loads)');
  assert.ok(
    dRes2.requests.some((r) => r.method === 'POST' && r.urlPattern === '/api/dostuff'),
    'the now-allowed read is causally attributed to D',
  );
  assert.ok(
    blocked.some((b) => b.reason === 'read-allowed' && b.urlPattern === '/api/dostuff'),
    'the allowlisted read is surfaced in the blocked ledger (read-allowed)',
  );

  // (3b) R — a read-over-POST. Once allowlisted it must CONTINUE or the app never loads content.
  judge({ endpoint: 'POST /api/listthings', class: 'read' });
  loadReadAllowlist().forEach((k) => readAllow.add(k));
  const r = findByName(graph, 'Load list');
  assert.ok(r, 'R (#r-load) was discovered');
  const rRes = await actStep(page, graph, ledger, targetOf(r));
  assert.ok(server.readHits() >= 1, 'the allowlisted read POST /api/listthings was CONTINUED (content loaded)');
  assert.ok(
    rRes.requests.some((req) => req.method === 'POST' && req.urlPattern === '/api/listthings'),
    'the allowed read is causally attributed to R',
  );

  // (4) F — a mutation-NAMED control firing a BENIGN-named endpoint. The NAME gate refuses it at CLICK time.
  const f = findByName(graph, 'Follow');
  assert.ok(f, 'F (#f-follow) was discovered');
  await assert.rejects(
    () => actStep(page, graph, ledger, targetOf(f), { refuseMutations: true }),
    (e) => e.code === 'MUTATION_FLOOR',
    'a mutation-named control is refused at click time under refuseMutations (MUTATION_FLOOR)',
  );
  assert.equal(server.xHits(), 0, 'the name-gated control never fired its benign-endpoint write — the account is unmutated');

  // Without the name gate, under the DEFAULT firewall /api/x123 is not allowlisted → ABORTED (residual closed).
  const fRes = await actStep(page, graph, ledger, targetOf(f));
  assert.equal(server.xHits(), 0, 'the benign-named write is ABORTED by default even without the name gate — the residual is CLOSED');
  assert.ok(
    fRes.requests.some((req) => req.method === 'POST' && req.urlPattern === '/api/x123'),
    'the aborted benign write is still causally attributed to F (the map survives)',
  );
  assert.ok(
    blocked.some((b) => b.reason === 'write-blocked' && b.urlPattern === '/api/x123'),
    'the benign write is surfaced blocked (write-blocked), not silently allowed',
  );
  await teardown();

  // ── Phase B: the OPERATOR OVERRIDE (--allow-benign-post) — restores the old benign-non-GET continue. ──
  const fw2 = await installReadOnlyFirewall(page, { allowBenignPost: true });
  t.after(async () => { await fw2.teardown(); });

  // (5a) The write-verb gate STILL aborts under the override — an obvious mutation is never continued.
  await actStep(page, graph, ledger, targetOf(w));
  assert.equal(server.writeHits(), 0, 'the write-verb POST is ABORTED even under --allow-benign-post (branch b survives the override)');

  // (5b) A benign-named non-GET without the name gate now CONTINUES under the override (the operator-opted reach).
  const fRes2 = await actStep(page, graph, ledger, targetOf(f));
  assert.equal(server.xHits(), 1, 'under --allow-benign-post the benign-named write reaches the server (the operator override)');
  assert.ok(
    fRes2.requests.some((req) => req.method === 'POST' && req.urlPattern === '/api/x123'),
    'the override-allowed write is causally attributed to F',
  );
  assert.ok(
    fw2.blocked.some((b) => b.reason === 'non-get-allowed' && b.urlPattern === '/api/x123'),
    'the override allowance is surfaced in the blocked ledger (non-get-allowed)',
  );
});
