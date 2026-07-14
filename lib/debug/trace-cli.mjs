#!/usr/bin/env node
// trace-cli — bracket a debug-capture run from the /recon orchestrator. `--open` mints a
// runId, creates its trail dir + run.json, and prints the id (the driver exports it as
// BUGHUNTER_RUN_ID so every recon CLI in the loop appends to the same trail). `--close`
// stamps the run finished with the final coverage stats read from the graph. Neither
// touches the browser — this is pure trail bookkeeping, the counterpart to the CLIs that
// WRITE events (frontier-cli/whats-new/observe). No runId → the recon CLIs stay silent.
//
// Usage:
//   node lib/debug/trace-cli.mjs --open [--target=<url>]      → {ok:true, runId}
//   node lib/debug/trace-cli.mjs --close --run=<id>           → {ok:true, runId, stats}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnvelope, envelopeError, exitCode } from '../core/envelope.mjs';
import { loadGraph } from '../graph/graph-store.mjs';
import { frontierStats } from '../recon/frontier.mjs';
import { mintRunId, openRun, closeRun } from './trace.mjs';

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}

export function open({ target } = {}) {
  const runId = mintRunId();
  openRun({ runId, target: target || null });
  return { ok: true, runId };
}

export function close({ run } = {}) {
  if (!run) throw envelopeError({ code: 'USAGE', message: 'missing required --run=<id>', exit: 'USAGE' });
  const stateDir = process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state');
  const graph = loadGraph(path.join(stateDir, 'graph.json'));
  const stats = frontierStats(graph);
  closeRun(run, { stats });
  return { ok: true, runId: run, stats };
}

function emitError(env) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: env.code, message: env.message } }) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    let result;
    if (args.open) result = open({ target: args.target });
    else if (args.close) result = close({ run: args.run });
    else throw envelopeError({ code: 'USAGE', message: 'expected --open or --close', exit: 'USAGE' });
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
