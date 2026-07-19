// A FIELD CAN ANSWER WITHOUT BEING SUBMITTED — and only for itself.
//
// THE MEASURED GAP. Run probe9: four textboxes were filled successfully and recorded `inert` — "Search
// Community", "Search your connections", "Group Name", "Search <App>". Nothing was wrong with the fill.
// Under a commit-only model they can never leave L2, because they have no commit control to answer to, and
// the literature says field→commit on nameless markup is unsolved (the classical crawlers take the submit
// for free from `<form action>`; the LLM agents press Enter and hope). The client already holds the answer:
// AntD's Form.Item validates on `validateTrigger`, defaulting to `onChange`, so the error node is in the DOM
// after a fill and a blur with no submit anywhere.
//
// Guards:
//   (1) A field's own region is found, and its own validation error is read from it.
//   (2) SCOPE IS LOAD-BEARING: a NEIGHBOURING field's error is NOT read as this field's answer. This is the
//       borrowed-evidence fallacy that once made a single toast the recorded outcome of three separate acts,
//       and page-scoped reading would reintroduce it in a form where some other field is always invalid.
//   (3) A field with no validation region yields null rather than a page-wide fallback — an honest "no local
//       answer" instead of somebody else's.
//   (4) Reading answers nothing when the page said nothing: a valid field is not reported refused.
//
// FAIL-ON-REVERT:
//   (2) make `fieldScopeSelector` return 'body' when no region is found → the neighbour's error is read →
//       "a neighbour's error is not this field's answer" goes red.
//   (1) drop the `.ant-form-item` branch from the region query → the region is not found, scope is null →
//       "the field's own error is read from its own region" goes red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fieldScopeSelector, settleField } from '../../lib/recon/field-scope.mjs';
import { readOutcome, wasRefused } from '../../lib/browser/observables.mjs';

// Two AntD-shaped form items side by side. The FIRST is already showing an error; the SECOND is the one
// under test. That ordering is deliberate — a page-scoped read finds the first one and calls it the
// second's answer.
const PAGE = `
  <div class="ant-form-item" id="item-a">
    <label>Alpha</label><input id="alpha" />
    <div class="ant-form-item-explain-error">Alpha is required</div>
  </div>
  <div class="ant-form-item" id="item-b">
    <label>Beta</label><input id="beta" />
  </div>
  <div id="bare"><input id="loose" /></div>
  <script>
    // Validate on change, with no submit anywhere — the AntD default trigger.
    document.getElementById('beta').addEventListener('change', function () {
      var err = document.querySelector('#item-b .ant-form-item-explain-error');
      if (this.value.length > 5) {
        if (!err) {
          err = document.createElement('div');
          err.className = 'ant-form-item-explain-error';
          document.getElementById('item-b').appendChild(err);
        }
        err.textContent = 'Beta must be 5 characters or fewer';
      } else if (err) { err.remove(); }
    });
  </script>`;

test('a field answers for itself, and never borrows its neighbour\'s error', async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.setContent(PAGE);
    const beta = await page.$('#beta');

    // (1) Over-long value → the field's OWN region reports the refusal, with no submit performed.
    await beta.fill('far too long');
    await settleField(page, beta);
    const scope = await fieldScopeSelector(page, beta);
    assert.ok(scope, 'the field has a validation region');
    const own = await readOutcome(page, { scope });
    assert.ok(wasRefused(own), 'the field refused the value — read from its own region, no commit needed');
    assert.ok(own.frameworkErrors.some((e) => /Beta must be/.test(e.text || e)),
      'and it is BETA\'s message, not whatever else the page is showing');

    // (2) THE SCOPE GUARD. Alpha's error is present the whole time. It must never surface as Beta's answer.
    assert.ok(!own.frameworkErrors.some((e) => /Alpha is required/.test(e.text || e)),
      'a neighbour\'s error is not this field\'s answer');

    // (4) A valid value clears it — the read reports refusal only when the page actually pushed back.
    await beta.fill('ok');
    await settleField(page, beta);
    const clean = await readOutcome(page, { scope: await fieldScopeSelector(page, beta) });
    assert.equal(wasRefused(clean), false, 'a field that accepted its value is not reported refused');

    // (3) A field with no region yields null, not a page-wide fallback that would inherit Alpha's error.
    const loose = await page.$('#loose');
    assert.equal(await fieldScopeSelector(page, loose), null,
      'no validation region means no local answer — never somebody else\'s');
  } finally {
    await browser.close();
  }
});
