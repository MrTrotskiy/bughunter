// coverage-ledger — WHY the coverage number is what it is, as an exhaustive partition.
//
// WHY THIS MODULE EXISTS. A run reported 16.7% and no consumer of the trail — not the operator, not a
// reviewing agent — could say whether the missing 83% was the agent deciding wrong, the script failing to
// navigate, a safety gate declining, or the application genuinely not offering the control. The report
// printed `explored / unreachable / unexplored`, and "unexplored" absorbed everything with no better home.
// A bucket meaning "the rest" cannot locate a defect.
//
// THE RULE. Every instance lands in exactly one bucket and the buckets sum to the total with a residual of
// zero. `residual !== 0` is a defect in THIS file, reported as a number rather than hidden.
//
// EACH BUCKET NAMES AN OWNER, which is what makes the ledger actionable:
//   crawler — acted on; the numerator
//   script  — our own machinery never got there (route queue never drained it, picker never chose it)
//   policy  — a deliberate refusal or sample; working as designed, and it must still be counted
//   app     — the application made it impossible (route 404s, element re-rendered away, handle detached)
// "Where is the problem — the agent, the script, or something else" is answered by sorting on count.
//
// ORDER IS LOAD-BEARING, first-match-wins. A gate refusal is checked BEFORE `explored`, because a control
// the gate declined to fire was never observed — measured, 6 refused instances carried `explored: true`,
// inflating the numerator with acts that never happened. `explored ⟺ observed` is a founding invariant.
//
// EXHAUSTIVE, BUT NOT MUTUALLY EXCLUSIVE. `buckets` is the exclusive partition (sums to total, carries the
// %); `allReasons` is the non-exclusive histogram (may exceed total, carries the diagnosis). Never divide
// by the second. Measured, it earns its keep immediately: the exclusive view showed 2 `cannot-resolve`
// while 23 instances actually carried that failure. Rationale and precedent in decisions.md 2026-07-19.
//
// PURE. Takes a graph, returns a report. No browser, no I/O, no graph mutation.

import { classifyMessage } from './refusal-codes.mjs';

// A route carries additive flags; absence of both is what "visited" means in the store.
function routeState(graph, routeKey) {
  const r = (graph.routes || {})[routeKey];
  if (!r) return 'unknown';
  if (r.unreachable) return 'unreachable';
  if (r.pending) return 'pending';
  return 'visited';
}

const BUCKET_OWNER = {
  'acted': 'crawler',
  'gate-refused': 'policy',
  'route-never-visited': 'script',
  'route-unreachable': 'app',
  'route-unknown': 'script',
  'churned': 'app',
  'owed-never-picked': 'script',
};

// reasonsFor(graph, node, inst) → EVERY reason that applies, not just the winning one.
// This is the diagnostic view. Its counts may sum past the total; that is the point, and it is why it is
// kept separate from the partition rather than replacing it.
export function reasonsFor(graph, node, inst) {
  const out = [];
  const msg = String(inst.unreachable || node.unreachable || '');
  if (msg) out.push(classifyMessage(msg).code);
  if (inst.explored) out.push('acted');
  const rs = routeState(graph, node.route);
  if (rs === 'pending') out.push('route-never-visited');
  if (rs === 'unreachable') out.push('route-unreachable');
  if (rs === 'unknown') out.push('route-unknown');
  if (inst.churned) out.push('churned');
  if (!out.length) out.push('owed-never-picked');
  return out;
}

// classifyInstance(graph, node, inst) → { bucket, owner }
// First match wins. The order below IS the precedence rule; see the header for why refusal precedes acted.
export function classifyInstance(graph, node, inst) {
  const msg = String(inst.unreachable || node.unreachable || '');
  if (msg) {
    const { code, owner } = classifyMessage(msg);
    // A refusal outranks `explored`: the gate declined, so no act occurred.
    if (code === 'gate-refused') return { bucket: 'gate-refused', owner };
    if (inst.explored) return { bucket: 'acted', owner: 'crawler' };
    return { bucket: code, owner };
  }
  if (inst.explored) return { bucket: 'acted', owner: 'crawler' };

  const rs = routeState(graph, node.route);
  if (rs === 'pending') return { bucket: 'route-never-visited', owner: 'script' };
  if (rs === 'unreachable') return { bucket: 'route-unreachable', owner: 'app' };
  if (rs === 'unknown') return { bucket: 'route-unknown', owner: 'script' };

  if (inst.churned) return { bucket: 'churned', owner: 'app' };
  return { bucket: 'owed-never-picked', owner: 'script' };
}

