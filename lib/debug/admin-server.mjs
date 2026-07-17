#!/usr/bin/env node
// admin-server — a zero-dependency LOCAL viewer for Phase-1 debug-capture runs. Reads the
// trail written by trace.mjs (events.ndjson + per-step graph snapshots + key-frames) and
// serves a single self-contained page that replays a run: graph growth, the agent's walk,
// what it tested, logs, speed, before/after screenshots. READ-ONLY — it never writes the
// trail, never drives the browser.
//
// SECURITY (this server exposes local run artifacts, which may screenshot a logged-in app):
//  - binds 127.0.0.1 ONLY (never 0.0.0.0) — not reachable off the machine.
//  - Host-header allowlist (loopback names on our port) — blunts DNS-rebinding, where a
//    malicious page resolves its own hostname to 127.0.0.1 to reach us from the browser.
//  - NO CORS headers ever — a foreign origin's fetch is blocked by the same-origin policy.
//  - a per-startup ACCESS TOKEN gates every /api/* route — the Host allowlist alone does not
//    stop a non-browser client (another local user's `curl`), so the data routes also require
//    `?t=<token>`; the token rides in the URL the operator opens (Jupyter-style).
//  - security headers on every response (nosniff + frame-deny; CSP on the page) — no framing,
//    no MIME sniffing, and a CSP backstop for the inline-asset page.
//  - artifact paths are allowlisted: runId/seq/filename are regex-validated, the resolved
//    path MUST stay inside the run's own shots/ or graph/ dir, AND a realpath check refuses a
//    symlink that escapes it (anti path-traversal, defense-in-depth).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runsRoot, runDir } from './trace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = /^r-[0-9]{14}-[a-z0-9]{4}$/;      // exactly the mintRunId() shape
const SEQ = /^[0-9]{1,9}$/;                        // a step index
const SHOT = /^[A-Za-z0-9._-]+\.png$/;             // a key-frame filename, no path parts
// nosniff + deny-framing on every response; a strict CSP is added for the HTML page only.
const SEC_HEADERS = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY' };
// script-src 'self' allows the same-origin scrub-math.mjs module; 'unsafe-inline' the page's
// own inline module. No external host is ever allowed (default-src 'none').
const HTML_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'";

function loopbackHost(host, port) {
  if (!host) return false;
  const h = String(host).toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

// Constant-time token compare (length-guarded — timingSafeEqual throws on length mismatch).
function tokenOk(url, token) {
  const t = url.searchParams.get('t') || '';
  if (t.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS });
  res.end(JSON.stringify(obj));
}
function sendText(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...SEC_HEADERS });
  res.end(body);
}

