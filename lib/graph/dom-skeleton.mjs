// dom-skeleton — a SCHEMATIC picture of the rendered page instead of a screenshot: one
// page.evaluate returning a flat, columnar description of the DOM tree (tag/id/class/role/name
// + rect + visibility per node), so a FAILED act still leaves evidence of what the crawler
// could see.
//
// WHY, AND WHY THE OBVIOUS CAPTURE POINT IS WRONG. Measured on run raw1 (287 acts): key-frames
// exist on 140 of 141 SUCCESSFUL acts and 0 of 146 FAILURES — structural, not sampling. Every
// pre-click gate in step.mjs (DANGER_FLOOR / NOT_VISIBLE / NO_INSTANCE / DISABLED) throws BEFORE
// `capture.before`, and the reveal failures (REVEAL_FIREWALL, REVEAL_HOP_MISSING) throw from
// applyReveal before the capture collaborator exists. So the half of the run an operator most
// needs to see has no evidence, and a skeleton taken where screenshots are taken would have
// covered ~8 of those 146.
//
// THIS MODULE IS THEREFORE DESIGNED TO BE CALLED FROM A CATCH BLOCK, where the failure is already
// known. Two consequences are load-bearing:
//   - IT MUST NEVER THROW. A capture that breaks the error path destroys the error it was meant to
//     explain, so every failure mode (page closed, navigation mid-evaluate, a hostile getter)
//     degrades to `null` — the caller carries a null ref as it already does for a frameless act.
//   - IT IS READ-ONLY DOM OBSERVATION. No click, scroll, navigation or request, and it never opens
//     a causal window, so it cannot forge a phantom edge. The call sites are idle-safe BY
//     CONSTRUCTION: pre-click throws precede beginCause and post-click throws follow resetCause,
//     so the cause token is `__idle__` at every one.
//
// IDENTITY SAFETY — the constraint everything else bends around. This is a SEPARATE module
// producing a PARALLEL artifact. Its output must never join dom-snapshot's `elements` array and
// must never reach graph-store.mergeSnapshot. It carries RECTS, which move on every scroll and
// resize; in the identity path it would churn templates exactly the way transient CSS-motion
// classes once did (148 phantom templates, decisions.md INC.4). The property is PROVEN by test
// (tests/live/dom-skeleton.test.mjs guard C: the graph stays byte-identical, the ledger unmoved
// and identity-diff ok across a capture AND a scroll), never merely asserted here.

// The node budget. Set by MEASUREMENT, not taste — at 1440x900 over three real pages:
//
//   page         DOM els  interactive  full tree  full KB  @400 KB  @1000 KB  SCREENSHOT KB
//   github         1824       319        1631       149       44       ~110        134
//   wikipedia      3061       813        2941       293       44       ~110        276
//   hacker news     818       230         810        64       30        ~64        234
//
// A node costs ~110 bytes on real markup (~77 on simple markup). Two things follow. FIRST, the
// artifact this replaces is a viewport PNG at 134-276 KB, so a ~110 KB skeleton is CHEAPER THAN
// THE SCREENSHOT IT STANDS IN FOR on every page measured, and a run already writes 140 of those
// on its successful half — byte cost is not the binding constraint. SECOND, 400 was too tight:
// controls score far above filler, so at 400 a wide page emits a LIST OF CONTROLS and almost no
// structure, and the graph already lists the controls. What a skeleton adds over `report` is the
// structure AROUND them (which control sat in which panel, row or modal) — and wikipedia's 813
// interactive elements would have eaten a 400 budget twice over, truncating controls themselves.
// 1000 keeps the whole interactive set plus its structure, still under the PNG, at ~100ms.
//
// Over-cap pages are truncated by SCORE (least informative dropped first) and the drop is always
// COUNTED in `truncated` — the project rule is that the denominator never collapses, so a silent
// drop is not an option. The cap is a parameter, not a law: captureSkeleton takes `{ cap }`.
export const SKELETON_NODE_CAP = 1000;

// A hung page must not stall the failure path this runs on.
const EVALUATE_TIMEOUT_MS = 5000;

