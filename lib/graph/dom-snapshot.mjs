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

  // Framework-generated wrapper ids (Ant Design/`rc-*`, Radix, Headless UI, MUI) and hashed
  // ids SHIFT across reloads and FRAGMENT one logical control into N per-instance templates
  // (each tab anchoring on its own `#rc-tabs-0-tab-N`), which also breaks the reset-and-replay
  // reveal chain that depends on a stable selector across reloads. So they must NEVER anchor a
  // selector path (INC.1; decisions.md 2026-07-15 "whole-site reach"). This same predicate also
  // gates the sole-`#id` locator below (stableIdForLocator) so a rejected id can't become a
  // brittle Phase-2 handle either. Prefix match is `<lib>` + `-`/`_` so a semantic id like
  // `#antarctica` (no dash) is never a false positive. NOTE: framework CLASSES (`ant-tabs-tab`)
  // are deliberately KEPT by isStableClass — they are the STABLE structural anchor we want.
  const isFrameworkNoiseId = (id) => /^(?:rc|ant|radix|headlessui|mui)[-_]/i.test(id)
    || (/[0-9a-f]{6,}/i.test(id) && /\d/.test(id));   // hashed hex run carrying a digit
  const isGeneratedId = (id) => !id
    || /\d{4,}/.test(id)                       // long digit runs
    || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)    // uuid
    || /:r[0-9a-z]+:/i.test(id)                // react useId
    || isFrameworkNoiseId(id)                  // framework wrapper / hashed ids (INC.1)
    || id.length > 32;
  const isStableClass = (c) => !!c && !/\d/.test(c) && !/^(?:ng|css|sc|jsx|_)-/.test(c) && c.length <= 32;

  const DATA_ATTRS = ['data-id', 'data-testid', 'data-test', 'data-key', 'data-row-id', 'data-index'];
  const dataIdOf = (el) => {
    for (const a of DATA_ATTRS) if (el.hasAttribute(a)) return { name: a, value: el.getAttribute(a) };
    return null;
  };

  // Locator preference (a DERIVED attribute, NOT identity). Identity keys on the selector
  // string (ids.mjs), so this classification can never churn a templateId/instanceId — it
  // only tells Phase-2 the most DURABLE handle to generate a test on. A SEPARATE, broader
  // authored-test-id list from DATA_ATTRS (which stays byte-identical for the instanceKey /
  // instanceSelector path) so widening it here cannot touch identity.
  const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-automation-id', 'data-pw'];
  const safeLocatorValue = (v) => typeof v === "string" && v.length > 0 && v.length <= 128 && !/["'\\<>\u0000-\u001f\u007f-\u009f]/.test(v);
  const testidOf = (el) => {
    for (const a of TESTID_ATTRS) if (el.hasAttribute(a)) { const v = el.getAttribute(a); if (safeLocatorValue(v)) return { attr: a, value: v }; }
    return null;
  };
  // A #id is a usable SOLE locator only if strictly stable — stricter than the path-anchor
  // isGeneratedId (where nth-child still disambiguates): reject useId colons, pure numeric,
  // hash-like hex runs, framework-wrapper ids (INC.1: isFrameworkNoiseId covers the hashed-hex
  // case too), and over-long ids. A rejected id falls through to role+name — the durable handle.
  const stableIdForLocator = (id) => !!id && id.length <= 40 && !id.includes(':')
    && !/^\d+$/.test(id) && !isFrameworkNoiseId(id) && safeLocatorValue(id);

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

  // Additive per-element list-row provenance (DRILL_PER_LIST honesty): does this element sit inside a
  // genuine LIST ROW ancestor (li/tr/[role=row|listitem]) — a NARROWER set than the data-id/testid one
  // rowKey uses, since a lone data-id div is not a list row. A template with any row-resident instance is
  // a list of rows: DRILL_PER_LIST walks one representative row and COUNTS the rest as drillSkipped
  // (frontier.mjs), the non-opener analog of cappedRemainder. Reporting-only — NEVER an identity input
  // (identity keys on the selector strings; templateSelector/instanceKey never see inRow).
  const inRowOf = (el) => el.closest('li, tr, [role=row], [role=listitem]') !== null;

  // Sits inside a navigation landmark OR a WAI-ARIA navigation-pattern container — a global-section nav
  // control (the constant-URL onClick sections a menu-event sweep front-loads: Groups/Events swap content
  // in place, never a URL). Beyond <nav>/[role=navigation], real SPAs mark section nav with the ARIA
  // TAB/MENU authoring patterns and NO <nav> element (rawcaster's Groups/Events are `div[role=tab]` in a
  // `div[role=tablist]`), so those roles count too. Structural role/landmark containment, NOT geometry —
  // a plain button outside these is never swept. A false positive (a content-area tablist) only REORDERS
  // (front-loads) a non-nav tab, never mis-collects it. REPORTING-ONLY (drives node.navControl → frontier
  // navBatch priority), NEVER an identity input.
  const inNavOf = (el) => el.closest('nav, [role=navigation], [role=tablist], [role=menubar], [role=menu]') !== null;

  // Approximates Playwright's isVisible (actStep gates the click on `handle.isVisible()`, step.mjs):
  // an element is visible iff it is NOT display:none / visibility:hidden AND its bounding box has a
  // non-zero area — the same width>0 && height>0 box test Playwright uses (getBoundingClientRect,
  // not getClientRects().length, so a zero-area 0×0 box reads hidden as Playwright does). visibility
  // inherits, so an ancestor-hidden control reads hidden too; opacity:0 is NOT hidden (it has a box)
  // — matching Playwright. Divergence is only in exotic layouts (display:contents has no own box and
  // reads hidden here though Playwright recurses to children) — over-/under-permissive at most wastes
  // or skips a REPLAY, never mis-clicks: actStep's isVisible is the real click gate. This drives the
  // state model's "hidden-at-baseline, revealed-by-an-opener" fill (graph-store mergeSnapshot); it is
  // an ADDITIVE attribute, NEVER an identity input (identity keys on the selector strings only).
  const isVisible = (el) => {
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
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
      visible: isVisible(el),                                   // approx Playwright isVisible; drives the reveal fill, NEVER identity
      inRow: inRowOf(el),                                       // sits in a list-row ancestor; drives DRILL_PER_LIST, NEVER identity
      inNav: inNavOf(el),                                       // sits in a nav landmark; drives the menu-event sweep priority, NEVER identity
      _tid: testidOf(el),                                       // {attr,value} | null
      _sid: stableIdForLocator(el.id) ? el.id : null,           // strictly-stable id | null
    });
  }
  // Role-less clickables ("div-soup"): modern SPAs bind click handlers to <div>/<span>/<svg>
  // via addEventListener with NO role/tag the SEL pass matches — often half of a React app's
  // controls (a feed's connection rows, a composer's Video/Image/Poll, video-call icons).
  // addEventListener handlers are invisible to page script, so the durable signal is computed
  // `cursor: pointer`. Gates (safety + noise, ALL required): (1) not already captured;
  // (2) cursor:pointer; (3) a SHORT synthesizable name — aria-label/title, else own text ≤40 chars
  // (a label, not a content blob) — REQUIRED so the name-based danger-floor CAN judge it before any
  // live click and decorative pointer chrome is skipped (an unnamed pointer div is honestly
  // UNCAPTURED, never blind-clicked); (4) NOT a wrapper of an already-matched control
  // (`!el.querySelector(SEL)` — the real control is the handle, avoids a duplicate by content text);
  // (5) OUTERMOST pointer only — `cursor` INHERITS, so an element with a pointer ancestor is the
  // inner icon/span of an outer clickable and is dropped. Capped, and the whole scan is bounded, so
  // a pathological page cannot blow up. Role stays roleOf() ('generic' for a bare div) — honest, and
  // the locator ladder then falls to the css path, never a broken getByRole. Additive: a role-based
  // fixture with no pointer divs yields ZERO new elements (byte-identical, zero identity churn).
  const ROLELESS_CAP = 60;
  const SCAN_CAP = 8000;
  const shortName = (el) => {
    const pick = (v) => (v && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, 80) : '');
    const label = pick(el.getAttribute('aria-label')) || pick(el.getAttribute('title'));
    if (label) return label;
    const txt = pick(el.textContent);
    return txt && txt.length <= 40 ? txt : '';   // own short text is a label; a long blob is a card
  };
  const hasPointerAncestor = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).cursor === 'pointer') return true;
    }
    return false;
  };
  let rolelessN = 0;
  let scanned = 0;
  for (const el of document.querySelectorAll('*')) {
    if (rolelessN >= ROLELESS_CAP || ++scanned > SCAN_CAP) break;
    if (seen.has(el)) continue;
    if (getComputedStyle(el).cursor !== 'pointer') continue;   // the click-affordance signal
    const nm = shortName(el);
    if (!nm) continue;                                         // unnamed → cannot danger-judge → skip
    if (el.querySelector(SEL)) continue;                       // wrapper of a real control → skip
    if (hasPointerAncestor(el)) continue;                      // inner icon/span of an outer clickable
    seen.add(el);
    rolelessN++;
    elements.push({
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: nm,
      templateSelector: buildPath(el, false),
      instanceSelector: buildPath(el, true),
      instanceKey: rowKey(el),
      visible: isVisible(el),
      inRow: inRowOf(el),
      inNav: inNavOf(el),
      _tid: testidOf(el),
      _sid: stableIdForLocator(el.id) ? el.id : null,
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

  // Locator classification (the durable handle Phase-2 should prefer). A test-id is a
  // usable IDENTITY handle only when its value is scoped to ONE template; the uniqueness
  // gate (page-unique → unique instance discriminator; shared across a template's rows →
  // template MARKER, non-unique; spanning MULTIPLE templates → unusable, fall through). The
  // ladder then falls to a strictly-stable #id, else role+name, else the css instanceSelector.
  // NOTE: `unique` reflects THIS snapshot's page state; mergeSnapshot does not rewrite an
  // instance's locator on a later merge, so a test-id first seen unique stays flagged unique
  // even if more rows sharing it appear later. Phase-2 treats `unique` as a first-observation
  // hint, not a live guarantee — verify uniqueness at generation time before relying on it.
  const pageCount = Object.create(null);       // testid value -> occurrences page-wide
  const valTemplates = Object.create(null);    // testid value -> Set of templateSelectors
  for (const e of elements) {
    if (!e._tid) continue;
    const v = e._tid.value;
    pageCount[v] = (pageCount[v] || 0) + 1;
    (valTemplates[v] || (valTemplates[v] = new Set())).add(e.templateSelector);
  }
  for (const e of elements) {
    if (e._tid && valTemplates[e._tid.value].size === 1) {
      e.locator = { type: 'testid', attr: e._tid.attr, value: e._tid.value, unique: pageCount[e._tid.value] === 1 };
    } else if (e._sid) {
      e.locator = { type: 'id', value: '#' + CSS.escape(e._sid) };
    } else if (e.name && e.role && e.role !== 'generic') {
      e.locator = { type: 'role-name', role: e.role, name: e.name };
    } else {
      e.locator = { type: 'css', value: e.instanceSelector };
    }
    delete e._tid; delete e._sid;
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
