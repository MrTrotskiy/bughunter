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
import { makeEnvelope, envelopeError } from '../core/envelope.mjs';
import { launch, gotoGated, close } from '../browser/session.mjs';
import { waitSettled } from '../browser/causal.mjs';
import { loadLedger, saveLedger } from '../graph/ids.mjs';
import { loadGraph, saveGraph } from '../graph/graph-store.mjs';
import { snapshotStep, actStep } from './step.mjs';

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
  const route = new URL(opts.url).pathname;

  const { browser, page } = await launch();
  try {
    await gotoGated(page, opts.url);
    await waitSettled(page);

    // Baseline: snapshot → mint ids → merge. These are the pre-action elements.
    const result = { ok: true, route, baseline: await snapshotStep(page, graph, ledger, route) };

    if (opts.actTemplate != null) {
      const tid = Number(opts.actTemplate);
      const node = graph.elements[tid];
      if (!node || !node.instances.length) {
        throw envelopeError({ code: 'NO_TEMPLATE', message: `no element instance for templateId ${opts.actTemplate}` });
      }
      result.acted = await actStep(
        page, graph, ledger, route,
        { templateId: tid, instance: node.instances[0] },
        { fill: opts.fill },
      );
    }

    saveLedger(ledgerPath, ledger);
    saveGraph(graphPath, graph);
    return result;
  } finally {
    await close(browser);
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
    const result = await run({ url: args.url, actTemplate: args['act-template'], fill: args.fill });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (err) {
    let env = err && err.envelope;
    if (!env) {
      const code = typeof err?.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(err.code) ? err.code : 'INTERNAL';
      env = makeEnvelope({ code, message: err?.message || 'unknown error', exit: 'VIOLATION' });
    }
    emitError(env);
    process.exit(env.exit === 'USAGE' ? 64 : 1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
