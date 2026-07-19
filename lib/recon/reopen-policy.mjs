// REOPEN POLICY — the pure admission rules for re-entering an in-app container (INC.7).
//
// THE PROBLEM. Three of the six target user flows have no navigational address at all: /groups renders the
// app's client-404 shell, /events and /chats redirect to /dashboard. Their functionality exists only as
// in-dashboard modal state. When a control inside such a modal does not resolve, the stateful driver's ONLY
// recovery is to re-navigate to its route — which closes the modal — and it does that up to MAX_REVISITS
// times per route. Measured: 141 of 180 navigations in one run produced zero acts. The driver is retrying
// the ROUTE dimension when the missing dimension is STATE.
//
// THE INFORMATION IS ALREADY RECORDED. 476 instances carry a `reveal.statePath`. All 476 are marked
// `stateful: true`, and `reveal-replay.mjs` refuses every one of them (REVEAL_PROVENANCE_ONLY) — correctly,
// because a stateful breadcrumb is an over-approximation of every act since the last navigation, not a
// minimal route. That guard is NOT touched here. This module is a separate, stricter admission path.
//
// WHY SUFFIXES, NOT THE WHOLE PATH. The last hop of a reveal path is, by construction, the immediate opener.
// Measured over the 87 unreachable-with-path instances: keying by the LAST HOP ALONE yields 37 distinct
// suffixes that cover ALL 87. Capping recorded path depth instead covers far less — and would exclude the
// headline case outright: the live `Create` control sits at depth 4 behind hops that include
// `See Translation` and `Read Out`, which are transparently not on the path to a Create modal. Shortest
// suffix first is therefore the correctly-ordered hypothesis, not a heuristic.
//
// Pure: no browser, no graph mutation. `admitHop` is the single gate, in the shape of explore-policy.decide.

import { isDismissControl, dangerFloor, REFUSED, isAccountDeletion, destroysContent, editsContent, mutationFloor } from './danger-floor.mjs';
import { classifyEndpoints } from './endpoint-class.mjs';

export const REOPEN_MAX_HOPS = 3;
// How many times ONE opener template may be re-fired across a run, and the global ceiling. The gate below
// judges IRREVERSIBILITY, which is decidable; it deliberately does not judge whether repeating a reversible
// side effect is acceptable, which is not. That residual is bounded by a budget instead of guessed at by a
// regex — the same move the create budget made for the same reason.
export const REOPEN_HOP_FIRES_MAX = 3;
export const REOPEN_HOP_BUDGET = 60;

// The requests a hop's control caused when the crawl fired it, read off the graph's causal edges — the same
// shape reveal-firewall uses to build its allowlist. Used ONLY to LABEL the hop's write risk in the trail;
// see admitHop for why this evidence deliberately does not gate.
function recordedRequests(graph, templateId) {
  const out = [];
  for (const e of graph.edges || []) {
    if (e.from !== `element:${templateId}` || e.type !== 'triggers') continue;
    const node = (graph.requests || {})[String(e.to).replace(/^request:/, '')];
    if (node) out.push({ method: node.method, url: node.url, urlPattern: node.urlPattern });
  }
  return out;
}

