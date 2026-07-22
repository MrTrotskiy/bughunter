// Guards: the recall fixture's /__manifest__ cannot drift from the site it actually renders —
//         the known denominator IS a projection of the served DOM, not a hand-synced doc.
// FAIL-ON-REVERT: add a data-testid to a controlHtml output with no matching CASES row (or drop a
//   testid'd row's data-testid) -> the rendered testid set and manifest.testids diverge ->
//   "the rendered testid set must equal the manifest" reds. (Verified by hand-editing render-visible.)
//
// Layer: unit (no browser) — pure string render + regex, per tests/CLAUDE.md layer rule.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES } from '../../recall-site/cases.mjs';
import { pageHtml } from '../../recall-site/render-page.mjs';
import { manifestOf } from '../../recall-site/manifest.mjs';

// Every data-testid the site actually renders across all its routes.
function renderedTestids() {
  const routes = [...new Set(CASES.map((c) => c.route))];
  const found = new Set();
  for (const route of routes) {
    const html = pageHtml(route, CASES);
    for (const m of html.matchAll(/data-testid="([^"]+)"/g)) found.add(m[1]);
  }
  return found;
}

function symmetricDiff(a, b) {
  const out = [];
  for (const x of a) if (!b.has(x)) out.push(x);
  for (const x of b) if (!a.has(x)) out.push(x);
  return out;
}

test('the rendered testid set must equal the manifest testids (drift is impossible)', () => {
  const rendered = renderedTestids();
  const declared = new Set(manifestOf(CASES).testids);
  const diff = symmetricDiff(rendered, declared);
  assert.deepEqual(diff, [], `manifest/DOM testid drift: ${JSON.stringify(diff)}`);
});

test('the manifest is a projection of CASES: routes, endpoints and per-case metadata', () => {
  const m = manifestOf(CASES);
  // Routes are the distinct case routes.
  assert.deepEqual(new Set(m.routes), new Set(CASES.map((c) => c.route)));
  // Every declared endpoint is surfaced exactly once (deduped by method+pattern).
  const declaredKeys = new Set(CASES.filter((c) => c.endpoint).map((c) => `${c.endpoint.method} ${c.endpoint.pattern}`));
  assert.equal(m.endpoints.length, declaredKeys.size);
  for (const e of m.endpoints) assert.ok(declaredKeys.has(`${e.method} ${e.pattern}`));
  // Every case is projected with its class + identity-difficulty class (the recall slices).
  assert.equal(m.cases.length, CASES.length);
  for (const c of m.cases) {
    assert.ok(['home', 'route-transition', 'hidden-function', 'request-endpoint'].includes(c.caseClass));
    assert.ok(['testid', 'role-name', 'positional', 'portal'].includes(c.identityClass));
  }
});

test('a testid is emitted ONLY for the testid identity class (the difficulty slice is real)', () => {
  const rendered = renderedTestids();
  // A positional/role-name case must NOT leak a data-testid into the DOM.
  for (const c of CASES) {
    if (c.identityClass !== 'testid' && c.testid) {
      assert.ok(!rendered.has(c.testid), `${c.id} is ${c.identityClass} but leaked a testid`);
    }
  }
});
