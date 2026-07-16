#!/usr/bin/env node
// frontier-cli — the recon agent's "what to study next" tool. NO browser: reads
// state/graph.json (nextBatch + frontierStats + frontierInstanceStats) and the run trail,
// then prints one envelope. An empty batch ⇒ the frontier is drained ⇒ the agent ends the
// crawl. NOT pure (the header once claimed "No side effects" — already inexact): when a runId
// is set it appends ONE best-effort `frontier.emit` trail event; it NEVER mutates the graph,
// so repeated calls stay safe, but each records a window. Size is clamped to the
// receptive-field ceiling (the perceptron-loop invariant: 2-5 NEW elements per step). The
// returned `progress` verdict (continue|drained|stalled) is the driver's HONEST termination
// signal — see loop-control.mjs.
//
// Usage: node lib/recon/frontier-cli.mjs --emit [--size=<N>] [--tick]
// Success → {ok:true, batch:[...], stats:{...}, instanceStats:{...}, progress:{action,reason}}, exit 0.
// --tick: record THIS window's instanceStats onto the frontier.emit trail (the stall-history
// sample). Only the /recon DRIVER passes it; the recon subagent's own --emit is history-neutral.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnvelope, exitCode } from '../core/envelope.mjs';
import { loadGraph } from '../graph/graph-store.mjs';
import { nextBatch, frontierStats, frontierInstanceStats, RECEPTIVE_FIELD } from './frontier.mjs';
import { traceEvent, readFrontierProgress } from '../debug/trace.mjs';
import { decideProgress } from './loop-control.mjs';

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
  const batch = nextBatch(graph, { size });
  const stats = frontierStats(graph);
  const instanceStats = frontierInstanceStats(graph);
  // Debug trail: record what the agent is ABOUT to study this step (the receptive field) + the
  // honest denominator — BOTH the template `stats` (unchanged; tests depend on it) AND the
  // instance-level `instanceStats`, so the admin timeline shows the walk's decision points AND
  // the loop's stall detector has this window's instance-level progress signal (walked +
  // unreachable + walkable) on the trail to compare against prior windows.
  //
  // TICK GATE: instanceStats lands in the payload ONLY when the caller passed --tick. Only the
  // /recon DRIVER passes it, so the stall history is exactly ONE sample per driver iteration —
  // immune to the recon subagent's own --emit calls (which fire on the SAME runId before it
  // acts). Without --tick the event carries candidates + stats but NO instanceStats, and
  // readFrontierProgress skips events whose payload lacks a numeric instanceStats, so a non-tick
  // emit is history-neutral automatically. (Reverting to always writing instanceStats reintroduces
  // the false-stall: two flat emits per dead iteration trip STALL_WINDOWS=3 after one dead pass.)
  const runId = process.env.BUGHUNTER_RUN_ID;
  if (runId) {
    const payload = {
      candidates: batch.map((t) => ({ templateId: t.templateId, name: t.name, role: t.role, route: t.route })),
      stats,
    };
    if (opts.tick) payload.instanceStats = instanceStats;
    traceEvent(runId, 'frontier.emit', payload);
  }
  // Progress verdict for the /recon driver: this window's MONOTONE progress signal is
  // walked + unreachable + walkable (grows on an explore / a failed act / a discovery alike, so it
  // is flat ONLY on a true stall — unlike `remaining`, which sits flat on a balanced
  // drain+discovery plateau). Read the PRIOR windows' progress back off the trail (traceEvent just
  // appended THIS window as the last frontier.emit), drop the current window, and compare — a
  // K-window flat progress is a stall, an empty batch is drained. With no runId the trail is unread
  // → history empty → never STALLED; but DRAINED (empty batch) still fires, so a runId-less caller
  // still gets an honest end-of-frontier signal. The stall signal only exists under /recon, which
  // always sets BUGHUNTER_RUN_ID.
  const progress = instanceStats.walked + instanceStats.unreachable + instanceStats.walkable;
  const progressHistory = runId ? readFrontierProgress(runId).slice(0, -1) : []; // drop the current window
  const verdict = decideProgress({
    batchLen: batch.length,
    remaining: instanceStats.remaining,
    cappedRemainder: instanceStats.cappedRemainder,
    progress,
    progressHistory,
  });
  return { ok: true, batch, stats, instanceStats, progress: verdict };
}

function emitError(env) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: env.code, message: env.message } }) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    process.stdout.write(JSON.stringify(emit({ size: args.size, tick: args.tick })) + '\n');
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