// Admit ONE hop of a candidate suffix.
//
// THE AXIS IS IRREVERSIBILITY, NOT WRITE-NESS — this is the second version of this gate, and the first one
// was wrong in a way worth recording. It refused any hop whose recorded endpoints classified as a write, and
// that question is not answerable lexically: `POST /app/addnuggetview` is a VIEW COUNTER that fires on
// almost every interaction, yet `endpoint-class` sees the verb `add` at a path boundary and calls it a write,
// so a menu opener, a nav tab and a counter all read as mutating. Meanwhile `POST /app/influencerlist`
// is a plain list that falls through to the non-GET fallback, which on a target that reads over POST is the
// normal shape of a READ. Measured live: 12 of 37 openers refused, catching ZERO irreversible acts and
// blocking 17 recoverable instances — including `add` → the `Create` modal, refused on its NAME alone with
// zero recorded requests. The project's founding decisions reject exactly this ("a hard-coded read/write
// heuristic re-imports the name-based guessing"; "the judgment is semantic → it belongs to the agent").
//
// So: refuse what is DECIDABLE and irreversible, record what is not, and bound the rest with a budget.
// `writeRisk` is a LABEL that rides in the trail — it never gates.
export function admitHop(graph, hop, seen = new Set(), fires = null) {
  const node = graph?.elements?.[hop?.templateId];
  if (!node) return { ok: false, code: 'REOPEN_HOP_UNKNOWN' };
  if (seen.has(hop.templateId)) return { ok: false, code: 'REOPEN_HOP_REPEAT' };

  const name = node.name;
  const route = node.route;

  // A dismiss control CLOSES the container we are trying to open. Replaying one is self-defeating, and it
  // is how 22 recorded paths were poisoned in the first place (INC.6).
  if (isDismissControl({ name })) return { ok: false, code: 'REOPEN_HOP_DISMISS' };

  // The danger floor is NOT lifted under explore-all here, unlike a measured act. A reopen hop is plumbing:
  // it runs outside any causal window, so firing a destructive/auth/payment/communication control would
  // commit the effect with NOTHING recording it, and the control would still be unexplored afterwards.
  // Explore-all buys coverage by firing things deliberately and attributing them; this is neither.
  if (REFUSED.has(dangerFloor({ name, route }))) return { ok: false, code: 'REOPEN_HOP_DANGER' };
  if (isAccountDeletion({ name })) return { ok: false, code: 'REOPEN_HOP_DANGER' };

  // MODIFIES EXISTING CONTENT. Ownership is proven LIVE off the acted handle (hunt-gate), and at policy time
  // there is no handle and no causal window — so we cannot tell our content from a stranger's here. The
  // foreign-content rail is the whole safety story, and it cannot be evaluated, so anything that destroys or
  // edits an existing item is refused outright. Additive controls (open a composer, expand a menu, follow)
  // create nothing of anyone else's to lose and stay admissible.
  if (destroysContent({ name, route }) || editsContent({ name, route })) {
    return { ok: false, code: 'REOPEN_HOP_MODIFIES' };
  }

  // EVIDENCE BEATS THE REGEX — WHERE THERE IS EVIDENCE. Dropping the name signal entirely was the second
  // wrong version of this gate. `dangerFloor` is `safe` for every opener in the measured population, and
  // that is not proof the population is safe — it is proof `dangerFloor` has no resolving power on it.
  // "report Report Abuse" and "block Block User" are in neither the destructive nor the communication set,
  // yet both are outward-facing and effectively irreversible: a report reaches a moderator, unblocking is a
  // separate act. `mutationFloor` is the ONLY signal that catches them.
  //
  // So the name is not asked to decide whether something mutates — it is asked whether we need PROOF before
  // re-firing it. A hop whose own instance was acted CLEANLY has that proof and is admitted whatever its
  // name suggests (this is what unblocks `add` → the Create modal). A hop with no clean act behind it, whose
  // name is anything other than plainly safe, is refused.
  //
  // Per INSTANCE, never per template — and that distinction is load-bearing. `markInstanceUnreachable`
  // propagates to the node only for instances[0], so a non-representative instance that FAILED is invisible
  // at template level. Measured: tpl 515 and 521 both read clean on the node while carrying an
  // explored-AND-unreachable instance. Those are exactly the two controls that most needed refusing.
  // `!== 'safe'` rather than `=== 'mutation'` also restores the fail-closed contract this module claims:
  // an icon-only control classifies `unknown`, and four such openers were being admitted on no information.
  const inst = (node.instances || []).find((i) => i.instanceKey === hop.instanceKey);
  const firedCleanly = !!(inst && inst.explored && !inst.unreachable && !inst.churned);
  if (!firedCleanly && mutationFloor({ name }) !== 'safe') {
    return { ok: false, code: 'REOPEN_HOP_UNPROVEN' };
  }

  // Budget, not judgment: how often may ONE opener be re-fired this run.
  if (fires && (fires.get(hop.templateId) || 0) >= REOPEN_HOP_FIRES_MAX) {
    return { ok: false, code: 'REOPEN_HOP_BUDGET_SPENT' };
  }

  const reqs = recordedRequests(graph, hop.templateId);
  let writeRisk = 'none';
  if (reqs.length) {
    const cls = classifyEndpoints(reqs);
    if (cls.writes?.length) writeRisk = cls.unnamedWrites?.length === cls.writes.length ? 'unnamed' : 'named';
  }
  return { ok: true, code: 'REOPEN_HOP_OK', writeRisk, firedCleanly, evidence: reqs.map((r) => `${r.method} ${r.urlPattern || r.url}`) };
}

// The ordered candidate attempts for one instance: shortest suffix of its recorded path first.
// Returns [] when there is no path to work from — the caller then has nothing to try and says so honestly.
export function reopenAttempts(graph, node, inst, { maxHops = REOPEN_MAX_HOPS, fires = null } = {}) {
  const path = inst?.reveal?.statePath || node?.reveal?.statePath || [];
  if (!Array.isArray(path) || path.length === 0) return [];
  const out = [];
  for (let n = 1; n <= Math.min(maxHops, path.length); n++) {
    const hops = path.slice(path.length - n);
    const seen = new Set();
    let verdict = { ok: true, code: 'REOPEN_HOP_OK' };
    for (const h of hops) {
      verdict = admitHop(graph, h, seen, fires);
      if (!verdict.ok) break;
      seen.add(h.templateId);
    }
    out.push({ hops, admitted: verdict.ok, code: verdict.code, writeRisk: verdict.writeRisk || null });
  }
  return out;
}
