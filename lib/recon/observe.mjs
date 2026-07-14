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
import { loadGraph, saveGraph, recordSemantics, markExplored, markUnreachable } from '../graph/graph-store.mjs';
import { dangerFloor } from './danger-floor.mjs';

const DANGER = new Set(['safe', 'destructive', 'auth', 'payment', 'unknown']);
const EFFECT = new Set(['none', 'request', 'navigate', 'reveal', 'state-change', 'unreachable-coldstart']);
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
  const unreachable = effect === 'unreachable-coldstart';
  const acted = unreachable ? false : (opts.acted == null ? true : !(opts.acted === 'false' || opts.acted === false));
  const stateChange = opts.stateChange === true || opts.stateChange === 'true';
  const purpose = String(opts.purpose || '').slice(0, PURPOSE_CAP);

  // Destructive backstop: a mis-judging agent must not RECORD an act on a
  // logout/delete/payment control. It may record it as NOT acted (--acted=false).
  const floor = dangerFloor({ name: node.name, route: node.route });
  if (acted && FLOORED.has(floor)) {
    throw envelopeError({
      code: 'DANGER_FLOOR',
      message: `refusing an ACTED observation on a ${floor} control "${node.name}"; re-run with --acted=false`,
      exit: 'VIOLATION',
    });
  }

  recordSemantics(graph, tid, { purpose, danger, effect, acted, stateChange });
  markExplored(graph, tid); // drained from the frontier either way (do not re-emit it)
  // Honest coverage parity with the node-loop path: a control the agent could NOT reach
  // (cold-start reload can't resolve a control behind in-app state) is drained but must
  // NOT inflate genuine coverage. markUnreachable keeps it out of the explored count, so
  // both front-ends report the same denominator. Only effect=unreachable-coldstart flags
  // this — a deliberate danger-skip (acted=false on a reachable control) is real coverage.
  if (unreachable) markUnreachable(graph, tid, 'unreachable-coldstart');
  saveGraph(graphPath, graph);
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
