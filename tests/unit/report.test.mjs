// report — renders state/graph.json into the recon summary (coverage + control→endpoint
// map). Pure over a constructed graph, no browser.
//
// Guards: (1) the coverage line surfaces the honest frontier denominator (explored
//   excludes unreachable — delegated to frontierStats, itself guarded in frontier.test);
//   (2) the causal control→endpoint map is bidirectional — a request lists the templates
//   that caused it AND each template lists the requests it causes (the key Phase-2 input;
//   if this drops, the report is decorative); the unreachable REASON is surfaced, not hidden.
// FAIL-ON-REVERT (a): make report's causedBy edge-walk a no-op (`causedBy = {}`) → the
//   request has no causing control → "request must credit its causing control" fails.
// FAIL-ON-REVERT (b): make report ignore `n.unreachable` (always false) → the Edit control
//   no longer shows its reason → "the unreachable reason is surfaced, not hidden" fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeGraph, mergeSnapshot, addTrigger, recordSemantics, markExplored, markUnreachable, saveGraph } from '../../lib/graph/graph-store.mjs';
import { report } from '../../lib/recon/report.mjs';

function withGraph(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bughunter-rep-'));
  const prev = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = dir;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prev;
  });
  const g = makeGraph();
  mergeSnapshot(g, '/', [
    { templateId: 3, instanceId: 4, templateSelector: 'button#search', role: 'button', name: 'Search', instanceKey: '#1', instanceSelector: 'button#search' },
    { templateId: 5, instanceId: 6, templateSelector: 'button.edit', role: 'button', name: 'Edit', instanceKey: '#1', instanceSelector: 'button.edit' },
  ]);
  addTrigger(g, 3, { method: 'GET', urlPattern: '/api/search?q=:param' });
  recordSemantics(g, 3, { purpose: 'runs a search', danger: 'safe', effect: 'request', acted: true, stateChange: false });
  markExplored(g, 3);
  markExplored(g, 5);
  markUnreachable(g, 5, 'unreachable-coldstart');
  saveGraph(path.join(dir, 'graph.json'), g);
  return dir;
}

test('report: honest coverage denominator', (t) => {
  withGraph(t);
  const rep = report({ json: true });
  assert.equal(rep.coverage.discovered, 2, 'both templates discovered');
  assert.equal(rep.coverage.explored, 1, 'explored must exclude the unreachable control');
  assert.equal(rep.coverage.unreachable, 1, 'the unreachable control is flagged');
  assert.equal(rep.coverage.remaining, 0, 'frontier drained');
});

test('report: bidirectional causal control→endpoint map', (t) => {
  withGraph(t);
  const rep = report({ json: true });

  const req = rep.requests.find((r) => r.key === 'GET /api/search?q=:param');
  assert.ok(req, 'the caused request appears in the report');
  assert.deepEqual(req.causedBy, [3], 'request must credit its causing control');

  const search = rep.routes.flatMap((r) => r.templates).find((tpl) => tpl.templateId === 3);
  assert.ok(search.causes.includes('GET /api/search?q=:param'), 'the control lists the endpoint it causes');
  assert.equal(search.danger, 'safe', 'semantics surfaced');
  assert.equal(search.effect, 'request');

  const edit = rep.routes.flatMap((r) => r.templates).find((tpl) => tpl.templateId === 5);
  assert.equal(edit.unreachable, 'unreachable-coldstart', 'the unreachable reason is surfaced, not hidden');
});

// Guards: a raw browser error stored as the unreachable reason (multi-line: "element is
//   not enabled" + a full Playwright call log) renders as ONE scannable line, so the
//   text report — the Phase-2 input — stays readable instead of exploding into log noise.
// FAIL-ON-REVERT: drop the oneLine() collapse in report.mjs → the raw newlines survive →
//   the "[5]" template line no longer contains the collapsed "timeout - waiting" fragment
//   (it spills onto separate physical lines) → the single-line assertion fails.
// Guards: report surfaces observed response status(es) + resource type — in the --json
//   request objects AND on the text causal-map line — so the Phase-2 input shows what each
//   endpoint returned, not just its method+path.
// FAIL-ON-REVERT: drop the `statuses`/`rtype` render in report.mjs's causal-map loop → the
//   "GET /api/list" line no longer carries "200 xhr" → the assertion fails.
test('report: observed response status + resource type are surfaced', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bughunter-rep2-'));
  const prev = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = dir;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prev;
  });
  const g = makeGraph();
  mergeSnapshot(g, '/', [
    { templateId: 3, instanceId: 4, templateSelector: 'button#list', role: 'button', name: 'List', instanceKey: '#1', instanceSelector: 'button#list' },
  ]);
  addTrigger(g, 3, { method: 'GET', urlPattern: '/api/list', status: 200, resourceType: 'XHR' });
  saveGraph(path.join(dir, 'graph.json'), g);

  const rep = report({ json: true });
  const req = rep.requests.find((r) => r.key === 'GET /api/list');
  assert.deepEqual(req.statuses, { '200': 1 }, 'the status histogram is in the JSON report');
  assert.equal(req.resourceType, 'XHR', 'the resource type is in the JSON report');

  const text = report({ json: false });
  // The causal-map line (`[3] → GET /api/list  200 xhr`), not the control line which also
  // lists the endpoint it causes.
  const line = text.split('\n').find((l) => l.includes('[3] → GET /api/list'));
  assert.ok(line, 'the causal-map line for the endpoint exists');
  assert.ok(line.includes('200'), 'the status is rendered on the causal-map line');
  assert.ok(line.includes('xhr'), 'the resource type is rendered (lowercased) on the causal-map line');
});

test('report: a multi-line unreachable reason renders on one line', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bughunter-rep1-'));
  const prev = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = dir;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prev;
  });
  const g = makeGraph();
  mergeSnapshot(g, '/', [
    { templateId: 5, instanceId: 6, templateSelector: 'button.x', role: 'button', name: 'Disabled', instanceKey: '#1', instanceSelector: 'button.x' },
  ]);
  markExplored(g, 5);
  markUnreachable(g, 5, 'click: timeout\n  - waiting for element\n  - retrying click action');
  saveGraph(path.join(dir, 'graph.json'), g);

  const text = report({ json: false });
  const line = text.split('\n').find((l) => l.includes('[5]'));
  assert.ok(line, 'the disabled control has a rendered line');
  assert.ok(line.includes('click: timeout - waiting for element'), 'the multi-line reason is collapsed onto the control line');
});
