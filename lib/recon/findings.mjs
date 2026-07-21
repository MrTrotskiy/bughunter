// findings — the PRODUCT of a crawl, pulled out of the graph.
//
// WHY THIS EXISTS. docs/GOAL.md: "A 403 or 500 where 200 belongs is not a failed probe to retry away — it
// is the most valuable thing the crawl can find." The graph already held them: causal edges attribute a
// request to the control that caused it, and the response ledger records status. But nothing SURFACED
// them. A run reporting "74 API endpoints mapped" buried three 400s inside that list, and the operator had
// to read the graph by hand to find that one control returns 400 on seven separate attempts.
//
// This module derives findings from what is already recorded. It performs NO acts, opens no browser, and
// mutates nothing — a pure read over the graph, so it can never affect what it reports on.
//
// A finding is a DISAGREEMENT between what the application declares and what it does, or an outcome that
// is anomalous on its face. Each carries the control that caused it, because "POST /x returned 500" is a
// log line while "clicking Save on /settings returns 500" is a bug report.

import { formConflict } from './form-battery.mjs';
import { isShapedType } from './probe-kinds.mjs';

const asId = (ref) => String(ref || '').replace(/^element:/, '');

// The control(s) a request was causally attributed to. Attribution is the token+initiator pair recorded at
// act time — this only reads the edge it produced, never re-derives it.
function causersOf(graph, reqKey) {
  const out = [];
  for (const e of graph.edges || []) {
    if (e.provenance !== 'causal' || e.to !== `request:${reqKey}`) continue;
    const node = (graph.elements || {})[asId(e.from)];
    if (node) out.push({ id: asId(e.from), name: node.name || '', route: node.route || '', role: node.role || '' });
  }
  return out;
}

// 4xx / 5xx responses. A 5xx is a server fault and always a finding. A 4xx is a finding too, but a weaker
// one: it can be the application correctly refusing our deliberately-bad probe — which is exactly what a
// boundary probe is FOR — so the probe kind that caused it is carried, letting a reader tell "the app
// rejected our nonsense" (working as intended) from "the app rejects its own UI's request" (a bug).
function httpAnomalies(graph) {
  const out = [];
  for (const [key, req] of Object.entries(graph.requests || {})) {
    const statuses = req.statuses || {};
    for (const [code, count] of Object.entries(statuses)) {
      const n = Number(code);
      if (!Number.isFinite(n) || n < 400) continue;
      const causers = causersOf(graph, key);
      // Which probe kinds hit this endpoint — a rejection of `fill-overflow` is expected, of `fill-valid`
      // is not. Read off the causing controls' probe rows.
      const kinds = new Set();
      for (const c of causers) {
        for (const p of ((graph.elements || {})[c.id] || {}).probes || []) if (p && p.kind) kinds.add(p.kind);
      }
      out.push({
        kind: n >= 500 ? 'server-error' : 'client-error',
        severity: n >= 500 ? 'high' : (kinds.has('fill-valid') && kinds.size === 1 ? 'high' : 'medium'),
        endpoint: key,
        status: n,
        count,
        causedBy: causers,
        probeKinds: [...kinds],
        note: n >= 500
          ? 'the server failed — this is a defect regardless of what was sent'
          : 'refused by the server; expected if a deliberately-invalid probe caused it, a defect if a valid one did',
      });
    }
  }
  return out;
}

// A field that DECLARES a constraint the application does not enforce. The declaration is the prediction;
// the observed behaviour falsifies it. Both directions are recorded because both are defects: a required
// field that accepts empty, and a maxLength that does not truncate or reject.
function brokenContracts(graph) {
  const out = [];
  for (const [id, node] of Object.entries(graph.elements || {})) {
    const facts = node.fieldFacts;
    if (!facts) continue;
    const probes = (node.probes || []).filter((p) => p && !p.blocked && p.verdict);
    const where = { id, name: node.name || '', route: node.route || '', role: node.role || '' };

    // Declared required, yet an empty commit went through to the server and was accepted.
    const empty = probes.find((p) => p.kind === 'fill-empty');
    if (facts.required && empty && ['read', 'write', 'write-unconfirmed'].includes(empty.verdict)) {
      out.push({
        kind: 'required-not-enforced', severity: 'high', where,
        note: 'the field declares itself required, but committing it EMPTY reached the server and was not refused',
      });
    }
    // Declared a maximum length, yet an over-length value was accepted and committed.
    const over = probes.find((p) => p.kind === 'fill-overflow');
    if (facts.maxLength && over && ['read', 'write', 'write-unconfirmed'].includes(over.verdict)) {
      out.push({
        kind: 'limit-not-enforced', severity: 'medium', where,
        note: `declares maxLength ${facts.maxLength}, but a longer value was accepted and committed`,
      });
    }
    // Declared a SHAPE (a typed input, a regex pattern, a numeric range), yet a value that VIOLATES it was
    // accepted and committed — "declares type=number, accepted letters" (docs/GOAL.md rung 4). A wrong-shape
    // probe the field REFUSED (a native type refusing the fill → NOT_FILLABLE, or the page saying no →
    // `rejected`) is the declaration WORKING and is not reported; only an accepted violation is a finding.
    const shaped = facts.pattern || facts.min != null || facts.max != null || isShapedType(facts.kind || facts.type);
    const invalid = probes.find((p) => p.kind === 'fill-invalid');
    if (shaped && invalid && ['read', 'write', 'write-unconfirmed'].includes(invalid.verdict)) {
      const declared = facts.pattern ? `pattern ${facts.pattern}` : `type ${facts.kind || facts.type}`;
      out.push({
        kind: 'type-not-enforced', severity: 'medium', where,
        note: `declares ${declared}, but a wrong-shape value was accepted and committed`,
      });
    }
  }
  return out;
}

