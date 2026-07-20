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

// THE RUN IS ALWAYS LOGGED (operator rule 2026-07-18: "logs are always mandatory"). Previously the
// trail was opt-in — no BUGHUNTER_RUN_ID meant a crawl clicked its way through an app leaving no
// record of what it touched, which is indefensible for a mode that now commits real writes.
//
// So: return the operator's run id when set, else MINT one and publish it into the environment, so
// every downstream CLI in the agent path (whats-new / observe / route-cli are separate processes)
// joins the SAME run rather than each minting its own and fragmenting the trail.
export function activeRunId(env = process.env) {
  if (env.BUGHUNTER_RUN_ID) return env.BUGHUNTER_RUN_ID;
  const id = mintRunId();
  env.BUGHUNTER_RUN_ID = id;
  return id;
}

// SCREENSHOTS are the one part of the trail that stays opt-in ("screens are rational when the run is
// started in view mode"): key-frames cost real time and disk per act, and are only ever consumed by
// the admin viewer. Events are the record; frames are a convenience for looking at it.
export function viewMode(env = process.env) {
  return env.BUGHUNTER_VIEW === '1';
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function writeJson(f, o) { fs.writeFileSync(f, JSON.stringify(o, null, 2)); }
// The run's dir layout: shots/ (key-frames) + graph/ (per-step snapshots). Cheap to
// re-assert (recursive mkdir is a no-op when present), so every writer calls it first —
// the trail has no fixed process ordering (frontier-cli / whats-new / observe are
// separate processes in the agent path), so no single writer can be trusted to have run.
// THROWS. The trail is no longer an opt-in diagnostic riding along the crawl — it is the record of
// what the crawl DID, and a run that cannot write its record must stop, not continue unlogged.
//
// The old best-effort swallow existed to protect honest coverage: a throw here would trip reconLoop's
// catch and falsely mark an acted control `unreachable`. That concern is real, and is handled at the
// RIGHT layer instead — `openRun` proves the trail is writable BEFORE the crawl acts (fail-fast, with
// nothing yet mis-attributed), so a mid-crawl failure means the disk genuinely died mid-run, and
// stopping is then the correct outcome rather than silently losing the log of live mutations.
function ensureDirs(runId) {
  const dir = runDir(runId);
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'graph'), { recursive: true });
  // bodies/ can hold redacted request/response payloads from an authed crawl — keep it
  // owner-only (0700), matching the storageState/session.json discipline.
  fs.mkdirSync(path.join(dir, 'bodies'), { recursive: true, mode: 0o700 });
  // skel/ holds DOM-skeleton JSON — the schematic stand-in for a screenshot on the FAILURE path,
  // where key-frames structurally do not exist (measured on raw1: shots on 140/141 successful acts
  // and 0/146 failures). It carries rendered text and rects of a possibly-logged-in app, so it is
  // the same class of artifact as shots/ and is served under the same containment fence.
  fs.mkdirSync(path.join(dir, 'skel'), { recursive: true });
  return dir;
}

// Open a run: create its dirs and write run.json. Idempotent — re-opening an existing
// run PRESERVES its original startedAt (so a second opener, or a stale re-run, cannot
// rewind the clock), only refreshing target/status. Best-effort (never throws).
// THROWS on an unwritable trail — deliberately, and BEFORE the crawl touches the target. This is the
// fail-fast point that lets every later writer throw honestly: if the log cannot be written, we find
// out with zero acts performed and nothing mis-attributed, rather than discovering it after a run has
// already committed writes it failed to record.
export function openRun({ runId, target }) {
  const dir = ensureDirs(runId);
  const f = path.join(dir, 'run.json');
  const prior = readJson(f);
  writeJson(f, {
    id: runId,
    target: target || prior?.target || null,
    startedAt: prior?.startedAt || new Date().toISOString(),
    status: 'running',
  });
  // Prove the EVENT stream itself is appendable, not merely that the directory exists — the failure
  // that matters is a read-only mount / full disk at append time, which mkdir alone would not catch.
  fs.appendFileSync(path.join(dir, 'events.ndjson'), '');
  return runId;
}

