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
import { routeKey } from './scope.mjs';
import { routeRefused } from './danger-floor.mjs';
import { dismissOverlays } from './overlays.mjs';
import { makeCapture, traceEvent, snapshotGraph } from '../debug/trace.mjs';

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
  // Self-logout / self-destruct guard (mirrors persistentStep): refuse to even navigate to a
  // destructive/auth/payment route. On the agent path a transient /logout nav would end the
  // authed session and pollute coverage with the resulting /login controls. Fail fast before
  // acquiring a browser.
  if (routeRefused(route)) {
    throw envelopeError({ code: 'ROUTE_DANGER', message: `refusing to navigate to a danger route ${route}`, exit: 'VIOLATION' });
  }

  // attach() connects to the shared browser daemon if one is running (one chromium for
  // the whole run), else cold-launches a private browser — identical behavior either way.
  const { page, release } = await attach();
  try {
    await gotoGated(page, opts.url);
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

    // Opt-in debug trail (set by /recon): when BUGHUNTER_RUN_ID is present, this call writes
    // a `route` event (navigation + baseline counts) and, if it acts, an `act` event with
    // before/after key-frames + a graph snapshot, so the admin can replay the walk. No
    // runId → zero capture, byte-identical.
    const runId = process.env.BUGHUNTER_RUN_ID || null;
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
        { fill: opts.fill, capture: runId ? makeCapture(runId, tid) : undefined, revealPath, openerReplayable: opts.openerReplayable },
      );
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
    const result = await run({ url: args.url, actTemplate: args['act-template'], instance: args.instance, fill: args.fill, openerReplayable });
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
