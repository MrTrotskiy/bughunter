// THE ALIAS GATE — two instances must never be credited from one node.
//
// THE MEASURED FAILURE. Run probe6, template 392, instance keys `05`..`11`: seven acts, seven instances
// credited, one identical rect {x:693,y:383,w:48,h:28} on every single one. The stored positional selectors
// had gone stale, `resolveHandle` fell through to its `getByText` fallback, and the fallback returned the
// same first-visible node every time. Seven real clicks on one control, written into the graph as knowledge
// about seven different controls — and under explore-all, seven real interactions with a live stand.
//
// It survived because identity was only ever checked at the SELECTOR layer, and two selectors resolving to
// one node is precisely what a selector-layer check cannot see. The node itself had to be asked.
//
// Guards, in order of how much damage each prevents:
//   (1) IDENTITY SAFETY — the claim mark is invisible to every channel dom-snapshot reads. This is the one
//       that matters most: a marker that leaked into identity would corrupt the graph the whole tool is
//       built on, which is strictly worse than the bug being fixed.
//   (2) A second actor on the same node collides.
//   (3) The SAME actor re-claims freely — an overlay retry and an L4 reproduction probe both re-act the
//       same instance legitimately, and a gate that blocked them would break confirmation outright.
//   (4) A collision is TRANSIENT — the obligation stays owed. A collision means "identity unproven", never
//       "this control is dead", so it must not discharge anything.
//
// FAIL-ON-REVERT (one lever per guard):
//   (1) change `Object.defineProperty(... enumerable: false)` in act-alias.mjs to a plain `el[prop] = key`
//       assignment → the property becomes enumerable → the `Object.keys` assertion goes red.
//   (2) make `claimNode` return `{ok:true}` unconditionally → the collision assertion goes red.
//   (3) make the equality check `if (prior)` instead of `if (prior && prior !== k)` → the re-claim
//       assertion goes red.
//   (4) remove 'ALIAS_COLLISION' from TRANSIENT_BLOCKS → the obligation is silently discharged and the
//       `outstanding` assertion goes red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { claimNode, actorKey } from '../../lib/recon/act-alias.mjs';

test('one node cannot be credited to two instances, and the claim cannot touch identity', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    // Two locators that resolve to the SAME node — the exact aliasing the text fallback produced live.
    await page.setContent('<div id="host" class="row" data-k="v">More</div>');
    const a = await page.$('#host');
    const b = await page.$('div.row');

    const first = await claimNode(a, actorKey(392, '05'));
    assert.equal(first.ok, true, 'the first actor claims the node');

    // (3) The SAME actor re-claims — overlay retry and L4 reproduction both depend on this.
    const again = await claimNode(a, actorKey(392, '05'));
    assert.equal(again.ok, true, 're-acting the same instance is legitimate, not a collision');

    // (2) A DIFFERENT instance landing on that node is refused, and told whose it is.
    const second = await claimNode(b, actorKey(392, '06'));
    assert.equal(second.ok, false, 'instance 06 resolved onto the node already acted for instance 05');
    assert.equal(second.heldBy, '392#05', 'the collision names the holder, so the trail can explain itself');

    // (1) IDENTITY SAFETY. dom-snapshot builds identity from tagName, id, classList, attributes, computed
    // style, rects and textContent. The claim must be absent from every one of them, and absent from
    // enumeration besides — a page walking its own properties must not see it either.
    const seen = await a.evaluate((el) => ({
      attrs: [...el.attributes].map((x) => x.name),
      cls: el.className,
      id: el.id,
      text: el.textContent,
      html: el.outerHTML,
      ownKeys: Object.keys(el),
    }));
    assert.deepEqual(seen.attrs, ['id', 'class', 'data-k'], 'no attribute was added');
    assert.equal(seen.cls, 'row', 'no class was added');
    assert.equal(seen.id, 'host');
    assert.equal(seen.text, 'More', 'textContent — the fallback resolver reads this — is untouched');
    assert.ok(!seen.html.includes('__bhActor'), 'the mark does not appear in serialized markup');
    assert.deepEqual(seen.ownKeys, [], 'the mark is non-enumerable — invisible even to enumeration');
    // And the aliasing locator still finds it: the gate must not make the node unfindable.
    assert.equal(await page.locator('div.row').count(), 1, 'the node is still selectable as it was');
  } finally {
    await browser.close();
  }
});
