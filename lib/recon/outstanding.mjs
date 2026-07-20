// outstanding — the work queue, in the script's own words.
//
// docs/GOAL.md: "The script must be able to answer, at any moment: total / studied / outstanding, and the
// outstanding number must fall." It could COMPUTE that — `probeStatus` has known what each element still
// owes for a while — and it printed none of it. The operator could see a coverage percentage and had no
// way to ask "what exactly is left, and why is that one not done".
//
// A percentage is a summary; this is the queue. Every element that still owes something is NAMED, with
// what it owes and what is blocking it, because "23 elements outstanding" tells you nothing about whether
// the run is stuck on one unreachable modal or spread thin across the app.
//
// Pure read over the graph — no browser, no acts, no mutation.

import { probeStatus, levelOf } from './knowledge.mjs';

const widgetInternal = (node) => node.widgetInternal === true;

// Per-element: what it owes, what answered, what is blocked and why.
export function outstandingOf(graph) {
  const rows = [];
  let total = 0;
  let studied = 0;
  let blockedOnly = 0;

  for (const [id, node] of Object.entries(graph.elements || {})) {
    if (widgetInternal(node)) continue;              // framework chrome is not an obligation
    total++;
    const probes = (node.probes || []).filter(Boolean);
    const st = probeStatus(node, probes);
    const level = levelOf(node, probes);
    if (!st.outstanding.length) {
      // Nothing owed. Either it answered (studied) or everything it owed is terminally blocked.
      if (st.blocked.length && !st.done.length) blockedOnly++;
      else studied++;
      continue;
    }
    rows.push({
      templateId: id,
      name: node.name || '',
      role: node.role || '',
      route: node.route || '',
      level,
      owed: st.outstanding,
      done: st.done,
      blocked: st.blocked,
      tries: probes.length,
    });
  }

  // Worst first: never-touched before partly-probed, then by how much is owed. The operator reads the top
  // of this list to know what the next hour of crawling will do.
  rows.sort((a, b) => (a.tries - b.tries) || (b.owed.length - a.owed.length) || String(a.route).localeCompare(String(b.route)));
  return { total, studied, outstanding: rows.length, blockedOnly, rows };
}

export function renderOutstanding(graph, { limit = 40 } = {}) {
  const s = outstandingOf(graph);
  const pct = s.total ? Math.round((100 * s.studied) / s.total) : 0;
  const lines = [
    `Outstanding work — ${s.studied}/${s.total} studied (${pct}%) · ${s.outstanding} still owed · ${s.blockedOnly} terminally blocked`,
  ];
  if (!s.rows.length) {
    lines.push('  nothing owed — every element has answered what it was asked, or is blocked with a reason.');
    return lines.join('\n');
  }
  for (const r of s.rows.slice(0, limit)) {
    const name = r.name ? JSON.stringify(r.name.slice(0, 34)) : '(unnamed)';
    const blocked = r.blocked.length ? ` · blocked: ${r.blocked.map((b) => `${b.kind}=${b.code}`).join(',')}` : '';
    lines.push(`  [${r.level}] ${name} ${r.role}@${r.route}`);
    lines.push(`      owes: ${r.owed.join(', ')} · tried ${r.tries}×${blocked}`);
  }
  if (s.rows.length > limit) lines.push(`  … and ${s.rows.length - limit} more (raise --limit to see them)`);
  return lines.join('\n');
}
