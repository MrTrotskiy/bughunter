#!/usr/bin/env node
// build.mjs — reproducible masker for the golden-trail fixture.
//
// Reads a REAL run (fix1, isolated tmp state dir), keeps a small ordered slice
// (~130 events) that witnesses every case the Stage-2 viewer-truth gate needs,
// masks all sensitive identifiers CONSISTENTLY (same input -> same placeholder,
// so joins survive), preserves every diagnostic field BYTE-FOR-BYTE, and writes
// the committed fixture. A self-check at the bottom fails loudly on any leak or
// any missing required case.
//
// The committed OUTPUT is what the test depends on; this script depends on the
// tmp source and is only re-run to regenerate. Run:  node build.mjs
//
// SEE README.md for the fixture contract (case -> witnessing seq).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- source (real run fix1, isolated state dir — never modified) -----------
const SRC = '/Users/anton/.claude/jobs/8e41b100/tmp/state-fix1';
const SRC_RUN = path.join(SRC, 'runs/fix1');
const SRC_EVENTS = path.join(SRC_RUN, 'events.ndjson');
const SRC_GRAPH_DIR = path.join(SRC_RUN, 'graph');
const SRC_RUN_JSON = path.join(SRC_RUN, 'run.json');
const SRC_FINAL_GRAPH = path.join(SRC, 'graph.json');

// ---- output ----------------------------------------------------------------
const OUT_EVENTS = path.join(HERE, 'events.ndjson');
const OUT_GRAPH_DIR = path.join(HERE, 'graph');
const OUT_RUN_JSON = path.join(HERE, 'run.json');
const OUT_FINAL_GRAPH = path.join(HERE, 'graph.json');
const OUT_MANIFEST = path.join(HERE, 'manifest.json');

// ---- the slice: contiguous windows chosen so every required case has a witness
// (see README for which window carries which case). Order is preserved; every
// graph snapshot referenced by a kept route/act event is copied.
// Windows are kept tight, and deliberately AVOID incidental route/act events
// (each writes a ~0.3-0.5 MB cumulative graph snapshot). Only the snapshots a
// case truly needs are pulled: the 3 small opening ones, the two entry-route
// mislabel witnesses (587, 893), and the 500-act witness (694). Every non-
// snapshot witness (act.failed, pick-empty, reopen, …) sits in an act-free
// range, so the committed fixture stays ~1.3 MB of graph, not 10 MB.
const WINDOWS = [
  [0, 7],       // route(0) / drain-outcome / retire / route-choice / pick / policy-verdict / act(4,7, shots.before=null, 11-req all-200)
  [82, 88],     // pick-empty, drain-outcome, reopen, retire, route-choice (act-free)
  [225, 231],   // act.failed ACT_FAILED (+target.attempts 6-rec, hadRevealPath:false), retire-answered
  [326, 331],   // act.failed DISABLED
  [446, 450],   // act.failed hadRevealPath:true (448)
  [477, 480],   // reopen-delivered
  [587, 587],   // entry-route mislabel A source: snapshot holds 63 instances of the /track_ad route
  [595, 597],   // entry-route mislabel A: drain-outcome acts:0 at 597 (nearest snapshot = 587)
  [674, 678],   // act.failed NO_INSTANCE (675)
  [694, 694],   // act with POST .../addfriendgroup 500 (694) — earliest 500 = smallest snapshot
  [779, 784],   // act.failed OUTWARD_REFUSED
  [853, 858],   // act.failed ALIAS_COLLISION (855)
  [893, 895],   // entry-route mislabel B: route(893) holds 71 instances; drain acts:0 at 895; base64 profile route
  [1091, 1091], // reloc-census (run tail)
];
const inWindows = (seq) => WINDOWS.some(([a, b]) => seq >= a && seq <= b);

// ============================================================================
// 1. Read the full source (maps are built from the FULL run so numbering is
//    stable regardless of which subset is kept).
// ============================================================================
const readNdjson = (p) =>
  fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const allEvents = readNdjson(SRC_EVENTS);
