// THE OVERLAY CLOSER MUST NOT BE SHAPED LIKE ONE FRAMEWORK.
//
// THE MEASURED FAILURE, and it is the first time this tool met a second application. Every overlay
// mechanism here was built against one component library. Another library's dialog instead
// does NOT put a matching `.ant-modal-wrap` in the DOM — it sets `pointer-events: none` on the BODY. So
// `overlaySignature`, which counts elements matching a curated class list, read 0; `dismissBlockingOverlay`
// took its `if (before === 0) return false` early exit; and it never even pressed Escape, which is the one
// affordance that would have closed the dialog. First crawl of the new target: 55 of 59 failed acts, every
// one reporting `<html lang="en" class="light"> intercepts pointer events`.
//
// The hit-test (`clickIntercepted`) had detected the block CORRECTLY. An older, framework-shaped mechanism
// downstream discarded that knowledge. That is the general lesson worth encoding: when a curated list and a
// direct measurement disagree, the measurement wins, and the list is demoted to what it is actually good at
// — deciding what to CLICK to close, not deciding whether anything is blocking.
//
// Guards:
//   (1) A body-level pointer-events lock with NO recognisable overlay class is still detected as blocking,
//       and Escape is tried.
//   (2) The verdict is the hit-test: "did the dismiss work" means "can the target be clicked now", not
//       "did a curated selector count change".
//   (3) The AntD-shaped case still works — this is a widening, not a replacement.
//
// FAIL-ON-REVERT:
//   (1)+(2) restore `if (before === 0) return false;` as the unconditional first line → the Radix-shaped
//           lock is declared unclosable and "a body-level lock is closed" goes red.
//   (3)     drop `.ant-modal-wrap` from BACKDROP_SELECTORS → the AntD case goes red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { dismissBlockingOverlay, clickIntercepted } from '../../lib/recon/overlay-dismiss.mjs';

// Radix's actual shape: a dialog with no framework class the curated list knows, plus the body lock. The
// overlay deliberately carries NO `.ant-*`/`.modal` class — that is the whole point of the fixture.
const RADIX_SHAPED = `
  <button id="target">Target</button>
  <div id="shroud" style="position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.4)"></div>
  <div data-state="open" style="position:fixed;top:40%;left:40%;z-index:60;background:#fff">
    <button aria-label="Close" id="x">×</button>
  </div>
  <script>
    document.body.style.pointerEvents = 'none';
    document.getElementById('x').addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    function close() {
      document.body.style.pointerEvents = '';
      document.getElementById('shroud').remove();
      document.querySelector('[data-state=open]').remove();
    }
  </script>`;

test('a body-level pointer lock with no known overlay class is still closed', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.setContent(RADIX_SHAPED);
    const target = await page.$('#target');

    // (1) The failure is real, not hypothetical: the click genuinely cannot land.
    assert.equal(await clickIntercepted(page, target), true,
      'the target is genuinely blocked — this is the state the crawl kept failing in');

    // (2) The hit-test governs the verdict. Passing the handle is what lets it.
    const dismissed = await dismissBlockingOverlay(page, target);
    assert.equal(dismissed, true, 'the dismiss reports success because the target became clickable');
    assert.equal(await clickIntercepted(page, target), false, 'and it really is clickable now');

    // The act that was failing 55 times now lands.
    await target.click({ timeout: 3000 });
  } finally {
    await browser.close();
  }
});

test('the AntD-shaped overlay still closes — this is a widening, not a swap', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    // (3) The original shape: a recognised backdrop class, no body lock.
    await page.setContent(`
      <button id="target">Target</button>
      <div class="ant-modal-wrap" style="position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.4)"></div>
      <script>
        document.querySelector('.ant-modal-wrap').addEventListener('click', function () { this.remove(); });
      </script>`);
    const target = await page.$('#target');
    assert.equal(await clickIntercepted(page, target), true, 'the backdrop covers the target');
    assert.equal(await dismissBlockingOverlay(page, target), true, 'and the curated backdrop click still closes it');
  } finally {
    await browser.close();
  }
});
