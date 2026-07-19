// A REVEAL THAT MOUNTS LATE IS STILL A REVEAL.
//
// THE MEASURED FAILURE, which read as a finding rather than a bug and so survived. Run probe10: 17 of the 25
// elements stuck at L2 were `role=generic` divs verdicted `inert`, led by `more_horiz` and `expand_less` —
// AntD overflow and collapse triggers, about the last controls on a page that are genuinely dead. Measured
// live on the target: 925 DOM nodes and 0 dropdowns before the click, 925 and 0 IMMEDIATELY after, 942 and 2
// after 700ms. The control opened a 17-node menu every single time and the crawl filed it as dead surface,
// because the post-act snapshot ran before the menu existed.
//
// WHY THE EXISTING SIGNALS BOTH MISS IT, and this is the whole reason for a third mechanism:
//   - `waitSettled` waits for the NETWORK; the menu mounts from client state and issues no request.
//   - `settleAnimations` was tried here FIRST and measured returning `true` after ONE millisecond with zero
//     dropdowns present — nothing is animating at that instant because the element that will animate has
//     not mounted. "Is anything animating" asked the moment before anything mounts always answers no.
//
// Guards:
//   (1) A panel that mounts on a delay IS present by the time settleDom returns — the reveal is observable.
//   (2) It reports `true` (settled) rather than merely timing out, so a caller can tell quiet from busy.
//   (3) A page that never stops changing returns `false` at the deadline instead of hanging — the crawl
//       must not stall on a spinner or an infinite feed.
//   (4) TEXT CHURN IS NOT A CHANGE: a page whose text updates constantly (a clock, a counter, a live feed)
//       still settles. A text-sensitive digest would report "still changing" forever on any real app, which
//       is why the digest is structural — the same reasoning as `contentSig` and `domFingerprint`.
//
// FAIL-ON-REVERT:
//   (1) set `stableFor = 1` so a single repeat counts as settled → the poll returns during the gap before
//       the panel mounts → "the late panel is present" goes red.
//   (4) add `document.body.innerText.length` to the digest → the ticking page never repeats → "a page whose
//       text churns still settles" goes red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { settleDom } from '../../lib/browser/dom-settle.mjs';

test('a panel that mounts late is present by the time the page reads settled', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    // The measured shape: a click that mounts a menu ~400ms later, with NO network involved and — for the
    // first instants — nothing animating either.
    await page.setContent(`
      <button id="open">more_horiz</button>
      <script>
        document.getElementById('open').addEventListener('click', function () {
          setTimeout(function () {
            var m = document.createElement('div');
            m.setAttribute('role', 'menu');
            m.innerHTML = '<div role="menuitem">Edit</div><div role="menuitem">Delete</div>';
            document.body.appendChild(m);
          }, 400);
        });
      </script>`);

    await page.click('#open');
    // Snapshotting HERE is what the crawl used to do, and it is the bug: nothing is there yet.
    assert.equal(await page.locator('[role=menu]').count(), 0,
      'the menu genuinely is not present immediately after the click — the failure is real, not hypothetical');

    const verdict = await settleDom(page);
    assert.equal(verdict, true, 'the page reports SETTLED, not merely timed out');
    assert.equal(await page.locator('[role=menu]').count(), 1,
      'and the revealed menu is present — the act is a reveal, not inert surface');
    assert.equal(await page.locator('[role=menuitem]').count(), 2, 'with its items, which the snapshot will now see');
  } finally {
    await browser.close();
  }
});

test('a page that never stops changing is reported busy, never hung', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    // (3) A perpetual spinner adding nodes forever. The crawl must move on, not wait for a page that will
    // never be quiet.
    await page.setContent(`<div id="host"></div>
      <script>setInterval(function () {
        document.getElementById('host').appendChild(document.createElement('span'));
      }, 40);</script>`);

    const t0 = Date.now();
    const verdict = await settleDom(page, { timeout: 600 });
    const waited = Date.now() - t0;
    assert.equal(verdict, false, 'still changing at the deadline is FALSE — distinct from settled and from unknown');
    assert.ok(waited < 2000, `and it returned at its deadline (${waited}ms), rather than hanging the crawl`);
  } finally {
    await browser.close();
  }
});

test('a page whose text churns still settles — the digest is structural', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    // (4) A clock. The STRUCTURE is quiet; only the characters change. Every real app has one of these
    // somewhere, and a text-sensitive digest would make every act on every such page read "still changing".
    // The text must vary in LENGTH as well as content, or a digest that naively hashes `innerText.length`
    // would pass this test while still being text-sensitive — the first version of this test did exactly
    // that and stayed green through the revert, which made it worthless as a guard.
    await page.setContent(`<div id="clock">0</div>
      <script>var n = 0; setInterval(function () {
        n++;
        document.getElementById('clock').textContent = 'tick '.repeat(n % 7) + n;
      }, 30);</script>`);

    assert.equal(await settleDom(page, { timeout: 1500 }), true,
      'text churn is not structural change — otherwise no page with a counter could ever be snapshotted');
  } finally {
    await browser.close();
  }
});