// ledger(graph) → exhaustive partition of every element instance.
//   { total, residual, buckets:[{bucket,owner,count,pct,samples}], byOwner:{owner:count}, headline }
// `residual` MUST be 0. It is returned rather than asserted so a caller can print the defect instead of
// crashing a finished run — but a non-zero value is a bug in this file, not a property of the graph.
export function ledger(graph) {
  const counts = new Map();
  const samples = new Map();
  // The owner is recorded AS CLASSIFIED. Recomputing it from the bucket name looked equivalent and was not:
  // `detached` is charged to the app, but re-matching the string "detached" against the message patterns
  // missed (they match the prose, not the code) and silently re-charged it to the script — the ledger
  // mis-assigning blame is precisely the failure it exists to prevent.
  const owners = new Map();
  const byOwner = {};
  const allReasons = {};
  let total = 0;
  // GENERATED DATA IS NOT A DISTINCT CONTROL. Measured: 955 of 2047 instances (47%) were table rows, and a
  // denominator mixing them with 1092 real controls cannot be read. Reported side by side, never merged and
  // never dropped — the rows are the only path to detail pages. See decisions.md 2026-07-19.
  const split = { rowTemplates: 0, rowInstances: 0, rowActed: 0, ctrlTemplates: 0, ctrlInstances: 0, ctrlActed: 0 };

  for (const node of Object.values(graph.elements || {})) {
    const insts = (node.instances || []).filter(Boolean);
    const acted = insts.filter((i) => i.explored).length;
    if (node.listRow) { split.rowTemplates++; split.rowInstances += insts.length; split.rowActed += acted; }
    else { split.ctrlTemplates++; split.ctrlInstances += insts.length; split.ctrlActed += acted; }
    for (const inst of node.instances || []) {
      if (!inst) continue;
      total++;
      const { bucket, owner } = classifyInstance(graph, node, inst);
      for (const r of reasonsFor(graph, node, inst)) allReasons[r] = (allReasons[r] || 0) + 1;
      counts.set(bucket, (counts.get(bucket) || 0) + 1);
      if (!owners.has(bucket)) owners.set(bucket, owner);
      byOwner[owner] = (byOwner[owner] || 0) + 1;
      if (!samples.has(bucket)) samples.set(bucket, []);
      const s = samples.get(bucket);
      if (s.length < 5) {
        s.push({
          route: node.route || null,
          templateId: node.templateId,
          name: String(node.name || inst.instanceKey || '').slice(0, 48),
        });
      }
    }
  }

  const buckets = [...counts.entries()]
    .map(([bucket, count]) => ({
      bucket,
      owner: owners.get(bucket) || BUCKET_OWNER[bucket] || 'script',
      count,
      pct: total ? +(100 * count / total).toFixed(1) : 0,
      samples: samples.get(bucket) || [],
    }))
    .sort((a, b) => b.count - a.count);

  const sum = buckets.reduce((n, b) => n + b.count, 0);
  const acted = counts.get('acted') || 0;
  const worst = buckets.find((b) => b.bucket !== 'acted') || null;

  return {
    total,
    residual: total - sum,
    acted,
    pct: total ? +(100 * acted / total).toFixed(1) : 0,
    buckets,
    byOwner,
    // NON-EXCLUSIVE. May sum past `total` by design — an instance blocked two ways is counted twice.
    // Never a denominator.
    allReasons,
    split,
    // The one-line answer to "where is the problem": the largest non-numerator bucket and who owns it.
    headline: worst
      ? `${worst.pct}% of the surface is ${worst.bucket} — owner: ${worst.owner}`
      : 'nothing outstanding',
  };
}

// render(l) → a plain-text block for the run report. Deliberately terse: the ledger is read by an operator
// deciding what to fix next, so it leads with the verdict and never buries it under a table.
export function render(l) {
  const lines = [];
  lines.push(`Coverage ledger — ${l.acted}/${l.total} acted (${l.pct}%)`);
  lines.push(`WHERE THE REST WENT: ${l.headline}`);
  for (const b of l.buckets) {
    const tag = b.bucket === 'acted' ? '' : `  [${b.owner}]`;
    lines.push(`  ${String(b.count).padStart(5)}  ${String(b.pct + '%').padStart(6)}  ${b.bucket}${tag}`);
  }
  const owners = Object.entries(l.byOwner).sort((a, b) => b[1] - a[1])
    .map(([o, n]) => `${o}=${n}`).join(' ');
  lines.push(`  by owner: ${owners}`);
  // Two populations, two numbers. Merging them produces a percentage nobody can act on.
  const s = l.split;
  if (s && s.rowInstances) {
    const pc = (a, b) => (b ? (100 * a / b).toFixed(1) : '0.0');
    lines.push(`  controls: ${s.ctrlActed}/${s.ctrlInstances} (${pc(s.ctrlActed, s.ctrlInstances)}%) over ${s.ctrlTemplates} templates`);
    lines.push(`  list rows (generated data, ${pc(s.rowInstances, l.total)}% of the denominator): ${s.rowActed}/${s.rowInstances} over ${s.rowTemplates} templates`);
  }
  // Printed only when it disagrees with the partition — i.e. when some instance is blocked more than one
  // way and the exclusive view is therefore hiding a reason. Silence here means the two views agree.
  const overlapped = Object.values(l.allReasons).reduce((a, b) => a + b, 0) - l.total;
  if (overlapped > 0) {
    const hist = Object.entries(l.allReasons).sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r}=${n}`).join(' ');
    lines.push(`  all reasons (non-exclusive, ${overlapped} overlap — never a denominator): ${hist}`);
  }
  if (l.residual !== 0) lines.push(`  !! LEDGER DEFECT: residual ${l.residual} — buckets do not partition the total`);
  return lines.join('\n');
}
