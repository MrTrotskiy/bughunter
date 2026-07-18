#!/usr/bin/env node
// observe — the recon agent's "write what I learned" tool, and the ONLY thing that
// flips `explored` in the agent path (explored ⟺ observed, a richer denominator than
// explored ⟺ clicked). Validates the template + enums, enforces the destructive
// backstop (dangerFloor), then records the semantics and marks the template explored.
// Every graph write in the agent path goes THROUGH here (file-only handoff).
//
// Usage: node lib/recon/observe.mjs --template=<id> --purpose=<str> --danger=<enum>
//        --effect=<enum> [--acted=<bool>] [--state-change]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnvelope, envelopeError, exitCode } from '../core/envelope.mjs';
import { loadGraph, saveGraph, recordSemantics, markExplored, markUnreachable, markInstanceExplored, markInstanceUnreachable } from '../graph/graph-store.mjs';
import { dangerFloor } from './danger-floor.mjs';
import { exploreAllArmed } from './explore-policy.mjs';
import { traceEvent, snapshotGraph } from '../debug/trace.mjs';

const DANGER = new Set(['safe', 'destructive', 'auth', 'payment', 'unknown']);
const EFFECT = new Set(['none', 'request', 'navigate', 'reveal', 'state-change', 'unreachable-coldstart', 'not-visible', 'external-link']);
// Effects that mean "discovered but NOT genuinely reached" — drained from the frontier
// yet must not inflate coverage. Both markUnreachable (see below), keeping the explored
// count honest and identical across both front-ends.
const UNREACHED = new Set(['unreachable-coldstart', 'not-visible']);
const FLOORED = new Set(['destructive', 'auth', 'payment']);
const PURPOSE_CAP = 120;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}

