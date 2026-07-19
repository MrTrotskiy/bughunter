// ACT ALIAS LEDGER — proof that the node we are about to click is not one we already acted on.
//
// THE FAILURE THIS EXISTS TO PREVENT, measured in run probe6. Template 392, instance keys `05` through
// `11`: seven separate acts, each recorded against a different instance, every one reporting the IDENTICAL
// rect {x:693,y:383,w:48,h:28}. The positional selectors had gone stale, so `resolveHandle` fell through to
// the `getByText` fallback and returned the same first-visible node seven times. We clicked ONE control
// seven times and wrote seven instances' worth of knowledge from it. Under explore-all those were seven
// real interactions with the operator's live stand, six of which nobody asked for.
//
// It was invisible for the same reason it was possible: nothing compared the RESOLVED NODE across acts.
// Identity was checked at the selector layer, and two different selectors resolving to one node is exactly
// the case a selector-layer check cannot see.
//
// WHY AN EXPANDO. The claim is stamped as a JS property on the element, not an attribute or a class:
//   - dom-snapshot reads tagName / classList / id / attributes / computed style / rects / textContent.
//     An expando is in NONE of those, so this can never perturb template or instance identity — the
//     invariant that makes the whole graph addressable.
//   - It is invisible to `querySelector`, to CSS, and to the page's own code.
//   - It dies with the node. A genuinely re-rendered element arrives unstamped, so a framework that
//     recreates a row between acts produces no false collision.
//
// WHAT A COLLISION MEANS, exactly. Not "we clicked the wrong thing" — that would be a verdict we have not
// earned. It means the identity of what we are about to click is UNPROVEN, which is a failure to measure.
// So the caller raises a TRANSIENT block: the obligation stays standing, the element stays visibly
// incomplete, and the denominator does not collapse. A virtualized list that legitimately recycles one DOM
// node for a different logical row lands here too, and lands correctly — we genuinely cannot tell the two
// apart from the node alone, and saying so is the honest answer.

const PROP = '__bhActor';

// The key identifying WHICH logical element an act belongs to. Template + instance, because the same
// template acted at two instances is exactly the case we are policing.
export function actorKey(templateId, instanceKey) {
  return `${templateId}#${instanceKey ?? ''}`;
}

// Claim the node for this actor. Idempotent for the same actor — re-acting the SAME instance (an overlay
// retry, a reproduction probe for L4) is legitimate and must not self-collide.
//
// Fail-open on an evaluate failure: a detached or cross-origin handle returns `ok` with `heldBy: null`, so
// a broken read degrades to today's behaviour rather than blocking a legitimate act. The alias gate exists
// to catch a specific measured fault, not to become a new way for acts to fail.
export async function claimNode(handle, key) {
  if (!handle || !key) return { ok: true, heldBy: null };
  try {
    return await handle.evaluate((el, { prop, key: k }) => {
      const prior = el[prop];
      if (prior && prior !== k) return { ok: false, heldBy: prior };
      // Non-enumerable so a page walking its own properties never sees it.
      if (!prior) Object.defineProperty(el, prop, { value: k, writable: true, configurable: true, enumerable: false });
      return { ok: true, heldBy: prior || null };
    }, { prop: PROP, key });
  } catch {
    return { ok: true, heldBy: null };
  }
}
