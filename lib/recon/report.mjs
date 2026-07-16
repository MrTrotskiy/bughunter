#!/usr/bin/env node
// report — render state/graph.json into a readable recon summary: the honest coverage
// denominator, per-route controls with their semantics, and the causal control→endpoint
// map (the key Phase-2 input). Pure read, no browser. This is the "what did the recon
// find" surface a run produces so a human (or Phase 2) can start from it.
//
// Usage: node lib/recon/report.mjs [--json]
//   default → human-readable text on stdout, exit 0.
//   --json  → the structured report object as one JSON line.
//
// NOTE: opaque regions (closed shadow DOM / canvas / cross-origin iframe) are counted at
// snapshot time but NOT yet persisted in the graph — coverage below is of VISIBLE controls.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnvelope, exitCode } from '../core/envelope.mjs';
import { loadGraph } from '../graph/graph-store.mjs';
import { frontierStats, frontierInstanceStats } from './frontier.mjs';
import { oneLine } from '../core/text.mjs';
import { latestRunId, readActFailed } from '../debug/trace.mjs';
import { buildUnreached, renderUnreached } from './unreached.mjs';

function buildReport(graph) {
  const stats = frontierStats(graph);
  // Instance-level frontier (opener siblings + beyond-cap remainder) — the honest number that,
  // unlike template-level `stats.remaining`, never reads "done" while nextBatch still yields work.
  const instanceStats = frontierInstanceStats(graph);

  // causedBy: which templates cause each request, from the causal edges.
  const causedBy = {};
  for (const e of graph.edges) {
    if (e.type !== 'triggers') continue;
    const tid = Number(String(e.from).replace('element:', ''));
    const rk = String(e.to).replace('request:', '');
    (causedBy[rk] ||= []).push(tid);
  }
  // Per-template outgoing request keys.
  const causesOf = (tid) => graph.edges
    .filter((e) => e.from === `element:${tid}` && e.type === 'triggers')
    .map((e) => String(e.to).replace('request:', ''));

  const templates = Object.values(graph.elements).map((n) => {
    const sem = n.semantics || {};
    return {
      templateId: n.templateId,
      route: n.route,
      role: n.role,
      name: n.name,
      locator: n.locator || null,
      instances: n.instances ? n.instances.length : 0,
      explored: !!n.explored,
      unreachable: n.unreachable ? (typeof n.unreachable === 'string' ? n.unreachable : true) : false,
      danger: sem.danger || null,
      effect: sem.effect || null,
      acted: sem.acted != null ? sem.acted : null,
      purpose: sem.purpose || null,
      causes: causesOf(n.templateId),
    };
  }).sort((a, b) => a.templateId - b.templateId);

  const routes = Object.keys(graph.routes).sort().map((route) => ({
    route,
    templates: templates.filter((t) => t.route === route),
  }));

  const requests = Object.values(graph.requests).map((r) => {
    const key = `${r.method} ${r.urlPattern}`;
    return {
      method: r.method, urlPattern: r.urlPattern, key, causedBy: causedBy[key] || [],
      statuses: r.statuses || null, resourceType: r.resourceType || null,
    };
  }).sort((a, b) => a.key.localeCompare(b.key));

  return { ok: true, coverage: stats, instanceCoverage: instanceStats, routes, requests, edgeCount: graph.edges.length };
}