const graphFiles = fs.readdirSync(SRC_GRAPH_DIR).filter((f) => f.endsWith('.json'));
const seqOfFile = (f) => Number(f.split('-')[0]);
const graphFilesSorted = [...graphFiles].sort((a, b) => seqOfFile(a) - seqOfFile(b));
const runJson = JSON.parse(fs.readFileSync(SRC_RUN_JSON, 'utf8'));
const finalGraph = JSON.parse(fs.readFileSync(SRC_FINAL_GRAPH, 'utf8'));

// ============================================================================
// 2. Build the consistent mask maps (deterministic first-encounter order).
// ============================================================================
const ROUTE_FIELDS = new Set(['route', 'from', 'chosen', 'requested', 'url', 'pattern']);
const structuralKey = (v) => /^#\d+$/.test(v);

const hostMap = new Map();   // original host -> placeholder host
const routeMap = new Map();  // page-route path -> /route-a ...
const nameMap = new Map();   // accessible name / label -> Control N
const keyMap = new Map();    // non-structural instanceKey -> key-N
const b64Set = new Set();    // base64 profile segments seen in route paths

const letters = (n) => {
  // 0->a, 25->z, 26->aa ...
  let s = '';
  n += 1;
  while (n > 0) { n -= 1; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
};
const hostOf = (origin) => { try { return new URL(origin).host; } catch { return origin; } };
const mapHost = (host) => {
  if (!hostMap.has(host)) {
    const idx = hostMap.size;
    hostMap.set(host, idx === 0 ? 'app.example.test' : `host-${letters(idx - 1)}.example.test`);
  }
  return hostMap.get(host);
};
let routeCounter = 0;
const mapRoute = (r) => {
  if (r === '/') return '/';
  if (!routeMap.has(r)) routeMap.set(r, `/route-${letters(routeCounter++)}`);
  return routeMap.get(r);
};
const mapName = (n) => {
  if (n === '' || n == null) return n;
  if (!nameMap.has(n)) nameMap.set(n, `Control ${nameMap.size + 1}`);
  return nameMap.get(n);
};
const mapKey = (k) => {
  if (structuralKey(k)) return k;
  if (!keyMap.has(k)) keyMap.set(k, `key-${keyMap.size + 1}`);
  return keyMap.get(k);
};

// Collect base64 profile segments from route paths (>=20 chars, base64 alphabet).
const harvestB64 = (routePath) => {
  for (const seg of routePath.split('/')) {
    if (seg.length >= 20 && /^[A-Za-z0-9+/]+={0,2}$/.test(seg)) b64Set.add(seg);
  }
};

// Pre-scan (target host first so it maps to app.example.test).
mapHost(hostOf(runJson.target));
const preScan = (obj, parentKey) => {
  if (Array.isArray(obj)) { for (const x of obj) preScan(x, parentKey); return; }
  if (obj && typeof obj === 'object') { for (const [k, v] of Object.entries(obj)) preScan(v, k); return; }
  if (typeof obj !== 'string') return;
  if (parentKey === 'origin') mapHost(hostOf(obj));
  if (ROUTE_FIELDS.has(parentKey) && obj.startsWith('/')) { harvestB64(obj); mapRoute(obj); }
  if (parentKey === 'name') mapName(obj);
  if (parentKey === 'instanceKey' || parentKey === 'instance') mapKey(obj);
};
for (const e of allEvents) preScan(e, null);
// graph route keys + element fields (so keys line up with element.route)
for (const f of graphFilesSorted) {
  const g = JSON.parse(fs.readFileSync(path.join(SRC_GRAPH_DIR, f), 'utf8'));
  for (const rk of Object.keys(g.routes || {})) { harvestB64(rk); mapRoute(rk); }
  preScan(g, null);
}
for (const rk of Object.keys(finalGraph.routes || {})) { harvestB64(rk); mapRoute(rk); }
preScan(finalGraph, null);
for (const req of Object.values(finalGraph.requests || {})) for (const o of (req.origins || [])) mapHost(hostOf(o));

// ============================================================================
// 3. Masking transforms.
// ============================================================================
// Global string scrub: neutralise any leaked host / brand / email / base64 /
// ACCOUNT NAME in ANY string value — including free text the field-specific
// maskers never see (fieldFacts.placeholder, title, aria-label, probe text, …).
// scrubString is applied to EVERY string in events, snapshots, run.json and the
// final graph (maskValue's fallthrough), so a token added here is masked
// everywhere. Order matters: hosts before the brand pass (so devapi.<brand>.com
// is gone before the brand -> 'app' rewrite could half-rewrite it), emails
// before bare-username tokens.
// Test-account names (Stierlitz/Stark/rawtest*/Trip1) leak through DOM
// placeholders like "hey <name>, share some …" — same input -> same placeholder
// so cross-file joins survive.
const NAME_TOKENS = [
  [/stierlitz/gi, 'Test User'],
  [/\bstark\b/gi, 'Test User Two'],
  [/\brawtest\w*/gi, 'testacct'],
  [/\btrip1\b/gi, 'testuser'],
];
const scrubString = (s) => {
  let out = s;
  for (const [host, ph] of hostMap) out = out.split(host).join(ph);
  for (const seg of b64Set) out = out.split(seg).join('b64seg');
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'user@example.test');
  out = out.replace(/rawcaster/gi, 'app');
  for (const [re, ph] of NAME_TOKENS) out = out.replace(re, ph);
  return out;
};
// urlPattern (API path): keep shape (:param, verb tail), only scrub host/brand.
const scrubUrlPattern = (s) => scrubString(s);

