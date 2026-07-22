// Guards: the RECALL LOOP closes end to end — a real Phase-1 crawl of the known-ground-truth
//   recall fixture discovers each planted case (home / request-endpoint / route-transition), the
//   danger control is found AND declined (not fired), the crawl never touches the ground-truth
//   channel (/__manifest__), and the scorer measures recall against the emitted manifest.
//   This turns a recall number into a regression guard for real crawler capabilities:
//     - the roleless-clickable row collection (dom-snapshot) — the hrefless-row route-transition
//     - the danger-floor authored-id read (danger-floor.authoredIdOf) — the icon-logout decline
//     - portal reach via reveal (reveal-backfill / ownsViaReveal) — the body-portal Delete is
//       discovered only after clicking its "…" opener, then declined (destructive)
//
// FAIL-ON-REVERT:
//   - SEAM (verified this session, fixture-side): add <a href="/__manifest__"> to render-page ->
//     the route-frontier harvests + visits it -> "the ground-truth channel was never crawled" reds.
//   - DANGER DECLINE (crawler capability, VERIFIED this session): revert danger-floor.authoredIdOf so the
//     icon logout's testid is not read -> the name+route haystack is blank -> the gate returns safe ->
//     logout FIRES -> logoutHits>0 -> railFailures non-empty ("no danger control was fired" reds) AND no
//     auth refuse gate ("attempted and refused" reds). The trail assertion is what makes this non-vacuous:
//     effect==0 alone would stay green for a discovered-but-unreached control.
//   - ROLELESS ROW (crawler capability, VERIFIED this session): disable dom-snapshot's clickable-row
//     collection — the pointer `<tr>` is caught by BOTH the roleless-clickable scan AND the ROW_SEL
//     collector, so both cursor gates must be neutered -> the hrefless row is never captured ->
//     contact-row-open missed -> "every planted case must be recalled" reds with missed ["contact-row-open"].
//
// Layer: live (real chromium + local fixture), per tests/CLAUDE.md. The fixture is measured, not
//   asserted-to-exist: recall is scored off the crawl's own graph + the server's effect counters.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { start } from '../../recall-site/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';
import { latestRunId, runDir } from '../../lib/debug/trace.mjs';
import { scoreRecall } from '../../tools/recall/score.mjs';

// The gate events the crawl recorded — the ATTEMPT-then-refusal evidence the graph cannot carry (a
// declined control is not `explored` and has no edge, so "gate refused the click" and "the click never
// happened" look identical in the graph; only the trail distinguishes them).
function refuseGates() {
  const file = path.join(runDir(latestRunId()), 'events.ndjson');
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.kind === 'gate' && e.payload.decision === 'refuse')
    .map((e) => e.payload);
}