// The FORM LADDER's finding, surfaced. The incremental submit ladder (form-battery.mjs) records
// `submit-empty` / `submit-req-N` rows on the SUBMIT button — a node carrying `formFacts`, NOT `fieldFacts`,
// so `brokenContracts` above never looks at it, and the field-level `fill-empty` probe rarely commits (a
// bare field has no submit to answer to). So the "required not enforced" a live crawl actually records —
// an EMPTY submit the server accepted, or an incomplete submit accepted before the complete one — was
// computed by `formConflict` and surfaced by NOBODY. This is that wiring: the same defect, keyed off the
// `submit-empty` rung where it truly lands.
function formContracts(graph) {
  const out = [];
  for (const [id, node] of Object.entries(graph.elements || {})) {
    if (!node.formFacts) continue;
    const conflict = formConflict(node.formFacts, node.probes || []);
    if (!conflict) continue;
    out.push({
      kind: 'required-not-enforced', severity: conflict.severity || 'high',
      where: { id, name: node.name || '', route: node.route || '', role: node.role || '' },
      note: conflict.note,
    });
  }
  return out;
}

// A control that does nothing observable, every time it was tried. Not a server defect — but it is either
// dead UI or a control whose effect the crawl cannot see, and both are worth a human's attention. Only
// reported when tried more than once, so a single transient miss is not dressed up as a finding.
function inertControls(graph) {
  const out = [];
  for (const [id, node] of Object.entries(graph.elements || {})) {
    const probes = (node.probes || []).filter((p) => p && !p.blocked && p.verdict);
    if (probes.length < 2) continue;
    if (!probes.every((p) => p.verdict === 'inert')) continue;
    out.push({
      kind: 'inert-control', severity: 'low',
      where: { id, name: node.name || '', route: node.route || '', role: node.role || '' },
      tries: probes.length,
      note: 'acted more than once and produced no request, no reveal, no navigation and no visible change',
    });
  }
  return out;
}

// A control OBSCURED by a modal left open from a PRIOR act (CLASS 1b). Recorded ONLY when Escape + the
// curated close selectors already FAILED and just the text Cancel/Close worked — so the signal is the
// Escape-resistant modal, not app blame (obstruction order is partly a crawl artifact). Additive
// `node.obstructions`, never a probe row (must not touch the knowledge ladder).
function obstructedControls(graph) {
  const out = [];
  for (const [id, node] of Object.entries(graph.elements || {})) {
    const obs = node.obstructions;
    if (!Array.isArray(obs) || !obs.length) continue;
    const named = [...new Set(obs.map((o) => o && o.obscuredBy && (o.obscuredBy.title || o.obscuredBy.tag)).filter(Boolean))];
    out.push({
      kind: 'obstructed-control', severity: 'medium',
      where: { id, name: node.name || '', route: node.route || '', role: node.role || '' },
      count: obs.length,
      note: `a leftover modal${named.length ? ` (${named.join(', ')})` : ''} from a prior act obscured this control and did NOT close on Escape (only its Cancel/Close affordance did) — reach was recovered; the Escape-resistant modal is the signal, obstruction order may be a crawl artifact`,
    });
  }
  return out;
}

// Everything the crawl learned that looks wrong, ordered worst-first. Pure over the graph.
export function findingsOf(graph) {
  const all = [...httpAnomalies(graph), ...brokenContracts(graph), ...formContracts(graph), ...inertControls(graph), ...obstructedControls(graph)];
  const rank = { high: 0, medium: 1, low: 2 };
  all.sort((a, b) => (rank[a.severity] - rank[b.severity]) || String(a.kind).localeCompare(String(b.kind)));
  return {
    findings: all,
    counts: all.reduce((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] || 0) + 1 }), {}),
  };
}

// One line per finding, worst first — the report a human reads.
export function renderFindings(graph) {
  const { findings, counts } = findingsOf(graph);
  if (!findings.length) return 'Findings: none recorded.';
  const lines = [`Findings: ${findings.length} (high ${counts.high || 0} · medium ${counts.medium || 0} · low ${counts.low || 0})`];
  for (const f of findings) {
    const who = f.causedBy && f.causedBy.length
      ? f.causedBy.map((c) => `${JSON.stringify(c.name || '(unnamed)')}@${c.route}`).join(' | ')
      : (f.where ? `${JSON.stringify(f.where.name || '(unnamed)')}@${f.where.route}` : '');
    const head = f.endpoint ? `${f.status} ×${f.count} ${f.endpoint}` : f.kind;
    lines.push(`  [${f.severity}] ${f.kind}: ${head}`);
    if (who) lines.push(`      caused by: ${who}`);
    lines.push(`      ${f.note}`);
  }
  return lines.join('\n');
}
