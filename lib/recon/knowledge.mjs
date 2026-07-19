// THE KNOWLEDGE LADDER — what we actually know about an element, as opposed to whether we touched it.
//
// THE PROBLEM THIS REPLACES. `explored` was set immediately after one act returned, before anything about
// the outcome was inspected, and the frontier's drain predicate read that flag. So "explored" meant "we
// clicked it once and the click did not throw" — and coverage counted those. Measured over one run: 279
// acts, 27% caused any request, 43% completely inert, 21 of 32 submit-like controls clicked with no fields
// filled at all, and 0 of 6 user flows completed. The percentage rose while nothing worked, because the
// percentage was measuring effort rather than understanding.
//
// Phase 1 exists to turn a black box into a white one: for every control what it is and what it does, for
// every field what it accepts and what it refuses. That is a claim about KNOWLEDGE, so the metric has to be
// one. Hence a ladder, where each rung is earned by recorded evidence and cannot be reached by clicking
// faster.
//
//   L-1 BLOCKED       — cannot be probed, with a NAMED code. Counted, listed, never in the numerator.
//   L0  UNKNOWN       — discovered, never touched.
//   L1  REACHED       — resolved live at least once. (This is what `explored` really meant.)
//   L2  EXERCISED     — at least one probe with a recorded outcome.
//   L3  CHARACTERIZED — the role-appropriate battery is complete: every owed probe is done or blocked.
//   L4  CONFIRMED     — the outcome was reproduced, or a write was verified by reading it back.
//
// "90% coverage" means 90% of obligations at L3 or above. It cannot silently collapse: the denominator is
// the existing non-collapsing one, every rung above L1 requires probe rows that each point at a trail seq,
// and BLOCKED is a listed bucket with reasons rather than a quiet subtraction.
//
// PURE — no browser, no graph mutation. The caller appends probe rows and asks this module what they mean.

// What a control of this shape owes before we can claim to understand it. Deliberately small: the point is
// to answer "what is this and what does it do", not to fuzz every element. A field owes more than a button
// because a field's whole meaning is what it accepts, and that is the operator's explicit requirement.
export function batteryFor({ role = '', fieldFacts = null } = {}) {
  const r = String(role).toLowerCase();
  if (fieldFacts) {
    const kinds = ['fill-valid'];
    // Only probe a boundary the field DECLARES. A blind overflow probe on a field with no declared limit
    // tells us nothing we can check an answer against; a declared limit gives us a prediction to falsify,
    // and a disagreement between declared and observed is itself a defect worth reporting.
    if (fieldFacts.maxLength) kinds.push('fill-overflow');
    if (fieldFacts.required) kinds.push('fill-empty');
    if (fieldFacts.pattern || fieldFacts.min || fieldFacts.max) kinds.push('fill-invalid');
    return kinds;
  }
  if (r === 'link') return ['click'];
  return ['click'];
}

// One probe's verdict, from evidence alone. The ordering matters: a navigation and a write can both happen
// in one act, and the more specific fact wins. `rejected` is the rung that never existed before — an act
// that fired nothing because the PAGE SAID NO is a working control we failed to satisfy, which is a
// completely different fact from a control that does nothing, and they used to score identically.
export function verdictOf({ requests = [], revealed = 0, navigated = false, refused = false, succeeded = false, error = null } = {}) {
  if (error) return 'error';
  const writes = requests.filter((q) => q.class === 'write');
  if (navigated) return 'navigate';
  if (succeeded || writes.length) return 'write';
  if (refused) return 'rejected';
  if (requests.length) return 'read';
  if (revealed > 0) return 'reveal';
  return 'inert';
}

// Which owed probes are still outstanding, and which are blocked with a reason. `probes` are the recorded
// rows for ONE element.
export function probeStatus(node, probes = []) {
  const owed = batteryFor(node || {});
  const done = new Set();
  const blocked = new Map();
  for (const p of probes) {
    if (!p || !p.kind) continue;
    if (p.blocked) { if (!blocked.has(p.kind)) blocked.set(p.kind, p.blocked); continue; }
    done.add(p.kind);
  }
  // A kind that eventually succeeded is not blocked, however many times it failed first.
  for (const k of done) blocked.delete(k);
  const outstanding = owed.filter((k) => !done.has(k) && !blocked.has(k));
  return {
    owed,
    done: [...done],
    blocked: [...blocked.entries()].map(([kind, code]) => ({ kind, code })),
    outstanding,
    terminal: outstanding.length === 0 ? (blocked.size && !done.size ? 'EXHAUSTED' : 'CHARACTERIZED') : null,
  };
}

// The rung this element currently sits on.
export function levelOf(node, probes = []) {
  if (!node) return 'L0';
  const rows = probes.filter(Boolean);
  const real = rows.filter((p) => !p.blocked);
  // BLOCKED is only the verdict when NOTHING could ever be probed — a partially blocked element still owes
  // whatever remains, so it is not written off.
  if (rows.length && !real.length) return 'L-1';
  if (!rows.length) return node.reachedAt || node.explored ? 'L1' : 'L0';
  const st = probeStatus(node, rows);
  if (st.terminal !== 'CHARACTERIZED') return 'L2';
  // L4 needs the outcome to have been seen twice the same way, or a write confirmed by read-back — one
  // observation of a flaky control is not knowledge.
  const byKind = new Map();
  for (const p of real) {
    const seen = byKind.get(p.kind) || [];
    seen.push(p.verdict);
    byKind.set(p.kind, seen);
  }
  const reproduced = [...byKind.values()].some((v) => v.length >= 2 && v[0] === v[v.length - 1]);
  const readBack = real.some((p) => p.confirmedByReadBack === true);
  return (reproduced || readBack) ? 'L4' : 'L3';
}

const LEVELS = ['L-1', 'L0', 'L1', 'L2', 'L3', 'L4'];

// The honest headline. THREE numbers, never blended into one — that blending is what let coverage climb
// from 45% to 67% while completed user flows stayed at zero. `knowledge` answers "how much do we
// understand", `blocked` answers "what could we not touch and why", and flows are counted by the caller
// because they are a different question entirely (input quality versus action order).
export function knowledgeStats(graph, probesFor) {
  const counts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
  const blocked = [];
  const nodes = Object.entries(graph?.elements || {});
  for (const [tid, node] of nodes) {
    if (node.widgetInternal) continue;                      // chrome is not an obligation (INC.6f)
    const probes = (probesFor ? probesFor(tid, node) : node.probes) || [];
    const lvl = levelOf(node, probes);
    counts[lvl]++;
    if (lvl === 'L-1') {
      const first = probes.find((p) => p && p.blocked);
      blocked.push({ templateId: Number(tid), name: node.name || null, code: first ? first.blocked : 'unknown' });
    }
  }
  const obligations = nodes.length ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  const understood = counts.L3 + counts.L4;
  return {
    obligations,
    understood,
    knowledgePct: obligations ? Math.round((understood / obligations) * 1000) / 10 : 0,
    byLevel: counts,
    blocked: blocked.sort((a, b) => a.templateId - b.templateId),
  };
}