function fetchManifest(base) {
  return new Promise((resolve, reject) => {
    http.get(`${base}__manifest__`, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function withEnv(stateDir) {
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  return () => {
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  };
}

test('recall loop: a real crawl discovers each planted case, declines the danger control, never touches /__manifest__', async (t) => {
  const server = await start(0);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-recall-'));
  const restoreEnv = withEnv(stateDir);
  t.after(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    restoreEnv();
  });

  // The manifest is fetched over HTTP (proving the self-emit works), never imported — the scorer
  // joins the crawl's graph against exactly what the running site publishes.
  const manifest = await fetchManifest(base);
  assert.ok(manifest.testids.includes('nav-contacts') && manifest.testids.includes('contact-create'),
    'the site self-emits its known-testid denominator');

  const res = await crawl({ url: base, steps: 40 });
  assert.equal(res.ok, true, 'crawl completed');

  const graph = loadGraph(path.join(stateDir, 'graph.json'));
  const recall = scoreRecall(graph, manifest, server.effects());

  // Every EXPECTED-reachable case is recalled (measured 5/5 across three runs; the testid trio is
  // deterministic, the hrefless row and the portal reveal fire deterministically). Asserted as a floor.
  assert.equal(recall.expected.found, recall.expected.total,
    `every expected-reachable case must be recalled: missed ${JSON.stringify(recall.expected.missed)}`);
  assert.equal(recall.expected.recall, 1, 'expected-reachable recall is full');
  assert.equal(recall.byIdentityClass.testid.found, 3,
    'the three testid-identified controls are all discovered');
  // The fixture's whole point: it measures what the crawler CANNOT do, honestly. The hover-only control
  // is a documented known-miss; if `surprises` is ever non-empty the crawler improved — promote the case.
  assert.deepEqual(recall.knownMisses, ['hover-quickview'], 'the hover-only case is an honest documented miss');
  assert.deepEqual(recall.surprises, [], 'a crawler that now reaches a known-miss must be promoted to expectReach:true');

  // The route-transition class: the hrefless clickable row was CLICKED and its detail GET attributed
  // (the hygge-crm class of row that had never opened a detail — a crawler-capability regression guard).
  const row = recall.perCase.find((c) => c.id === 'contact-row-open');
  assert.equal(row.found, true, 'the hrefless clickable row + its detail GET must be recalled');

  // The danger control (icon logout, empty name, authored testid) is DISCOVERED but DECLINED — found
  // via recall, its effect counter untouched, and NOT a rail failure.
  const logout = recall.perCase.find((c) => c.id === 'logout-icon');
  assert.equal(logout.controlFound, true, 'the icon logout was discovered');
  assert.equal(logout.declinedCorrectly, true, 'the danger control was declined (its effect stayed 0)');
  assert.deepEqual(recall.railFailures, [], 'no danger control was fired');
  // POSITIVE evidence the logout was ATTEMPTED and REFUSED (not merely never reached): a danger-floor
  // refuse gate classified via the AUTHORED testid ('logout'), floor 'auth'. Without this the effect==0
  // recall above is vacuous — a discovered-but-unacted control would score the same. This is also what
  // makes the authored-id revert lever bite: revert authoredIdOf -> the icon logout's empty name yields
  // no auth floor -> no refuse gate here AND the click fires (railFailures non-empty above).
  const gates = refuseGates();
  const authRefusal = gates.some(
    (g) => g.floor === 'auth' && String(g.authored || '').includes('logout') && g.code === 'DANGER_FLOOR',
  );
  assert.equal(authRefusal, true, 'the icon logout was attempted and refused (danger-floor auth gate on its authored id)');

  // The hidden-function / PORTAL class: the Delete lives in a body-portal dropdown, reached ONLY by
  // first clicking the "…" opener (reveal). It is DISCOVERED via reveal and DECLINED (destructive) — a
  // regression guard for portal reach (ownsViaReveal / reveal-backfill) AND the destructive decline.
  const del = recall.perCase.find((c) => c.id === 'row-delete-portal');
  assert.equal(del.controlFound, true, 'the portal Delete was reached through the "…" reveal');
  assert.equal(del.declinedCorrectly, true, 'the portal Delete was declined (destructive, effect stayed 0)');
  const destructiveRefusal = gates.some(
    (g) => g.floor === 'destructive' && g.name === 'Delete' && g.code === 'DANGER_FLOOR',
  );
  assert.equal(destructiveRefusal, true, 'the portal Delete was attempted and refused (destructive gate) — reveal reach is non-vacuous');

  // No over-detection: the crawl minted no testid the manifest never declared.
  assert.deepEqual(recall.extras, [], 'the crawl produced no phantom testids');

  // SEAM: the ground-truth channel was never crawled — /__manifest__ is unlinked, so the a[href]
  // route-frontier can never enqueue it. This is what keeps ground truth out of the crawl.
  const touched = Object.keys(graph.routes || {}).some((k) => k.includes('__manifest__'));
  assert.equal(touched, false, 'the ground-truth channel /__manifest__ was never crawled');
});
