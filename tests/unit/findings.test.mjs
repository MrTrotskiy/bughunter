// FINDINGS ARE THE PRODUCT — an anomalous response must reach the operator with its cause attached.
//
// docs/GOAL.md: "A 403 or 500 where 200 belongs is not a failed probe to retry away — it is the most
// valuable thing the crawl can find." The graph already held them — the causal edge attributes a request
// to the control that caused it, and the response ledger records the status — but NOTHING surfaced them.
// A run printed "74 API endpoints mapped" with three 400s buried inside that list, and finding the one
// control that returns 400 on seven separate attempts meant reading the graph by hand.
//
// The reason attribution matters: "POST /x returned 500" is a log line, while "clicking Save on /settings
// returns 500" is a bug report. The difference is the whole value of the causal layer.
//
// Guards: server errors and refused requests are reported WITH the control that caused them; a declared
//   contract the application does not honour (required-accepts-empty, limit-not-enforced) is a finding;
//   a control that does nothing on repeated tries is reported, but a single transient miss is NOT.
// FAIL-ON-REVERT: make `causersOf` return [] → "the causing control is named" reds, and every finding
//   degrades to an unattributed log line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findingsOf } from '../../lib/recon/findings.mjs';

const graph = () => ({
  elements: {
    5: { name: 'Login as', route: '/people', role: 'button', probes: [{ kind: 'click', verdict: 'write-unconfirmed' }] },
    7: {
      name: 'Title', route: '/f', role: 'textbox',
      fieldFacts: { kind: 'text', required: true, maxLength: 50 },
      probes: [
        { kind: 'fill-valid', verdict: 'read' },
        { kind: 'fill-empty', verdict: 'write' },      // required, yet an empty commit was ACCEPTED
        { kind: 'fill-overflow', verdict: 'write' },   // declared maxLength 50, over-length ACCEPTED
      ],
    },
    9: { name: 'Dead', route: '/x', role: 'button', probes: [{ kind: 'click', verdict: 'inert' }, { kind: 'click', verdict: 'inert' }] },
    11: { name: 'Once', route: '/x', role: 'button', probes: [{ kind: 'click', verdict: 'inert' }] },
  },
  requests: {
    'POST /api/auth/impersonate': { statuses: { 400: 7 } },
    'GET /api/health': { statuses: { 200: 3 } },
    'POST /api/save': { statuses: { 500: 1 } },
  },
  edges: [
    { from: 'element:5', to: 'request:POST /api/auth/impersonate', type: 'triggers', provenance: 'causal' },
    { from: 'element:5', to: 'request:POST /api/save', type: 'triggers', provenance: 'causal' },
    { from: 'element:9', to: 'request:GET /api/health', type: 'triggers', provenance: 'nav' },   // not causal
  ],
});

test('an anomalous response is a finding, and it names the control that caused it', () => {
  const { findings } = findingsOf(graph());
  const impersonate = findings.find((f) => f.endpoint === 'POST /api/auth/impersonate');
  assert.ok(impersonate, 'a 400 is a finding');
  assert.equal(impersonate.count, 7, 'and its repeat count survives — seven failures is not one failure');
  assert.deepEqual(impersonate.causedBy.map((c) => c.name), ['Login as'],
    'the causing control is named — "POST /x returned 400" is a log line, "Login as returns 400" is a bug report');

  const server = findings.find((f) => f.status === 500);
  assert.equal(server.severity, 'high', 'a server error is high severity whatever we sent');

  assert.ok(!findings.some((f) => f.endpoint === 'GET /api/health'), 'a 200 is not a finding');
});

test('a declared contract the application does not honour is a finding', () => {
  const { findings } = findingsOf(graph());
  const req = findings.find((f) => f.kind === 'required-not-enforced');
  assert.ok(req, 'a required field that accepts an empty commit is a defect');
  assert.equal(req.severity, 'high');
  assert.equal(req.where.name, 'Title');

  const lim = findings.find((f) => f.kind === 'limit-not-enforced');
  assert.ok(lim, 'a declared maxLength that is not enforced is a defect — the declaration was a prediction');
});

// A WRONG-SHAPE value the field ACCEPTED is a finding — "declared type=number, committed letters" — while a
// wrong-shape value the field REFUSED is the declaration working and is not reported.
// Guards: the accepted-violation direction is a finding; the enforced (NOT_FILLABLE) direction is not.
// FAIL-ON-REVERT: drop the `fill-invalid` branch from `brokenContracts` → "a wrong-shape value the field
//   accepted is a finding" reds.
test('a wrong-shape value the field accepted is a finding; one it refused is not', () => {
  const g = {
    elements: {
      1: {
        name: 'Amount', route: '/f', role: 'textbox', fieldFacts: { kind: 'number' },
        probes: [
          { kind: 'fill-valid', verdict: 'write' },
          { kind: 'fill-invalid', verdict: 'write' },   // committed a non-numeric value, not refused
        ],
      },
      2: {
        name: 'Strict', route: '/f', role: 'textbox', fieldFacts: { kind: 'number' },
        probes: [{ kind: 'fill-invalid', blocked: 'NOT_FILLABLE' }],   // the type WAS enforced
      },
    },
  };
  const { findings } = findingsOf(g);
  const bad = findings.find((f) => f.kind === 'type-not-enforced');
  assert.ok(bad, 'declares type=number and commits letters — a defect, not a silent success');
  assert.equal(bad.where.name, 'Amount');
  assert.ok(!findings.some((f) => f.where && f.where.name === 'Strict'),
    'a wrong-shape probe the field REFUSED (NOT_FILLABLE) is the type being enforced — never a finding');
});

// THE FORM LADDER's finding must reach the operator, keyed off the `submit-empty` rung where it actually
// lands. The incremental submit ladder records `submit-empty` on the SUBMIT button (a `formFacts` node, not
// a `fieldFacts` one), so `brokenContracts` (which reads field-level `fill-empty`) never sees it, and
// `formConflict` computed it for nobody. This is that wiring.
// Guards: an EMPTY submit the server accepted on a form declaring required fields is surfaced.
// FAIL-ON-REVERT: drop `formContracts` from `findingsOf` → "the form ladder's required-not-enforced is
//   surfaced" reds — the required-not-enforced finding a live crawl records vanishes.
test("the form ladder's required-not-enforced is surfaced, keyed off submit-empty", () => {
  const g = {
    elements: {
      10: {
        name: 'Save', route: '/new', role: 'button',
        formFacts: { total: 2, required: [{ selector: '#a' }, { selector: '#b' }], requiredBeyondCap: 0 },
        probes: [{ kind: 'submit-empty', verdict: 'write' }],   // EMPTY submit ACCEPTED
      },
    },
  };
  const { findings } = findingsOf(g);
  const req = findings.find((f) => f.kind === 'required-not-enforced');
  assert.ok(req, 'the empty-required defect the ladder records on the submit button must reach the operator');
  assert.equal(req.severity, 'high');
  assert.equal(req.where.name, 'Save');
  assert.match(req.note, /EMPTY submit was accepted/);
});

test('a control that never does anything is reported; a single miss is not', () => {
  const { findings } = findingsOf(graph());
  const inert = findings.filter((f) => f.kind === 'inert-control');
  assert.equal(inert.length, 1, 'only the twice-tried control is reported');
  assert.equal(inert[0].where.name, 'Dead', 'one transient miss must not be dressed up as a finding');
});