// Runs entirely in the page; must be self-contained (no closure over module scope) — the cap is
// therefore PASSED IN, the same discipline dom-snapshot's collect() follows.
function collect(cap) {
  // VISIBILITY. The CANONICAL definition is dom-snapshot.mjs `isVisible` (~L213-218): Playwright
  // parity, where display:none / visibility:hidden hide, a zero-AREA box reads hidden, opacity:0
  // does NOT (it still has a box), and visibility inherits so an ancestor-hidden node reads hidden.
  // Restated rather than imported because that copy is a closure inside dom-snapshot's own
  // page.evaluate payload and is unreachable from here. Restating is how two definitions drift, so
  // the guard is a TEST, not this comment: tests/live/dom-skeleton.test.mjs (guard A) asserts the
  // two verdicts agree element-for-element over a fixture covering every branch. Divergence would
  // mean the skeleton disagrees with what the crawler considered visible — its whole point.
  const visOf = (el, r) => {
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    return r.width > 0 && r.height > 0;
  };

  // Elements carrying no visual or structural information; their SUBTREES are skipped too — an
  // icon's 40 <path> children describe nothing a viewer can use.
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD', 'TITLE', 'BASE', 'TEMPLATE']);
  const NO_DESCEND = new Set(['SVG']);           // describe the <svg>, never its geometry
  // The same interactive set dom-snapshot's SEL uses — a control is the most informative thing a
  // skeleton can show, so it outranks everything else under the cap.
  const INTERACTIVE = 'button, a[href], input, select, textarea, [role=button], [role=link], '
    + '[role=tab], [role=menuitem], [onclick], [tabindex]:not([tabindex="-1"])';
  const STRUCT = new Set(['NAV', 'HEADER', 'MAIN', 'FOOTER', 'ASIDE', 'SECTION', 'ARTICLE', 'FORM',
    'DIALOG', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'UL', 'OL', 'LI', 'LABEL', 'FIELDSET',
    'LEGEND', 'IMG', 'SVG', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

  // OWN text only — the direct text-node children. A container's textContent is the whole page
  // ("a card", the blob problem dom-snapshot's roleless pass guards against), which would make
  // every ancestor read as a leaf full of prose.
  const ownText = (el) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.replace(/\s+/g, ' ').trim();
  };
  const nameOf = (el, own) => {
    const pick = (v) => (v && v.trim() ? v.replace(/\s+/g, ' ').trim() : '');
    const v = pick(el.getAttribute('aria-label')) || own || pick(el.getAttribute('placeholder'))
      || pick(el.getAttribute('title')) || pick(el.getAttribute('alt'))
      || (el.tagName === 'INPUT' ? pick(el.getAttribute('value')) : '');
    return v.slice(0, 60);
  };

  // Precomputed once — `el.matches(INTERACTIVE)` per element over a large DOM is the expensive
  // way to ask the same question.
  let interactive;
  try { interactive = new Set(document.querySelectorAll(INTERACTIVE)); } catch { interactive = new Set(); }

  // INFORMATIVENESS. The cap must drop the least useful node, never the most useful, so the order
  // is explicit rather than incidental: control > landmark > identified > text-bearing > bare
  // layout div, with shallow structure edging out deep at equal weight. Visibility is deliberately
  // NOT scored — a NOT_VISIBLE failure is exactly when the hidden nodes are the interesting ones.
  const scoreOf = (el, d, own) => {
    let s = Math.max(0, 12 - d);
    if (interactive.has(el)) s += 40;
    if (STRUCT.has(el.tagName)) s += 25;
    if (el.hasAttribute('role')) s += 15;
    if (el.id) s += 12;
    if (el.hasAttribute('data-testid') || el.hasAttribute('data-test') || el.hasAttribute('data-qa')) s += 12;
    if (own) s += 8;
    return s;
  };

  // Walk. Enumeration is cheap (no style reads, no rects) so the whole tree is scored and the
  // expensive per-node work is deferred to the <=cap survivors. WALK_CAP is a runaway guard for a
  // pathological DOM; whatever it leaves unwalked is still counted in `truncated` below.
  const WALK_CAP = 20000;
  const seen = [];
  const walk = (el, d) => {
    if (SKIP.has(el.tagName) || seen.length >= WALK_CAP) return;
    seen.push({ el, d, own: ownText(el), i: seen.length });
    if (NO_DESCEND.has(el.tagName)) return;
    for (const k of el.children) walk(k, d + 1);
  };
  if (document.documentElement) walk(document.documentElement, 0);
  for (const s of seen) s.score = scoreOf(s.el, s.d, s.own);

  // THE DENOMINATOR. `describable` is every element the skeleton COULD have described — the whole
  // document minus the head/script/style noise and minus svg internals, both of which this format
  // deliberately never carries. truncated = describable - emitted, so it covers BOTH the score cap
  // and anything the walk guard left behind. Never a silent drop.
  let describable = 0;
  try {
    const total = document.getElementsByTagName('*').length;
    const noise = document.querySelectorAll('script,style,noscript,meta,link,title,base,template,head,svg *').length;
    describable = Math.max(0, total - noise);
  } catch { describable = seen.length; }

  // Rank, cap, then restore DOCUMENT ORDER — the emitted list must read top-to-bottom like the
  // page. Array.prototype.sort is stable, so equal scores keep document order.
  let kept = seen;
  if (seen.length > cap) {
    kept = seen.slice().sort((a, b) => b.score - a.score).slice(0, cap).sort((a, b) => a.i - b.i);
  }

  // `d` is the TRUE depth, not a re-indexed one. When the cap drops an intermediate node the depth
  // sequence jumps, and that jump is honest: it says a node between these two was not described.
  // Re-indexing would hide the drop, which is the one thing this format must not do.
  const nodes = [];
  for (const s of kept) {
    const el = s.el;
    let r;
    try { r = el.getBoundingClientRect(); } catch { r = { x: 0, y: 0, width: 0, height: 0 }; }
    const n = { d: s.d, tag: el.tagName.toLowerCase() };
    // CLASSES ARE KEPT RAW (first 3, length-capped) — including the transient motion/state tokens
    // dom-snapshot rejects from IDENTITY. Here they are diagnostics, not names: "it was mid
    // `ant-slide-up-leave` when the click timed out" is exactly what a failed act needs to say.
    const id = el.id || '';
    const cls = Array.from(el.classList).slice(0, 3).join(' ').slice(0, 60);
    const role = el.getAttribute('role') || '';
    const name = nameOf(el, s.own);
    if (id) n.id = String(id).slice(0, 60);
    if (cls) n.cls = cls;
    if (role) n.role = String(role).slice(0, 30);
    if (name) n.name = name;
    n.x = Math.round(r.x); n.y = Math.round(r.y);
    n.w = Math.round(r.width); n.h = Math.round(r.height);
    n.vis = visOf(el, r) ? 1 : 0;
    nodes.push(n);
  }

  // Rects are VIEWPORT-relative, matching makeCapture's `handle.boundingBox()` + `viewportSize()`
  // pair, so a viewer places a skeleton box the same way it places a screenshot's highlight box.
  return {
    v: 1,
    w: window.innerWidth || 0,
    h: window.innerHeight || 0,
    nodes,
    truncated: Math.max(0, describable - nodes.length),
  };
}

// Capture one skeleton. NEVER THROWS — returns null on a closed/navigating/hostile page, because
// this runs inside a catch block and must not replace the real error with its own.
export async function captureSkeleton(page, { cap = SKELETON_NODE_CAP } = {}) {
  if (!page || typeof page.evaluate !== 'function') return null;
  try {
    if (typeof page.isClosed === 'function' && page.isClosed()) return null;
  } catch { return null; }
  let timer = null;
  try {
    const evaluated = page.evaluate(collect, cap).catch(() => null);
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), EVALUATE_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();   // never hold the process open
    });
    const out = await Promise.race([evaluated, guard]);
    return out && Array.isArray(out.nodes) ? out : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
