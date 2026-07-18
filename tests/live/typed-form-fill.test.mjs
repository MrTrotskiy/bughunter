// Live proof that a create form with NON-TEXT required fields can actually be submitted (INC.6).
//
// This is the measured cause of six live crawls creating nothing. `form-fill` enumerated only
// `input`+`textarea` and skipped anything `readOnly`, and `step.mjs` put values in with `fill()` alone.
// antd renders a Select and a DatePicker AS a readonly `<input>`, so both were invisible to the filler;
// the submit button was still clicked, client validation refused, the server heard nothing, and the
// control was scored covered. The trail showed the exact shape: "Create Event" clicked three times, only
// `get_status_detail` (the modal's own load) ever left the browser.
//
// Guards: fieldsFor classifies select/date/check/upload rather than dropping them, and actuateAll drives
//   each kind with the right Playwright API — so the fixture's server-side create counter goes from 0 to 1.
// FAIL-ON-REVERT (a): restore the `:not([type=file])` + `f.readOnly` skips in form-fill.mjs fieldsFor →
//   the select/date fields are never enumerated → the form stays incomplete → createHits() stays 0.
// FAIL-ON-REVERT (b): make actuateAll always call actuateFill → the readonly inputs reject the fill →
//   same result, createHits() stays 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../fixtures/typed-form-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { fieldsFor } from '../../lib/recon/form-fill.mjs';
import { actuateAll } from '../../lib/recon/field-actuate.mjs';

test('a create form whose required fields are a select, a date and a checkbox actually submits', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  process.env.PW_ALLOW_PRIVATE = '1';

  const sess = await launch();
  t.after(async () => {
    await close(sess.browser);
    await new Promise((r) => server.close(r));
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
  });

  const { page } = sess;
  await gotoGated(page, url);
  await waitSettled(page);

  // Discover the fields the way the crawler does: from the SUBMIT control's own scope.
  const submit = await page.$('#create');
  assert.ok(submit, 'the fixture submit button must resolve');
  const fields = await fieldsFor(page, submit, 'HUNT-typedform');

  // The classifier must SEE all four kinds. Before the fix it saw exactly one (the text input).
  const kinds = fields.map((f) => f.kind).sort();
  assert.ok(kinds.includes('fill'), `text field must be found — got ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('select'), `antd select must be found, not skipped as readonly — got ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('date'), `antd picker must be found, not skipped as readonly — got ${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('check'), `checkbox must be found — got ${JSON.stringify(kinds)}`);

  // A select carries no string value — inventing one would put a value in the trail that never reached
  // the page.
  for (const f of fields) {
    if (f.kind !== 'fill') assert.equal(f.value, null, `${f.kind} must carry no text value`);
  }

  const res = await actuateAll(page, fields);
  assert.ok(res.actuated >= 4, `all four fields must be actuated — got ${res.actuated}, skipped ${JSON.stringify(res.skipped)}`);

  assert.equal(server.createHits(), 0, 'nothing may be created before the submit is clicked');
  await submit.click();
  await waitSettled(page);

  // The whole point: the server actually heard a create.
  assert.equal(server.createHits(), 1, 'the filled form must reach the server — this is the create that six live runs never made');
});
