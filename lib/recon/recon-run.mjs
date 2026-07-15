#!/usr/bin/env node
// recon-run — the Phase-1 loop runner CLI. Seeds the frontier with a baseline
// snapshot, then drives reconLoop over a PERSISTENT browser step: ONE browser for
// the whole crawl (launched once), re-navigated per act to the TARGET control's own
// same-origin route — so a control first seen on /products is reached by loading
// /products, making recon MULTI-ROUTE. The graph (persisted between steps) is the
// memory. This spends one chromium process for the run, not one per act — the resource
// win. Controls reachable by a direct same-origin navigation are covered; a control behind a
// DEPTH-1 in-page reveal (a modal button) is also reached — a per-act reveal prologue replays
// its recorded path (reveal-replay.mjs). Deeper / mutating reveals stay honestly unreachable,
// surfaced as a step-level error, never a silent skip.
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
import { loadGraph, saveGraph, markInstanceExplored } from '../graph/graph-store.mjs';
import { snapshotStep, actStep } from './step.mjs';
import { routeKey, sameOrigin } from './scope.mjs';
import { routeRefused } from './danger-floor.mjs';
import { dismissOverlays } from './overlays.mjs';
import { applyReveal } from './reveal-replay.mjs';
import { reconLoop } from './recon-loop.mjs';
import { openRun, closeRun, makeCapture, traceEvent, snapshotGraph } from '../debug/trace.mjs';

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
// (`node.route`), dismiss overlays, replay the target's in-page reveal path if any (applyReveal
// — GAP 2 stay-on-page reach), then act. Re-navigation makes recon multi-route (a /products
// control is reached by loading /products) and re-runs the probe init-script (fresh fire-ring)
// so acts stay independent; the initiator tracker, armed before the first navigation, stays
// armed so load-time pollers are still async-tagged (causal attribution unchanged). The route
// is a same-origin routeKey reconstructed against the run's origin; mutates graph + ledger.
function persistentStep({ page, origin, ledger, runId, graphPath }) {
  return async (graph, target) => {
    // Record a FAILED step on the debug timeline (opt-in via runId) so the admin shows the
    // "why didn't it reach X?" cases — the PRE-NAV guards (OFF_ORIGIN / ROUTE_DANGER), the
    // reveal replay (REVEAL_*) and the actStep throws — that reconLoop's catch would otherwise
    // swallow into markUnreachable with no trail entry.
    const recordFail = (err) => {
      if (!runId) return;
      traceEvent(runId, 'act', {
        templateId: target.templateId, name: target.name, role: target.role, route: target.route,
        error: err?.message || String(err), requests: [], revealed: 0, shots: null,
      });
    };
    const navUrl = new URL(target.route, origin).href;
    // Defense-in-depth: never navigate off the run origin. routeKey already normalizes a
    // leading `//` so it cannot reconstruct as a protocol-relative off-origin url, but a
    // guard here means a bad route can only ever fail the step (→ unreachable), never send
    // the recon browser to a foreign host (gotoGated's SSRF gate allows public hosts).
    if (!sameOrigin(navUrl, origin)) {
      const err = envelopeError({ code: 'OFF_ORIGIN', message: `refusing to navigate off-origin to ${navUrl}` });
      recordFail(err); throw err;
    }
    // Self-logout guard (authed runs): the click gate only sees a control's NAME, so a
    // GET /logout route reached by NAVIGATION would end the session with no click it can
    // catch. Refuse to navigate to a destructive/auth/payment route — reconLoop's catch
    // marks it unreachable, so /logout is honestly counted refused, never visited.
    if (routeRefused(target.route)) {
      const err = envelopeError({ code: 'ROUTE_DANGER', message: `refusing to navigate to a danger route ${target.route}`, exit: 'VIOLATION' });
      recordFail(err); throw err;
    }
    await gotoGated(page, navUrl);
    await waitSettled(page);
    // Clear a cookie/consent overlay before this act — while cause is still __idle__, so its
    // accept-click request is excluded and cannot forge a causal edge. Runs BEFORE the verdict
    // reset so any sticky verdict the accept-click leaves is cleared with the rest.
    const dismissed = await dismissOverlays(page);
    if (dismissed) { await waitSettled(page); process.stderr.write(JSON.stringify({ overlayDismissed: dismissed }) + '\n'); }
    let res;
    try {
      // GAP 2 stay-on-page: replay the target's in-page reveal path (if any) so its instance
      // is present for the measured act (applyReveal; a stale/danger/navigating step throws).
      const revealPath = await applyReveal(page, graph, target);
      // Reused page: clear stale cross-act initiator verdicts (load burst, overlay accept, AND
      // the reveal clicks) so none suppress a same-path poll's timer-rejection in THIS window.
      resetTrackerVerdicts(page);
      const capture = runId ? makeCapture(runId, target.templateId) : undefined;
      res = await actStep(page, graph, ledger, target, { capture, revealPath });
    } catch (err) {
      // applyReveal (REVEAL_*) or actStep (NOT_VISIBLE/NO_INSTANCE/DANGER_FLOOR) failed — re-throw
      // so the loop marks it unreachable (coverage unchanged); the agent path logs via observe.
      recordFail(err);
      throw err;
    }
    // Debug trail (opt-in via runId): record this act + snapshot the graph. reconLoop marks
    // the template explored AFTER step() returns, so mark it here too (idempotent) — else the
    // per-act snapshot would show the just-acted control as still `unexplored`. saveGraph
    // first so the snapshot on disk reflects the merged revealed controls + explored flag.
    if (runId) {
      markInstanceExplored(graph, target.templateId, target.instance && target.instance.instanceKey);
      const seq = traceEvent(runId, 'act', {
        templateId: target.templateId, name: target.name, role: target.role, route: res.route,
        requests: res.requests, revealed: res.newElements.length, external: res.external || null,
        timings: res.debug?.timings || null,
        shots: res.debug ? { before: res.debug.before?.shot, after: res.debug.after?.shot, rect: res.debug.before?.rect, viewport: res.debug.before?.viewport } : null,
        bodies: res.debug?.bodies || null, // REFS only (paths); raw redacted bytes live in bodies/*
      });
      saveGraph(graphPath, graph);
      snapshotGraph(runId, seq);
    }
    return res;
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

  // Opt-in debug trail (set by /recon or the admin): openRun is idempotent, so it is safe
  // whether the caller already opened the run or not. Every actStep below then writes an
  // `act` event + graph snapshot; the run is closed with the final stats in the finally.
  const runId = process.env.BUGHUNTER_RUN_ID || null;
  if (runId) openRun({ runId, target: opts.url });

  // ONE browser for the whole crawl: baseline snapshot + every act run on it.
  const { page, release } = await acquire();
  try {
    await gotoGated(page, opts.url);
    await waitSettled(page);
    const baselineDismissed = await dismissOverlays(page);
    if (baselineDismissed) { await waitSettled(page); process.stderr.write(JSON.stringify({ overlayDismissed: baselineDismissed }) + '\n'); }
    const baseline = await snapshotStep(page, graph, ledger, route);
    if (runId) {
      persist(); // make the on-disk graph current so the baseline snapshot is complete
      const seq = traceEvent(runId, 'route', { route, ...baseline, overlayDismissed: baselineDismissed || null });
      snapshotGraph(runId, seq);
    }

    const step = persistentStep({ page, origin, ledger, runId, graphPath });
    const loop = await reconLoop(graph, { step, budget, onStep: persist });

    persist(); // final save (also covers the zero-step case, where onStep never fired)
    if (runId) closeRun(runId, { stats: loop.stats, stopped: loop.stopped, steps: loop.steps.length });
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
