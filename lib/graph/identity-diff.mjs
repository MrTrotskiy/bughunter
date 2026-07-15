#!/usr/bin/env node
// identity-diff — the read-only churn GATE for identity-adjacent changes (GAP 2 step 1;
// decisions.md 2026-07-15 "GAP 2 stay-on-page reach", the "probe FIRST" bullet). Turns
// "this change churned ZERO existing element identity" from an assertion into a
// one-command, CI-able FACT. Pure diff over two already-loaded {ledger, graph} pairs.
//
// The append-only ledger (ids.mjs) mints a stable id per KEY: 'tpl:'+templateSelector and
// 'inst:'+templateSelector+'::'+instanceKey (step.mjs idify). Identity is CHURNED when the
// SAME key maps to a DIFFERENT id across the two runs — the regression this gate exists to
// catch. A NEW key (added template/instance) is EXPECTED growth, never churn; a key present
// BEFORE but absent AFTER is a DROPPED template/instance (an element lost its identity — also
// a gate failure). Edge identity = the (from,to,type) triple; a triple present before but
// absent after is a DROPPED edge (also a churn). Additive edges are reported as a count only.
//
// Usage: node lib/graph/identity-diff.mjs --before=<dir> --after=<dir> [--json]
//   Each <dir> holds an element-ids.json + graph.json (a run's state/). Exit 0 when ok (no
//   churn), non-zero when ok===false — usable directly as a script/CI gate.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnvelope, envelopeError, exitCode } from '../core/envelope.mjs';
import { makeLedger } from './ids.mjs';
import { makeGraph } from './graph-store.mjs';

// Edge identity = the (from,to,type) triple (graph-store dedupes edges too).
const edgeKey = (e) => JSON.stringify([e.from, e.to, e.type]);

// Robust field access: a missing/empty before (first run) yields empty maps, so everything
// in after reads as added and the gate is ok:true — never a throw.
const safeIds = (ledger) => (ledger && ledger.ids && typeof ledger.ids === 'object' ? ledger.ids : {});
const safeEdges = (graph) => (graph && Array.isArray(graph.edges) ? graph.edges : []);

// Pure core. before/after are each { ledger, graph } (already parsed). Compares by KEY: a
// churn is the SAME 'tpl:'/'inst:' key mapping to a different id; a dropped edge is a
// (from,to,type) triple present in before.graph but gone in after.graph. Added
// templates/instances/edges are counts only. No I/O, no browser.
export function diffIdentity(before, after) {
  const bIds = safeIds(before && before.ledger);
  const aIds = safeIds(after && after.ledger);

  const churnedTemplates = [];
  const churnedInstances = [];
  let addedTemplates = 0;
  let addedInstances = 0;

  for (const key of Object.keys(aIds)) {
    // Split exactly as ids.mjs mints the keys; ignore any other prefix (the ledger only
    // ever holds these two, but a stray key must not be miscounted as identity).
    const bucket = key.startsWith('tpl:') ? 'tpl' : key.startsWith('inst:') ? 'inst' : null;
    if (!bucket) continue;
    // Churn is only meaningful for a key present in BOTH ledgers — a new key is additive.
    if (!Object.prototype.hasOwnProperty.call(bIds, key)) {
      if (bucket === 'tpl') addedTemplates++; else addedInstances++;
      continue;
    }
    // Shared key: CHURN only when the id CHANGED (the comparison this gate turns on).
    if (aIds[key] !== bIds[key]) {
      const churn = { key, beforeId: bIds[key], afterId: aIds[key] };
      (bucket === 'tpl' ? churnedTemplates : churnedInstances).push(churn);
    }
  }

  // A key present in BEFORE but absent from AFTER = a DROPPED template/instance (an element
  // lost its identity — also a gate failure). The churn loop above only iterates AFTER's keys,
  // so a disappeared key would slip through silently; this reverse pass catches it.
  const droppedTemplates = [];
  const droppedInstances = [];
  for (const key of Object.keys(bIds)) {
    const bucket = key.startsWith('tpl:') ? 'tpl' : key.startsWith('inst:') ? 'inst' : null;
    if (!bucket) continue;
    if (!Object.prototype.hasOwnProperty.call(aIds, key)) {
      (bucket === 'tpl' ? droppedTemplates : droppedInstances).push({ key, id: bIds[key] });
    }
  }

  // Dedupe both edge sets on the triple, then diff. A dropped edge is a before-triple
  // absent from after; an added edge is an after-triple absent from before.
  const bEdges = new Map();
  for (const e of safeEdges(before && before.graph)) bEdges.set(edgeKey(e), { from: e.from, to: e.to, type: e.type });
  const aKeys = new Set(safeEdges(after && after.graph).map(edgeKey));

  const droppedEdges = [];
  for (const [k, e] of bEdges) if (!aKeys.has(k)) droppedEdges.push(e);
  let addedEdges = 0;
  for (const k of aKeys) if (!bEdges.has(k)) addedEdges++;

  const ok = churnedTemplates.length === 0 && churnedInstances.length === 0
    && droppedTemplates.length === 0 && droppedInstances.length === 0 && droppedEdges.length === 0;
  return {
    churnedTemplates, churnedInstances, droppedTemplates, droppedInstances, droppedEdges,
    addedTemplates, addedInstances, addedEdges, ok,
  };
}

