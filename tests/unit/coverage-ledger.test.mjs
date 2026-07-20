// The coverage ledger must partition the denominator with nothing left over, and must name the owner.
//
// WHY THIS TEST EXISTS. A run reported 16.7% coverage and the report's three buckets — explored /
// unreachable / unexplored — could not say whether the missing surface was the agent's fault, the script's,
// a safety policy's, or the application's. "unexplored" was a catch-all, and a catch-all bucket cannot
// locate a defect. Measured on the live graph behind that number: 61.6% of all instances sat on routes the
// crawler NEVER NAVIGATED TO, which the old report rendered indistinguishably from a control it had tried
// and failed to click.
//
// Two properties are pinned here, and both are FAIL-ON-REVERT:
//   1. residual === 0. Delete a branch from classifyInstance and a unit falls out of the partition.
//   2. a gate-refused instance is NOT in the numerator, even when it carries explored:true. Measured, 6
//      such instances existed; counting them inflates coverage with acts that never happened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledger, classifyInstance } from '../../lib/recon/coverage-ledger.mjs';

// A graph exercising every bucket at once. Shaped like the real store: routes carry additive flags, and
// absence of both `pending` and `unreachable` is what "visited" means.
function graphWithEveryBucket() {
  return {
    routes: {
      '/visited': { type: 'route', url: '/visited' },
      '/queued': { type: 'route', url: '/queued', pending: true },
      '/gone': { type: 'route', url: '/gone', unreachable: true },
    },
    elements: {
      1: {
        templateId: 1, route: '/visited', name: 'Save',
        instances: [
          { instanceKey: 'a', explored: true },                        // acted
          { instanceKey: 'b' },                                        // owed-never-picked
          { instanceKey: 'c', churned: true },                         // churned
          { instanceKey: 'd', unreachable: 'Timeout 5000ms exceeded' }, // timeout
        ],
      },
      2: {
        templateId: 2, route: '/visited', name: 'Log out',
        unreachable: 'refusing to fire a auth control "" (template 2)',
        // THE MEASURED DEFECT: the gate declined to click, yet the instance is flagged explored.
        instances: [{ instanceKey: 'e', explored: true }],
      },
      3: { templateId: 3, route: '/queued', name: 'New board', instances: [{ instanceKey: 'f' }] },
      4: { templateId: 4, route: '/gone', name: 'Ghost', instances: [{ instanceKey: 'g' }] },
      5: { templateId: 5, route: '/nowhere', name: 'Orphan', instances: [{ instanceKey: 'h' }] },
    },
  };
}

test('the ledger partitions every instance — residual is exactly zero', () => {
  const l = ledger(graphWithEveryBucket());
  assert.equal(l.total, 8, 'every instance in the graph enters the denominator');
  assert.equal(l.residual, 0, 'buckets must sum to the total — a residual is a defect in the ledger itself');
  const summed = l.buckets.reduce((n, b) => n + b.count, 0);
  assert.equal(summed, l.total, 'the arithmetic invariant holds independently of the reported residual');
});

test('a control the gate refused to fire is NOT counted as acted', () => {
  const g = graphWithEveryBucket();
  const refused = classifyInstance(g, g.elements[2], g.elements[2].instances[0]);
  assert.equal(refused.bucket, 'gate-refused',
    'a refusal outranks explored:true — the gate declined, so no act occurred');
  assert.equal(refused.owner, 'policy', 'a deliberate refusal is owned by policy, not charged to the script');

  const l = ledger(g);
  assert.equal(l.acted, 1, 'only the genuinely acted instance is in the numerator, not the refused one');
});

test('an untouched route is charged to the script, not blamed on the element', () => {
  const g = graphWithEveryBucket();
  const queued = classifyInstance(g, g.elements[3], g.elements[3].instances[0]);
  assert.equal(queued.bucket, 'route-never-visited');
  assert.equal(queued.owner, 'script',
    'the route queue never drained this page — that is our machinery, not the application');

  const gone = classifyInstance(g, g.elements[4], g.elements[4].instances[0]);
  assert.equal(gone.owner, 'app', 'a route that 404s is the application making it impossible');
});

test('a route absent from the store is conspicuous, never silently dropped', () => {
  const g = graphWithEveryBucket();
  const orphan = classifyInstance(g, g.elements[5], g.elements[5].instances[0]);
  assert.equal(orphan.bucket, 'route-unknown',
    'an element whose route is not in the store must still land in a named bucket');
});

test('owner totals also partition the denominator', () => {
  const l = ledger(graphWithEveryBucket());
  const byOwner = Object.values(l.byOwner).reduce((a, b) => a + b, 0);
  assert.equal(byOwner, l.total, 'every instance is charged to exactly one owner');
});

test('the headline names the biggest non-numerator bucket and its owner', () => {
  // Make route-never-visited dominant, as it is on the live graph (61.6%).
  const g = graphWithEveryBucket();
  g.elements[3].instances = Array.from({ length: 20 }, (_, i) => ({ instanceKey: `q${i}` }));
  const l = ledger(g);
  assert.match(l.headline, /route-never-visited/, 'the operator is told WHICH bucket is the problem');
  assert.match(l.headline, /script/, 'and WHO owns it');
});

test('a bucket reports the owner it was CLASSIFIED with, not one re-derived from its name', () => {
  // My own defect, caught in the rendered output: the bucket list recomputed the owner by re-matching the
  // bucket NAME against the message patterns. Those patterns match prose ("not attached to the DOM"), not
  // codes ("detached"), so the re-match missed and charged the application's failure to the script. A
  // ledger that mis-assigns blame is worse than no ledger.
  const g = graphWithEveryBucket();
  const inst = { instanceKey: 'x', unreachable: 'elementHandle.click: Element is not attached to the DOM' };
  g.elements[1].instances.push(inst);
  assert.equal(classifyInstance(g, g.elements[1], inst).owner, 'app');

  const b = ledger(g).buckets.find((x) => x.bucket === 'detached');
  assert.equal(b.owner, 'app', 'the rendered bucket agrees with the classifier that decided it');
});

test('an unmatched reason is conspicuous rather than absorbed', () => {
  // The `unreachable` field holds prose. A message the shim does not recognise must not vanish into a
  // catch-all that reads as "fine" — it lands in a bucket whose name says the classifier has drifted.
  const g = graphWithEveryBucket();
  g.elements[1].instances.push({ instanceKey: 'z', unreachable: 'some future message nobody mapped' });
  const l = ledger(g);
  const un = l.buckets.find((b) => b.bucket === 'unreachable-unclassified');
  assert.ok(un && un.count === 1, 'an unrecognised reason gets its own visible bucket');
  assert.equal(l.residual, 0, 'and the partition still closes');
});