function readEvents(id) {
  try {
    return fs.readFileSync(path.join(runDir(id), 'events.ndjson'), 'utf8')
      .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

function listRuns() {
  let ids;
  try { ids = fs.readdirSync(runsRoot()); } catch { return []; }
  const runs = [];
  for (const id of ids) {
    if (!RUN_ID.test(id)) continue;
    const run = readJson(path.join(runDir(id), 'run.json'));
    if (run) runs.push(run);
  }
  runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return runs;
}

// Resolve an artifact path and REFUSE to leave the run's sub-dir. Even though runId/file
// are regex-validated, the resolved-path containment check is the load-bearing guard: it
// holds regardless of any future loosening of the regexes. A realpath check then refuses a
// symlink planted in the run dir that points outside it (defense-in-depth; the lexical
// check alone follows symlinks). When the target does not exist yet, realpath throws and we
// keep the lexical result — serveFile will 404.
function safeArtifact(id, sub, name) {
  const base = path.resolve(runDir(id), sub);
  const full = path.resolve(base, name);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  try {
    const realBase = fs.realpathSync(base);
    const realFull = fs.realpathSync(full);
    if (realFull !== realBase && !realFull.startsWith(realBase + path.sep)) return null;
  } catch { /* missing file/dir — lexical containment already passed */ }
  return full;
}

function serveFile(res, file, type, extra = {}) {
  fs.readFile(file, (err, buf) => {
    if (err) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-length': buf.length, ...SEC_HEADERS, ...extra });
    res.end(buf);
  });
}

export function handle(req, res, { port, token }) {
  // DNS-rebinding guard: only loopback Host names on our port may talk to us.
  if (!loopbackHost(req.headers.host, port)) { sendText(res, 403, 'forbidden host'); return; }
  // Read routes are GET; the ONLY mutation is DELETE /api/runs/:id (deleting a run's trail). Everything else non-GET is 405.
  if (req.method !== 'GET' && req.method !== 'DELETE') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return; }

  let url;
  try { url = new URL(req.url, `http://127.0.0.1:${port}`); } catch { sendText(res, 400, 'bad url'); return; }
  const seg = url.pathname.split('/').filter(Boolean);
  // DELETE is accepted ONLY for the exact run-delete route — no other path may be reached with it.
  if (req.method === 'DELETE' && !(seg[0] === 'api' && seg[1] === 'runs' && seg.length === 3)) { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return; }

  // The page itself carries no data — serve it token-free with a strict CSP so the operator
  // always reaches the viewer; it then reads the token from its own URL for the data calls.
  if (seg.length === 0) { serveFile(res, path.join(HERE, 'admin.html'), 'text/html; charset=utf-8', { 'content-security-policy': HTML_CSP }); return; }
  // The scrubber geometry module, same-origin + token-free (it is code, not run data), so the
  // page's `script-src 'self'` can import it. Fixed basename only — no path from the request.
  if (seg.length === 1 && seg[0] === 'scrub-math.mjs') { serveFile(res, path.join(HERE, 'scrub-math.mjs'), 'text/javascript; charset=utf-8'); return; }

  if (seg[0] === 'api') {
    // Access token gates ALL data routes — the Host allowlist stops a browser, not a local
    // non-browser client (another user's curl). Screenshots can hold session UI, so require it.
    if (!tokenOk(url, token)) { sendJson(res, 403, { ok: false, error: 'forbidden' }); return; }
    if (seg[1] === 'runs' && seg.length === 2) { sendJson(res, 200, { ok: true, runs: listRuns() }); return; }
    const id = seg[2];
    if (seg[1] === 'runs' && id) {
      if (!RUN_ID.test(id)) { sendJson(res, 400, { ok: false, error: 'bad run id' }); return; }
      // DELETE /api/runs/:id → remove the run's trail dir. Token-gated (checked above), loopback-only, and the
      // resolved path MUST stay strictly inside runsRoot — the load-bearing guard against deleting anything else.
      if (req.method === 'DELETE') {
        const root = path.resolve(runsRoot());
        const dir = path.resolve(runDir(id));
        if (dir === root || !dir.startsWith(root + path.sep)) { sendJson(res, 400, { ok: false, error: 'bad path' }); return; }
        // realpath parity with safeArtifact (L1): refuse a symlinked run dir that resolves OUTSIDE runsRoot.
        // fs.rmSync does not follow symlinks today, but this keeps the guard robust to future option/behavior
        // changes; a missing dir throws → 404 (nothing to delete).
        try {
          const realRoot = fs.realpathSync(root), realDir = fs.realpathSync(dir);
          if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) { sendJson(res, 400, { ok: false, error: 'bad path' }); return; }
        } catch { sendJson(res, 404, { ok: false, error: 'no such run' }); return; }
        try { fs.rmSync(dir, { recursive: true, force: true }); sendJson(res, 200, { ok: true, deleted: id }); }
        catch { sendJson(res, 500, { ok: false, error: 'delete failed' }); }
        return;
      }
      // /api/runs/:id → run.json + the full event trail
      if (seg.length === 3) {
        const run = readJson(path.join(runDir(id), 'run.json'));
        if (!run) { sendJson(res, 404, { ok: false, error: 'no such run' }); return; }
        sendJson(res, 200, { ok: true, run, events: readEvents(id) }); return;
      }
      // /api/runs/:id/graph/:seq → a graph snapshot
      if (seg[3] === 'graph' && SEQ.test(seg[4] || '')) {
        const f = safeArtifact(id, 'graph', `${seg[4]}.json`);
        if (!f) { sendJson(res, 400, { ok: false, error: 'bad path' }); return; }
        serveFile(res, f, 'application/json; charset=utf-8'); return;
      }
      // /api/runs/:id/shots/:file → a key-frame PNG
      if (seg[3] === 'shots' && SHOT.test(seg[4] || '')) {
        const f = safeArtifact(id, 'shots', seg[4]);
        if (!f) { sendJson(res, 400, { ok: false, error: 'bad path' }); return; }
        serveFile(res, f, 'image/png'); return;
      }
    }
    sendJson(res, 404, { ok: false, error: 'unknown route' }); return;
  }
  sendText(res, 404, 'not found');
}

export function startAdmin({ port = 7666, token } = {}) {
  // A per-startup access token (unless the caller injects one, e.g. a test). It gates every
  // /api route and rides in the URL the operator opens.
  const tok = token || crypto.randomBytes(16).toString('hex');
  // `bound` is read at REQUEST time (the closure captures the variable, not the value), so an
  // ephemeral port (listen 0, used by tests) still matches the Host-guard once listen resolves.
  let bound = port;
  const server = http.createServer((req, res) => {
    try { handle(req, res, { port: bound, token: tok }); }
    // Generic 500 — never reflect err.message (could leak a filesystem path); guard against a
    // second write if a branch already sent headers before throwing.
    catch { if (!res.headersSent) sendText(res, 500, 'internal error'); else res.end(); }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      bound = server.address().port;
      resolve({ server, port: bound, token: tok, url: `http://127.0.0.1:${bound}/?t=${tok}` });
    });
  });
}

async function main() {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const port = portArg ? Number(portArg.split('=')[1]) : 7666;
  // Optional fixed token via env (NOT argv — argv is visible in `ps`): lets a restart keep the SAME URL the
  // operator already opened, instead of minting a new token and breaking their tab. Absent → random per start.
  const token = process.env.BUGHUNTER_ADMIN_TOKEN || undefined;
  try {
    const { url } = await startAdmin({ port, token });
    process.stdout.write(JSON.stringify({ ok: true, url }) + '\n');
  } catch (err) {
    process.stderr.write(JSON.stringify({ ok: false, error: err?.message || 'listen failed' }) + '\n');
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
