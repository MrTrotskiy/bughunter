// Live proof of READ-ALLOWLIST POPULATION — the productive half of the abort-by-default read-only
// WRITE-FIREWALL (lib/recon/read-only-firewall.mjs + read-allowlist.mjs + judge-endpoint.mjs). The firewall
// keeps a read-only authed crawl STRUCTURALLY unable to commit a write, but on an app whose CONTENT loads
// over POST-READs (the rawcaster class: listnuggets/getothersprofile over POST) a FRESH run with an empty
// allowlist renders SPARSE — those reads are aborted too. This test proves the crawl loads that content
// PROGRESSIVELY: pass 1 is sparse and surfaces the aborted read in result.blocked.refusedPatterns; the agent
// judges it a read (judge-endpoint --class=read); pass 2 CONTINUES it and the content loads into the graph —
// while a never-judged benign-named write stays aborted (the read opening never opens the write).
//
// This is the deterministic MECHANISM proof: the multi-pass plumbing (whats-new install re-reads the file →
// an allowlisted read continues on the next navigation) is exercised end-to-end WITHOUT the LLM judgment. The
// agent's read/write TAXONOMY (which patterns are reads) is validated on the live run, not here — here judge()
// is called with the known-correct class so only the plumbing is under test.
//
// Guards: read-allowlist population loads POST-read content progressively across whats-new passes; a
//         never-judged benign-named write stays aborted; abort-by-default holds on an empty allowlist.
// FAIL-ON-REVERT: comment out the `judge('POST /api/listitems', 'read')` call (allowlist stays empty) → pass 2
//   is still sparse → "the allowlisted read loads content on the next pass" reds. (The underlying firewall
//   levers — branch-(d) abort-by-default, the read-allowed continue — are revert-proven in
//   tests/live/read-only-firewall.test.mjs; this test guards the AGENT-PATH MULTI-PASS that wires them into /recon.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/post-read-app/server.mjs';
import { run as whatsNew } from '../../lib/recon/whats-new.mjs';
import { judge } from '../../lib/recon/judge-endpoint.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';

const findByName = (graph, name) => Object.values(graph.elements).find((n) => n.name === name);

test('read-allowlist population: an aborted POST-read loads content on the next pass once judged read; a never-judged write stays aborted', async (t) => {
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevStateDir = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  // Isolate the read-allowlist store AND the graph to a temp dir (never repo state/). judge-endpoint,
  // loadReadAllowlist, and whats-new all honor BUGHUNTER_STATE_DIR.
  const stateDir = mkdtempSync(path.join(tmpdir(), 'read-allowlist-multipass-'));
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  // Cleanup registered BEFORE any assertion that can throw (doctrine: t.after first).
  t.after(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevStateDir === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevStateDir;
  });

  // ── Pass 1: EMPTY allowlist → the content POST-read is ABORTED → SPARSE baseline. ──
  const pass1 = await whatsNew({ url, readOnly: true });
  assert.equal(server.listItemsHits(), 0, 'the content POST-read /api/listitems was ABORTED on the empty allowlist (server never hit)');
  const graph1 = loadGraph(path.join(stateDir, 'graph.json'));
  assert.ok(findByName(graph1, 'Static action'), 'the STATIC control IS present — the page rendered (sparse, not blank)');
  assert.ok(!findByName(graph1, 'Item alpha'), 'the POST-loaded item control is ABSENT on pass 1 (its read was aborted — sparse baseline)');
  assert.ok(
    pass1.blocked && pass1.blocked.refusedPatterns.includes('POST /api/listitems'),
    'the aborted content POST-read is surfaced in result.blocked.refusedPatterns (what the agent reads to judge)',
  );

  // ── Step 2: the AGENT judges the content POST-read a READ → appends it to state/read-allowlist.json. ──
  // Revert-lever: comment out this call (allowlist stays empty) → pass 2 stays sparse → the pass-2 content
  // asserts red with "the allowlisted read loads content on the next pass".
  const verdict = judge({ endpoint: 'POST /api/listitems', class: 'read' });
  assert.equal(verdict.allowed, true, 'a POST judged read opens the gate (state/read-allowlist.json updated)');

  // ── Pass 2: a FRESH whats-new install re-reads the allowlist → the read CONTINUES → content LOADS. ──
  await whatsNew({ url, readOnly: true });
  const graph2 = loadGraph(path.join(stateDir, 'graph.json'));
  assert.ok(findByName(graph2, 'Item alpha'), 'the allowlisted read loads content on the next pass');
  assert.ok(findByName(graph2, 'Item beta'), 'the allowlisted read loads content on the next pass');
  assert.ok(findByName(graph2, 'Item gamma'), 'the allowlisted read loads content on the next pass');
  assert.ok(server.listItemsHits() >= 1, 'the now-allowlisted read /api/listitems was CONTINUED on the next pass (content returned)');

  // ── The never-judged benign WRITE stays aborted even after the read was opened (the safety win holds). ──
  const w = findByName(graph2, 'Process');
  assert.ok(w, 'the write control (Process) is present');
  const wRes = await whatsNew({ url, readOnly: true, actTemplate: w.templateId });
  assert.equal(server.dostuffHits(), 0, 'the never-allowlisted write POST /api/dostuff stays ABORTED (dostuffHits===0) — the safety win holds after a read is opened');
  assert.ok(
    wRes.blocked && wRes.blocked.refusedPatterns.includes('POST /api/dostuff'),
    'the aborted write is surfaced blocked (refused), not silently allowed',
  );
});
