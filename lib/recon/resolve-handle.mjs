// resolve-handle — ACT-TIME durable-locator instance resolution (the "resolveHandle" layer).
//
// The stored instanceSelector is a POSITIONAL css path (:nth-child + data-* ids). On a dynamic page (a
// feed that re-renders WHILE the walk stays on it) the DOM reshuffles and that positional path goes
// stale — page.$(instanceSelector) returns null, so the stateful walk would prematurely mark the control
// NO_INSTANCE-unreachable even though the control is still right there. The graph ALREADY classifies a
// DURABLE per-element locator (testid > stable id > role+name > css, dom-snapshot.mjs); this layer USES
// it at act time to re-locate a LIVE handle when the positional path fails.
//
// PURE resolution: it does NOT click, opens NO causal window, and NEVER mutates the graph — it only picks
// the live ElementHandle actStep will act on. It never throws (any failure → null). Identity is
// untouched: dom-snapshot still mints templates/instances exactly as before; this only chooses a handle.
// Returns a VISIBLE handle only (the click gate wants a visible target).
//
// resolveHandle(page, inst, node) → { handle, via, representative } | null
//   via 'selector'  — the STORED instanceSelector resolved a visible handle (the exact instance; cheapest,
//                     unchanged behavior).
//   via 'id'        — a page-unique testid / stable #id re-located the exact element durably.
//   via 'role-name' — a role+name match; representative:true — a LIVE REPRESENTATIVE of the template (the
//                     stored positional instance churned away or went hidden; the matched element's
//                     identity is not provable, so it is recorded truthfully as a representative, and its
//                     danger/off-origin safety is RE-CHECKED on the live handle by actStep before firing).
//
// RECORD THE ATTEMPT, NOT ONLY THE OUTCOME. Six strategies run in order and a bare `null` came back, so
// every fact the resolver had just measured was destroyed at the exact moment it became interesting: which
// strategies ran vs were SKIPPED (each is gated on loc.type), how many raw matches each found, how many of
// those were visible, and how many the `sameTemplate` structural guard rejected. Two very different
// stories were indistinguishable in the trail — "getByRole found ZERO" (a coverage gap: the control is
// genuinely not on the page) versus "getByRole found THREE and the guard rejected all three" (a resolver
// bug: the control is right there and we refused it). Nobody could tell which, on any run.
//
// It costs NO extra DOM work: every count below is already computed by the resolution itself. `raw`,
// `visible` and `sameTemplate` are read off the same handle lists the strategies already built.
//
// TWO EXPORTS, ONE IMPLEMENTATION — deliberately, and not a style choice. `resolveHandle`'s null-on-failure
// contract is load-bearing at call sites this module cannot see: `stateful-loop.mjs` tests it for bare
// TRUTHINESS twice (`return !!(await resolveHandle(...))` for reachability, `if (await resolveHandle(...))
// continue` for retirement), so returning an always-object `{handle:null,…}` would make every unreachable
// control read as reachable and invert the retire/churn logic silently. `resolveWithAttempts` is therefore
// the widened primary and `resolveHandle` a thin projection of it — no caller changes, no behaviour change.

// Every strategy, listed UP FRONT. A strategy that never ran (its loc.type gate did not match) must be
// distinguishable from one that ran and found nothing — that is the difference between "we never looked"
// and "we looked and it is not there", and collapsing them is the whole defect this record exists to fix.
const STRATEGIES = ['selector', 'testid', 'id', 'role-name', 'label', 'text'];

// attempt := { strategy, ran, raw, visible, sameTemplate }
//   ran          — the strategy's gate opened and it performed its lookup
//   raw          — matches the lookup returned, before any visibility or structural filter
//   visible      — of those, how many were visible
//   sameTemplate — of the VISIBLE ones, how many passed the structural guard. `null` where the guard does
//                  not apply (selector / testid / id / label are identity-exact by construction, so there
//                  is nothing to guard); a NUMBER only for the two name-based fallbacks it governs.
//                  On the FAILURE path the count is exact — the loop ran to completion — which is the case
//                  that matters. On success the loop short-circuits at the first pass, so it reads 1.
function blankAttempts() {
  return STRATEGIES.map((strategy) => ({ strategy, ran: false, raw: 0, visible: 0, sameTemplate: null }));
}

async function isVisible(handle) {
  try { return await handle.isVisible(); } catch { return false; }
}

async function visibleOf(handles) {
  const out = [];
  for (const h of handles) if (await isVisible(h)) out.push(h);
  return out;
}

