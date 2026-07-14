// The SINGLE identity model. One page.evaluate returns every interactive element
// as a two-level identity:
//   templateSelector — a STABLE css path with structural indices (:nth-child) and
//                      generated ids/data-ids normalized OUT. The "template": two
//                      elements share it iff they are the same control in different
//                      rows (e.g. the Edit button in any row).
//   instanceSelector — the FULL css path WITH :nth-child and data-* ids. Uniquely
//                      addresses THIS occurrence (row 42).
//   instanceKey      — a discriminator: nearest row/item data-id or text, else the
//                      nth index within the template group.
// A 50-row table is therefore 50 addressable instances of ONE template. Regions the
// snapshot cannot see into (open shadow roots, canvas, cross-origin iframes) are
// counted into `opaque` and never silently dropped.

// Runs entirely in the page; must be self-contained (no closure over module scope).
function collect() {
  const SEL = 'button, a[href], input, select, textarea, [role=button], [role=link], '
    + '[role=tab], [role=menuitem], [onclick], [tabindex]';

  const isGeneratedId = (id) => !id
    || /\d{4,}/.test(id)                       // long digit runs
    || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)    // uuid
    || /:r[0-9a-z]+:/i.test(id)                // react useId
    || id.length > 32;
  const isStableClass = (c) => !!c && !/\d/.test(c) && !/^(?:ng|css|sc|jsx|_)-/.test(c) && c.length <= 32;

  const DATA_ATTRS = ['data-id', 'data-testid', 'data-test', 'data-key', 'data-row-id', 'data-index'];
  const dataIdOf = (el) => {
    for (const a of DATA_ATTRS) if (el.hasAttribute(a)) return { name: a, value: el.getAttribute(a) };
    return null;
  };

  const nthChild = (el) => {
    let n = 1;
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) n++;
    return n;
  };

  // Build a css path from `el` up to a stable-id anchor (or the document root).
  // withInstance=false → template (drop :nth-child + data-ids); true → instance.
  const buildPath = (el, withInstance) => {
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.documentElement && depth < 12) {
      if (node.id && !isGeneratedId(node.id)) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let seg = node.tagName.toLowerCase();
      for (const c of Array.from(node.classList).filter(isStableClass).slice(0, 2)) seg += '.' + CSS.escape(c);
      if (withInstance) {
        const d = dataIdOf(node);
        // Quote the value as a CSS string: escape backslash FIRST, then the double
        // quote, so a data value containing `\`, `"`, or `]` yields a valid,
        // correctly-targeting `[name="..."]` selector rather than a malformed one.
        if (d) {
          const v = String(d.value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          seg += `[${d.name}="${v}"]`;
        }
        seg += `:nth-child(${nthChild(node)})`;
      }
      parts.unshift(seg);
      node = node.parentElement;
      depth++;
    }
    return parts.join(' > ');
  };

  const nameOf = (el) => {
    const pick = (v) => (v && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, 80) : '');
    return pick(el.getAttribute('aria-label'))
      || pick(el.textContent)
      || pick(el.getAttribute('placeholder'))
      || pick(el.getAttribute('title'));
  };

  const roleOf = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'button' || t === 'submit' || t === 'reset') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      return 'textbox';
    }
    return 'generic';
  };

  // Discriminator from the nearest row/item: element's own data-id, else nearest
  // row (li/tr/[role=row|listitem]/[data-id]) data-id or text. null → nth fallback.
  const rowKey = (el) => {
    const own = dataIdOf(el);
    if (own) return own.name + ':' + own.value;
    const row = el.closest('li, tr, [role=row], [role=listitem], [data-id], [data-testid]');
    if (row && row !== el) {
      const rd = dataIdOf(row);
      if (rd) return rd.name + ':' + rd.value;
      const t = (row.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 48);
    }
    return null;
  };

  const seen = new Set();
  const elements = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (seen.has(el)) continue;
    seen.add(el);
    elements.push({
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: nameOf(el),
      templateSelector: buildPath(el, false),
      instanceSelector: buildPath(el, true),
      instanceKey: rowKey(el),
    });
  }
  // Fill null instanceKeys with the nth position within their template group, so a
  // control with no row context is still an addressable, distinct instance.
  const groupN = Object.create(null);
  for (const e of elements) {
    if (e.instanceKey == null) {
      groupN[e.templateSelector] = (groupN[e.templateSelector] || 0) + 1;
      e.instanceKey = '#' + groupN[e.templateSelector];
    }
  }

  // Opaque regions — counted, never silently dropped. NOTE: CLOSED shadow roots are
  // undetectable from script (element.shadowRoot === null), so only OPEN roots show
  // up here; that limitation is honest, not hidden.
  const opaque = [];
  for (const _ of document.querySelectorAll('canvas')) opaque.push({ kind: 'canvas' });
  for (const f of document.querySelectorAll('iframe')) {
    let accessible = false;
    try { accessible = !!f.contentDocument; } catch { accessible = false; }
    opaque.push({ kind: 'iframe', accessible });
  }
  for (const el of document.querySelectorAll('*')) {
    if (el.shadowRoot) opaque.push({ kind: 'shadow-root' });
  }
  return { elements, opaque };
}

export async function snapshotDom(page) {
  return await page.evaluate(collect);
}
