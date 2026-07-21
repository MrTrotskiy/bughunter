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

import { WIDGET_POPUP_SELECTOR } from './widget-popup.mjs';

// Runs entirely in the page; must be self-contained (no closure over module scope) — the widget-popup
// selector list is therefore PASSED IN as an argument rather than imported here.
function collect(widgetPopupSelector) {
  // `[tabindex="-1"]` is EXCLUDED. By definition it means "not in the tab order" — the attribute
  // frameworks put on focus-trap wrappers and scroll containers, not on controls. Including it captured
  // antd's `div.ant-modal-wrap` as an element in its own right, and since it wraps the whole dialog its
  // accessible name became the concatenation of everything inside it ("closeSchedule a Meeting
  // EventMeeting TitleEvent Type…"). Two costs, both measured: those blobs padded the denominator, and
  // CLICKING one is a click on the overlay itself — the source of the `ant-modal-wrap … subtree intercepts
  // pointer events` timeouts that killed all three Post Ad acts. A genuinely interactive element carries a
  // role, an onclick or a real tag, so it is still collected by one of the other branches.
  const SEL = 'button, a[href], input, select, textarea, [role=button], [role=link], '
    + '[role=tab], [role=menuitem], [onclick], [tabindex]:not([tabindex="-1"])';

  // Framework-generated wrapper ids (Ant Design/`rc-*`, Radix, Headless UI, MUI) and hashed
  // ids SHIFT across reloads and FRAGMENT one logical control into N per-instance templates
  // (each tab anchoring on its own `#rc-tabs-0-tab-N`), which also breaks the reset-and-replay
  // reveal chain that depends on a stable selector across reloads. So they must NEVER anchor a
  // selector path (INC.1; decisions.md 2026-07-15 "whole-site reach"). This same predicate also
  // gates the sole-`#id` locator below (stableIdForLocator) so a rejected id can't become a
  // brittle Phase-2 handle either. Prefix match is `<lib>` + `-`/`_` so a semantic id like
  // `#antarctica` (no dash) is never a false positive. NOTE: framework CLASSES (`ant-tabs-tab`)
  // are deliberately KEPT by isStableClass — they are the STABLE structural anchor we want.
  // CONTENT-KEYED IDS (INC.5). An id of the form `<word><digits>` / `<word>_<digits>` — `mulAnswer145`,
  // `groups_12`, `friends_3` — is a DATABASE PRIMARY KEY rendered into the DOM. Anchoring a selector on
  // one mints a NEW template per row, so the denominator grows with the CONTENT of the database rather
  // than with the app's surface: measured live, 50 templates across `#mulAnswer<N>`/`#groups_<N>`/
  // `#friends_<N>` were ONE control each, and 63 "unreachable" templates were duplicates of controls
  // already covered under a sibling id. Same defect class as INC.1 (framework ids) and INC.4 (motion
  // classes), one level over. A trailing digit run of 2+ is required so a genuine semantic id like `h1`
  // or `col2` is not swept up.
  const isContentKeyedId = (id) => /^[A-Za-z][A-Za-z]*[_-]?\d{2,}$/.test(id);
  const isFrameworkNoiseId = (id) => /^(?:rc|ant|radix|headlessui|mui)[-_]/i.test(id)
    || (/[0-9a-f]{6,}/i.test(id) && /\d/.test(id))   // hashed hex run carrying a digit
    || isContentKeyedId(id);
  const isGeneratedId = (id) => !id
    || /\d{4,}/.test(id)                       // long digit runs
    || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)    // uuid
    || /:r[0-9a-z]+:/i.test(id)                // react useId
    || isFrameworkNoiseId(id)                  // framework wrapper / hashed ids (INC.1)
    || id.length > 32;
  // TRANSIENT MOTION CLASSES (INC.4) — the animation-state tokens a CSS-transition library puts on an
  // element for the ~200-300ms of a transition: AntD/rc-motion `ant-slide-up-leave`, `ant-zoom-appear`,
  // `ant-fade-leave-start`, and the `-enter`/`-leave`/`-appear` (+`-start`/`-active`/`-prepare`) family
  // generally. Anchoring a selector on one produces a path that only matches MID-TRANSITION: the reveal
  // replay reopens a portal, the element resolves while the class is still on, and by the time the click's
  // actionability loop runs AntD has finished the transition to `ant-dropdown-hidden`/display:none — so the
  // click waits out its full timeout on an element that no longer exists. Measured live on the first target: 89 of
  // 475 templates were anchored on such a token, 96 of 195 unreachable templates were touched by one, and
  // 44 selector groups were pure duplicates of each other differing only by animation phase.
  //
  // This is the INC.1 defect one level over: `isFrameworkNoiseId` fixed transient framework IDs; transient
  // framework CLASSES were never covered. SETTLED state classes (`ant-tabs-tab-active`, `ant-dropdown-hidden`)
  // are deliberately KEPT — they describe what the UI IS, not a transition it is passing through.
  const isMotionClass = (c) => /-(?:enter|leave|appear)(?:-start|-active|-prepare|-end|-done)?$/.test(c)
    || /^(?:ant|rc)-(?:zoom|fade|slide|motion|collapse)(?:-|$)/.test(c);
  // INTERACTION-STATE CLASSES (INC.6) — the same defect class as INC.1/4/5, found by the CTO review after
  // drain1: a class that reflects the control's CURRENT interaction state, not its structure. The decisive
  // case is self-inflicted — our own form fill makes antd add `ant-form-item-has-success`, so the SAME
  // "Full Name" field existed as two templates: `#normal_login_name` before we typed and
  // `#normal_login > div.ant-form-item.ant-form-item-has-success > …` after. The crawler was inflating its
  // own denominator by acting. Also covers -open/-active/-checked/-focused/-disabled, which flip as the
  // user drives the UI. Structural framework classes (`ant-tabs-tab`, `ant-modal-content`) stay KEPT —
  // they are the anchor we want; only the state suffixes are rejected.
  // `-dragged`/`-dragging` (react-draggable, react-dnd) are the same defect one library over: a draggable
  // control acquires `react-draggable-dragged` AFTER it is first dragged, so `div.react-draggable` (never
  // dragged) and `div.react-draggable.react-draggable-dragged` (dragged once) fragmented into TWO templates
  // for ONE control — measured on the live target as ALIAS_COLLISION failures (tpl 1066 colliding onto tpl
  // 41, same node, different post-drag class). The structural `react-draggable` anchor is KEPT — the suffix
  // rule only rejects the `-dragged`/`-dragging` STATE token, never the base class.
  const isStateClass = (c) => /-(?:has-success|has-error|has-warning|has-feedback|focused|open|active|selected|checked|disabled|expanded|collapsed|loading|hover|pressed|dragged|dragging)$/.test(c)
    || /-status-(?:success|error|warning)$/.test(c);
  const isStableClass = (c) => !!c && !/\d/.test(c) && !/^(?:ng|css|sc|jsx|_)-/.test(c)
    && c.length <= 32 && !isMotionClass(c) && !isStateClass(c);

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
  // TAB/MENU authoring patterns and NO <nav> element (the first target's Groups/Events are `div[role=tab]` in a
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

  // PORTAL-MENU IDENTITY (INC.2; decisions.md 2026-07-18 "portal-menu identity"). A body-portal dropdown
  // menu — Ant Design `.ant-dropdown-menu-item`, and the same pattern in Radix/MUI/HeadlessUI — mounts its
  // items into a BARE div appended to <body>, DETACHED from the trigger. buildPath(el,false) then emits the
  // IDENTICAL structural templateSelector (`…ul.ant-dropdown-menu-root > li.ant-dropdown-menu-item`) for
  // EVERY action, and rowKey() returns null (a menuitem li has no li/tr/[role=row] row ancestor) so the
  // instanceKey falls to the open-order `#N`. Result (measured live on the first target): Delete/Edit/Share/Block/
  // Report/Become-a-Fan/… ALL collapse onto ONE template, and different actions from different triggers
  // COLLIDE on the same `#N` (Share-Link#1 == Live-events#1) — mergeSnapshot's key-dedup then DROPS the
  // second, so the connectome (the template→endpoint map, the Phase-2 product) lumps 6 endpoints on one
  // node and loses reveal paths. The fix folds the menuitem's NAME into the TEMPLATE selector only, so each
  // action is its own template (distinct edges) and — because the `#N` group counter keys on templateSelector
  // — its own `#1` instance (collision gone). instanceSelector is UNTOUCHED (it is a live `page.$` query
  // arg; the fold is identity-only, verified no consumer queries templateSelector), so resolveHandle's stale-
  // selector → durable role-name fallback still reaches the item once its trigger re-opens the dropdown.

  // The bare <body>-child portal wrapper an element is mounted under, else null. Walk to the ancestor whose
  // parent IS <body>; a real portal wrapper is class/id-less (the app root carries an id like #main-container
  // and landmarks are nav/header/…), so those are excluded — scoping the re-key to genuine detached portals.
  const bodyPortalRoot = (el) => {
    let p = el;
    while (p && p.parentElement && p.parentElement !== document.body) p = p.parentElement;
    if (!p || p.parentElement !== document.body) return null;
    if (p.id || p.matches('nav,header,footer,main,[role=main],[role=banner],[role=navigation]')) return null;
    return p;
  };
  // A menu control detached into a body-level portal AND lacking a row discriminator — the collapse case.
  const isPortalMenuItem = (el) => {
    if (el.getAttribute('role') !== 'menuitem' && !el.closest('[role=menu],[role=menubar],[class*=dropdown-menu]')) return false;
    if (rowKey(el) !== null) return false;                 // already has a stable row key — not the collapse
    return bodyPortalRoot(el) !== null;
  };
  // FIELD FACTS — the free half of white-box knowledge, and the point of Phase 1.
  //
  // Phase 1 exists to turn a black box into a white one: for every control, what it is and what it does;
  // for every field, what it accepts and what it refuses. A large part of that is DECLARED IN THE DOM and
  // costs nothing to read — maxlength, required, pattern, min/max/step, type, readonly, disabled, the
  // associated label, the described-by hint. We were never collecting any of it, and instead inferred
  // field semantics by typing into things and watching what broke.
  //
  // Measured on the live Create Event form: "Meeting Title" declares maxLength 50, "Event Type" is a
  // readonly select (value comes from a list, never typed), Date/Time are pickers. That is four facts
  // about four fields obtained without a single interaction.
  //
  // ADDITIVE and NEVER an identity input — the same class as visible/inRow/inNav/inWidgetPopup. It is
  // knowledge about the element, not a way of naming it. `required` also consults AntD's own markup
  // (`.ant-form-item-required`), because the framework marks requiredness on the wrapper rather than the
  // input, so the native attribute alone reports false on a genuinely required field.
  const fieldFactsOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return null;
    const item = el.closest('.ant-form-item');
    const labelled = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || (item && item.querySelector('label'));
    const describedId = el.getAttribute('aria-describedby');
    const described = describedId && document.getElementById(describedId);
    const num = (v) => (Number.isFinite(v) && v > 0 ? v : null);
    return {
      kind: el.closest('.ant-select') ? 'select' : el.closest('.ant-picker') ? 'picker'
        : el.closest('.ant-upload') ? 'upload' : tag === 'select' ? 'native-select' : (el.type || 'text'),
      label: ((labelled && labelled.innerText) || el.getAttribute('aria-label') || '').trim().slice(0, 60) || null,
      placeholder: el.placeholder || null,
      // AntD renders `rules:[{required:true}]` as a class on the field's <label>
      // (`.ant-form-item-required`, inside `.ant-form-item-label`) — NEVER on the `.ant-form-item`
      // CONTAINER and NEVER as a native attribute on the input. Reading `item.classList` (the container)
      // therefore reported false on every genuinely-required AntD field: measured 0/70 on the live target
      // (all requiredness is wrapper-marked there), so the whole `fill-empty` obligation went un-owed.
      // Query the label the framework actually marks.
      required: el.required || el.getAttribute('aria-required') === 'true'
        || !!(item && item.querySelector('label.ant-form-item-required')) || null,
      maxLength: num(el.maxLength),
      minLength: num(el.minLength),
      pattern: el.pattern || null,
      min: el.min || null,
      max: el.max || null,
      step: el.step || null,
      // STATE, NOT DECLARATION — and reported as an EXPLICIT BOOLEAN, never `|| null`. Everything else
      // here is a declaration whose absence is genuinely "nothing declared", so `null` is the honest
      // reading and graph-store's write-once merge skips it. `disabled` / `readOnly` are live IDL
      // properties: `false` is a REAL observation ("this control is operable right now"), and collapsing
      // it to `null` made it unrepresentable — the merge skipped it, so a control seen disabled once
      // could never be re-read as enabled. See graph-store.FIELD_STATE_KEYS for the full split.
      readOnly: !!el.readOnly,
      disabled: !!el.disabled,
      inputMode: el.inputMode || null,
      hint: ((described && described.innerText) || '').trim().slice(0, 80) || null,
      options: tag === 'select' ? el.options.length : null,
    };
  };
  // WIDGET CHROME. A framework widget renders its panel as a body portal — a date picker's month/year/decade
  // switchers, a select's option list. Those are not application surface: nobody "covers" `Choose a decade`,
  // they pick a date. Left in the frontier they are a coverage obligation that can never be satisfied
  // (measured: 55 templates, 17% of the graph, ZERO requests ever fired) and, because each switcher opens a
  // deeper panel, an unbounded depth-first descent generator under recency-first ordering.
  //
  // ROLE IS CHECKED FIRST, container second, and the order is load-bearing. A portal MENU item — a row's
  // Edit/Delete/Share, which INC.2 exists to address — is genuine surface and must never be excluded. On the
  // live graph the two sets have ZERO role overlap across 84 templates: chrome is button/generic, portal
  // menus are menuitem/menu. That discriminator is the ARIA authoring pattern and does generalise; the
  // container list does not, and fails OPEN (an unrecognised widget stays a coverage obligation).
  const inWidgetPopupOf = (el) => {
    if (!widgetPopupSelector) return false;
    if (el.getAttribute('role') === 'menuitem') return false;
    if (el.closest('[role=menu],[role=menubar],[class*=dropdown-menu]')) return false;
    return el.closest(widgetPopupSelector) !== null;
  };
  // The stable per-action discriminator for a portal menuitem: a semantic-enum `value`, else aria-label,
  // else own text with a trailing count/badge stripped ("Save Item (12)" → "Save Item"), lower-cased.
  // Capped at 40 chars — a longer label is content, not a label, so DON'T fold (honest under-fragmentation
  // beats a per-render template explosion); returns null → the caller appends nothing (stays collapsed).
  const menuAction = (el) => {
    const val = el.getAttribute('value');
    if (val && /^[A-Z_][A-Z0-9_]*$/.test(val)) return val.toLowerCase();
    const aria = el.getAttribute('aria-label');
    let raw = (aria && aria.trim() ? aria : (el.textContent || ''))
      .replace(/\s+/g, ' ').trim()
      .replace(/\s*[([]\s*[\d.,\s]+\s*[)\]]\s*$/, '')     // trailing "(12)" / "[3]" badge
      .replace(/\s+\d+$/, '')                             // trailing bare count
      .trim();
    if (!raw || raw.length > 40) return null;
    return raw.toLowerCase();
  };
  // The TEMPLATE identity string (buildPath template) plus, for a portal menuitem, a synthetic ` @menu(<action>)`
  // suffix. The suffix is deliberately NON-CSS (`@menu(` cannot appear in a selector) so it can never be mistaken
  // for a live query — templateSelector is an identity key only. Non-portal elements are byte-identical (zero churn).
  const templateSelectorOf = (el) => {
    const base = buildPath(el, false);
    if (!isPortalMenuItem(el)) return base;
    const action = menuAction(el);
    return action ? `${base} @menu(${action})` : base;
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
      templateSelector: templateSelectorOf(el),
      instanceSelector: buildPath(el, true),
      instanceKey: rowKey(el),
      visible: isVisible(el),                                   // approx Playwright isVisible; drives the reveal fill, NEVER identity
      inRow: inRowOf(el),                                       // sits in a list-row ancestor; drives DRILL_PER_LIST, NEVER identity
      inNav: inNavOf(el),                                       // sits in a nav landmark; drives the menu-event sweep priority, NEVER identity
      inWidgetPopup: inWidgetPopupOf(el),                       // widget chrome (picker/select panel); kept OUT of the frontier, NEVER identity
      fieldFacts: fieldFactsOf(el),                             // declared field constraints (what it accepts); knowledge, NEVER identity
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
    if (txt && txt.length <= 40) return txt;     // own short text is a label; a long blob is a card
    // ICON-ONLY CONTROLS. A chat/call/edit affordance is often a bare <img alt="video call"> or an
    // <svg>/<i> with NO text at all, so every check above returns '' and the control is dropped — it can
    // never be danger-judged, so it is honestly uncaptured. Measured live on the first target: 16 visible
    // chat/audio-call/video-call controls next to each connection, plus the profile edit pencils, were
    // structurally invisible to the crawler for exactly this reason — an entire class of functionality
    // (message someone, call someone, edit your profile) that no crawl could ever reach.
    // Recover a name from, in order: a child <img alt>, an <svg><title>, or a ligature-style icon-font
    // class (`.material-icons` renders its text as the glyph name, e.g. "person_add").
    const img = el.querySelector('img[alt]');
    const alt = img && pick(img.getAttribute('alt'));
    if (alt && alt.length <= 40) return alt;
    const svgTitle = el.querySelector('svg > title');
    const st = svgTitle && pick(svgTitle.textContent);
    if (st && st.length <= 40) return st;
    // A class token that names the icon (`icon-chat`, `Connections_chat__qgMbX`) — last resort, and only
    // when it is descriptive enough to judge. Framework-hashed suffixes are stripped.
    for (const c of el.classList) {
      const m = /(?:^|[_-])(chat|message|call|video|audio|edit|delete|share|add|search|send|close|menu)(?:[_-]|$)/i.exec(c);
      if (m) return m[1].toLowerCase();
    }
    return '';
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
      templateSelector: templateSelectorOf(el),
      instanceSelector: buildPath(el, true),
      instanceKey: rowKey(el),
      visible: isVisible(el),
      inRow: inRowOf(el),
      inNav: inNavOf(el),
      _tid: testidOf(el),
      _sid: stableIdForLocator(el.id) ? el.id : null,
    });
  }

  // DRILL ROWS — the clickable table row / list item, and the reason no detail page was ever opened.
  //
  // MEASURED on the live target: 64 `<Link>` against 57 programmatic `navigate()`, and EVERY detail route
  // (`/<entity>/$id` and its siblings — including the richest page in the app at 321
  // controls) is reachable ONLY by clicking a row whose handler calls navigate(). Across every run to date
  // those pages were never opened, and the row is why: it fails the roleless pass on BOTH of its gates.
  //   (a) NAME — a row's text is its whole record ("Albert Huel Engineering albert.huel@… 2024-03-01"),
  //       far past the 40-char label bound, so `shortName` returns '' and it is dropped as "a card".
  //   (b) WRAPPER — a row almost always contains its own Edit/Delete buttons, so `el.querySelector(SEL)`
  //       matches and it is dropped as the wrapper of a real control.
  // Both gates are RIGHT for an arbitrary pointer div and WRONG for a row: the row is a control in its own
  // right (it navigates), independently of the buttons inside it.
  // So rows get their own pass, with the name taken from the LEADING CELL — which is what a row is called
  // in the UI and a safe thing to hand the danger floor (a person's name, a project title).
  // Bounded like the roleless pass. Rows of one table share a template and carry `inRow`, so `listRow`
  // makes the frontier walk ONE representative and count the rest in drillSkipped — 50 rows do not become
  // 50 obligations, they become one drill that proves the detail template exists.
  const ROW_SEL = 'tr, [role=row], li, [role=listitem]';
  const ROW_CAP = 40;
  let rowsN = 0;
  for (const el of document.querySelectorAll(ROW_SEL)) {
    if (rowsN >= ROW_CAP) break;
    if (seen.has(el)) continue;
    if (getComputedStyle(el).cursor !== 'pointer') continue;  // same click-affordance signal as roleless
    if (hasPointerAncestor(el)) continue;                     // inner row of an outer clickable
    // The leading cell names the row. Fall back to the row's own text, still bounded, so a list item with
    // no cell structure (a plain <li>) is still nameable.
    const cell = el.querySelector('td, th, [role=cell], [role=gridcell]');
    const raw = ((cell || el).textContent || '').replace(/\s+/g, ' ').trim();
    const nm = raw.slice(0, 40);
    if (!nm) continue;                                        // unnamed → cannot danger-judge → skip
    seen.add(el);
    rowsN++;
    elements.push({
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: nm,
      templateSelector: templateSelectorOf(el),
      instanceSelector: buildPath(el, true),
      instanceKey: rowKey(el),
      visible: isVisible(el),
      inRow: true,          // it IS the row — drives node.listRow, hence one walked representative
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
    // KEEP THE AUTHORED TESTID as an additive fact, ADDITIVE ONLY — never an identity input, exactly like
    // `visible` / `inRow` / `inNav` / `fieldFacts`. It was read here already and then discarded whenever it
    // failed the sole-locator uniqueness gate, which threw away the single most useful thing the author
    // told us: which controls they consider THE SAME and which DIFFERENT.
    //
    // That distinction is not decorative. Measured on a headless-component-library target: one settings page renders seven
    // different sections — `settings-category-general`, `-access_control`, `-absences`, `-ai` and so on —
    // through ONE template, because every `<Button>` there produces an identical CSS path. The template
    // abstraction is right for fifty identical table rows and wrong here, and without the authored id there
    // is nothing in the DOM that tells the two cases apart.
    // `_tid` is `{attr, value}` — the VALUE is the authored id. Writing the object here made every consumer
    // read `"[object Object]"`: the frontier's authored-site split collapsed to one key for every instance
    // (so it did nothing), and the ground-truth scorer intersected ZERO of 1167 answer-key ids. Both were
    // shipped green, because their tests build fixtures with a plain string — the exact shape of "a green
    // test on a fixture says nothing about whether the crawl collects data".
    if (e._tid && e._tid.value) e.testid = String(e._tid.value);
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
  return await page.evaluate(collect, WIDGET_POPUP_SELECTOR);
}

// contentSig — a text-free, attribute-free STRUCTURAL digest of the rendered page, for the honest
// denominator (GOAL 1 client-404 detection). A constant-URL SPA renders a shared Not-Found component
// under an unchanged 200 URL for a phantom route; its structure is IDENTICAL to a synthetic
// negative-control probe (route-frontier.probeNotFound), so route-coverage can label it client-404.
//
// REPORTING-ONLY, NEVER AN IDENTITY INPUT — same discipline as the additive `visible`/`inRow`/`inNav`
// element fields: it is written to a graph.routes NODE, never fed to ids.mjs / templateId / instanceKey
// / reqKey / edges, never seen by identity-diff.mjs. Deliberately NOT the deferred graph.states{}
// stateKey (a real second identity, rejected thrice in decisions.md) — this is a route-node hint.
//
// Text-free + attribute-free (only tag name + depth + child-count) so two REAL sections with different
// tag structure never collide, while the shared dead shell always does; SHELL LANDMARKS are dropped
// (nav/header/footer + their ARIA roles) so a route-reactive active-nav highlight or breadcrumb does
// not desync two dead routes. FNV-1a → a compact stable hex digest.
export async function contentSig(page) {
  return await page.evaluate(() => {
    if (!document.body) return '0';
    const isShell = (el) => el.matches('nav,header,footer,[role=navigation],[role=banner],[role=contentinfo]');
    const SKIP = new Set(['SCRIPT', 'STYLE', 'SVG', 'NOSCRIPT']);
    const parts = [];
    const walk = (el, d) => {
      if (d > 40 || isShell(el)) return;                                  // depth-bounded; shell chrome excluded
      const kids = [...el.children].filter((k) => !SKIP.has(k.tagName.toUpperCase()));
      parts.push(d + el.tagName + '(' + kids.length + ')');               // tag + depth + child-count; NO text/attr
      for (const k of kids) walk(k, d + 1);
    };
    walk(document.body, 0);
    let h = 0x811c9dc5;                                                    // FNV-1a 32-bit offset basis
    const s = parts.join('|');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16);
  });
}