// -------- CLI shell --------

// Strict load for the GATE: a MISSING file is a first run (empty `fallback`, ok); a file that
// is PRESENT but unparseable must fail LOUD (throw INTERNAL → non-zero exit), NEVER be treated
// as empty. The crawl's loadLedger/loadGraph deliberately swallow a parse error and start
// fresh, but the churn gate must NOT — a corrupt --before/--after would otherwise read as empty
// and pass falsely green, hiding real identity movement. Exported for the unit gate test.
export function loadStrict(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw envelopeError({ code: 'INTERNAL', message: `${file} is present but not valid JSON — refusing to gate on corrupt state` });
  }
}

function loadPair(dir) {
  return {
    ledger: loadStrict(path.join(dir, 'element-ids.json'), makeLedger()),
    graph: loadStrict(path.join(dir, 'graph.json'), makeGraph()),
  };
}

function renderText(d) {
  const L = [];
  L.push(`Identity diff — ${d.ok ? 'ok (no churn)' : 'CHURN DETECTED'}`);
  L.push(`Templates: +${d.addedTemplates} added, ${d.churnedTemplates.length} churned, ${d.droppedTemplates.length} dropped`);
  for (const c of d.churnedTemplates) L.push(`  churn ${c.key}  id ${c.beforeId} → ${c.afterId}`);
  for (const c of d.droppedTemplates) L.push(`  drop  ${c.key}  id ${c.id}`);
  L.push(`Instances: +${d.addedInstances} added, ${d.churnedInstances.length} churned, ${d.droppedInstances.length} dropped`);
  for (const c of d.churnedInstances) L.push(`  churn ${c.key}  id ${c.beforeId} → ${c.afterId}`);
  for (const c of d.droppedInstances) L.push(`  drop  ${c.key}  id ${c.id}`);
  L.push(`Edges:     +${d.addedEdges} added, ${d.droppedEdges.length} dropped`);
  for (const e of d.droppedEdges) L.push(`  ${e.from} --${e.type}--> ${e.to}`);
  return L.join('\n');
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}

function emitError(env) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: env.code, message: env.message } }) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.before || !args.after) {
    emitError(makeEnvelope({ code: 'USAGE', message: 'usage: identity-diff --before=<dir> --after=<dir> [--json]', exit: 'USAGE' }));
    process.exit(64);
  }
  try {
    const d = diffIdentity(loadPair(args.before), loadPair(args.after));
    process.stdout.write((args.json ? JSON.stringify(d) : renderText(d)) + '\n');
    // Churn gate: non-zero exit on churn lets a script/CI FAIL the moment identity moves.
    process.exit(d.ok ? 0 : exitCode('VIOLATION'));
  } catch (err) {
    const env = makeEnvelope({ code: 'INTERNAL', message: err?.message || 'unknown error', exit: 'VIOLATION' });
    emitError(env);
    process.exit(exitCode(env));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
