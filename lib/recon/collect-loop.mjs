#!/usr/bin/env node
// collect-loop — THE CONTROLLER. It does not click anything itself; it GOVERNS the collection worker in a
// loop. Every round it reads the ONE graph and shows a PER-PAGE ledger: for each page the crawl has
// touched — how many UI elements it holds, how many are already collected (clicked), how many still
// REMAIN — plus the pages still queued to visit. Then it dispatches ONE bounded collection pass and
// repeats, until every page's elements are collected AND the page queue is drained (everything reachable
// is collected), or it honestly STALLS (a pass that discovers nothing new) or hits a round cap.
//
// This is exactly the operator's ask: "a script that controls the agent, remembers how many elements each
// page had and how many we clicked, and loops the agent — go back and finish a page we wandered off — until
// all pages are fully walked." The worker never has to remember which page to return to: the frontier is
// GLOBAL across pages and the worker re-navigates to each control's OWN page per act, so a control left on
// /dashboard is picked up again no matter where the crawl currently is — this ledger just makes that
// visible, page by page.
//
// The worker here is recon-run's deterministic node-loop (a runnable script → this whole thing is one shell
// command). The SEMANTIC worker (the LLM recon agent, which judges reads-vs-writes and does nuanced CRUD)
// is driven by the SAME control logic in /recon (frontier-cli emit → agent acts → re-emit → until drained).
//
// Usage: BUGHUNTER_STATE_DIR=… node lib/recon/collect-loop.mjs --url=<url> [--chunk=8] [--max-rounds=40]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../graph/graph-store.mjs';
import { frontierStats, frontierInstanceStats } from './frontier.mjs';
import { routeFrontierStats } from './route-frontier.mjs';
import { perRouteCoverage, coverageTotals } from './coverage-by-page.mjs';
import { yieldOf, verdictFor } from './yield-report.mjs';

function snapshot(graphPath) {
  const graph = loadGraph(graphPath);
  const f = frontierStats(graph);
  const fi = frontierInstanceStats(graph);
  const r = routeFrontierStats(graph);
  const rows = perRouteCoverage(graph);
  const endpoints = Object.keys(graph.requests || {}).length;
  return { f, fi, r, rows, endpoints };
}

// Fully collected ⟺ no unexplored control templates AND no pending pages in the route queue.
const isDrained = (s) => s.f.remaining === 0 && s.r.pending === 0;

// ── rendering ─────────────────────────────────────────────────────────────────────────────────────
const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); };
const padL = (s, n) => { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; };
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

