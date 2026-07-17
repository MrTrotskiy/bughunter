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

async function firstVisible(handles) {
  for (const h of handles) if (await isVisible(h)) return h;
  return null;
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
    if (role && role !== 'generic' && name) {
      const handles = await page.getByRole(role, { name }).elementHandles().catch(() => []);
      const h = await firstVisible(handles);
      if (h) return { handle: h, via: 'role-name', representative: true };
    }
    return null;
  } catch {
    return null;
  }
}