// Long CSS selectors dominate snapshot size and carry no diagnostic signal the
// gate reads (identity is instanceKey; the truth claims never inspect selector
// bytes). Not preserve-listed, so we truncate them — head kept for readability.
const SELECTOR_KEYS = new Set(['templateSelector', 'instanceSelector', 'selector']);
const looksSelector = (s) => s.length > 100 && (s.includes(' > ') || s.includes(':nth-child'));
const truncSel = (s) => (s.length > 100 ? s.slice(0, 96) + ' …' : s);

const maskValue = (v, key) => {
  if (typeof v === 'string') {
    if (key === 'origin') return mapHost(hostOf(v));
    if (key === 'urlPattern') return scrubUrlPattern(v);
    if (ROUTE_FIELDS.has(key) && v.startsWith('/')) return mapRoute(v);
    if (key === 'name') return scrubString(mapName(v));
    if (key === 'instanceKey' || key === 'instance') return mapKey(v);
    if (SELECTOR_KEYS.has(key)) return truncSel(scrubString(v));
    if (key === 'value' && looksSelector(v)) return truncSel(scrubString(v));
    return scrubString(v);
  }
  return v;
};

const maskNode = (obj, key) => {
  if (Array.isArray(obj)) return obj.map((x) => maskNode(x, key));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = maskNode(v, k);
    return out;
  }
  return maskValue(obj, key);
};

// Remap the top-level dict keys of graph.routes / graph.requests / graph.elements
// where a KEY embeds a route path or a request urlPattern.
const maskGraph = (g) => {
  const m = maskNode(g, null);
  if (g.routes) {
    const routes = {};
    for (const [rk, rv] of Object.entries(m.routes)) routes[ROUTE_FIELDS_KEY(rk)] = rv;
    m.routes = routes;
  }
  if (g.requests) {
    const requests = {};
    for (const [rk, rv] of Object.entries(m.requests)) requests[scrubString(rk)] = rv;
    m.requests = requests;
  }
  return m;
};
// graph.routes keys are page-route paths.
const ROUTE_FIELDS_KEY = (rk) => (rk.startsWith('/') ? mapRoute(rk) : scrubString(rk));

// ============================================================================
// 4. Select + write the slice.
// ============================================================================
const keptEvents = allEvents.filter((e) => inWindows(e.seq));
const keptGraphSeqs = new Set(keptEvents.map((e) => e.seq));

