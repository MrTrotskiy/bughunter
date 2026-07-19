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

async function isVisible(handle) {
  try { return await handle.isVisible(); } catch { return false; }
}

async function visibleOf(handles) {
  const out = [];
  for (const h of handles) if (await isVisible(h)) out.push(h);
  return out;
}

export async function resolveHandle(page, inst, node) {
  try {
    // (a) STORED positional selector — the exact original instance (cheapest, unchanged behavior).
    const sel = inst && inst.instanceSelector;
    if (sel) {
      const h = await page.$(sel).catch(() => null);
      if (h && await isVisible(h)) return { handle: h, via: 'selector', representative: false };
    }

    // (b) DURABLE locator. The instance carries the concrete locator ({type, attr/value/role/name});
    // the node carries role+name for the role-name fallback. A stale nth-child does not make a control
    // gone — the durable handle keeps it reachable.
    const loc = (inst && inst.locator) || null;

    // page-unique testid → [attr="value"]. Only a UNIQUE-flagged testid is an instance handle (a shared
    // marker testid is not). Re-verify a SINGLE visible live match: a testid that duplicated since
    // baseline is a marker now → treat as a role-name representative, never a false "exact id".
    if (loc && loc.type === 'testid' && loc.unique === true && loc.attr && loc.value) {
      const vis = await visibleOf(await page.$$(`[${loc.attr}="${loc.value}"]`).catch(() => []));
      if (vis.length === 1) return { handle: vis[0], via: 'id', representative: false };
      if (vis.length > 1) return { handle: vis[0], via: 'role-name', representative: true };
    }

    // stable #id — page-unique by construction: the exact element re-located durably (not representative).
    if (loc && loc.type === 'id' && loc.value) {
      const h = await page.$(loc.value).catch(() => null);
      if (h && await isVisible(h)) return { handle: h, via: 'id', representative: false };
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
      const visible = [];
      for (const h of handles) if (await isVisible(h)) visible.push(h);
      for (const h of visible) if (await sameTemplate(h)) return { handle: h, via: 'role-name', representative: true };
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
      const lab = await stored.evaluateHandle((el) => {
        const t = el.tagName.toLowerCase();
        if (t !== 'input' && t !== 'select' && t !== 'textarea') return null;
        return el.closest('label') || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
      }).catch(() => null);
      const lh = lab && lab.asElement();
      if (lh && await isVisible(lh)) return { handle: lh, via: 'label', representative: false };
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
      const handles = await page.getByText(name, { exact: true }).elementHandles().catch(() => []);
      for (const h of handles) {
        if (!(await isVisible(h))) continue;
        if (await sameTemplate(h)) return { handle: h, via: 'text', representative: true };
      }
    }
    return null;
  } catch {
    return null;
  }
}