// The heart of the controller's output: the per-page ledger. One line per page — DONE / LEFT / TOTAL
// elements — with a status flag (✓ finished · pages with work show their numbers · ⏳ a page still queued
// to visit · ✗ unreachable). A page with capped/overflow rows appends "(+N flagged)" so nothing hides.
function renderLedger(round, s) {
  const W = 38;
  const lines = [];
  lines.push('');
  lines.push(`════ round ${round} · per-page collection ledger ════`);
  // KNOWN is deliberately its own column, not folded into DONE: clicking a control drains it from the
  // frontier, but only an `observe` records WHAT it is. The deterministic node-loop acts without
  // judging, so a page can read fully collected and still be entirely unexplained — that gap is the
  // whole point of showing this, and folding the two would hide it.
  lines.push(`${pad('PAGE', W)}${padL('DONE', 6)}${padL('LEFT', 6)}${padL('TOTAL', 7)}${padL('KNOWN', 8)}  status`);
  for (const r of s.rows) {
    const flags = [];
    if (r.capped) flags.push(`+${r.capped} capped`);
    if (r.drillSkipped) flags.push(`+${r.drillSkipped} rows`);
    if (r.churnSkipped) flags.push(`+${r.churnSkipped} churned`);
    let status;
    if (r.unreachable) status = '✗ unreachable';
    else if (r.pending && r.total === 0) status = '⏳ not yet visited';
    else if (r.left === 0 && r.total > 0) status = '✓ done';
    else if (r.total === 0) status = '— (no elements yet)';
    else status = `→ ${r.left} left to click`;
    if (flags.length) status += `  [${flags.join(', ')}]`;
    // KNOWN reads `<classified>/<templates studied>` — of the control kinds this page has drained, how
    // many carry a recorded purpose/danger/effect. Blank on a page with nothing collected yet.
    const c = r.classify || { known: 0, clicked: 0 };
    const studied = c.known + c.clicked;
    const known = studied > 0 ? `${c.known}/${studied}` : '';
    const nums = r.total === 0 && r.pending ? `${pad('', 6)}${pad('', 6)}${pad('', 7)}${pad('', 8)}`
      : `${padL(r.done, 6)}${padL(r.left, 6)}${padL(r.total, 7)}${padL(known, 8)}`;
    lines.push(`${pad(clip(r.route, W - 1), W)}${nums}  ${status}`);
  }
  const t = coverageTotals(s.rows);
  lines.push('─'.repeat(W + 32));
  lines.push(`TOTAL across ${s.rows.length} page(s): ${t.done} collected / ${t.left} remaining`
    + ` · ${t.pagesPending} page(s) still to visit · ${s.endpoints} API endpoints mapped`);
  // The understanding line — what the controls we touched actually ARE. Separate from the coverage
  // line above so "walked" can never be read as "explained".
  const dangers = Object.entries(t.byDanger).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`).join(' · ');
  lines.push(`UNDERSTOOD: ${t.known} classified${dangers ? ` (${dangers})` : ''}`
    + ` · ${t.clicked} clicked-but-unclassified · ${t.untouched} never clicked`
    // "inert" answers the operator's literal question — it looked like a control, we clicked it, and it
    // caused no request and revealed nothing. Reported, not hidden: it is a finding, not a failure.
    + (t.inert ? ` · ${t.inert} inert (clicked, caused nothing)` : ''));
  // The DIRECTIVE — what the controller is about to make the agent do this round.
  const work = s.rows.filter((r) => r.left > 0).sort((a, b) => b.left - a.left).slice(0, 4)
    .map((r) => `${clip(r.route, 24)}(${r.left} left)`);
  if (work.length) lines.push(`NEXT: drain the next controls, prioritizing pages with work → ${work.join(', ')}`);
  else if (s.r.pending > 0) lines.push(`NEXT: no controls left on visited pages → visit the next of ${s.r.pending} queued page(s)`);
  return lines.join('\n');
}

export async function collectLoop({ url, chunk = 8, maxRounds = 40, stateful = false, log = (m) => process.stdout.write(m + '\n') }, deps = {}) {
  const crawl = deps.crawl || (await import('./recon-run.mjs')).crawl;
  const stateDir = process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state');
  const graphPath = path.join(stateDir, 'graph.json');

  let round = 0;
  let outcome = 'cap';
  // Transient pass failures (network drops, target restarts). Counted and reported, never silent:
  // a run that limped through three dropped connections must not read as a clean crawl.
  const faults = [];
  for (round = 1; round <= maxRounds; round++) {
    const before = snapshot(graphPath);
    log(renderLedger(round, before));
    if (isDrained(before) && round > 1) { outcome = 'drained'; log('\n[done] every page fully walked + no page left to visit — everything reachable is collected'); break; }

    // Dispatch ONE bounded collection pass (the worker acts on the next `chunk` controls; it resumes the
    // accumulated graph, so already-collected controls stay collected and it only reaches for what remains,
    // re-navigating to each control's own page — the "go back and finish that page" the operator described).
    // A pass may die on TRANSIENT infrastructure — a dropped connection, a DNS blip, the target
    // restarting (measured live: `net::ERR_INTERNET_DISCONNECTED` mid-crawl killed the whole controller
    // and threw away the round). The graph is persisted incrementally by the worker, so everything
    // collected before the fault survives; the correct response is to note the fault and let the NEXT
    // round resume from the accumulated graph, not to abort the run. A persistent fault still terminates
    // the loop honestly — the stall check below sees no new controls and stops with `stalled`, never a
    // fake drain. The error text is surfaced, never swallowed.
    const faultsBefore = faults.length;
    try {
      // STATEFUL: walk INSIDE one live session — no page reload before each click, so an open modal, an
      // expanded dropdown and a scrolled feed survive from one act to the next. That in-session state is
      // exactly what the re-navigating driver destroys, and it is the dominant source of NO_INSTANCE.
      await crawl({ url, steps: chunk, stateful });
    } catch (err) {
      const msg = err?.message || String(err);
      faults.push({ round, message: msg.slice(0, 200) });
      log(`  ! pass failed: ${msg.split('\n')[0].slice(0, 160)} — keeping the collected graph, retrying next round`);
    }

    const after = snapshot(graphPath);
    const dControls = after.f.explored - before.f.explored;
    const dRoutes = after.f.routes - before.f.routes;
    const dEndpoints = after.endpoints - before.endpoints;
    log(`  → this pass: +${dControls} controls collected, +${dRoutes} new pages, +${dEndpoints} new API endpoints`);

    // Honest STALL: a pass that collected nothing new AND still has work left is not "done" — stop and say so
    // (never a faked drain). A drained frontier is caught at the top of the NEXT round.
    //
    // A FAULTED pass is excluded from the stall test. It collected nothing because the network dropped, not
    // because the surface is exhausted — counting it as a stall would end a crawl with real work left on a
    // transient blip (measured live: one ERR_INTERNET_DISCONNECTED ended a run with 109 controls still
    // queued). Consecutive faults are still bounded: they burn rounds toward maxRounds, so a target that is
    // durably unreachable terminates on the cap rather than looping forever, and `faults` reports why.
    const faultedThisRound = faults.length > faultsBefore;
    if (faultedThisRound) {
      log('  (pass faulted — not counted as a stall; the surface was not exhausted, the connection dropped)');
      continue;
    }
    if (dControls === 0 && dRoutes === 0 && after.f.remaining > 0 && !isDrained(after)) {
      outcome = 'stalled';
      log(`\n[stalled] a full pass collected nothing new but ${after.f.remaining} control(s) / ${after.r.pending} page(s) remain — honest stop (not a fake 100%)`);
      break;
    }
  }
  const final = snapshot(graphPath);
  const finalTotals = coverageTotals(final.rows);
  const summary = {
    outcome, rounds: round,
    collected: final.f.explored, remaining: final.f.remaining, unreachable: final.f.unreachable,
    // Understanding rides in the summary too, so a caller reading only the JSON cannot mistake a
    // fully-drained crawl for a fully-classified one.
    classified: finalTotals.known, unclassified: finalTotals.clicked, inert: finalTotals.inert,
    byDanger: finalTotals.byDanger,
    instancesWalked: final.fi.walked, routesMapped: final.f.routes, pendingRoutes: final.r.pending,
    apiEndpoints: final.endpoints,
    faults: faults.length, faultDetail: faults.slice(0, 5),
    pages: final.rows.map((r) => ({ route: r.route, done: r.done, left: r.left, total: r.total, status: r.pending ? 'pending' : r.unreachable ? 'unreachable' : r.left === 0 ? 'done' : 'in-progress' })),
  };
  // YIELD VERDICT — printed LAST, from the trail, so a run that navigated a lot and did nothing cannot
  // read as progress. This is the check that was missed three runs in a row when it depended on someone
  // remembering to open events.ndjson.
  const runId = process.env.BUGHUNTER_RUN_ID;
  if (runId) {
    const y = yieldOf(runId);
    if (y) {
      log(`\n[yield] ${y.acts} act(s) over ${y.navigations} navigation(s) · ${y.fired} caused a request · `
        + `${y.inert} inert · ${y.failed} failed · endpoints ${y.endpoints.reads} read / ${y.endpoints.writes} write`);
      for (const line of verdictFor(y)) log(`   ${line}`);
      summary.yield = { acts: y.acts, fired: y.fired, inert: y.inert, writes: y.endpoints.writes };
    }
  }
  log(`\n[summary] ${JSON.stringify({ ...summary, pages: `${summary.pages.length} pages (see ledger above)` })}`);
  return summary;
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) { const m = a.match(/^--([^=]+)=?(.*)$/); if (m) out[m[1]] = m[2] === '' ? true : m[2]; }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) { process.stderr.write(JSON.stringify({ ok: false, error: { code: 'USAGE', message: 'usage: collect-loop --url=<url> [--chunk=8] [--max-rounds=40]' } }) + '\n'); process.exit(64); }
  const res = await collectLoop({
    url: args.url,
    chunk: args.chunk != null ? Number(args.chunk) : 8,
    maxRounds: args['max-rounds'] != null ? Number(args['max-rounds']) : 40,
    stateful: args.stateful === true,
  });
  process.exit(res.outcome === 'drained' ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
