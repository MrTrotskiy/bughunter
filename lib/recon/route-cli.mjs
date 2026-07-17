#!/usr/bin/env node
// route-cli — the deterministic route-visit DRIVER the /recon loop calls BETWEEN agent acts. The
// LLM recon subagent keeps ACTING (whats-new); THIS driver NAVIGATES one queued page per call, so
// the agent never runs its own BFS. It is the agent-path twin of recon-run's `refill` hook.
//
// SNAPSHOT-ONLY + EDGE-FREE (the invariant that killed the predecessor): visitRoute re-navigates to
// the route, snapshots the landed page into the graph, promotes the route to visited, and harvests
// its links — it NEVER opens a causal window or addTrigger. A navigation forges ZERO edges; request
// attribution stays token + initiator, never a side effect of loading a page. Every gate is reused
// with no bypass: routeRefused (danger) + navigateGated (SSRF) live inside visitRoute; the route
// queue is the ONE graph.routes store (routeKey/toUrlPattern, no third normalizer). Explored ⟺
// observed still holds — this snapshots/discovers controls but NEVER marks one explored (only an act does).
//
// Usage: node lib/recon/route-cli.mjs (--visit-next | --seed-manifest) --url=<url>
//   --visit-next: drain ONE pending route → snapshot it → report the route-frontier stats.
//   --seed-manifest: navigate the target, extract the app's DECLARED route list from its own
//     same-origin bundles, and seed the declared routes as PENDING nodes --visit-next then drains
//     — expanding the honest denominator (metadata-only, no act/causal window/edges).
// Success → {ok:true, visited:<rk|null>, routeStats:{...}} (--visit-next) or {ok:true, seeded, declared,
// paramPatterns, routeStats} (--seed-manifest) on stdout, exit 0. A null nextPendingRoute is an
// idempotent no-op ({visited:null}, exit 0) — no browser is acquired.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnvelope, exitCode } from '../core/envelope.mjs';
import { attach, gotoGated } from '../browser/session.mjs';
import { waitSettled } from '../browser/causal.mjs';
import { loadLedger, saveLedger } from '../graph/ids.mjs';
import { loadGraph, saveGraph } from '../graph/graph-store.mjs';
import { nextPendingRoute, visitRoute, routeFrontierStats, probeNotFound } from './route-frontier.mjs';
import { extractRoutes, seedManifestRoutes, seedParamPatterns } from './route-manifest.mjs';
import { dismissOverlays } from './overlays.mjs';
import { traceEvent, snapshotGraph } from '../debug/trace.mjs';

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}

export async function run(opts) {
  const stateDir = process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state');
  const ledgerPath = path.join(stateDir, 'element-ids.json');
  const graphPath = path.join(stateDir, 'graph.json');
  const ledger = loadLedger(ledgerPath);
  const graph = loadGraph(graphPath);
  // Origin from the target arg (the graph stores route PATHS, not an absolute origin) — visitRoute
  // reconstructs `new URL(rk, origin)`. Same derivation whats-new/recon-run use.
  const origin = new URL(opts.url).origin;

  // --seed-manifest (the agent-path twin of recon-run's manifest seed): navigate the target, extract
  // the app's DECLARED route list from its own same-origin bundles, and seed the declared routes as
  // PENDING nodes the existing --visit-next drain will GENUINELY visit. Metadata-only (no act, no
  // causal window, no edges) — it EXPANDS the honest denominator, it never claims coverage. The
  // existing loop's `visit-route` verdict drains what this queues.
  if (opts.seedManifest) {
    const { page, release } = await attach();
    try {
      await gotoGated(page, opts.url);
      await waitSettled(page);
      await dismissOverlays(page);
      const manifest = await extractRoutes(page);
      const seedRes = seedManifestRoutes(graph, manifest.routes, origin);
      const paramRes = seedParamPatterns(graph, manifest.paramRoutes);
      saveGraph(graphPath, graph);
      const routeStats = routeFrontierStats(graph);
      const runId = process.env.BUGHUNTER_RUN_ID || null;
      if (runId) {
        const seq = traceEvent(runId, 'route.seed-manifest', { seeded: seedRes.seeded, declared: seedRes.declaredTotal, paramPatterns: paramRes.seeded, routeStats });
        snapshotGraph(runId, seq);
      }
      return { ok: true, seeded: seedRes.seeded, skipped: seedRes.skipped, declared: seedRes.declaredTotal, paramPatterns: paramRes.seeded, routeStats };
    } finally {
      await release();
    }
  }

  const rk = nextPendingRoute(graph);
  // Idempotent no-op: nothing queued → return without acquiring a browser (the /recon loop calls
  // this until the queue drains; a spurious final call must be cheap and side-effect-free).
  if (!rk) return { ok: true, visited: null, routeStats: routeFrontierStats(graph) };

  // attach() connects to the shared daemon if one is up, else cold-launches — same convention as
  // whats-new. BUGHUNTER_STORAGE_STATE (authed) is loaded inside contextOptions at newContext.
  const { page, release } = await attach();
  try {
    // NEGATIVE-CONTROL client-404 label (GOAL 1): fingerprint the app's Not-Found shell ONCE (idempotent
    // via graph.notFoundSig) before the first route is classified, so route-coverage can tell a constant-
    // URL SPA's dead routes (200 + shared Not-Found) from real content-starved sections. Edge-free
    // (navigate + contentSig, no causal window); a near-zero-cost no-op after the first visit-next.
    await probeNotFound(page, graph, origin);
    const res = await visitRoute(page, graph, ledger, rk, { origin });
    saveLedger(ledgerPath, ledger);
    saveGraph(graphPath, graph);
    const routeStats = routeFrontierStats(graph);

    // Opt-in debug trail (set by /recon): record the route drain + snapshot the coverage so the
    // admin's scrubber has a state for it. deriveSteps ignores non-`act` kinds, so a route.visit
    // event rides along without perturbing the walk timeline. Best-effort (traceEvent swallows).
    const runId = process.env.BUGHUNTER_RUN_ID || null;
    if (runId) {
      const seq = traceEvent(runId, 'route.visit', { route: rk, visited: res.visited, routeStats });
      snapshotGraph(runId, seq);
    }
    // `visited` is the route we successfully snapshotted, or null if it turned out unreachable
    // (404/redirect/off-scope) — the loop keys continuation on routeStats.pending, not this field.
    return { ok: true, visited: res.visited ? rk : null, routeStats };
  } finally {
    await release();
  }
}

function emitError(env) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: env.code, message: env.message } }) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['visit-next'] && !args['seed-manifest']) {
    emitError(makeEnvelope({ code: 'USAGE', message: 'missing required action: --visit-next or --seed-manifest', exit: 'USAGE' }));
    process.exit(64);
  }
  if (!args.url) {
    emitError(makeEnvelope({ code: 'USAGE', message: 'missing required --url=<url> (origin for route reconstruction)', exit: 'USAGE' }));
    process.exit(64);
  }
  try {
    const result = await run({ url: args.url, seedManifest: args['seed-manifest'] === true });
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