// Append one {seq, ts, kind, payload}. Returns the seq.
//
// seq is a per-process MONOTONE COUNTER, seeded ONCE per run from the lines already on disk (so a
// resumed run continues instead of restarting at 0), incremented in memory after — O(1), where
// re-deriving it by reading the WHOLE file per append was O(n^2) (~6.5 min at 51k events). The old
// premise "acts are strictly sequential across the CLI processes, so appends never interleave" is
// enforced by NOTHING: whats-new / observe / route-cli are separate processes joined only by
// BUGHUNTER_RUN_ID, with no lock. So seq is a HINT, NOT A PRIMARY KEY. A tie survives the append
// (one O_APPEND write each) but destroyed a graph SNAPSHOT, which used seq as its filename — the
// second writer silently overwrote the first's graph state. snapshotGraph now suffixes the pid.
//
// THROWS on a failed append (operator rule: logs are always mandatory). An act that happened but was
// not recorded is worse than a stopped crawl — especially now that acts commit real creates, edits and
// deletes. The missing-file read below still swallows: a fresh run has no events.ndjson yet, and that
// is the normal first-append path, not a failure.
const seqByRun = new Map(); // run DIR (not id) -> next seq, so a BUGHUNTER_STATE_DIR switch re-seeds
export function traceEvent(runId, kind, payload = {}) {
  ensureDirs(runId); // no ordering guarantee across the agent-path CLIs — assert the dir
  const dir = runDir(runId);
  const file = path.join(dir, 'events.ndjson');
  let seq = seqByRun.get(dir);
  if (seq === undefined) {
    seq = 0;
    try { seq = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch {}
  }
  fs.appendFileSync(file, JSON.stringify({ seq, ts: Date.now(), kind, payload }) + '\n');
  seqByRun.set(dir, seq + 1); // advance only on a SUCCESSFUL append — a throw leaves no seq gap
  return seq;
}

// Read the per-window instance-level PROGRESS history off a run's trail: the ordered
// `walked + unreachable + walkable` from every `frontier.emit` event whose payload carries a
// numeric instanceStats, oldest→newest. The loop-control verdict (decideProgress) reads this to
// detect a stall. Progress is MONOTONE (walked grows on an explore, unreachable on a failed act,
// walkable on a discovery), so it is flat ONLY when nothing was explored, failed, or discovered
// (the true stall) — unlike `remaining`, which sits flat on a balanced drain+discovery plateau
// and thus FALSE-stalled a still-progressing crawl. Events without numeric instanceStats fields
// (older trails / capture off) are skipped, so an upgraded run mid-crawl never yields a NaN into
// the stall math. Reads the SAME runDir(runId)/events.ndjson path traceEvent writes.
// BEST-EFFORT: any read/parse error → [] (swallow-never-throw, matching the rest of this file).
export function readFrontierProgress(runId) {
  const file = path.join(runDir(runId), 'events.ndjson');
  const out = [];
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.kind !== 'frontier.emit') continue;
      const s = ev.payload?.instanceStats;
      if (s && typeof s.walked === 'number' && typeof s.unreachable === 'number' && typeof s.walkable === 'number') {
        out.push(s.walked + s.unreachable + s.walkable);
      }
    }
  } catch {}
  return out;
}

// Read the per-window CHURN history off a run's trail: the ordered `churnSkipped` (feed rows that
// re-rendered away, frontierInstanceStats) from every `frontier.emit` event whose payload carries a
// numeric instanceStats, oldest→newest. The loop-control verdict (decideProgress) reads this for its
// churn-flat release gate — it must not declare DRAINED while a live feed is still spawning fresh churn.
// Uses the SAME event predicate as readFrontierProgress (walked/unreachable/walkable numeric) so the two
// histories align one-to-one per window; an older sample without churnSkipped contributes 0 (conservative,
// never a NaN into the flat-check). BEST-EFFORT: any read/parse error → [] (swallow-never-throw).
export function readFrontierChurn(runId) {
  const file = path.join(runDir(runId), 'events.ndjson');
  const out = [];
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.kind !== 'frontier.emit') continue;
      const s = ev.payload?.instanceStats;
      if (s && typeof s.walked === 'number' && typeof s.unreachable === 'number' && typeof s.walkable === 'number') {
        out.push(typeof s.churnSkipped === 'number' ? s.churnSkipped : 0);
      }
    }
  } catch {}
  return out;
}

// The lexicographically-largest run dir name under runsRoot(). runIds are sortable
// `r-<YYYYMMDDHHMMSS>-<rand>`, so the max name is the most recent run — report --unreached
// falls back to this when no run is named on the CLI or in the env. Only names starting with
// `r-` count (ignore stray files), matching mintRunId's scheme.
// BEST-EFFORT: no runs dir / unreadable → null (swallow-never-throw, like the rest of this file).
export function latestRunId() {
  try {
    const names = fs.readdirSync(runsRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('r-'))
      .map((d) => d.name)
      .sort();
    return names.length ? names[names.length - 1] : null;
  } catch { return null; }
}

// The ordered `act.failed` fire-failures off a run's trail — each event's granular code plus
// its context ({templateId, instance, code, message}), oldest→newest. report --unreached
// PREFERS these over the graph's COARSE unreachable reason (observe stamps only
// unreachable-coldstart / not-visible, so the precise NO_INSTANCE / NOT_VISIBLE / REVEAL_*
// code that whats-new's catch wrote lives ONLY here). Reads the SAME runDir(runId)/events.ndjson
// path traceEvent writes. BEST-EFFORT: any read/parse error → [] (swallow-never-throw).
export function readActFailed(runId) {
  const file = path.join(runDir(runId), 'events.ndjson');
  const out = [];
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.kind !== 'act.failed') continue;
      const p = ev.payload || {};
      out.push({ templateId: p.templateId, instance: p.instance ?? null, code: p.code, message: p.message });
    }
  } catch {}
  return out;
}

