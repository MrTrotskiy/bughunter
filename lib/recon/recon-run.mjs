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

import fs from 'node:fs';
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
import { exploreAllArmed } from './explore-policy.mjs';
import { huntMarker } from './hunt-gate.mjs';
import { statefulStep } from './stateful-step.mjs';
import { statefulLoop } from './stateful-loop.mjs';
import { reconLoop } from './recon-loop.mjs';
import { harvestRoutes, seedRoutes, nextPendingRoute, visitRoute, probeNotFound } from './route-frontier.mjs';
import { harvestLinks } from './nav-links.mjs';
import { extractRoutes, seedManifestRoutes, seedParamPatterns } from './route-manifest.mjs';
import { openRun, closeRun, makeCapture, traceEvent, snapshotGraph, activeRunId } from '../debug/trace.mjs';

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
function persistentStep({ page, origin, ledger, runId, graphPath, marker, runCreatedAccount, exploreAll, stateDir }) {
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
    // Lifted under explore-all: such a route is a page the mode is meant to reach. A logout that lands
    // there is settled by re-login (result.needsRelogin), not by declining to navigate.
    if (!exploreAll && routeRefused(target.route)) {
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
    let revealPath = [];
    try {
      // GAP 2 stay-on-page: replay the target's in-page reveal path (if any) so its instance
      // is present for the measured act (applyReveal; a stale/danger/navigating step throws).
      // Re-read reveal from the GRAPH, not the stale batch item: an opener acted earlier in THIS
      // batch may have just FILLED this control's reveal path (panel reach), which the frontier
      // snapshot taken before that act would miss. Prefer the live path; fall back to the batch item.
      const liveInst = target.instance
        && graph.elements[target.templateId]?.instances?.find((i) => i.instanceKey === target.instance.instanceKey);
      const liveTarget = (liveInst && liveInst.reveal) ? { ...target, reveal: liveInst.reveal } : target;
      revealPath = await applyReveal(page, graph, liveTarget);
      // Reused page: clear stale cross-act initiator verdicts (load burst, overlay accept, AND
      // the reveal clicks) so none suppress a same-path poll's timer-rejection in THIS window.
      resetTrackerVerdicts(page);
      const capture = runId ? makeCapture(runId, target.templateId) : undefined;
      res = await actStep(page, graph, ledger, target, {
        capture, revealPath, marker, runCreatedAccount,
        // EXPLORE-ALL: full-write exploration. actStep's own rail (explore-policy) governs it; stateDir
        // lets a foreign edit journal its rollback before the click.
        exploreAll, stateDir, runId,
      });
    } catch (err) {
      // NOTE (INC.4): an overlay-dismiss retry was ported here from stateful-step and then REMOVED. It is
      // architecturally wrong for THIS driver: persistentStep re-navigates before every act (above), so a
      // PRIOR act's modal cannot survive into this one — any overlay present at click time was opened by
      // THIS act's own applyReveal. Dismissing it therefore destroys the exact state the target needs, and
      // the retry did not re-run applyReveal, so on a reveal-carrying target a "successful" dismiss
      // guaranteed NO_INSTANCE. Measured: it could fire for at most 4 of 52 click-timeouts (the AntD
      // dropdown selectors that dominate them are not in OVERLAY_SELECTORS at all). The real cause was
      // transient motion classes in the selector — fixed in dom-snapshot.isMotionClass. dismissBlockingOverlay
      // stays where it is correct: statefulStep, which does NOT re-navigate.
      // applyReveal (REVEAL_*) or actStep (NOT_VISIBLE/NO_INSTANCE/DANGER_FLOOR) failed — re-throw
      // so the loop marks it unreachable (coverage unchanged); the agent path logs via observe.
      recordFail(err);
      throw err;
    }
    // BFS route discovery (edge-free): harvest a[href] on the LANDED page, so a nav act that opened
    // a new same-origin page enqueues its links for the route-frontier's refill drain. Metadata-only
    // write to graph.routes — no causal window, no addTrigger.
    await harvestRoutes(page, graph, origin);
    await harvestLinks(page, graph, origin); // structural page→page nav edges (non-causal; see nav-links.mjs)
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

  // MANDATORY run trail (operator rule 2026-07-18): mint a run id when the operator did not supply one,
  // so no crawl is ever unlogged. openRun is idempotent (safe whether /recon already opened the run) and
  // proves the trail is WRITABLE before the first act — fail-fast, nothing yet performed or mis-attributed.
  // Every actStep below then writes an `act` event + graph snapshot; the run is closed in the finally.
  const runId = activeRunId();
  openRun({ runId, target: opts.url });

  // WRITE POSTURE: explore-all is the only one. Armed by the operator alone (BUGHUNTER_EXPLORE_ALL/
  // --explore-all + a run id for the ownership marker — exploreAllArmed, explore-policy.mjs). When armed,
  // actStep drops the danger-floor refusals and keeps the ONE rail that survives: another user's content
  // is edited-with-restore, never destroyed. When NOT armed the crawl behaves as it always did — the
  // danger-floor click/navigation gates still refuse destructive/auth/payment controls and routes.
  const exploreAll = exploreAllArmed(process.env, { exploreAll: opts.exploreAll, runId });
  // The HUNT-<runId> ownership marker: stamped into every fill so content THIS run creates is provably
  // ours later. It is what makes the foreign-content rail decidable, so explore-all cannot run without it.
  const marker = exploreAll ? huntMarker(runId) : null;
  const runCreatedAccount = !!opts.runCreatedAccount || !!process.env.BUGHUNTER_HUNT_CREATED_ACCOUNT;

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

    // STATEFUL (opt-in `--stateful`): the operator's in-session loop. Act on the LIVE, already-
    // accumulated page and re-snapshot in place — a modal/dropdown an act opens stays open, so its
    // controls become genuine coverage next round WITHOUT reveal-replay (statefulStep). Driven by the
    // LOCATION-AWARE statefulLoop (INC.2, not the location-blind reconLoop): it drains the current
    // route's reachable controls, follows a nav act to a new page, and BACKTRACKS in-session (gotoGated,
    // session preserved) to routes still holding unfinished controls until every route's remainder is
    // zero. Deliberately NO route-frontier seed/refill: statefulLoop navigates only to routes DISCOVERED
    // by ACTING (a nav act's landed page), never a cold visit that would hand statefulStep controls that
    // do not resolve on the live page. An empty routesWithWork everywhere is the completion oracle.
    // ROUTE DISCOVERY runs for BOTH drivers. Only the metadata-only half is lifted here: the manifest seed
    // and the a[href] harvest write graph.routes and nothing else — no elements, no edges, no addTrigger,
    // no causal window. The stateful branch's original "deliberately NO route-frontier" note is still
    // honoured for the half that matters: seedRoutes/visitRoute COLD-visit pages and would hand statefulStep
    // controls that do not resolve on the live page, so they stay stateless-only. Without this, the stateful
    // driver's route universe was {entry URL} ∪ {wherever an act landed} — 3 patterns against the 85 the
    // stateless path reached, with /groups, /events, /chats, /profile and /setting never queued at all, so
    // two of the six user flows could not produce a single act. statefulLoop drains what is queued here by
    // NAVIGATING in-session (goToRoute), never by cold-visiting.
    if (opts.seedManifest !== false) {
      const manifest = await extractRoutes(page);
      const seedRes = seedManifestRoutes(graph, manifest.routes, origin);
      const paramRes = seedParamPatterns(graph, manifest.paramRoutes);
      process.stderr.write(JSON.stringify({ manifestSeeded: seedRes.seeded, manifestSkipped: seedRes.skipped, manifestDeclared: seedRes.declaredTotal, paramPatterns: paramRes.seeded }) + '\n');
    }
    await harvestRoutes(page, graph, origin);
    persist();

    let loop;
    if (opts.stateful) {
      const step = statefulStep({ page, origin, baselineUrl: opts.url, ledger, runId, graphPath, exploreAll, stateDir, marker, runCreatedAccount });
      loop = await statefulLoop(graph, { page, origin, ledger, step, budget, onStep: persist, runId });
    } else {
      // STATELESS (default, UNCHANGED): SEED phase (edge-free BFS) — harvest the baseline page's
      // routes, then snapshot-visit the whole discoverable route queue BEFORE any act — so a control
      // that lives only on a page beyond the element OPENER_INSTANCE_CAP (a wide nav's 9th tab, a
      // 50-row listing's detail page) is reached. Discovery opens no causal window: zero edges.
      //
      // The manifest seed and harvestRoutes now run ABOVE this branch (both drivers need them).
      await harvestLinks(page, graph, origin); // structural page→page nav edges (non-causal; see nav-links.mjs)
      // NEGATIVE-CONTROL client-404 label (GOAL 1): fingerprint the app's Not-Found shell ONCE via a GET
      // to a guaranteed-nonexistent path, so route-coverage can tell a constant-URL SPA's dead routes
      // (200 + shared Not-Found) from real content-starved sections. Edge-free (navigate + contentSig,
      // no causal window), idempotent (graph.notFoundSig). Runs AFTER the baseline harvest (which reads
      // this page's a[href]) and BEFORE seedRoutes re-navigates per route.
      await probeNotFound(page, graph, origin);
      await seedRoutes(page, graph, ledger, { origin });
      persist();

      // refill drains routes discovered only by ACTING (a nav act's landed page) once the template
      // frontier empties — the seed-then-loop hook. Drain ⟺ template frontier AND route queue empty.
      const refill = async (g) => {
        const rk = nextPendingRoute(g);
        if (!rk) return false;
        await visitRoute(page, g, ledger, rk, { origin });
        persist();
        return true;
      };

      const step = persistentStep({
        page, origin, ledger, runId, graphPath,
        marker, runCreatedAccount, exploreAll, stateDir,
      });
      // GOAL 5 variance: BUGHUNTER_SEED re-permutes the frontier so ≥2 budget-capped (--steps) re-crawls
      // explore different subsets — the run-to-run difference the Chao2 completeness oracle needs.
      // SESSION REPAIR under explore-all: a fired Logout (or a click onto an auth route) ends the
      // session. Re-authenticate with the SAME operator env credentials the pre-step used, then re-apply
      // the refreshed storageState to the LIVE context so the already-open page is authed again —
      // reloading the state file alone would only affect a future context. Requires an authed run
      // (BUGHUNTER_STORAGE_STATE) and the login env; absent either, the hook is null and reconLoop stops
      // honestly with 'relogin-failed' instead of crawling on logged-out.
      const stateFile = process.env.BUGHUNTER_STORAGE_STATE;
      const canRelogin = exploreAll && stateFile && process.env.BUGHUNTER_LOGIN_USER && process.env.BUGHUNTER_LOGIN_PASS;
      const relogin = canRelogin ? async () => {
        const { login } = await import('./login.mjs');
        const res = await login({ loginUrl: opts.loginUrl || new URL('/login', origin).href, out: stateFile });
        if (!res || res.ok === false) return false;
        const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        await page.context().addCookies(stored.cookies || []);
        await gotoGated(page, opts.url);           // land back on the run's entry point, authed
        await waitSettled(page);
        return true;
      } : null;
      loop = await reconLoop(graph, { step, budget, seed: process.env.BUGHUNTER_SEED, onStep: persist, refill, relogin });
    }

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
    const result = await crawl({
      url: args.url,
      steps: args.steps,
      stateful: args.stateful === true,
      // --explore-all: the operator's FULL-exploration mode. No danger-floor refusals; unknown/destructive/
      // payment controls are all fired so they can be classified. One rail survives: another user's content
      // is edited-with-restore, never destroyed (explore-policy.mjs). --created-account permits account
      // deletion only if THIS run made the account.
      exploreAll: args['explore-all'] === true,
      runCreatedAccount: args['created-account'] === true,
      // Route-manifest seeding is ON by default (expands the honest denominator on a constant-URL SPA);
      // --no-seed-manifest opts out. A manifest seed is safe (denominator + gated genuine visits only).
      seedManifest: args['no-seed-manifest'] !== true,
    });
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
