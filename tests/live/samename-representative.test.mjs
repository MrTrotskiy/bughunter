// SAME-NAME REPRESENTATIVE (INC.6) — a role+name fallback must not hand back a DIFFERENT control.
//
// This is the last link in the create chain, and the most expensive bug of the project so far. When an
// instance's stored positional selector goes stale, resolveHandle falls back to a durable role+name
// locator — but `page.getByRole` searches the WHOLE PAGE. On the live target the button that OPENS the
// Create Event modal and the button that SUBMITS it share the accessible name "Create Event". With the
// modal shut, the submit's selector failed, the fallback resolved the OPENER, and the crawl clicked the
// opener while recording the act against the submit. Seven runs read as "Create Event exercised, fired
// only get_status_detail"; the submit was never once clicked. Clicking it by hand fires
// POST /api/meetings-events and the event is created.
//
// Guards: resolveHandle rejects a same-named candidate whose templateSelector differs, so it either
//   returns the RIGHT control or none — never a silent impostor from another template.
// FAIL-ON-REVERT: drop the sameTemplate filter in resolve-handle.mjs (return the first visible handle) →
//   the submit resolves to the opener → "the resolved handle must be the SUBMIT, not the opener" fails
//   (and the server sees an open, not a create).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../fixtures/samename-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { resolveHandle } from '../../lib/recon/resolve-handle.mjs';

test('a role+name representative must belong to the SAME template, not merely share a name', async (t) => {
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

  // Open the modal so BOTH same-named buttons are present and visible — the live situation.
  await page.click('#opener');
  await waitSettled(page);
  assert.equal(server.openHits(), 1, 'the opener fired its read');
  assert.equal(server.createHits(), 0, 'nothing created yet');

  // The submit's node, with a DELIBERATELY STALE positional selector — the exact state a re-render (or a
  // closed-then-reopened modal) leaves behind, which is what pushes resolveHandle onto the fallback.
  const submitNode = {
    role: 'button',
    name: 'Create Event',
    templateSelector: 'div.modal-footer > button',
  };
  const submitInstance = { instanceSelector: '#gone-after-rerender', instanceKey: '#1' };

  const got = await resolveHandle(page, submitInstance, submitNode);
  assert.ok(got && got.handle, 'the submit must still resolve via its durable locator');

  // The decisive assertion: which control did we actually get?
  const id = await got.handle.evaluate((el) => el.id);
  assert.equal(id, 'submit', 'the resolved handle must be the SUBMIT, not the opener that shares its name');

  // And it must actually create when clicked — the outcome seven live runs never reached.
  await got.handle.click();
  await waitSettled(page);
  assert.equal(server.createHits(), 1, 'clicking the resolved handle must create');
  assert.equal(server.openHits(), 1, 'the opener must NOT have been clicked again');

  // The converse: the OPENER's own node still resolves to the opener (the guard does not break the
  // legitimate case by rejecting everything).
  const openerNode = { role: 'button', name: 'Create Event', templateSelector: 'main > button' };
  const gotOpener = await resolveHandle(page, { instanceSelector: '#also-gone', instanceKey: '#1' }, openerNode);
  assert.ok(gotOpener && gotOpener.handle, 'the opener must resolve too');
  assert.equal(await gotOpener.handle.evaluate((el) => el.id), 'opener', 'the opener resolves to the opener');
});

// THE LIVE SHAPE — and the case the test above does NOT cover. It opens the modal first, so both same-named
// buttons are visible, the role+name branch succeeds, and control never reaches the text fallback beneath it.
// That is why it stayed green while the bug it was written for went on happening: with the modal SHUT the
// role+name branch finds only the opener, the sameTemplate guard correctly rejects it — and then execution
// falls through to `getByText(name, {exact:true})`, which had no structural check at all and handed the
// opener straight back. Both "Create Event" templates ended up with a causal edge to the opener's own read.
//
// Guards: EVERY name-based fallback in resolveHandle is structurally gated, so a stale selector yields an
//   honest null rather than a same-named control from a different template.
// FAIL-ON-REVERT: drop the sameTemplate check in the text fallback (`const h = await firstVisible(handles);
//   if (h) return {handle: h, via: 'text', representative: true}`) → the opener comes back via:'text' →
//   "must not fall through to the text fallback and return the opener" fails.
test('with the container CLOSED, a stale submit resolves to nothing — never to its same-named opener', async (t) => {
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

  // Deliberately do NOT open the modal. This is the state the crawler is in on every cold re-navigate and
  // after any act that closed the dialog — which the live trail shows is most of them.
  const submitNode = { role: 'button', name: 'Create Event', templateSelector: 'div.modal-footer > button' };
  const got = await resolveHandle(page, { instanceSelector: '#gone-after-rerender', instanceKey: '#1' }, submitNode);

  if (got && got.handle) {
    const id = await got.handle.evaluate((el) => el.id);
    assert.notEqual(id, 'opener',
      `must not fall through to the text fallback and return the opener (got id="${id}" via="${got.via}")`);
  }
  assert.equal(server.openHits(), 0, 'nothing was clicked while merely resolving');
  assert.equal(server.createHits(), 0, 'and certainly nothing was created');
});
