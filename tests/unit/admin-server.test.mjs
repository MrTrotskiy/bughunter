// The local debug admin serves a Phase-1 capture trail (runs list, event stream, graph
// snapshots, key-frame PNGs) AND fences it: only a loopback Host may read it, no CORS
// header is ever sent, and artifact paths cannot escape the run dir. The trail may hold
// screenshots of a logged-in app, so these fences are load-bearing, not cosmetic.
//
// Guards: /api/runs enumerates a run; /api/runs/:id returns the event stream (incl. an act
//   event carrying its causal request + key-frame refs); /api/runs/:id/graph/:seq serves a
//   snapshot; /api/runs/:id/shots/:png serves the image; a request WITHOUT the access token is
//   403'd; a FOREIGN Host header is 403'd; no access-control-allow-origin is sent; a
//   path-traversal attempt never returns 200.
// FAIL-ON-REVERT: (a) delete the loopbackHost 403 guard in lib/debug/admin-server.mjs → the
//   foreign-Host request returns 200 → the "forbidden host" assertion goes red; (b) delete the
//   tokenOk 403 guard → the no-token /api request returns 200 → the "token required" assertion
//   goes red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openRun, traceEvent, snapshotGraph, closeRun, runDir } from '../../lib/debug/trace.mjs';
import { startAdmin } from '../../lib/debug/admin-server.mjs';

// 1x1 PNG — a real image so content-type + bytes are meaningful.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('admin serves the capture trail behind a loopback + containment fence', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-admin-'));
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = stateDir;

  const runId = 'r-20260101000000-aaaa';
  openRun({ runId, target: 'http://example.test/' });
  // A minimal but real graph, snapshotted at the act's seq.
  const graph = { routes: { '/': { type: 'route', url: '/' } }, elements: {
    1: { type: 'element', templateId: 1, role: 'button', name: 'Save', route: '/', explored: true,
         locator: { type: 'testid', attr: 'data-testid' }, instances: [{ instanceKey: '' }],
         semantics: { danger: 'safe', effect: 'request', acted: true, purpose: 'save the form' } },
  }, requests: { 'POST /api/save': { type: 'request', method: 'POST', urlPattern: '/api/save' } },
     edges: [{ from: 'element:1', to: 'request:POST /api/save', type: 'triggers', provenance: 'causal' }] };
  fs.writeFileSync(path.join(stateDir, 'graph.json'), JSON.stringify(graph));

  traceEvent(runId, 'route', { route: '/', total: 1, new: 1, opaque: 0 });
  const actSeq = traceEvent(runId, 'act', {
    templateId: 1, name: 'Save', role: 'button', route: '/',
    requests: [{ method: 'POST', urlPattern: '/api/save' }], revealed: 0,
    timings: { actMs: 12, settleMs: 30, snapMs: 8 },
    shots: { before: 't1-before.png', after: 't1-after.png', rect: { x: 5, y: 6, width: 40, height: 20 }, viewport: { width: 1280, height: 720 } },
  });
  fs.writeFileSync(path.join(runDir(runId), 'shots', 't1-before.png'), PNG);
  fs.writeFileSync(path.join(runDir(runId), 'shots', 't1-after.png'), PNG);
  snapshotGraph(runId, actSeq);
  closeRun(runId, { stats: { discovered: 1, explored: 1, unreachable: 0, remaining: 0, routes: 1 } });

  const TOK = 'testtoken00000000';
  const { server, port } = await startAdmin({ port: 0, token: TOK });
  const q = (p) => p + (p.includes('?') ? '&' : '?') + 't=' + TOK; // append the access token
  t.after(() => { server.close(); rmSync(stateDir, { recursive: true, force: true });
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState; });

  // runs list
  const runs = await get(port, q('/api/runs'));
  assert.equal(runs.status, 200);
  const runsJson = JSON.parse(runs.body);
  assert.ok(runsJson.runs.some((r) => r.id === runId), 'the run is listed');

  // event stream — the act event with its causal request + key-frames
  const one = await get(port, q('/api/runs/' + runId));
  assert.equal(one.status, 200);
  const oneJson = JSON.parse(one.body);
  const act = oneJson.events.find((e) => e.kind === 'act');
  assert.ok(act, 'act event served');
  assert.deepEqual(act.payload.requests, [{ method: 'POST', urlPattern: '/api/save' }], 'causal edge carried in the trail');
  assert.equal(act.payload.shots.before, 't1-before.png', 'key-frame ref carried');

  // graph snapshot
  const gsnap = await get(port, q(`/api/runs/${runId}/graph/${actSeq}`));
  assert.equal(gsnap.status, 200);
  assert.ok(JSON.parse(gsnap.body).elements['1'], 'graph snapshot has the control');

  // key-frame PNG
  const png = await get(port, q(`/api/runs/${runId}/shots/t1-before.png`));
  assert.equal(png.status, 200);
  assert.equal(png.headers['content-type'], 'image/png');
  assert.ok(png.body.length > 0 && png.body[0] === 0x89, 'PNG bytes served');

  // NO CORS header on any response (a foreign https tab must not be able to read the trail).
  assert.equal(png.headers['access-control-allow-origin'], undefined, 'no CORS header');
  assert.equal(one.headers['access-control-allow-origin'], undefined, 'no CORS header on JSON');

  // Access token gate: a data request WITHOUT the token is refused (a local non-browser
  // client — another user's curl — cannot read the trail on the Host allowlist alone).
  const noTok = await get(port, '/api/runs');
  assert.equal(noTok.status, 403, 'token required on /api');

  // Loopback Host-guard: a foreign Host header is refused (DNS-rebinding defense) — token
  // supplied, so the ONLY failing condition is the Host.
  const foreign = await get(port, q('/api/runs'), { Host: 'evil.example.com' });
  assert.equal(foreign.status, 403, 'foreign Host is forbidden');

  // Path traversal cannot escape the run dir (URL normalization + regex + containment).
  const trav = await get(port, q(`/api/runs/${runId}/shots/..%2f..%2frun.json`));
  assert.notEqual(trav.status, 200, 'traversal attempt is not served');
});
