// WIDGET CHROME exclusion (INC.6f) — 17% of the coverage denominator that can never be satisfied.
//
// A framework widget renders its panel as a body portal: a date picker's month/year/decade switchers, a
// select's option list. Those are not application surface — nobody "covers" `Choose a decade`, they pick a
// date — but the frontier was handing them out as controls. Measured on the live graph: 55 of 319 templates
// (17%) are picker/select chrome and they have fired ZERO requests between them, ever. `Next year (Control +
// right)` exists as SEVEN separate templates because each panel level (date → month → year → decade) is a
// new structural anchor. And because every switcher opens a deeper panel, under recency-first ordering they
// are an unbounded depth-first descent generator: one live run spent 22 consecutive acts walking a calendar.
//
// The danger in fixing this is the CONVERSE, and it is why this test has two halves. A portal MENU — a row's
// Edit/Delete/Share — is mounted the same way, into the same kind of body-level div, and IS genuine surface;
// INC.2 exists specifically to make those addressable. A container-based rule would silently delete them
// from coverage. The discriminator is the ARIA authoring pattern: role=menuitem is never chrome. On the live
// graph the two sets have ZERO role overlap across 84 templates.
//
// The panels here are opened by an ACT, never present in baseline markup. That is deliberate: live, the
// chrome only enters the graph when `field-actuate` opens the picker during a submit attempt, and a fixture
// that pre-rendered the panel would pass without ever exercising that path — the doctrine failure recorded
// in decisions.md this session (a test that revert-proved its guard while the live bug continued).
//
// Guards: widget chrome is flagged, kept out of every frontier reader, and COUNTED in widgetSkipped (the
//   denominator does not collapse); portal menu items are still emitted and still reachable.
// FAIL-ON-REVERT (two levers — one per direction, both required):
//   (a) drop the `widgetInternal(node)` peel in frontier.nextBatch → `Choose a month` enters the batch →
//       "picker chrome must never be handed out as a control" fails.
//   (b) drop the `role === 'menuitem'` exemption in dom-snapshot's inWidgetPopupOf, making the rule purely
//       container-based → the menu items are excluded → "a portal MENU item is genuine surface" fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../fixtures/widget-chrome-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { makeGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';
import { snapshotStep } from '../../lib/recon/step.mjs';
import { nextBatch, frontierInstanceStats } from '../../lib/recon/frontier.mjs';

const named = (graph, re) => Object.entries(graph.elements)
  .filter(([, n]) => re.test(n.name || ''))
  .map(([tid, n]) => ({ tid: Number(tid), name: n.name, role: n.role, widgetInternal: !!n.widgetInternal }));

test('a widget panel is chrome and leaves the frontier; a portal menu is surface and stays', async (t) => {
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
  const graph = makeGraph();
  const ledger = makeLedger();
  await gotoGated(page, url);
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');

  // ACT-OPENED, not pre-rendered — the live path by which chrome enters the graph.
  await page.click('#date');
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');
  await page.click('#more');
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');
  await page.click('#sel');
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');

  const chrome = named(graph, /Choose a (month|year|decade)|Next year/);
  const menu = named(graph, /^(Edit|Share Link)$/);
  // The load-bearing case for the role rule: a real control mounted INSIDE a widget popup container by the
  // app itself (AntD dropdownRender). Its container is byte-identical to the picker's — only the ARIA role
  // separates it from the chrome sitting beside it in the very same div. Without the role exemption this
  // control is silently deleted from coverage, which is the one failure direction that matters here.
  const injected = named(graph, /^Add new community$/);
  assert.ok(chrome.length >= 3, `the picker panel must have been captured (non-vacuous), got ${chrome.length}`);
  assert.ok(menu.length >= 2, `the portal menu must have been captured (non-vacuous), got ${menu.length}`);

  // HALF ONE — chrome is flagged and never handed out.
  for (const c of chrome) assert.equal(c.widgetInternal, true, `"${c.name}" must be flagged widget chrome`);
  const batch = nextBatch(graph, { size: 50 });
  const batchNames = batch.map((b) => b.name || '');
  for (const c of chrome) {
    assert.ok(!batchNames.includes(c.name),
      `picker chrome must never be handed out as a control — "${c.name}" is in the batch`);
  }

  // HALF TWO — the converse. A container-based rule would take these too.
  assert.equal(injected.length, 1, 'the dropdownRender-injected control must have been captured (non-vacuous)');
  assert.equal(injected[0].widgetInternal, false,
    'a real control injected INTO a widget popup (dropdownRender) must NOT be excluded — only its ARIA role distinguishes it from the options beside it');
  assert.ok(batchNames.includes('Add new community'),
    'the injected control must still be handed out — a container-only rule would silently delete it from coverage');
  for (const m of menu) {
    assert.equal(m.widgetInternal, false, `a portal MENU item is genuine surface — "${m.name}" must NOT be flagged chrome`);
    assert.ok(batchNames.includes(m.name), `a portal MENU item is genuine surface — "${m.name}" must still be emitted`);
  }
  // And it is really reachable, not merely enumerated: clicking it hits the server.
  await page.click('#mi-share');
  await waitSettled(page);
  assert.equal(server.shareHits(), 1, 'the portal menu item is genuinely actionable, not just listed');

  // HALF THREE — the denominator does not collapse. Chrome is counted, not dropped.
  const stats = frontierInstanceStats(graph);
  assert.ok(stats.widgetSkipped >= chrome.length,
    `chrome must be COUNTED in widgetSkipped, not silently dropped — got ${stats.widgetSkipped}`);
  const discovered = Object.keys(graph.elements).length;
  assert.ok(discovered >= chrome.length + menu.length,
    'every control stays in the graph — exclusion is from the frontier, never from discovery');
});
