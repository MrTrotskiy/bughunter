// pick-diagnose — WHY the selector refused a candidate.
//
// WHY THIS MODULE EXISTS. `resolveHandle` answers one bit: a live handle, or null. `pickLive` scanned
// every candidate on the route, dropped the ones that answered null, and — when they ALL answered null —
// returned `null`, which the driver stamped `drained`: "this page owes nothing".
//
// MEASURED, on one page of a live run: 332 control instances, 141 acted, and **107 of the untouched ones
// carried no reveal path at all** — controls sitting on the page, clickable in principle, present in the
// graph since the FIRST HALF of the run. They produced ZERO lines of trail between them. Not a skip, not
// a reason, nothing. The run's own log said the route was drained while a third of it had never been
// touched, and no consumer of that log could have known: the refusals were never written down.
//
// That is a LOG defect before it is a reach defect (CLAUDE.md: if a log cannot answer "where was it, what
// did it do, how, and why did that fail", REWRITE THE LOG). So: this module turns a null into a REASON,
// and the driver records the census.
//
// PURE OBSERVATION. No click, no causal window, no graph write, never throws. It re-asks the DOM the same
// questions `resolveHandle` asked and reports which one failed — it does not re-implement the ladder, and
// its verdict is advisory: the authority on reachability stays `resolveHandle`.
//
// COST DISCIPLINE. Only ever called on the DRY path — when the whole scan came up empty — and bounded by
// the caller. A diagnosis that ran per-candidate per-pick would add a DOM round-trip to the hot loop for
// information nobody reads while the crawl is making progress.

const CAP = 40; // per dry scan; the census stays honest about what it did not inspect

// Does anything match, and is any match visible? Two separate facts — "gone" and "there but hidden" are
// different defects with different fixes, and collapsing them is what made the old null useless.
async function probe(page, selector) {
  if (!selector) return { matched: 0, visible: 0 };
  try {
    return await page.evaluate((sel) => {
      let els = [];
      try { els = Array.from(document.querySelectorAll(sel)); } catch { return { matched: -1, visible: -1 }; }
      const vis = els.filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      });
      return { matched: els.length, visible: vis.length };
    }, selector);
  } catch { return { matched: 0, visible: 0 }; }
}

// The durable locator as a css selector, mirroring resolve-handle's ladder. Returns null for role-name,
// which has no css form — that absence is itself a reported reason (`role-name-only`).
function durableSelector(loc) {
  if (!loc) return null;
  if (loc.type === 'testid' && loc.attr && loc.value) return `[${loc.attr}="${loc.value}"]`;
  if (loc.type === 'id' && loc.value) return loc.value;
  if (loc.type === 'css' && loc.value) return loc.value;
  return null;
}

// diagnose(page, inst, node) → reason string. One of:
//   'hidden-positional'  the stored selector matches, but nothing it matches is visible
//   'hidden-durable'     the durable locator matches, but nothing it matches is visible
//   'stale-positional'   the stored selector matches nothing; no durable locator to fall back to
//   'absent'             neither the stored selector nor the durable locator matches anything
//   'role-name-only'     no css-expressible locator; reachability rests on a role+name search that failed
//   'bad-selector'       the stored selector is not valid css (a graph defect, not a page one)
export async function diagnose(page, inst, node) {
  const positional = (inst && inst.instanceSelector) || null;
  const durable = durableSelector((inst && inst.locator) || null);

  const p = await probe(page, positional);
  if (p.matched === -1) return 'bad-selector';
  if (p.visible > 0) return 'resolved-since';     // it resolves NOW — the scan and the diagnosis disagree
  const d = durable ? await probe(page, durable) : { matched: 0, visible: 0 };
  if (d.visible > 0) return 'resolved-since';

  if (p.matched > 0) return 'hidden-positional';
  if (d.matched > 0) return 'hidden-durable';
  if (!durable) {
    const loc = (inst && inst.locator) || null;
    if (loc && loc.type === 'role-name') return 'role-name-only';
    if (positional) return 'stale-positional';
  }
  return 'absent';
}

// census(page, rejected) → { inspected, skipped, reasons:{reason:count}, samples:[{name,reason}] }
//
// `rejected` is the ordered list the scan discarded. Bounded by CAP and HONEST about the remainder:
// a census that silently truncated would recreate the defect it exists to fix, one level up.
// `seen` is a CALLER-OWNED set of `templateId::instanceKey` carried across the whole run. Without it every
// dry scan re-diagnoses the same candidates and a consumer summing the trail multiplies them: I reported
// "360 absent controls" from eleven censuses of the SAME ~37 instances, a tenfold inflation, and the
// project's own rule is that a headline number gets audited before it is quoted. An event that cannot be
// summed without double-counting is a defect in the event, not in the reader — so each row now carries
// whether this is the FIRST time that instance was refused.
export async function census(page, rejected, { cap = CAP, seen = null } = {}) {
  const reasons = {};
  const firstTimeReasons = {};
  const samples = [];
  let repeats = 0;
  const take = rejected.slice(0, cap);
  for (const r of take) {
    const id = `${r.node?.templateId}::${r.instanceKey ?? ''}`;
    const first = !seen || !seen.has(id);
    if (seen) seen.add(id);
    const reason = await diagnose(page, r.instance, r.node).catch(() => 'diagnose-failed');
    reasons[reason] = (reasons[reason] || 0) + 1;
    if (first) firstTimeReasons[reason] = (firstTimeReasons[reason] || 0) + 1; else repeats++;
    if (first && samples.length < 8) samples.push({ name: (r.name || r.instanceKey || '').slice(0, 60), reason });
  }
  return {
    inspected: take.length,
    skipped: Math.max(0, rejected.length - take.length),
    reasons,               // this scan, as observed
    firstTimeReasons,      // SUMMABLE across the run — distinct instances only
    repeats,               // how much of this scan was already diagnosed earlier
    samples,
  };
}
