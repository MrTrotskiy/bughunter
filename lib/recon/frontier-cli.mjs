#!/usr/bin/env node
// frontier-cli — the recon agent's "what to study next" tool. Pure graph read, NO
// browser: wraps nextBatch + frontierStats over state/graph.json and prints them as
// one envelope. An empty batch ⇒ the frontier is drained ⇒ the agent ends the crawl.
// No side effects, so it is safe to call repeatedly. Size is clamped to the
// receptive-field ceiling (the perceptron-loop invariant: 2-5 NEW elements per step).
//
// Usage: node lib/recon/frontier-cli.mjs --emit [--size=<N>]
// Success → {ok:true, batch:[{templateId,role,name,route,instance}], stats:{...}}, exit 0.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnvelope, exitCode } from '../core/envelope.mjs';
import { loadGraph } from '../graph/graph-store.mjs';
import { nextBatch, frontierStats, RECEPTIVE_FIELD } from './frontier.mjs';

const MAX_SIZE = 5; // receptive-field ceiling — never hand the agent more than it can study

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}

export function emit(opts = {}) {
  const stateDir = process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state');
  const graph = loadGraph(path.join(stateDir, 'graph.json'));
  let size = opts.size != null ? Number(opts.size) : RECEPTIVE_FIELD;
  if (!Number.isFinite(size) || size < 1) size = RECEPTIVE_FIELD;
  size = Math.min(size, MAX_SIZE);
  return { ok: true, batch: nextBatch(graph, { size }), stats: frontierStats(graph) };
}

function emitError(env) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: env.code, message: env.message } }) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    process.stdout.write(JSON.stringify(emit({ size: args.size })) + '\n');
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
