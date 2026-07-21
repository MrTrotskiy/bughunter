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
//    path MUST stay inside the run's own shots/, graph/ or skel/ dir, AND a realpath check
//    refuses a symlink that escapes it (anti path-traversal, defense-in-depth).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runsRoot, runDir } from './trace.mjs';
import { frontierInstanceStats } from '../recon/frontier.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// A run id is either minted (`r-<14 digits>-<4>`) or SUPPLIED BY THE OPERATOR: `trace.mjs` returns
// `env.BUGHUNTER_RUN_ID` verbatim, so a crawl started with `BUGHUNTER_RUN_ID=nightly-2` writes a perfectly
// good trail. Accepting only the minted shape made every such run INVISIBLE here — the viewer silently
// skipped it in listRuns and 400'd its artifacts — so the operator who names his runs (the normal way to
// tell one from another) could not open any of them. The trail was written and unreadable.
// Kept strict where it matters: the charset excludes `.`, `/` and `\`, so no id can traverse out of the
// runs dir, and the resolved-path containment check below remains the load-bearing guard regardless.
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SEQ = /^[0-9]{1,9}$/;                        // a step index
const SHOT = /^[A-Za-z0-9._-]+\.png$/;             // a key-frame filename, no path parts
// A DOM-skeleton filename (skel/, trace.writeSkeleton). Same shape and same reasoning as SHOT:
// the charset excludes `/` and `\`, so no name can carry a path part, and `..` alone fails the
// `\.json` tail. As with shots, the regex is the cheap first gate and safeArtifact's resolved-path
// containment remains the load-bearing guard.
const SKEL = /^[A-Za-z0-9._-]+\.json$/;
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
    // `trailBytes` (additive) is how the page tells an ABORTED zero-event run from a real one
    // WITHOUT reading every trail on every poll: runs sort newest-first, the newest are usually
    // the aborted ones, and defaulting to runs[0] showed the operator a blank viewer. A stat is
    // O(1) per run; the line count would be O(events). 0 (or a missing file) === empty.
    let trailBytes = 0;
    try { trailBytes = fs.statSync(path.join(runDir(id), 'events.ndjson')).size; } catch { /* no trail written */ }
    if (run) runs.push({ ...run, trailBytes });
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

// Resolve a graph snapshot by step index. trace.mjs writes `<seq>-<pid>.json` (the pid makes two
// agent-path processes that tie on seq collision-proof — seq is a monotone HINT, not a key), while
// the 49 runs already on disk carry the legacy bare `<seq>.json`. BOTH are accepted and the NEWEST
// match wins; nothing is migrated or rewritten. The pid suffix is matched WITHOUT building a regex
// from the request (digits only, checked structurally), and every candidate still goes through
// safeArtifact — the resolved-path containment check stays the load-bearing guard.
function graphSnapshotFile(id, seq) {
  let names;
  try { names = fs.readdirSync(path.resolve(runDir(id), 'graph')); } catch { return null; }
  let best = null, bestAt = -1;
  for (const n of names) {
    const exact = n === `${seq}.json`;
    const suffixed = n.startsWith(`${seq}-`) && /^[0-9]{1,10}\.json$/.test(n.slice(seq.length + 1));
    if (!exact && !suffixed) continue;
    const f = safeArtifact(id, 'graph', n);
    if (!f) continue;
    let at; try { at = fs.statSync(f).mtimeMs; } catch { continue; }
    if (at > bestAt) { bestAt = at; best = f; }
  }
  return best;
}