function renderText(rep) {
  const L = [];
  const c = rep.coverage;
  const routeCount = rep.routes.length;
  const tplCount = rep.routes.reduce((n, r) => n + r.templates.length, 0);
  L.push(`Recon report — ${routeCount} route(s), ${tplCount} control template(s)`);
  L.push(`Coverage: ${c.explored}/${c.discovered} explored · ${c.unreachable} unreachable · ${c.remaining} unexplored · ${c.routes ?? routeCount} route(s) mapped`);
  // Instance-level line: an opener with N instances is N addressable controls, not one; this is the
  // number that stays honest while siblings remain. Beyond-cap instances are flagged, never hidden.
  const ic = rep.instanceCoverage;
  if (ic) {
    const cap = ic.cappedRemainder > 0 ? ` · ${ic.cappedRemainder} beyond-cap (un-walked, flagged)` : '';
    L.push(`Instances: ${ic.walked}/${ic.walkable} walked · ${ic.unreachable} unreachable · ${ic.remaining} unexplored${cap}`);
  }
  L.push('(opaque regions not yet persisted — coverage is of visible controls)');
  for (const r of rep.routes) {
    L.push('');
    L.push(`Route ${r.route}`);
    for (const t of r.templates) {
      const inst = t.instances > 1 ? ` ×${t.instances}` : '';
      const flags = [];
      if (t.unreachable) {
        // The reason may be a raw browser error carrying newlines + a full call log (an
        // "element is not enabled" click timeout). Collapse to one line and cap it so the
        // Phase-2 input stays scannable — the full text is still in the graph.
        const raw = typeof t.unreachable === 'string' ? t.unreachable : 'unreachable';
        const reason = oneLine(raw);
        // Don't repeat the reason if `effect` already shows it (agent path sets both).
        if (reason !== t.effect) flags.push(reason);
      } else if (!t.explored) flags.push('unexplored');
      const danger = t.danger ? `danger=${t.danger}` : '';
      const effect = t.effect ? `effect=${t.effect}` : '';
      // Locator KIND — the durable handle Phase-2 should prefer (testid > id > role > css).
      const loc = t.locator && t.locator.type ? `loc=${t.locator.type}` : '';
      const meta = [loc, danger, effect, ...flags].filter(Boolean).join(' ');
      const causes = t.causes.length ? `  → ${t.causes.join(', ')}` : '';
      const purpose = t.purpose ? `  "${oneLine(t.purpose, 120)}"` : '';
      L.push(`  [${t.templateId}] ${t.role || '?'} ${JSON.stringify(t.name || '')}${inst}  ${meta}${causes}${purpose}`.replace(/\s+$/, ''));
    }
  }
  L.push('');
  L.push(`Causal control→endpoint map (${rep.edgeCount} edge(s)):`);
  if (!rep.requests.length) L.push('  (none captured)');
  for (const req of rep.requests) {
    const by = req.causedBy.length ? req.causedBy.map((t) => `[${t}]`).join(', ') : '(uncredited)';
    // Observed response status(es) + resource type on one scannable line, e.g.
    // `[3] → POST /api/orders  201` or `[3] → GET /api/list  200 xhr`. Sanitized: both
    // come from CDP, but oneLine keeps the map immune to any control byte leaking through.
    const statuses = req.statuses ? oneLine(Object.keys(req.statuses).sort().join(','), 40) : '';
    const rtype = req.resourceType ? oneLine(String(req.resourceType).toLowerCase(), 20) : '';
    const meta = [statuses, rtype].filter(Boolean).join(' ');
    L.push(`  ${by} → ${req.key}${meta ? '  ' + meta : ''}`);
  }
  return L.join('\n');
}

export function report(opts = {}) {
  const stateDir = process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state');
  const graph = loadGraph(path.join(stateDir, 'graph.json'));
  if (opts.unreached) {
    // runId source, in order: the active /recon run env > an explicit --run > the latest run
    // on disk. The trail carries the GRANULAR per-code fire failures; the graph reason is coarse.
    const runId = process.env.BUGHUNTER_RUN_ID || opts.run || latestRunId();
    const actFailed = runId ? readActFailed(runId) : [];
    const rep = buildUnreached(graph, actFailed, frontierInstanceStats(graph), runId);
    return opts.json ? rep : renderUnreached(rep);
  }
  const rep = buildReport(graph);
  return opts.json ? rep : renderText(rep);
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a === '--json') out.json = true;
    else if (a === '--unreached') out.unreached = true;
    else if (a.startsWith('--run=')) out.run = a.slice('--run='.length);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const out = report({ json: args.json, unreached: args.unreached, run: args.run });
    process.stdout.write((args.json ? JSON.stringify(out) : out) + '\n');
    process.exit(0);
  } catch (err) {
    const env = makeEnvelope({ code: 'INTERNAL', message: err?.message || 'unknown error', exit: 'VIOLATION' });
    process.stderr.write(JSON.stringify({ ok: false, error: { code: env.code, message: env.message } }) + '\n');
    process.exit(exitCode(env));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