// Masked events, order preserved.
const maskedEvents = keptEvents.map((e) => maskNode(e, null));
fs.writeFileSync(OUT_EVENTS, maskedEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');

// Referenced graph snapshots (route/act events write one keyed by seq).
fs.rmSync(OUT_GRAPH_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_GRAPH_DIR, { recursive: true });
const copiedGraphs = [];
for (const f of graphFilesSorted) {
  const seq = seqOfFile(f);
  if (!keptGraphSeqs.has(seq)) continue;
  const g = JSON.parse(fs.readFileSync(path.join(SRC_GRAPH_DIR, f), 'utf8'));
  fs.writeFileSync(path.join(OUT_GRAPH_DIR, f), JSON.stringify(maskGraph(g)));
  copiedGraphs.push(f);
}

// run.json (mask target host).
const maskedRun = maskNode(runJson, null);
maskedRun.target = runJson.target.replace(hostOf(runJson.target), mapHost(hostOf(runJson.target)));
fs.writeFileSync(OUT_RUN_JSON, JSON.stringify(maskedRun, null, 2));

// final graph.json (notFoundSig preserved; contentSig stays absent).
fs.writeFileSync(OUT_FINAL_GRAPH, JSON.stringify(maskGraph(finalGraph), null, 1));

// ============================================================================
// 5. Manifest: required case -> witnessing seq(s).
// ============================================================================
const firstSeqWhere = (pred) => { const e = maskedEvents.find(pred); return e ? e.seq : null; };
const allSeqsWhere = (pred) => maskedEvents.filter(pred).map((e) => e.seq);
const KINDS = ['route', 'drain-outcome', 'retire', 'route-choice', 'pick', 'policy-verdict',
  'act', 'act.failed', 'pick-empty', 'reopen', 'reopen-delivered', 'retire-answered', 'reloc-census'];
const CODES = ['ACT_FAILED', 'ALIAS_COLLISION', 'OUTWARD_REFUSED', 'NO_INSTANCE', 'DISABLED'];

const manifest = {
  source: 'run fix1 (masked slice)',
  eventCount: maskedEvents.length,
  graphSnapshots: copiedGraphs,
  kinds: Object.fromEntries(KINDS.map((k) => [k, firstSeqWhere((e) => e.kind === k)])),
  failureCodes: Object.fromEntries(CODES.map((c) =>
    [c, firstSeqWhere((e) => e.kind === 'act.failed' && e.payload.code === c)])),
  cases: {
    'request status>=500': allSeqsWhere((e) =>
      e.kind === 'act' && (e.payload.requests || []).some((r) => Number(r.status) >= 500)),
    'act.failed with target.attempts (6 strategy records)': firstSeqWhere((e) =>
      e.kind === 'act.failed' && Array.isArray(e.payload.target?.attempts) && e.payload.target.attempts.length === 6),
    'act.failed hadRevealPath:true': firstSeqWhere((e) =>
      e.kind === 'act.failed' && e.payload.target?.hadRevealPath === true),
    'act shots.before === null': firstSeqWhere((e) =>
      e.kind === 'act' && e.payload.shots && e.payload.shots.before === null),
    'entry-route mislabel (drain-outcome acts:0, graph holds many instances)': allSeqsWhere((e) =>
      e.kind === 'drain-outcome' && e.payload.acts === 0 && graphInstanceCount(e.seq, e.payload.route) >= 40),
    'notFoundSig present, zero contentSig (dead client-404 detector)': 'graph.json',
  },
};
fs.writeFileSync(OUT_MANIFEST, JSON.stringify(manifest, null, 2));

// nearest masked snapshot <= seq, count instances whose element.route === route
function graphInstanceCount(seq, route) {
  const below = copiedGraphs.map(seqOfFile).filter((s) => s <= seq).sort((a, b) => a - b);
  if (!below.length) return 0;
  const snap = below[below.length - 1];
  const f = copiedGraphs.find((x) => seqOfFile(x) === snap);
  const g = JSON.parse(fs.readFileSync(path.join(OUT_GRAPH_DIR, f), 'utf8'));
  let n = 0;
  for (const el of Object.values(g.elements || {})) if (el.route === route) n += (el.instances || []).length;
  return n;
}

// ============================================================================
// 6. SELF-CHECK — fail loudly on a leak or a missing required case.
// ============================================================================
const fail = (msg) => { console.error('SELF-CHECK FAILED: ' + msg); process.exitCode = 1; throw new Error(msg); };

const outBlob = [
  fs.readFileSync(OUT_EVENTS, 'utf8'),
  fs.readFileSync(OUT_RUN_JSON, 'utf8'),
  fs.readFileSync(OUT_FINAL_GRAPH, 'utf8'),
  fs.readFileSync(OUT_MANIFEST, 'utf8'),
  ...copiedGraphs.map((f) => fs.readFileSync(path.join(OUT_GRAPH_DIR, f), 'utf8')),
].join('\n');

// (a) no leaks. outBlob deliberately includes EVERY committed data file — the
// events, run.json, the final graph AND all graph snapshots — because the
// Stierlitz leak survived an earlier self-check that had the snapshots in the
// blob but not the account names in the token list. Both must stay true:
// snapshots in the blob, account names in the list. All checks case-insensitive.
const LEAK_TOKENS = [
  'rawcaster',            // the brand
  'stierlitz', 'stark', 'rawtest', 'trip1',  // test-account names
  'gmail',                // real mail domain
  'qwert', 'xcvbn',       // decoded credential fragments from the b64 profile segs
];
const leaks = [];
for (const tok of LEAK_TOKENS) {
  if (new RegExp(tok, 'i').test(outBlob)) leaks.push(`token "${tok}"`);
}
for (const host of hostMap.keys()) {
  if (new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(outBlob)) leaks.push(`host "${host}"`);
}
for (const seg of b64Set) if (outBlob.includes(seg)) leaks.push(`base64 segment "${seg.slice(0, 12)}…"`);
if (leaks.length) fail('leak(s): ' + leaks.join(', '));

// (b) all 13 kinds present
for (const [k, s] of Object.entries(manifest.kinds)) if (s == null) fail(`missing kind: ${k}`);
// (c) all 5 codes present
for (const [c, s] of Object.entries(manifest.failureCodes)) if (s == null) fail(`missing failure code: ${c}`);
// (d) each required case has a witness
for (const [name, w] of Object.entries(manifest.cases)) {
  if (w == null || (Array.isArray(w) && w.length === 0)) fail(`missing required case: ${name}`);
}

// (e) byte-for-byte preservation spot-checks (diagnostic signal survived masking)
const bySeq = Object.fromEntries(maskedEvents.map((e) => [e.seq, e]));
// 500 status + endpoint tail shape kept
const act500 = maskedEvents.find((e) => e.kind === 'act' && (e.payload.requests || []).some((r) => r.status === 500));
const req500 = act500.payload.requests.find((r) => r.status === 500);
if (req500.method !== 'POST' || req500.status !== 500) fail('500 request method/status not preserved');
if (!/addfriendgroup/.test(req500.urlPattern)) fail('500 endpoint tail shape lost');
if (/rawcaster/i.test(req500.urlPattern)) fail('500 endpoint still carries brand');
// target.attempts shape (6 records, ran/raw/visible/sameTemplate)
const af = maskedEvents.find((e) => e.kind === 'act.failed' && e.payload.target?.attempts?.length === 6);
for (const a of af.payload.target.attempts)
  for (const fld of ['strategy', 'ran', 'raw', 'visible', 'sameTemplate'])
    if (!(fld in a)) fail(`target.attempts record missing ${fld}`);
// notFoundSig preserved & zero contentSig
const fg = JSON.parse(fs.readFileSync(OUT_FINAL_GRAPH, 'utf8'));
if (fg.notFoundSig !== finalGraph.notFoundSig) fail('notFoundSig not preserved byte-for-byte');
const withContentSig = Object.values(fg.routes || {}).filter((r) => r && r.contentSig).length;
if (withContentSig !== 0) fail(`contentSig must stay absent, found ${withContentSig}`);

console.log(`OK  events=${maskedEvents.length}  graphs=${copiedGraphs.length}  ` +
  `kinds=13  codes=5  hosts=${hostMap.size}  routes=${routeMap.size}  names=${nameMap.size}  keys=${keyMap.size}  b64=${b64Set.size}`);
console.log('manifest written:', path.relative(HERE, OUT_MANIFEST));