// THE INSTANCE-LEVEL COVERAGE NUMBERS, COMPUTED SERVER-SIDE ON PURPOSE.
//
// The viewer's headline printed `118/295` under «изучено контролов» — TEMPLATE counts, while a
// template is not a control (a 50-row table is one template and 50 addressable instances). The honest
// number is instance-level, and the rules that produce it (the opener cap, the list-row drill, the
// authored-site split, the widget peel, the churn peel) are owned by lib/recon/frontier.mjs.
//
// WHY HERE AND NOT IN THE PAGE. The alternative was allowlisting frontier.mjs as a browser module —
// which also means allowlisting its transitive imports (location-key.mjs, knowledge.mjs), i.e. three
// more fixed-basename branches shipping recon internals to the browser and a second place where those
// imports must be kept in sync. Computing it here is ONE node import of the module that owns the
// rules, so the viewer re-implements nothing. Re-deriving a cap rule inside the viewer is exactly the
// drift class this change exists to kill (cf. the dead `contentSig` detector).
//
// The graph is the run's OWN newest snapshot (trace writes one per step), never state/graph.json —
// that file belongs to whichever run wrote it last and would explain this run with another's numbers.
// Memoized on file+mtime: a live run re-polls every 2.5s and a snapshot is ~1 MB to parse; the newest
// file changes as the run grows, so the key invalidates itself and a finished run parses once.
const STATS_MEMO = new Map();
function instanceStatsFor(id) {
  let names;
  try { names = fs.readdirSync(path.resolve(runDir(id), 'graph')); } catch { return null; }
  let best = null, bestSeq = -1;
  for (const n of names) {
    const m = /^([0-9]{1,9})(?:-[0-9]{1,10})?\.json$/.exec(n);
    if (!m) continue;
    const seq = Number(m[1]);
    if (seq > bestSeq) { bestSeq = seq; best = n; }
  }
  if (!best) return null;
  const file = safeArtifact(id, 'graph', best);
  if (!file) return null;
  let mtime;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  const ck = file + ':' + mtime;
  if (STATS_MEMO.has(ck)) return STATS_MEMO.get(ck);
  let out = null;
  try {
    const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (graph && graph.elements) {
      // The DENOMINATOR is a plain count of what is on disk, not a rule: every instance of every
      // template. frontierInstanceStats partitions exactly this population, so the viewer can assert
      // the split sums with zero residue instead of trusting it.
      let instances = 0;
      for (const el of Object.values(graph.elements)) instances += ((el && el.instances) || []).length;
      out = { ...frontierInstanceStats(graph), instances, templates: Object.keys(graph.elements).length, atSeq: bestSeq };
    }
  } catch { out = null; }        // a half-written snapshot on a live run → null, never a wrong number
  STATS_MEMO.clear();            // one run open at a time; bounded by construction
  STATS_MEMO.set(ck, out);
  return out;
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
  // The «Конвейер» tab's module — same rule, same reasoning: code, not run data, so token-free,
  // and a FIXED basename so no path from the request ever reaches the filesystem. Without this
  // branch the page's `import './pipeline-view.mjs'` 404s and the whole tab silently never mounts.
  if (seg.length === 1 && seg[0] === 'pipeline-view.mjs') { serveFile(res, path.join(HERE, 'pipeline-view.mjs'), 'text/javascript; charset=utf-8'); return; }
  // The viewer CHROME module split out of pipeline-view.mjs (theme/sidebar/stubs) — same rule again:
  // code, not run data, so token-free, FIXED basename. pipeline-view.mjs re-exports from it, so the page
  // fetches it transitively; without this branch that transitive import 404s and the whole shell fails to mount.
  if (seg.length === 1 && seg[0] === 'pipeline-shell.mjs') { serveFile(res, path.join(HERE, 'pipeline-shell.mjs'), 'text/javascript; charset=utf-8'); return; }
  // The failure taxonomy — same rule again: code, not run data, so token-free, FIXED basename. Both
  // the page and pipeline-view.mjs import it, so a missing branch here would 404 the module and take
  // the whole explanation layer down with it (the page falls back to nothing, not to the old guesser).
  if (seg.length === 1 && seg[0] === 'failure-hints.mjs') { serveFile(res, path.join(HERE, 'failure-hints.mjs'), 'text/javascript; charset=utf-8'); return; }
  // The per-kind row sentences (row-vocabulary.mjs) — same rule again: code, not run data, so
  // token-free, FIXED basename. pipeline-view.mjs imports it, so a missing branch here would 404 the
  // module and take the «Конвейер» row labels down with it (every protocol row reverts to a bare kind).
  if (seg.length === 1 && seg[0] === 'row-vocabulary.mjs') { serveFile(res, path.join(HERE, 'row-vocabulary.mjs'), 'text/javascript; charset=utf-8'); return; }
  // The walk's TEXT module split out of admin.html (every sentence and number the Прогоны walk
  // prints) — same rule again: code, not run data, so token-free, FIXED basename. Without this branch
  // the page's `import './walk-view.mjs'` 404s under `script-src 'self'` and the walk mounts nothing.
  if (seg.length === 1 && seg[0] === 'walk-view.mjs') { serveFile(res, path.join(HERE, 'walk-view.mjs'), 'text/javascript; charset=utf-8'); return; }

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
      // /api/runs/:id → run.json + the full event trail + the instance-level coverage split
      // (`instanceStats`, see instanceStatsFor). Shipped as a SIBLING of `run`, not merged into it:
      // run.json is the crawl's own artifact and the viewer must not appear to have rewritten it.
      // null when the run wrote no graph snapshot — the page then says so instead of inventing one.
      if (seg.length === 3) {
        const run = readJson(path.join(runDir(id), 'run.json'));
        if (!run) { sendJson(res, 404, { ok: false, error: 'no such run' }); return; }
        sendJson(res, 200, { ok: true, run, events: readEvents(id), instanceStats: instanceStatsFor(id) }); return;
      }
      // /api/runs/:id/graph/:seq → a graph snapshot (either filename shape, newest match)
      if (seg[3] === 'graph' && SEQ.test(seg[4] || '')) {
        const f = graphSnapshotFile(id, seg[4]);
        if (!f) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
        serveFile(res, f, 'application/json; charset=utf-8'); return;
      }
      // /api/runs/:id/shots/:file → a key-frame PNG
      if (seg[3] === 'shots' && SHOT.test(seg[4] || '')) {
        const f = safeArtifact(id, 'shots', seg[4]);
        if (!f) { sendJson(res, 400, { ok: false, error: 'bad path' }); return; }
        serveFile(res, f, 'image/png'); return;
      }
      // /api/runs/:id/skel/:file → a DOM skeleton (the schematic stand-in for a key-frame on the
      // FAILURE path, where screenshots structurally do not exist). safeArtifact is reused
      // UNCHANGED — its resolved-path + realpath containment is what stops traversal, and it is
      // the reason this branch needs no traversal logic of its own.
      if (seg[3] === 'skel' && SKEL.test(seg[4] || '')) {
        const f = safeArtifact(id, 'skel', seg[4]);
        if (!f) { sendJson(res, 400, { ok: false, error: 'bad path' }); return; }
        serveFile(res, f, 'application/json; charset=utf-8'); return;
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
