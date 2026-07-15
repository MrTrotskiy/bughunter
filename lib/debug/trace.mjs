// Debug-capture trail for a Phase-1 run: one append-only NDJSON event stream + per-step
// graph snapshots + per-act key-frames, so the admin can replay a run (graph growth, the
// agent's walk, logs, speed, screenshots). This is the SINGLE writer of the trail, mirroring
// graph-store as the single writer of the graph — the admin only READS what lands here.
//
// CAUSAL SAFETY: the capture collaborator (makeCapture) is called by actStep ONLY while the
// cause token is __idle__ (before beginCause / after endCause), and every frame is a
// VIEWPORT screenshot (fullPage:false) that scrolls nothing — so it fires no page request
// and can never forge a phantom causal edge. Timings are Node-side performance.now(), inert.

import fs from 'node:fs';
import path from 'node:path';

function stateDir() {
  return process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state');
}
export function runsRoot() { return path.join(stateDir(), 'runs'); }
export function runDir(runId) { return path.join(runsRoot(), runId); }

// r-<YYYYMMDDHHMMSS>-<rand4> — sortable + collision-resistant (ref A's scheme).
export function mintRunId() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `r-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeJson(f, o) { fs.writeFileSync(f, JSON.stringify(o, null, 2)); }
// The run's dir layout: shots/ (key-frames) + graph/ (per-step snapshots). Cheap to
// re-assert (recursive mkdir is a no-op when present), so every writer calls it first —
// the trail has no fixed process ordering (frontier-cli / whats-new / observe are
// separate processes in the agent path), so no single writer can be trusted to have run.
// BEST-EFFORT: never throws. The trail is an opt-in diagnostic that "rides ALONG" the
// crawl — a full disk / EACCES here must NOT propagate into the acting CLIs, else it would
// skip the real saveGraph (dropping a causal edge) or trip reconLoop's catch (falsely
// marking an acted control unreachable — the honest-coverage invariant). Same discipline
// as makeCapture/snapshotGraph, which already swallow.
function ensureDirs(runId) {
  const dir = runDir(runId);
  try {
    fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'graph'), { recursive: true });
    // bodies/ can hold redacted request/response payloads from an authed crawl — keep it
    // owner-only (0700), matching the storageState/session.json discipline.
    fs.mkdirSync(path.join(dir, 'bodies'), { recursive: true, mode: 0o700 });
  } catch {}
  return dir;
}

// Open a run: create its dirs and write run.json. Idempotent — re-opening an existing
// run PRESERVES its original startedAt (so a second opener, or a stale re-run, cannot
// rewind the clock), only refreshing target/status. Best-effort (never throws).
export function openRun({ runId, target }) {
  const dir = ensureDirs(runId);
  const f = path.join(dir, 'run.json');
  const prior = readJson(f);
  try {
    writeJson(f, {
      id: runId,
      target: target || prior?.target || null,
      startedAt: prior?.startedAt || new Date().toISOString(),
      status: 'running',
    });
  } catch {}
  return runId;
}

// Append one {seq, ts, kind, payload}. seq = current line count (acts are strictly
// sequential across the CLI processes, so appends never interleave). Returns the seq.
// BEST-EFFORT: a write failure returns the computed seq without throwing — the trail is a
// diagnostic, never a reason to abort or corrupt the crawl (see ensureDirs).
export function traceEvent(runId, kind, payload = {}) {
  ensureDirs(runId); // no ordering guarantee across the agent-path CLIs — assert the dir
  const file = path.join(runDir(runId), 'events.ndjson');
  let seq = 0;
  try { seq = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch {}
  try { fs.appendFileSync(file, JSON.stringify({ seq, ts: Date.now(), kind, payload }) + '\n'); } catch {}
  return seq;
}

// Copy the whole graph.json as it stands after step `seq`, so the admin can scrub graph
// GROWTH over the walk. Cheap: graph-store already rewrites the full file each step.
export function snapshotGraph(runId, seq) {
  ensureDirs(runId);
  const src = path.join(stateDir(), 'graph.json');
  try { if (fs.existsSync(src)) fs.copyFileSync(src, path.join(runDir(runId), 'graph', `${seq}.json`)); } catch {}
}

export function closeRun(runId, summary = {}) {
  const f = path.join(runDir(runId), 'run.json');
  const run = readJson(f) || { id: runId };
  writeJson(f, { ...run, ...summary, finishedAt: new Date().toISOString(), status: 'done' });
}

// The capture collaborator injected into actStep. Frames are named by templateId (a
// template is acted at most once per run — markExplored), so no fragile parallel index.
// before(): viewport shot + the target's rect (the highlight box, "what it's about to act
// on"). after(): viewport shot post-settle (the effect — a revealed modal / new rows).
export function makeCapture(runId, templateId) {
  const dir = ensureDirs(runId);
  const shoot = async (page, name) => {
    const rel = `shots/${name}.png`;
    try { await page.screenshot({ path: path.join(dir, rel), fullPage: false }); return rel; } catch { return null; }
  };
  // Write one already-redacted body string to bodies/ and return its rel path (best-effort,
  // like shoot). The redaction happened at capture time (redact.mjs); only redacted bytes
  // ever reach disk. .json vs .txt is a viewer hint from the mimeType.
  const writeBody = (name, content, ext) => {
    const rel = `bodies/${name}.${ext}`;
    // 0600 — the body may carry redacted-but-still-sensitive session material from an authed run.
    try { fs.writeFileSync(path.join(dir, rel), String(content), { mode: 0o600 }); return rel; } catch { return null; }
  };
  return {
    before: async (page, handle) => {
      const rect = await handle.boundingBox().catch(() => null);
      // viewport CSS size lets the admin place the rect box independent of devicePixelRatio:
      // the shot covers exactly this CSS box (scaled by dpr), so rect maps linearly onto the
      // rendered <img> as rect.x * imgClientWidth / viewport.width.
      const viewport = page.viewportSize();
      return { shot: await shoot(page, `t${templateId}-before`), rect, viewport };
    },
    after: async (page) => ({ shot: await shoot(page, `t${templateId}-after`) }),
    // Bodies for one act's kept fires. Each record { method, urlPattern, mimeType, reqBody?,
    // respBody? } becomes a REF { method, urlPattern, reqBody?, respBody? } whose body fields
    // are FILE PATHS, not bytes — so the raw (redacted) body lands on disk and only the ref
    // rides events.ndjson / res.debug. Mirrors how screenshots are written to files with refs.
    bodies: (records) => (records || []).map((r, i) => {
      const ext = /json/i.test(r.mimeType || '') ? 'json' : 'txt';
      const ref = { method: r.method, urlPattern: r.urlPattern };
      if (r.reqBody != null) ref.reqBody = writeBody(`t${templateId}-${i}-req`, r.reqBody, ext);
      if (r.respBody != null) ref.respBody = writeBody(`t${templateId}-${i}-resp`, r.respBody, ext);
      return ref;
    }),
  };
}
