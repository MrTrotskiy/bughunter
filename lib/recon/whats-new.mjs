#!/usr/bin/env node
// whats-new — the keystone CLI. Snapshot a route into the graph, optionally act on
// one element (by templateId), and report what the action CAUSED (requests bound
// by causal token + initiator) and what it REVEALED (new element instances).
//
// Usage: node lib/recon/whats-new.mjs --url=<url> [--act-template=<id> --fill=<text>]
// Success → one {ok:true,...} envelope on stdout, exit 0.
// Failure → one {ok:false,error:{code,message}} envelope on stderr, non-zero exit.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnvelope, envelopeError, exitCode } from '../core/envelope.mjs';
import { attach, gotoGated } from '../browser/session.mjs';
import { waitSettled, resetTrackerVerdicts } from '../browser/causal.mjs';
import { loadLedger, saveLedger } from '../graph/ids.mjs';
import { loadGraph, saveGraph } from '../graph/graph-store.mjs';
import { snapshotStep, actStep } from './step.mjs';
import { applyReveal } from './reveal-replay.mjs';
import { harvestRoutes } from './route-frontier.mjs';
import { harvestLinks } from './nav-links.mjs';
import { routeKey } from './scope.mjs';
import { routeRefused } from './danger-floor.mjs';
import { exploreAllArmed } from './explore-policy.mjs';
import { huntMarker } from './hunt-gate.mjs';
import { dismissOverlays } from './overlays.mjs';
import { makeCapture, traceEvent, snapshotGraph, activeRunId, openRun } from '../debug/trace.mjs';

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
  const route = routeKey(opts.url);
  // WRITE POSTURE (agent path): explore-all is the only one, and only the OPERATOR can arm it
  // (BUGHUNTER_EXPLORE_ALL/--explore-all + a run id for the ownership marker — exploreAllArmed,
  // explore-policy.mjs). Armed → actStep drops the danger-floor refusals and keeps the ONE rail that
  // survives: another user's content is edited-with-restore, never destroyed. Unarmed → the danger-floor
  // click/navigation gates refuse destructive/auth/payment as they always have.
  const exploreAll = exploreAllArmed(process.env, { exploreAll: opts.exploreAll, runId: opts.runId });
  // The per-run HUNT-<runId> ownership marker — stamped into every fill so content THIS run created is
  // provably ours later. It is the only thing that distinguishes our content from a stranger's, so the
  // foreign-content rail depends on it. runCreatedAccount gates account-deletion (the operator's rule:
  // delete an account only if THIS run created it — never a persistent test account).
  const marker = exploreAll ? huntMarker(opts.runId || process.env.BUGHUNTER_RUN_ID) : null;
  const runCreatedAccount = !!opts.runCreatedAccount || !!process.env.BUGHUNTER_HUNT_CREATED_ACCOUNT;
  // Self-logout / self-destruct guard (mirrors persistentStep): refuse to even navigate to a
  // destructive/auth/payment route. On the agent path a transient /logout nav would end the
  // authed session and pollute coverage with the resulting /login controls. Fail fast before
  // acquiring a browser.
  // Lifted under explore-all: a /logout or /item/42/delete route is a page the mode is meant to study.
  // The session cost is handled by re-login, not by refusing to look.
  if (!exploreAll && routeRefused(route)) {
    throw envelopeError({ code: 'ROUTE_DANGER', message: `refusing to navigate to a danger route ${route}`, exit: 'VIOLATION' });
  }

  // attach() connects to the shared browser daemon if one is running (one chromium for
  // the whole run), else cold-launches a private browser — identical behavior either way.
  const { page, release } = await attach();
  try {
    await gotoGated(page, opts.url);
    // Derived AFTER gotoGated so a malformed URL surfaces as gotoGated's structured BAD_URL, not a
    // raw throw here. Same origin the route-frontier harvest scopes against (agent path parity with
    // recon-run's `const origin = new URL(opts.url).origin`).
    const origin = new URL(opts.url).origin;
    await waitSettled(page);
    // Clear a cookie/consent overlay BEFORE snapshot/act, while cause is still __idle__
    // (its accept-click request is excluded, never a causal edge). Best-effort. If it
    // fired, let the re-render settle, then CLEAR the accept-click's foreground initiator
    // verdict — otherwise a same-path background poll in the later act window would inherit
    // that sticky verdict and forge a phantom edge (the bughunt-agents failure class, the
    // same reason persistentStep resets per act).
    const overlayDismissed = await dismissOverlays(page);
    if (overlayDismissed) { await waitSettled(page); resetTrackerVerdicts(page); }

    // Baseline: snapshot → mint ids → merge. These are the pre-action elements.
    const result = { ok: true, route, baseline: await snapshotStep(page, graph, ledger, route) };
    if (overlayDismissed) result.overlayDismissed = overlayDismissed;

    // WHOLE-SITE REACH (INC.1b agent path): harvest the baseline page's a[href] into the route
    // frontier (graph.routes[*].pending) so the /recon driver's route-cli can visit pages beyond the
    // element cap. This is the FIRST of the two idle harvest points recon-run's persistentStep uses.
    // Cause is __idle__ here: no beginCause has run (the only preceding acts — overlay dismiss — were
    // reset via resetTrackerVerdicts above, and the baseline snapshotStep is read-only). Metadata-only,
    // edge-free: harvestRoutes writes graph.routes flags, never an element or a causal edge.
    await harvestRoutes(page, graph, origin);
    await harvestLinks(page, graph, origin); // structural page→page nav edges (non-causal; see nav-links.mjs)

    // MANDATORY run trail (operator rule 2026-07-18): every act is logged. `activeRunId` returns the
    // operator's run id, or mints one and publishes it into the environment so the sibling agent-path
    // CLIs join the SAME run. There is no longer an unlogged path — a crawl that commits creates,
    // edits and deletes must leave a record of what it touched. SCREENSHOTS remain view-mode-only.
    const runId = activeRunId();
    if (runId) {
      const seq = traceEvent(runId, 'route', { route, ...result.baseline, overlayDismissed: overlayDismissed || null });
      // Snapshot the baseline graph at this seq so the admin's step scrubber has a graph state
      // for the route event (recon-run does the same); saveGraph first so the copy is current.
      saveGraph(graphPath, graph);
      snapshotGraph(runId, seq);
    }

    if (opts.actTemplate != null) {
      const tid = Number(opts.actTemplate);
      const node = graph.elements[tid];
      if (!node || !node.instances.length) {
        throw envelopeError({ code: 'NO_TEMPLATE', message: `no element instance for templateId ${opts.actTemplate}` });
      }
      // Opener-drain guard (review follow-up): a PROVEN opener with >1 instance MUST be acted per
      // instance — the frontier emits each sibling's instanceKey. Silently defaulting to instances[0]
      // would act the WRONG control (the representative, not the emitted sibling) AND leave the sibling
      // undrained, so the observation gets recorded against an instance that was never clicked. Fail
      // loud so the caller passes the --instance the frontier handed it (the node loop is immune — it
      // always threads the frontier target's key).
      if (opts.instance == null && node.opener && node.instances.length > 1) {
        throw envelopeError({
          code: 'USAGE',
          message: `template ${tid} is a proven opener with ${node.instances.length} instances — pass --instance='<instanceKey>' (the frontier emits each sibling's key)`,
          exit: 'USAGE',
        });
      }
      // Agent-path stay-on-page (mirror persistentStep): replay the target's in-page reveal path
      // (if any) so a control behind an in-page action is PRESENT for the measured act. The reset
      // point is the baseline gotoGated(opts.url) above — the page is still in its default state
      // (the baseline snapshot is read-only), so applyReveal reconstructs the revealed state from
      // scratch. Valid whenever node.reveal.route === routeKey(opts.url), always true on a
      // constant-URL SPA (and for same-page reveals). applyReveal returns the FULL revealPath
      // (the target's prefix + itself) for actStep to stamp anything THIS act reveals — so depth-N
      // reveals accrete. resetTrackerVerdicts clears the replay clicks' initiator verdicts so none
      // suppress a same-path poll's timer-rejection in the measured window (same discipline as the
      // node loop). A stale/danger/off-origin/too-deep reveal throws → the act is honestly unreached.
      // Act on the instance the frontier emitted (state model: an opener's sibling instances are
      // addressable), defaulting to the representative instances[0]. The reveal path is instance-level
      // first (a control revealed in a specific state), falling back to the template annotation.
      const instance = opts.instance != null
        ? node.instances.find((i) => i.instanceKey === opts.instance)
        : node.instances[0];
      if (!instance) {
        throw envelopeError({ code: 'NO_INSTANCE', message: `no instance ${opts.instance} for template ${tid}` });
      }
      const target = { templateId: tid, name: node.name, role: node.role, route: node.route, instance, reveal: instance.reveal || node.reveal };
      const revealPath = await applyReveal(page, graph, target);
      resetTrackerVerdicts(page);
      result.acted = await actStep(
        page, graph, ledger, target,
        // marker is the HUNT-<runId> ownership proof the explore-all foreign-content rail reads back;
        // runCreatedAccount gates account-deletion.
        { fill: opts.fill, prefill: opts.prefill, capture: runId ? makeCapture(runId, tid) : undefined, revealPath, openerReplayable: opts.openerReplayable, marker, runCreatedAccount, exploreAll, stateDir, runId },
      );
      // WHOLE-SITE REACH (INC.1b) — the SECOND idle harvest point (mirrors persistentStep): a nav act
      // that landed on a new same-origin page enqueues its links for route-cli to drain. Runs AFTER
      // actStep's endCause has reset the cause to __idle__, so this a[href] read forges no causal edge
      // (harvestRoutes never opens a window / addTrigger). Scoped to the run origin regardless of the
      // route the act landed on.
      await harvestRoutes(page, graph, origin);
      await harvestLinks(page, graph, origin); // structural page→page nav edges (non-causal; see nav-links.mjs)
      if (runId) {
        const a = result.acted;
        const seq = traceEvent(runId, 'act', {
          templateId: tid, name: node.name, role: node.role, route: a.route,
          requests: a.requests, revealed: a.newElements.length, external: a.external || null,
          // fill is HUNT-tagged synthetic data today (auth/login-fill is unbuilt). REDACTION
          // POINT: when auth-fill lands, a typed password/PII must be masked here before it is
          // written to the trail and served by the admin (contained to 127.0.0.1, but plaintext).
          fill: opts.fill || null, timings: a.debug?.timings || null,
          shots: a.debug ? { before: a.debug.before?.shot, after: a.debug.after?.shot, rect: a.debug.before?.rect, viewport: a.debug.before?.viewport } : null,
        });
        saveGraph(graphPath, graph);
        snapshotGraph(runId, seq);
      }
    }

    saveLedger(ledgerPath, ledger);
    saveGraph(graphPath, graph);
    return result;
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
  try {
    // --opener-replayable: the agent's judgment that THIS opener's caused POST is a READ (a
    // list/search query), so its revealed children are replayable despite not being all-GET. Only
    // ever true from the agent path after judging non-mutating; never for a create/update/delete.
    const openerReplayable = args['opener-replayable'] === true || args['opener-replayable'] === 'true';
    // --explore-all: FULL exploration (operator-armed only). No danger-floor refusals — create/edit/
    // delete/payment/calls all commit, and unknown controls get clicked so they can be classified. The
    // single remaining rail: another user's content is edited-with-restore and never destroyed
    // (explore-policy.mjs). --created-account confirms THIS run made the account (gates account-deletion;
    // default off protects a persistent test account).
    const exploreAll = args['explore-all'] === true || args['explore-all'] === 'true';
    const runCreatedAccount = args['created-account'] === true || args['created-account'] === 'true';
    // --prefill='<css-selector>=<text>' (repeatable) — fill auxiliary fields before clicking the target,
    // in ONE act (the multi-step CREATE support). The FIRST '=' splits selector from value.
    const rawPre = args['prefill'];
    const preList = rawPre == null ? [] : (Array.isArray(rawPre) ? rawPre : [rawPre]);
    const prefill = preList.map((p) => { const s = String(p); const i = s.indexOf('='); return i < 0 ? null : { selector: s.slice(0, i), value: s.slice(i + 1) }; }).filter(Boolean);
    const result = await run({
      url: args.url, actTemplate: args['act-template'], instance: args.instance, fill: args.fill, prefill: prefill.length ? prefill : undefined, openerReplayable,
      exploreAll, runCreatedAccount,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (err) {
    let env = err && err.envelope;
    if (!env) {
      const code = typeof err?.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(err.code) ? err.code : 'INTERNAL';
      env = makeEnvelope({ code, message: err?.message || 'unknown error', exit: 'VIOLATION' });
    }
    // Record the granular fail-reason to the debug trail at throw time. On the agent path a
    // failed ACT's precise code (NO_TEMPLATE / NO_INSTANCE / NOT_VISIBLE / REVEAL_* / ROUTE_DANGER)
    // is otherwise LOST: emitError writes it to stderr only, the `act` trace event is written on
    // success alone, and the graph holds just the agent's COARSE observe effect
    // (unreachable-coldstart / not-visible). report.mjs --unreached needs these granular buckets,
    // so capture an `act.failed` here. Guarded to a real failed act (a run with --act-template), so
    // a usage/missing-url error unrelated to acting writes nothing. Best-effort and defensively
    // wrapped: traceEvent already swallows, but a capture failure must never change the exit path.
    const runId = process.env.BUGHUNTER_RUN_ID;
    if (runId && args['act-template'] != null) {
      try {
        traceEvent(runId, 'act.failed', {
          templateId: Number(args['act-template']),
          instance: args.instance ?? null,
          code: env.code,
          message: env.message,
        });
      } catch {}
    }
    emitError(env);
    process.exit(exitCode(env));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