export function observe(opts) {
  const stateDir = process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state');
  const graphPath = path.join(stateDir, 'graph.json');
  const graph = loadGraph(graphPath);

  // Accept a number (programmatic) or a digit string (CLI). REJECT a bare `--template`
  // flag: parseArgs turns it into boolean `true`, and Number(true) === 1 would silently
  // corrupt template 1.
  const t = opts.template;
  const validId = (typeof t === 'number' && Number.isInteger(t)) || (typeof t === 'string' && /^\d+$/.test(t));
  if (!validId) {
    throw envelopeError({ code: 'USAGE', message: 'missing/invalid --template=<int>', exit: 'USAGE' });
  }
  const tid = Number(t);
  const node = graph.elements[tid];
  if (!node) throw envelopeError({ code: 'NO_TEMPLATE', message: `unknown template ${tid}`, exit: 'VIOLATION' });

  const danger = String(opts.danger || '');
  if (!DANGER.has(danger)) {
    throw envelopeError({ code: 'USAGE', message: `--danger must be one of ${[...DANGER].join('|')}`, exit: 'USAGE' });
  }
  const effect = String(opts.effect || '');
  if (!EFFECT.has(effect)) {
    throw envelopeError({ code: 'USAGE', message: `--effect must be one of ${[...EFFECT].join('|')}`, exit: 'USAGE' });
  }

  // A control that could not be reached cannot have been acted on — force acted=false so a
  // record never claims "acted:true + unreachable" (an inconsistent, coverage-confusing state).
  const unreachable = UNREACHED.has(effect);
  const acted = unreachable ? false : (opts.acted == null ? true : !(opts.acted === 'false' || opts.acted === false));
  const stateChange = opts.stateChange === true || opts.stateChange === 'true';
  const purpose = String(opts.purpose || '').slice(0, PURPOSE_CAP);

  // Destructive backstop: a mis-judging agent must not RECORD an act on a
  // logout/delete/payment control. It may record it as NOT acted (--acted=false).
  //
  // EXPLORE-ALL (operator-armed, decisions.md 2026-07-18) LIFTS this backstop: in that mode the agent is
  // SUPPOSED to fire destructive/payment/auth controls and write down what they did, so refusing the
  // OBSERVATION would leave the graph unable to record work the click path deliberately permitted. The
  // real content rail lives at the click path (explore-policy: another user's content is never
  // destroyed) — this was only ever a record-keeping net, and it must not contradict the fire path.
  const exploreAll = exploreAllArmed(process.env);
  const floor = dangerFloor({ name: node.name, route: node.route });
  if (acted && !exploreAll && FLOORED.has(floor)) {
    throw envelopeError({
      code: 'DANGER_FLOOR',
      message: `refusing an ACTED observation on a ${floor} control "${node.name}"; re-run with --acted=false`,
      exit: 'VIOLATION',
    });
  }

  // Instance-level marking (state model): when the frontier handed out a specific instance (an
  // opener's sibling), drain THAT instance so the loop walks the rest. Falls back to template-level
  // when no --instance is given (a plain single-instance control), preserving the old behavior.
  const instanceKey = opts.instance != null ? String(opts.instance) : null;
  // Opener-drain guard (review follow-up): draining a PROVEN opener template-level (markExplored)
  // when only ONE sibling was acted marks the whole template explored while the OTHER instances stay
  // un-drained — the frontier then re-emits them until the step cap (a silent budget burn; the node
  // loop is immune, it always keys via the frontier target). Require --instance on a proven
  // multi-instance opener so the acted sibling drains, not the whole template. A plain (non-opener)
  // control is unaffected: node.opener is false, so its single instance still drains template-level.
  if (instanceKey == null && node.opener && node.instances && node.instances.length > 1) {
    throw envelopeError({
      code: 'USAGE',
      message: `template ${tid} is a proven opener with ${node.instances.length} instances — pass --instance='<instanceKey>' so the acted sibling drains, not the whole template`,
      exit: 'USAGE',
    });
  }
  recordSemantics(graph, tid, { purpose, danger, effect, acted, stateChange });
  if (instanceKey != null) markInstanceExplored(graph, tid, instanceKey); // drained from the frontier either way
  else markExplored(graph, tid);
  // Honest coverage parity with the node-loop path: a control the agent could NOT reach
  // — behind in-app state a cold-start reload can't resolve (unreachable-coldstart), or
  // present-but-hidden in the current viewport (not-visible) — is drained but must NOT
  // inflate genuine coverage. markUnreachable keeps it out of the explored count, so both
  // front-ends report the same denominator. Only the UNREACHED effects flag this — a
  // deliberate danger-skip (acted=false on a reachable control) is real coverage.
  if (unreachable) {
    if (instanceKey != null) markInstanceUnreachable(graph, tid, instanceKey, effect);
    else markUnreachable(graph, tid, effect);
  }
  saveGraph(graphPath, graph);

  // Debug trail: record the agent's VERDICT for this control (purpose/danger/effect) and
  // snapshot the graph as it stands now, so the admin can scrub coverage growth and read
  // what the walk concluded at each step. Written AFTER saveGraph so the snapshot matches.
  const runId = process.env.BUGHUNTER_RUN_ID;
  if (runId) {
    const seq = traceEvent(runId, 'observe', {
      templateId: tid, name: node.name, route: node.route,
      purpose, danger, effect, acted, unreachable, stateChange,
    });
    snapshotGraph(runId, seq);
  }
  return { ok: true, templateId: tid, explored: true, unreachable, danger, acted };
}

function emitError(env) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: env.code, message: env.message } }) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = observe({
      template: args.template,
      instance: args.instance,
      purpose: args.purpose,
      danger: args.danger,
      effect: args.effect,
      acted: args.acted,
      stateChange: args['state-change'],
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (err) {
    const env = err?.envelope || makeEnvelope({ code: 'INTERNAL', message: err?.message || 'unknown error', exit: 'VIOLATION' });
    emitError(env);
    process.exit(exitCode(env));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
