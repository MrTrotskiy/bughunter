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
//   goes red; (c) delete the `pipeline-shell.mjs` allowlist branch → the module 404s → the
//   "pipeline-shell.mjs served" assertion goes red (the split-out chrome silently never mounts);
//   (e) delete the `coverage-view.mjs` allowlist branch → the module 404s → the "coverage-view.mjs
//   served" assertion goes red (the «Покрытие» screen silently never mounts); (d) below still holds:
//   (d) delete the `walk-view.mjs` allowlist branch → the module 404s → the "walk-view.mjs served"
//   assertion goes red (the split-out walk text silently never mounts).
//
// GRAPH-SNAPSHOT COMPRESSION (the disk-bloat fix): trace.snapshotGraph gzips a snapshot on write and
// admin-server serves it with `content-encoding: gzip`. Guards: the on-disk snapshot is MATERIALLY
// smaller than the source graph (compression actually happened), the served body carries the gzip
// header + a real gzip stream, and a client that inflates it recovers the source graph BIT-FOR-BIT
// (the scrubber's "graph at step N" is unchanged). FAIL-ON-REVERT: restore the `copyFileSync` in
// snapshotGraph (no gzip) → the on-disk snapshot equals the source → the "materially smaller"
// assertion reds AND the `content-encoding: gzip` header is absent → the header assertion reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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

  // graph snapshot — stored gzip-framed, served content-encoded (Node's http client does NOT
  // auto-inflate, so gunzip here as the browser's fetch() would for free).
  const gsnap = await get(port, q(`/api/runs/${runId}/graph/${actSeq}`));
  assert.equal(gsnap.status, 200);
  assert.equal(gsnap.headers['content-encoding'], 'gzip', 'snapshot served with content-encoding: gzip');
  assert.ok(JSON.parse(zlib.gunzipSync(gsnap.body)).elements['1'], 'graph snapshot has the control');

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

  // The scrubber geometry module is served same-origin + token-free (it is code, not run
  // data) so the page's `script-src 'self'` can import it.
  const mod = await get(port, '/scrub-math.mjs');
  assert.equal(mod.status, 200, 'scrub-math.mjs served');
  assert.match(mod.headers['content-type'], /javascript/, 'served as javascript');
  assert.match(mod.body.toString(), /export function deriveSteps/, 'is the geometry module');

  // The «Конвейер» view module and the CHROME module it re-exports from are BOTH served as code
  // (token-free, fixed basename). pipeline-shell.mjs is fetched TRANSITIVELY by the page's single
  // import of pipeline-view.mjs, so a dropped allowlist branch silently 404s the whole shell and the
  // page mounts nothing — the exact failure a green suite would otherwise hide.
  const pv = await get(port, '/pipeline-view.mjs');
  assert.equal(pv.status, 200, 'pipeline-view.mjs served');
  assert.match(pv.headers['content-type'], /javascript/, 'pipeline-view served as javascript');
  const shell = await get(port, '/pipeline-shell.mjs');
  assert.equal(shell.status, 200, 'pipeline-shell.mjs served (the split-out chrome module)');
  assert.match(shell.headers['content-type'], /javascript/, 'pipeline-shell served as javascript');
  assert.match(shell.body.toString(), /export function mountShell/, 'is the chrome module');

  // walk-view.mjs — the walk's TEXT module split out of admin.html — is served the same way. A
  // dropped allowlist branch 404s it under `script-src 'self'` and the walk mounts NOTHING.
  const wv = await get(port, '/walk-view.mjs');
  assert.equal(wv.status, 200, 'walk-view.mjs served (the split-out walk text module)');
  assert.match(wv.headers['content-type'], /javascript/, 'walk-view served as javascript');
  assert.match(wv.body.toString(), /export function kpiHtml/, 'is the walk text module');

  // coverage-view.mjs — the «Покрытие» screen's TEXT module — is served the same way. A dropped
  // allowlist branch 404s it under `script-src 'self'` and the coverage screen mounts NOTHING.
  const cv = await get(port, '/coverage-view.mjs');
  assert.equal(cv.status, 200, 'coverage-view.mjs served (the split-out coverage screen module)');
  assert.match(cv.headers['content-type'], /javascript/, 'coverage-view served as javascript');
  assert.match(cv.body.toString(), /export function coverageScreen/, 'is the coverage screen module');

  // The run payload ships `instanceBuckets` beside `instanceStats` — the «Покрытие» drill-down (which
  // controls the sampling policy declined / the app broke / churned). Same rule, same snapshot; a
  // dropped payload field leaves the screen with counts and no per-control lists.
  assert.ok(oneJson.instanceBuckets, 'instanceBuckets shipped on /api/runs/:id');
  assert.equal(oneJson.instanceBuckets.walked[0].name, 'Save', 'the walked control is attributed by name');
});

