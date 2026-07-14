#!/usr/bin/env node
// recon-run — the Phase-1 loop runner CLI. Seeds the frontier with a baseline
// snapshot, then drives reconLoop over a PERSISTENT browser step: ONE browser for
// the whole crawl (launched once), re-navigated per act to the TARGET control's own
// same-origin route — so a control first seen on /products is reached by loading
// /products, making recon MULTI-ROUTE. The graph (persisted between steps) is the
// memory. This spends one chromium process for the run, not one per act — the resource
// win. Controls reachable by a direct same-origin navigation are covered; controls
// behind in-app CLIENT state (revealed only after an in-page action, not a reload) are
// NOT yet — that awaits the stay-on-page daemon work. The limitation is honest, not
// hidden: an unreachable instance surfaces as a step-level error, never a silent skip.
//
// Usage: node lib/recon/recon-run.mjs --url=<url> [--steps=<n>]
// Success → one {ok:true, route, baseline, stopped, stats, steps} envelope, exit 0.
// Failure → one {ok:false, error:{code,message}} envelope on stderr, non-zero exit.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnvelope, envelopeError, exitCode } from '../core/envelope.mjs';
import { attach, gotoGated } from '../browser/session.mjs';
import { waitSettled, resetTrackerVerdicts } from '../browser/causal.mjs';
import { loadLedger, saveLedger } from '../graph/ids.mjs';
import { loadGraph, saveGraph } from '../graph/graph-store.mjs';
import { snapshotStep, actStep } from './step.mjs';
import { routeKey, sameOrigin } from './scope.mjs';
import { dismissOverlays } from './overlays.mjs';
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

// A persistent step: re-navigate the ONE already-open page to the TARGET's own route
// (`node.route`, discovered when an earlier act navigated there), then act. This is what
// makes recon multi-route — a control found on /products is reached by navigating to
// /products, not by re-loading the entry page. The browser is launched once by crawl()
// and reused across every act — no per-act launch. Re-navigation re-runs the probe
// init-script (fresh fire-ring) so each act is independent; the initiator tracker was
// armed before the first navigation and stays armed, so load-time pollers on every
// re-navigation are still async-tagged (causal attribution unchanged). The route is a
// same-origin routeKey; reconstruct a concrete URL against the run's origin. Mutates
// graph + ledger via closure.
function persistentStep({ page, origin, ledger }) {
  return async (graph, target) => {
    const navUrl = new URL(target.route, origin).href;
    // Defense-in-depth: never navigate off the run origin. routeKey already normalizes a
    // leading `//` so it cannot reconstruct as a protocol-relative off-origin url, but a
    // guard here means a bad route can only ever fail the step (→ unreachable), never send
    // the recon browser to a foreign host (gotoGated's SSRF gate allows public hosts).
    if (!sameOrigin(navUrl, origin)) {
      throw envelopeError({ code: 'OFF_ORIGIN', message: `refusing to navigate off-origin to ${navUrl}` });
    }
    await gotoGated(page, navUrl);
    await waitSettled(page);
    // Clear a cookie/consent overlay before this act — while cause is still __idle__, so its
    // accept-click request is excluded and cannot forge a causal edge. Runs BEFORE the verdict
    // reset so any sticky verdict the accept-click leaves is cleared with the rest.
    const dismissed = await dismissOverlays(page);
    if (dismissed) { await waitSettled(page); process.stderr.write(JSON.stringify({ overlayDismissed: dismissed }) + '\n'); }
    // Reused page: clear stale cross-act initiator verdicts so a path an earlier act
    // click-rooted cannot suppress the timer-rejection of a same-path background poll in
    // THIS act's window (would forge a phantom causal edge). The current page's load-burst
    // is already excluded by the token filter (cause=__idle__, seq<seq0), so clearing here
    // is safe; this act's own requests get classified fresh inside its window.
    resetTrackerVerdicts(page);
    return await actStep(page, graph, ledger, target);
  };
}

// deps.acquire is injectable so a test can count acquisitions (must be exactly one for
// the whole crawl) without spawning; defaults to attach() — which CONNECTS to the shared
// daemon when one is up (so recon-run reuses it too) and cold-launches otherwise.
export async function crawl(opts, deps = {}) {
  const acquire = deps.acquire || attach;
  const stateDir = process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state');
  const ledgerPath = path.join(stateDir, 'element-ids.json');
  const graphPath = path.join(stateDir, 'graph.json');
  const ledger = loadLedger(ledgerPath);
  const graph = loadGraph(graphPath);
  const origin = new URL(opts.url).origin;
  const route = routeKey(opts.url);
  const budget = opts.steps != null ? { steps: Number(opts.steps) } : {};
  const persist = () => { saveLedger(ledgerPath, ledger); saveGraph(graphPath, graph); };

  // ONE browser for the whole crawl: baseline snapshot + every act run on it.
  const { page, release } = await acquire();
  try {
    await gotoGated(page, opts.url);
    await waitSettled(page);
    const baselineDismissed = await dismissOverlays(page);
    if (baselineDismissed) { await waitSettled(page); process.stderr.write(JSON.stringify({ overlayDismissed: baselineDismissed }) + '\n'); }
    const baseline = await snapshotStep(page, graph, ledger, route);

    const step = persistentStep({ page, origin, ledger });
    const loop = await reconLoop(graph, { step, budget, onStep: persist });

    persist(); // final save (also covers the zero-step case, where onStep never fired)
    return { ok: true, route, baseline, stopped: loop.stopped, stats: loop.stats, steps: loop.steps };
  } finally {
    await release();
  }
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
