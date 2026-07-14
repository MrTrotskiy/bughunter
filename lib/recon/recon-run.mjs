#!/usr/bin/env node
// recon-run — the Phase-1 loop runner CLI. Seeds the frontier with a baseline
// snapshot, then drives reconLoop over a COLD-START browser step: a fresh page per
// act, so the graph (persisted between steps) is the memory. Controls present on
// initial page load are reachable; controls behind in-app state are NOT yet — that
// awaits the persistent-session task. The limitation is honest, not hidden: an
// unreachable instance surfaces as a step-level error, never a silent skip.
//
// Usage: node lib/recon/recon-run.mjs --url=<url> [--steps=<n>]
// Success → one {ok:true, route, baseline, stopped, stats, steps} envelope, exit 0.
// Failure → one {ok:false, error:{code,message}} envelope on stderr, non-zero exit.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnvelope, exitCode } from '../core/envelope.mjs';
import { launch, gotoGated, close } from '../browser/session.mjs';
import { waitSettled } from '../browser/causal.mjs';
import { loadLedger, saveLedger } from '../graph/ids.mjs';
import { loadGraph, saveGraph } from '../graph/graph-store.mjs';
import { snapshotStep, actStep } from './step.mjs';
import { reconLoop } from './recon-loop.mjs';

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}

// A cold-start step: fresh browser + navigation per act, closed after. Mutates the
// graph + ledger in place through the closure so the loop accumulates one graph.
function coldStartStep({ url, route, ledger }) {
  return async (graph, target) => {
    const { browser, page } = await launch();
    try {
      await gotoGated(page, url);
      await waitSettled(page);
      return await actStep(page, graph, ledger, route, target);
    } finally {
      await close(browser);
    }
  };
}

export async function crawl(opts) {
  const stateDir = process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state');
  const ledgerPath = path.join(stateDir, 'element-ids.json');
  const graphPath = path.join(stateDir, 'graph.json');
  const ledger = loadLedger(ledgerPath);
  const graph = loadGraph(graphPath);
  const route = new URL(opts.url).pathname;

  // Baseline pass: seed the frontier with the initially-present controls.
  let baseline;
  const { browser, page } = await launch();
  try {
    await gotoGated(page, opts.url);
    await waitSettled(page);
    baseline = await snapshotStep(page, graph, ledger, route);
  } finally {
    await close(browser);
  }

  const budget = opts.steps != null ? { steps: Number(opts.steps) } : {};
  const step = coldStartStep({ url: opts.url, route, ledger });
  const persist = () => { saveLedger(ledgerPath, ledger); saveGraph(graphPath, graph); };
  const loop = await reconLoop(graph, { step, budget, onStep: persist });

  persist(); // final save (also covers the zero-step case, where onStep never fired)
  return { ok: true, route, baseline, stopped: loop.stopped, stats: loop.stats, steps: loop.steps };
}

function emitError(env) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: env.code, message: env.message } }) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    emitError(makeEnvelope({ code: 'USAGE', message: 'missing required --url=<url>', exit: 'USAGE' }));
    process.exit(64);
  }
  if (args.steps != null && !Number.isFinite(Number(args.steps))) {
    emitError(makeEnvelope({ code: 'USAGE', message: '--steps must be a number', exit: 'USAGE' }));
    process.exit(64);
  }
  try {
    const result = await crawl({ url: args.url, steps: args.steps });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (err) {
    let env = err && err.envelope;
    if (!env) {
      const code = typeof err?.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(err.code) ? err.code : 'INTERNAL';
      env = makeEnvelope({ code, message: err?.message || 'unknown error', exit: 'VIOLATION' });
    }
    emitError(env);
    process.exit(exitCode(env));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