// The legacy projection: exactly the contract every existing caller was written against.
export async function resolveHandle(page, inst, node) {
  const r = await resolveWithAttempts(page, inst, node);
  return r.handle ? { handle: r.handle, via: r.via, representative: r.representative } : null;
}

// resolveWithAttempts(page, inst, node) → { handle, via, representative, attempts }
//   handle non-null → resolved; `attempts` describes the path taken to get there.
//   handle null     → FAILED, and `attempts` is the evidence the decision was made on.
export async function resolveWithAttempts(page, inst, node) {
  const attempts = blankAttempts();
  const at = (s) => attempts.find((a) => a.strategy === s);
  // A single exit shape, so the outer catch returns whatever evidence was gathered before the throw —
  // a resolver that died half-way is itself a fact worth recording, not a reason to report nothing.
  const done = (handle, via, representative) => ({ handle, via, representative, attempts });
  try {
    // (a) STORED positional selector — the exact original instance (cheapest, unchanged behavior).
    const sel = inst && inst.instanceSelector;
    if (sel) {
      const a = at('selector');
      a.ran = true;
      const h = await page.$(sel).catch(() => null);
      if (h) {
        a.raw = 1;
        // Whether the stored positional path matched ANYTHING is the fact that decides NOT_VISIBLE vs
        // NO_INSTANCE downstream. It was re-queried a third time in step.mjs purely to answer that; it
        // has always existed here, one frame up.
        if (await isVisible(h)) { a.visible = 1; return done(h, 'selector', false); }
      }
    }

    // (b) DURABLE locator. The instance carries the concrete locator ({type, attr/value/role/name});
    // the node carries role+name for the role-name fallback. A stale nth-child does not make a control
    // gone — the durable handle keeps it reachable.
    const loc = (inst && inst.locator) || null;

    // page-unique testid → [attr="value"]. Only a UNIQUE-flagged testid is an instance handle (a shared
    // marker testid is not). Re-verify a SINGLE visible live match: a testid that duplicated since
    // baseline is a marker now → treat as a role-name representative, never a false "exact id".
    if (loc && loc.type === 'testid' && loc.unique === true && loc.attr && loc.value) {
      const a = at('testid');
      a.ran = true;
      const hs = await page.$$(`[${loc.attr}="${loc.value}"]`).catch(() => []);
      a.raw = hs.length;
      const vis = await visibleOf(hs);
      a.visible = vis.length;
      if (vis.length === 1) return done(vis[0], 'id', false);
      if (vis.length > 1) return done(vis[0], 'role-name', true);
    }

    // stable #id — page-unique by construction: the exact element re-located durably (not representative).
    if (loc && loc.type === 'id' && loc.value) {
      const a = at('id');
      a.ran = true;
      const h = await page.$(loc.value).catch(() => null);
      if (h) {
        a.raw = 1;
        if (await isVisible(h)) { a.visible = 1; return done(h, 'id', false); }
      }
    }

    // role + name — the FIRST VISIBLE match. Reached only because (a) failed, so the stored positional
    // instance is not the element we hand back: a LIVE REPRESENTATIVE of the same template.
    const role = (loc && loc.type === 'role-name' && loc.role) || (node && node.role) || null;
    const name = (loc && loc.type === 'role-name' && loc.name) || (node && node.name) || null;

    // The SAME-TEMPLATE predicate, shared by EVERY name-based fallback below. It must not live inside one
    // branch: a guard on role+name alone is defeated by the text fallback underneath it, which re-runs the
    // same "first visible thing with this name" search with no structural check at all. Measured live —
    // with the modal shut, role+name found only the opener, this guard correctly rejected it, control fell
    // through to getByText, and the opener came back anyway. Both "Create Event" templates ended up with a
    // causal edge to the opener's own POST get_status_detail; the submit's endpoint never fired once.
    const tsel = node && node.templateSelector;
    const sameTemplate = async (h) => {
      if (!tsel) return true;
      return h.evaluate((el, s) => { try { return el.matches(s); } catch { return true; } }, tsel).catch(() => true);
    };

    if (role && role !== 'generic' && name) {
      const a = at('role-name');
      a.ran = true;
      a.sameTemplate = 0; // the guard GOVERNS this strategy, so the count is a number from here on
      const handles = await page.getByRole(role, { name }).elementHandles().catch(() => []);
      // SAME-TEMPLATE GUARD. getByRole searches the WHOLE PAGE, so "the first visible control with this
      // accessible name" is not necessarily this template — and when two different controls share a name,
      // the representative is a DIFFERENT control and the act is recorded against the wrong one.
      //
      // Measured live, and it is the last link in the create chain: the "Create Event" that OPENS the
      // modal and the "Create Event" that SUBMITS it have the same name. Whenever the modal was shut, the
      // submit's stored selector failed, this fallback resolved the OPENER, and the crawl clicked the
      // opener while recording the act against the submit. Across seven runs that read as "Create Event
      // exercised, fired only get_status_detail" — the submit was never once clicked. Clicking it by hand
      // in a probe fires POST /api/meetings-events and creates the event.
      //
      // The template selector is the structural identity, so requiring the candidate to match it keeps a
      // genuine re-rendered representative (same shape, moved) while rejecting a same-named impostor.
      // Fail-safe: no selector recorded, or a selector the engine rejects → keep the old behaviour.
      a.raw = handles.length;
      const visible = [];
      for (const h of handles) if (await isVisible(h)) visible.push(h);
      a.visible = visible.length;
      // `raw` > 0 with `sameTemplate` === 0 is the resolver-bug signature: candidates were FOUND and the
      // structural guard refused every one. `raw` === 0 is the coverage gap. One number apart, opposite
      // diagnoses, and the trail could report neither.
      for (const h of visible) if (await sameTemplate(h)) { a.sameTemplate += 1; return done(h, 'role-name', true); }
    }

    // LABEL-WRAPPED INPUT. AntD segmented controls / styled radios / checkboxes render a VISUALLY HIDDEN
    // <input> inside a <label> that carries the actual affordance — so the input resolves, reads
    // not-visible, and the control is written off as unreachable even though a user clicks it every day.
    // Clicking the LABEL is the correct actuation (it forwards activation to its control per the HTML
    // spec), not a workaround. Only taken when the stored element is itself hidden and its label IS
    // visible, so a normal visible input is untouched. Not `representative`: the label IS this control's
    // click target, not a stand-in for a different element.
    const stored = await page.$(inst.instanceSelector).catch(() => null);
    if (stored && !(await isVisible(stored))) {
      const a = at('label');
      a.ran = true;
      const lab = await stored.evaluateHandle((el) => {
        const t = el.tagName.toLowerCase();
        if (t !== 'input' && t !== 'select' && t !== 'textarea') return null;
        return el.closest('label') || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
      }).catch(() => null);
      const lh = lab && lab.asElement();
      if (lh) {
        a.raw = 1;
        if (await isVisible(lh)) { a.visible = 1; return done(lh, 'label', false); }
      }
    }

    // TEXT fallback — the role-less clickable case. Modern React/AntD apps bind click handlers to bare
    // <div>/<span> with text and NO ARIA role, so roleOf() returns 'generic' and the branch above is
    // disabled exactly where a durable handle is most needed. Measured on the live target crawl: 44 of
    // 100 NO_INSTANCE instances were role='generic' WITH a usable name ("See Translation", "more_horiz",
    // "Read Out"), i.e. resolvable by text but never attempted.
    //
    // Exact-match, first VISIBLE — same representative semantics as role-name: this is a live stand-in for
    // the same template, not the stored positional instance, so it is flagged `representative: true`. That
    // flag is load-bearing: actStep re-derives the LIVE element's own name and re-runs the policy gate
    // before clicking, and stamps `viaRepresentative` on the instance so the report never claims the exact
    // instance was individually tested. Strictly additive — it can only turn a `null` into a resolution.
    //
    // STRUCTURALLY GATED, same as role+name above. Without the gate this branch is a hole straight through
    // that guard, and it is a wide one here: `name` is often SYNTHESIZED from a class token
    // (Connections_chat__qgMbX → "chat"), a string that does not exist as text on its own element but does
    // match a material-icons ligature elsewhere on the page — so getByText would hand back an unrelated
    // icon. On a name miss we return null (an honest NO_INSTANCE) rather than "somebody with this text".
    if (name) {
      const a = at('text');
      a.ran = true;
      a.sameTemplate = 0; // guard-governed, same as role-name above
      const handles = await page.getByText(name, { exact: true }).elementHandles().catch(() => []);
      a.raw = handles.length;
      for (const h of handles) {
        if (!(await isVisible(h))) continue;
        a.visible += 1;
        if (await sameTemplate(h)) { a.sameTemplate += 1; return done(h, 'text', true); }
      }
    }
    return done(null, null, false);
  } catch {
    return done(null, null, false);
  }
}