// Copy the whole graph.json as it stands after step `seq`, so the admin can scrub graph
// GROWTH over the walk. Cheap: graph-store already rewrites the full file each step.
// The filename carries the PID because `seq` is only a per-process hint (see traceEvent): two
// agent-path CLIs can derive the same seq, and `${seq}.json` alone meant the second copyFileSync
// silently DESTROYED the first's snapshot. Readers accept the legacy bare `${seq}.json` too
// (admin-server resolves the newest match), so runs already on disk still render unmigrated.
export function snapshotGraph(runId, seq) {
  ensureDirs(runId);
  const src = path.join(stateDir(), 'graph.json');
  try { if (fs.existsSync(src)) fs.copyFileSync(src, path.join(runDir(runId), 'graph', `${seq}-${process.pid}.json`)); } catch {}
}

export function closeRun(runId, summary = {}) {
  const f = path.join(runDir(runId), 'run.json');
  const run = readJson(f) || { id: runId };
  writeJson(f, { ...run, ...summary, finishedAt: new Date().toISOString(), status: 'done' });
}

// Write one DOM skeleton (lib/graph/dom-skeleton.mjs) to skel/ and return its relative ref,
// mirroring makeCapture's writeBody: the bytes land on disk and only the REF rides the event
// stream, so a 400-node skeleton never bloats events.ndjson.
//
// Called from a CATCH BLOCK on the act failure path, so it follows the skeleton module's own rule
// rather than this file's throw-on-failed-write discipline: BEST-EFFORT, null on any error. That
// exception is deliberate and narrow. The operator rule "logs are always mandatory" protects the
// RECORD OF WHAT THE CRAWL DID — the event stream, which already recorded the failure by the time
// we get here. This is supplementary evidence ABOUT an already-logged failure, and throwing here
// would replace a real, informative act.failed error with a disk error about its illustration.
//
// The stem is SANITIZED, not trusted. It is the write-side twin of admin-server's SKEL filename
// regex + resolved-path containment: a caller that interpolated a route or an element name into
// the stem must not be able to write outside the run's own skel/ dir. Three passes, each closing a
// different door: any character outside [A-Za-z0-9._-] becomes `_` (kills every path separator, so
// the name is a leaf and nothing else), runs of dots collapse to one (so `..` cannot survive
// anywhere in the name, not merely at the front), and leading dots are stripped (no dotfiles).
// Length-bounded last, so truncation can never re-expose a trailing `..`.
export function writeSkeleton(runId, stem, skeleton) {
  if (!skeleton) return null;
  const safe = String(stem || 'skel')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .slice(0, 80) || 'skel';
  try {
    const dir = ensureDirs(runId);
    const rel = `skel/${safe}.json`;
    // 0600 — a skeleton carries rendered text and layout from a possibly-authed page, the same
    // sensitivity class as bodies/ and shots/.
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(skeleton), { mode: 0o600 });
    return rel;
  } catch { return null; }
}

// The capture collaborator injected into actStep. Frames are named by templateId (a
// template is acted at most once per run — markExplored), so no fragile parallel index.
// before(): viewport shot + the target's rect (the highlight box, "what it's about to act
// on"). after(): viewport shot post-settle (the effect — a revealed modal / new rows).
// SCREENSHOTS are gated on VIEW MODE (`BUGHUNTER_VIEW=1`) while events are not: a frame costs real
// wall-clock and disk on every act and is only ever looked at through the admin viewer, whereas the
// event stream is the run's record and is always written. Outside view mode `shoot` returns null and
// the act's `shots` ride as nulls — the admin already renders a frameless step (it does so today for
// a failed act), so nothing downstream breaks.
// Monotonic per-process capture counter. Frames used to be named `t<templateId>-before`, on the
// assumption that a template is acted at most once per run — which the drain predicate happened to
// guarantee. The moment an element gets more than one probe (the whole point of studying an element
// rather than touching it), the second frame silently OVERWRITES the first and the evidence for the
// earlier probe is gone with no error. Prefixing the capture ordinal keeps every frame, in order.
let captureSeq = 0;

export function makeCapture(runId, templateId) {
  const dir = ensureDirs(runId);
  const n = ++captureSeq;
  const stem = `a${String(n).padStart(4, '0')}-t${templateId}`;
  const shoot = async (page, name) => {
    if (!viewMode()) return null;
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
      return { shot: await shoot(page, `${stem}-before`), rect, viewport };
    },
    after: async (page) => ({ shot: await shoot(page, `${stem}-after`) }),
    // Bodies for one act's kept fires. Each record { method, urlPattern, mimeType, reqBody?,
    // respBody? } becomes a REF { method, urlPattern, reqBody?, respBody? } whose body fields
    // are FILE PATHS, not bytes — so the raw (redacted) body lands on disk and only the ref
    // rides events.ndjson / res.debug. Mirrors how screenshots are written to files with refs.
    bodies: (records) => (records || []).map((r, i) => {
      const ext = /json/i.test(r.mimeType || '') ? 'json' : 'txt';
      const ref = { method: r.method, urlPattern: r.urlPattern };
      if (r.reqBody != null) ref.reqBody = writeBody(`${stem}-${i}-req`, r.reqBody, ext);
      if (r.respBody != null) ref.respBody = writeBody(`${stem}-${i}-resp`, r.respBody, ext);
      return ref;
    }),
  };
}
