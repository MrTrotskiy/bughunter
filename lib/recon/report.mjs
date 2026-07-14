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
import { frontierStats } from './frontier.mjs';

function buildReport(graph) {
  const stats = frontierStats(graph);

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
    return { method: r.method, urlPattern: r.urlPattern, key, causedBy: causedBy[key] || [] };
  }).sort((a, b) => a.key.localeCompare(b.key));

  return { ok: true, coverage: stats, routes, requests, edgeCount: graph.edges.length };
}

// Collapse a possibly-untrusted string (a browser error's call log, an agent-derived
// purpose) to one scannable line: strip C0/C1 control bytes FIRST — an ESC/OSC sequence
// in page-derived text must never reach the operator's terminal raw — then collapse
// whitespace and cap the length.
function oneLine(s, cap = 100) {
  const flat = String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > cap ? flat.slice(0, cap - 1) + '…' : flat;
}

function renderText(rep) {
  const L = [];
  const c = rep.coverage;
  const routeCount = rep.routes.length;
  const tplCount = rep.routes.reduce((n, r) => n + r.templates.length, 0);
  L.push(`Recon report — ${routeCount} route(s), ${tplCount} control template(s)`);
  L.push(`Coverage: ${c.explored}/${c.discovered} explored · ${c.unreachable} unreachable · ${c.remaining} unexplored · ${c.routes ?? routeCount} route(s) mapped`);
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
      const meta = [danger, effect, ...flags].filter(Boolean).join(' ');
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
    L.push(`  ${by} → ${req.key}`);
  }
  return L.join('\n');
}

export function report(opts = {}) {
  const stateDir = process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state');
  const graph = loadGraph(path.join(stateDir, 'graph.json'));
  const rep = buildReport(graph);
  return opts.json ? rep : renderText(rep);
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) { if (a === '--json') out.json = true; }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const out = report({ json: args.json });
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
