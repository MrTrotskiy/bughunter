// hunt-gate — the OWNERSHIP proof for WRITE-HUNT mode (safe mutation QA on OWN content). The
// HUNT-<runId> marker present in a target's item container IS the ownership proof: content carrying the
// marker was created by THIS run → editable/deletable; content WITHOUT it is pre-existing / another user's
// → the ONE hard rule is never edit/delete it (additive comment/like on it is fine). Read LIVE off the
// resolved handle right before the act, so it survives the re-renders and cold re-navigation a crawl does
// (an in-memory id would go stale). FAIL-CLOSED on every path — no boundary, marker absent, or evaluate
// throws → false → the destructive/edit act is refused.
//
// The marker is deterministic (huntMarker) and injected at the fill layer (step.fillTarget), NEVER by the
// agent, so an agent cannot forge a marker and a created resource is provably ours by construction. This
// is a route-node/DOM READING predicate only — never an identity input (it never reaches ids.mjs /
// templateId / instanceKey / reqKey / edges). Enforcement lives in step.mjs (the one causal act).

// The per-run marker. Long + run-scoped so `textContent.includes(marker)` cannot false-match real content
// or another run's data. Matches the standing mutation-test-data contract (decisions.md 2026-07-14).
export function huntMarker(runId) {
  return `HUNT-${runId}`;
}

// The nearest ITEM boundary around a control — the tightest post/card/row ancestor. Deliberately TIGHT
// (no `form`, no `[data-testid]` — those wrap the whole composer/feed and would leak a marked sibling's
// ownership to an adjacent unmarked item, security review H2). One constant, inlined into the evaluate.
export const ITEM_BOUNDARY = 'article,li,tr,[role="listitem"],[role="row"],[role="article"],[data-id],[data-key],.post,.card,.comment,.item,.feed-item,.tweet,.status,.message';

// True iff the HUNT marker is present in the control's OWN item — NOT merely somewhere in its subtree.
// Two leaks this guards (security review H2 + the nested-item case): (1) a WIDE boundary wrapping several
// items — the marker of a marked sibling would satisfy a naive textContent check; (2) OUR marked comment
// nested inside ANOTHER user's post — the marker is in the post's subtree but the post is not ours. Fix:
// take the boundary's text with the text of every NESTED item-boundary REMOVED, and require the marker to
// survive in that OWN-scope text. FAIL-CLOSED on every path (no input / no boundary / marker only in a
// nested item / thrown evaluate → false → refuse the edit/delete). A bare control with no item ancestor
// falls back to parentElement (narrow), whose own text almost never carries a foreign marker → refuse.
export async function ownsTarget(handle, marker) {
  if (!handle || !marker) return false;
  try {
    return await handle.evaluate((el, [m, sel]) => {
      const boundary = el.closest(sel) || el.parentElement;
      if (!boundary || typeof boundary.textContent !== 'string') return false;
      if (!boundary.textContent.includes(m)) return false;
      // Strip every NESTED item-boundary's text; the marker must remain in the boundary's OWN content.
      let own = boundary.textContent;
      for (const nestedItem of boundary.querySelectorAll(sel)) {
        if (typeof nestedItem.textContent === 'string') own = own.split(nestedItem.textContent).join('');
      }
      return own.includes(m);
    }, [marker, ITEM_BOUNDARY]);
  } catch {
    return false;
  }
}

// PORTAL-DROPDOWN ownership (live rawcaster finding): AntD (and similar) render a row's Edit/Delete dropdown
// as a PORTAL appended to <body>, structurally DETACHED from the post card — so `ownsTarget` on the delete
// button's own DOM ancestors finds no marker and fails closed, blocking a LEGITIMATE delete of OWN content.
// But the dropdown BELONGS to the control that OPENED it: the reveal path's LAST hop is that trigger (the
// post's "…" more_horiz), which IS inside the post card. So ownership of a portal control is the ownership of
// its reveal-TRIGGER's item. Resolve the trigger from the reveal path (its stored instanceSelector) and run
// the SAME marker check on it. FAIL-CLOSED: no reveal path / unresolvable trigger / trigger not in a marked
// item → false. Safe because AntD opens the dropdown FOR the row whose trigger was clicked, so the trigger's
// post IS the delete's target — authorizing by the trigger's ownership never authorizes a different row.
export async function ownsViaReveal(page, graph, revealPath, marker) {
  if (!page || !Array.isArray(revealPath) || !revealPath.length || !marker) return false;
  const hop = revealPath[revealPath.length - 1];               // the immediate opener (the row's "…" trigger)
  if (!hop || hop.templateId == null) return false;
  const node = graph && graph.elements && graph.elements[hop.templateId];
  const inst = node && node.instances && node.instances.find((i) => i.instanceKey === hop.instanceKey);
  const sel = inst && inst.instanceSelector;
  if (!sel) return false;
  try {
    const h = await page.$(sel);
    if (!h) return false;
    return await ownsTarget(h, marker);                        // the trigger's own item carries our marker?
  } catch {
    return false;
  }
}
