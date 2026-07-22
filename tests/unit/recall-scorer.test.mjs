// Guards: the recall scorer's join math — testid/route+role+name control join, the :id->:param
//   endpoint normalization (so a declared /api/contacts/:id joins the crawler's masked :param), the
//   danger "found = discovered AND declined" rule, rail-failure detection, and testid extras.
// FAIL-ON-REVERT:
//   - drop the `:param` normalization in join.endpointPattern (compare raw) -> the /api/contacts/:id
//     detail endpoint never matches the crawler's /api/contacts/:param -> "the route-transition detail
//     endpoint joins ... :param" reds. (Verified.)
//   - count a fired danger effect as found (scoreCase `danger` branch) -> "a fired danger control is a
//     rail failure, not recall" reds. (Verified.)
// Layer: unit (no browser) — a hand-built graph, per tests/CLAUDE.md layer rule.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES } from '../../recall-site/cases.mjs';
import { manifestOf } from '../../recall-site/manifest.mjs';
import { scoreRecall } from '../../tools/recall/score.mjs';

const MANIFEST = manifestOf(CASES);

// A graph in which the crawl discovered ALL four planted cases: nav-contacts (testid) with the home
// route collected, contact-create (testid) with an attributed POST, logout-icon (positional, declined),
// and the hrefless row (role-name) with the detail GET masked to :param.
function fullGraph() {
  return {
    schemaVersion: 99,
    routes: { '/': {}, '/contacts': {} },
    elements: {
      t1: { templateId: 't1', role: 'link', name: 'Contacts', route: '/', testid: 'nav-contacts', instances: [] },
      t2: { templateId: 't2', role: 'button', name: 'New contact', route: '/contacts', testid: 'contact-create', instances: [] },
      t3: { templateId: 't3', role: 'button', name: '', route: '/contacts', testid: 'logout', instances: [] },
      t4: { templateId: 't4', role: 'row', name: 'Ada Lovelace', route: '/contacts', instances: [] },
      t5: { templateId: 't5', role: 'menuitem', name: 'Delete', route: '/contacts', instances: [] }, // portal: joined by name
    },
    requests: {
      'POST /api/contacts': { type: 'request', method: 'POST', urlPattern: '/api/contacts' },
      'GET /api/contacts/:param': { type: 'request', method: 'GET', urlPattern: '/api/contacts/:param' },
    },
    edges: [
      { from: 'element:t2', to: 'request:POST /api/contacts', type: 'triggers', provenance: 'causal' },
      { from: 'element:t4', to: 'request:GET /api/contacts/:param', type: 'triggers', provenance: 'causal' },
    ],
  };
}

test('every EXPECTED-reachable case is recalled; hover is a documented known-miss', () => {
  const effects = { createHits: 1, logoutHits: 0, detailHits: 1 };
  const r = scoreRecall(fullGraph(), MANIFEST, effects);
  // The 5 reachable cases (home/create/logout/row/portal) all recalled; the hover case is not in the graph.
  assert.equal(r.expected.found, r.expected.total);
  assert.equal(r.expected.recall, 1);
  assert.deepEqual(r.railFailures, []);
  assert.deepEqual(r.knownMisses, ['hover-quickview'], 'the hover-only case is an honest documented miss');
  assert.deepEqual(r.surprises, [], 'nothing we expected to miss was unexpectedly reached');
});

test('the route-transition detail endpoint joins the crawler-masked :param', () => {
  const effects = { createHits: 1, logoutHits: 0, detailHits: 1 };
  const r = scoreRecall(fullGraph(), MANIFEST, effects);
  const row = r.perCase.find((x) => x.id === 'contact-row-open');
  assert.equal(row.found, true, 'the hrefless row + its detail GET must be recalled');
  assert.equal(row.how, 'toUrlPattern-attributed');
});

test('a fired danger control is a rail failure, not recall', () => {
  const effects = { createHits: 1, logoutHits: 1, detailHits: 1 }; // logout was fired — the rail broke
  const r = scoreRecall(fullGraph(), MANIFEST, effects);
  const logout = r.perCase.find((x) => x.id === 'logout-icon');
  assert.equal(logout.found, false, 'a fired danger control must NOT count as recall');
  assert.equal(logout.railFailed, true);
  assert.deepEqual(r.railFailures, ['logout-icon']);
});

test('recall is sliced by identity-difficulty class', () => {
  const effects = { createHits: 1, logoutHits: 0, detailHits: 1 };
  const r = scoreRecall(fullGraph(), MANIFEST, effects);
  assert.equal(r.byIdentityClass.testid.found, 3); // nav-contacts + contact-create + logout (declined)
  assert.equal(r.byIdentityClass['role-name'].found, 1); // the hrefless row
  assert.equal(r.byIdentityClass.portal.found, 1); // the portal Delete (declined, destructive)
});

test('a missed control is reported by testid (or case id), and testid extras are surfaced', () => {
  const g = fullGraph();
  delete g.elements.t2; // the crawl never found contact-create
  g.elements.t9 = { templateId: 't9', role: 'button', name: 'Ghost', route: '/contacts', testid: 'ghost-x', instances: [] };
  const r = scoreRecall(g, MANIFEST, { logoutHits: 0, detailHits: 1 });
  assert.ok(r.byCaseClass['request-endpoint'].missed.includes('contact-create'));
  assert.deepEqual(r.extras, ['ghost-x']);
});
