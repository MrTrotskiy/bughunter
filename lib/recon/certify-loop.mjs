#!/usr/bin/env node
// certify-loop — the AUTONOMOUS, SELF-TERMINATING collection loop. It drives full crawls REPEATEDLY with a
// rotating BUGHUNTER_SEED (the GOAL-5 variance source) until the Chao2 mark-recapture oracle CERTIFIES the
// crawl has collected the whole reachable surface — not just "the frontier drained this once", but "the
// shuffled re-crawls agree there is nothing left undiscovered". This is the "loop until EVERYTHING is
// collected" the operator asked for: the stopping condition is a MEASUREMENT (completeness ≥ target AND the
// re-crawls converged), never a fixed --steps guess.
//
// Each crawl already drains its own frontier (recon-run.crawl → reconLoop until DRAINED). This loop adds the
// OUTER convergence gate over ≥2 shuffled runs: while different seeds keep discovering routes/controls the
// others missed (Q1 > 0, completeness < target), it runs another pass; once they stop finding anything new
// (Q1 → 0 / C ≥ target on BOTH the route and control dimensions) it STOPS, certified. A hard maxRuns cap is
// a runaway backstop — hitting it reports certified:false honestly, never a faked completion.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from '../graph/graph-store.mjs';
import { completenessOf } from './completeness.mjs';

// Certified ⟺ ≥minRuns done AND the Chao2 estimate clears the target on BOTH dimensions (routes + controls).
// `converged` (Q1=0 — the shuffled re-crawls found NOTHING unique) is the strongest signal and certifies on
// its own; else BOTH completeness values must be ≥ target. Pure over an array of loaded graphs.
export function certifyDecision(graphs, { target = 0.95, minRuns = 2 } = {}) {
  if (!Array.isArray(graphs) || graphs.length < minRuns) return { certified: false, done: false, reason: 'need-more-runs' };
  const est = completenessOf(graphs);
  if (!est.ok) return { certified: false, done: false, reason: est.reason };
  const routeC = est.route.completeness;
  const tmplC = est.template.completeness;
  const bothConverged = est.route.converged && est.template.converged;
  const bothAtTarget = routeC >= target && tmplC >= target;
  const certified = bothConverged || bothAtTarget;
  return {
    certified, done: certified,
    reason: certified ? (bothConverged ? 'converged' : 'target-met') : 'below-target',
    routeCompleteness: routeC, templateCompleteness: tmplC,
    routeQ1: est.route.q1, templateQ1: est.template.q1, est,
  };
}

// The autonomous loop. `runCrawl(seed) → graph` performs ONE full (frontier-draining) crawl seeded by `seed`
// and returns its loaded graph — injectable so this is testable WITHOUT a browser (the CLI wires it to a
// seeded recon-run below). Accumulates graphs; stops the instant certifyDecision certifies, else at maxRuns.
export async function certifyLoop({ runCrawl, target = 0.95, minRuns = 2, maxRuns = 6, log = () => {} }) {
  const graphs = [];
  for (let run = 1; run <= maxRuns; run++) {
    const g = await runCrawl(run);            // seed = run number (deterministic, reproducible)
    if (g) graphs.push(g);
    const d = certifyDecision(graphs, { target, minRuns });
    log({ run, graphs: graphs.length, ...d });
    if (d.done) return { certified: true, runs: run, target, ...d };
  }
  const final = certifyDecision(graphs, { target, minRuns });
  return { certified: false, runs: maxRuns, cappedAtMax: true, target, ...final }; // honest: cap ≠ complete
}

// CLI: wire runCrawl to an in-process seeded recon-run crawl, each into its own state dir so the graphs are
// independent samples. Imported lazily (recon-run pulls in the browser stack) so a test importing the pure
// functions above never boots Playwright.
async function main() {
  const args = {};
  for (const a of process.argv.slice(2)) { const m = a.match(/^--([^=]+)=?(.*)$/); if (m) args[m[1]] = m[2] === '' ? true : m[2]; }
  if (!args.url) { process.stderr.write(JSON.stringify({ ok: false, error: { code: 'USAGE', message: 'missing --url' } }) + '\n'); process.exit(64); }
  const { crawl } = await import('./recon-run.mjs');
  const base = process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state');
  const steps = args.steps != null ? Number(args.steps) : undefined;   // per-run budget (the variance cap)
  const target = args.target != null ? Number(args.target) : 0.95;
  const maxRuns = args['max-runs'] != null ? Number(args['max-runs']) : 6;
  const prevSeed = process.env.BUGHUNTER_SEED;
  const prevDir = process.env.BUGHUNTER_STATE_DIR;
  const runCrawl = async (seed) => {
    process.env.BUGHUNTER_SEED = String(seed);
    process.env.BUGHUNTER_STATE_DIR = path.join(base, `seed-${seed}`);
    await crawl({ url: args.url, steps });
    return loadGraph(path.join(process.env.BUGHUNTER_STATE_DIR, 'graph.json'));
  };
  try {
    const res = await certifyLoop({ runCrawl, target, maxRuns, log: (l) => process.stderr.write(JSON.stringify(l) + '\n') });
    process.stdout.write(JSON.stringify({ ok: true, ...res, est: undefined }) + '\n'); // est is verbose; keep the headline
    process.exit(0);
  } finally {
    if (prevSeed === undefined) delete process.env.BUGHUNTER_SEED; else process.env.BUGHUNTER_SEED = prevSeed;
    if (prevDir === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevDir;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