// Guards: graph snapshots are gzip-compressed on disk (the ~126 MB/run disk-bloat fix) and inflate
// BIT-FOR-BIT through the server, so the admin scrubber's "graph at step N" is unchanged.
// FAIL-ON-REVERT: restore `fs.copyFileSync` in trace.snapshotGraph → the on-disk snapshot equals the
//   source graph → "snapshot is materially smaller" reds AND no gzip framing → the content-encoding
//   header assertion reds. Verified red by hand.
test('graph snapshots are gzip-compressed on disk and inflate bit-for-bit through the server', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-admin-gz-'));
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = stateDir;

  const runId = 'r-20260101000001-bbbb';
  openRun({ runId, target: 'http://example.test/' });
  // A realistically-sized graph — the disk-bloat this compresses is a ~1 MB graph copied 200×/run.
  const elements = {};
  for (let i = 1; i <= 400; i++) {
    elements[i] = { type: 'element', templateId: i, role: 'button', name: 'Control ' + i, route: '/',
      explored: true, locator: { type: 'css' }, instances: [{ instanceKey: '' }],
      semantics: { danger: 'safe', effect: 'request', acted: true, purpose: 'do the thing number ' + i } };
  }
  const graph = { routes: { '/': { type: 'route', url: '/' } }, elements, requests: {}, edges: [] };
  fs.writeFileSync(path.join(stateDir, 'graph.json'), JSON.stringify(graph));
  const seq = traceEvent(runId, 'act', { templateId: 1 });
  snapshotGraph(runId, seq);

  // COMPRESSION ACTUALLY HAPPENED — the on-disk snapshot is materially smaller than the source graph.
  const srcBytes = fs.statSync(path.join(stateDir, 'graph.json')).size;
  const snapName = fs.readdirSync(path.join(runDir(runId), 'graph'))[0];
  const snapPath = path.join(runDir(runId), 'graph', snapName);
  const snapBytes = fs.statSync(snapPath).size;
  assert.ok(snapBytes * 3 < srcBytes, `snapshot is materially smaller than the source (${snapBytes} vs ${srcBytes})`);
  const onDisk = fs.readFileSync(snapPath);
  assert.ok(onDisk[0] === 0x1f && onDisk[1] === 0x8b, 'the on-disk snapshot is a real gzip stream');

  const TOK = 'testtoken00000001';
  const { server, port } = await startAdmin({ port: 0, token: TOK });
  const q = (p) => p + (p.includes('?') ? '&' : '?') + 't=' + TOK;
  t.after(() => { server.close(); rmSync(stateDir, { recursive: true, force: true });
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState; });

  const gsnap = await get(port, q(`/api/runs/${runId}/graph/${seq}`));
  assert.equal(gsnap.status, 200);
  // Served gzip-encoded so the browser's fetch() inflates it transparently (zero server CPU).
  assert.equal(gsnap.headers['content-encoding'], 'gzip', 'snapshot served with content-encoding: gzip');
  assert.equal(Number(gsnap.headers['content-length']), snapBytes, 'content-length is the compressed (on-the-wire) size');
  // A client inflates it (as the browser does for free) → BIT-IDENTICAL to the source graph on disk.
  const served = JSON.parse(zlib.gunzipSync(gsnap.body));
  assert.deepEqual(served, graph, 'the snapshot round-trips bit-for-bit through gzip');
});
