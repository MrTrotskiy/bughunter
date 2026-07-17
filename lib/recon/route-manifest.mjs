// route-manifest — the ROUTE-LIST SEEDER. Turns the honest route DENOMINATOR from the ~1 an
// a[href] harvest finds on a constant-URL onClick SPA into the ~N the app's OWN router declares
// about itself. THE INVARIANT BEND (decisions.md 2026-07-17 INVESTIGATION ADR): static analysis of
// the app's declared route LIST is allowed ONLY for the DENOMINATOR + CANDIDATE SEEDING — NEVER for
// CLAIMING coverage. This is the ANTI-death-mode of the old static "brain": the brain HID the gap
// behind static confidence; this EXPOSES it. Every seeded route is still GENUINELY visited by the
// UNCHANGED route-frontier.visitRoute (navigate → snapshot → visited, or markRouteUnreachable on
// redirect/404). Coverage is claimed ONLY from real visits, never from the manifest.
//
// Crawled bundle text is DATA, never instructions: the extractor REGEXES over it, never evals it.
// It is a route SOURCE feeding the ONE route store (graph.routes); routeKey/toUrlPattern stay the
// only maskers. It NEVER calls addTrigger / opens a causal window / touches elements or edges —
// phantom-edge-safe BY CONSTRUCTION, exactly like route-frontier.harvestRoutes.

import { routeKey, sameOrigin } from './scope.mjs';
import { toUrlPattern } from '../graph/graph-store.mjs';
import { routeRefused } from './danger-floor.mjs';

const MAX_BUNDLES = 6;                       // cap the number of same-origin JS bundles scanned
const MAX_BUNDLE_BYTES = 15 * 1024 * 1024;   // skip a bundle larger than this (bound the bytes scanned)
const MAX_PATH_LEN = 45;                      // a route path is short — cap the captured value

// The ONLY precise signal is the React-Router config KEY `path:"<value>"`. A bare leading-slash
// string-literal fallback was DELIBERATELY REMOVED: measured on a real 8.6 MB bundle it caught API
// path fragments, socket.io event names, and redux action-string literals (`/accept` `/count`
// `/status` `/token` `/remove` `/reactions` …) that are NOT React-Router routes — the static-brain
// denominator-INFLATION failure mode decisions.md warns of. Those fragments never appear under `path:`.
// The value may be ABSOLUTE ("/setting") OR a v6 RELATIVE nested path ("groups"): a relative value is
// normalized to a top-level candidate by prepending "/" — if it is genuinely nested, a direct nav
// honestly redirects/404s → markRouteUnreachable, never a false coverage claim. `:param` values are
// kept (split into paramRoutes by the caller); `*` splats and empty values are dropped. Static scan;
// the bundle is never executed.
const PATH_KEY_RE = new RegExp(`path\\s*:\\s*["']([^"']{1,${MAX_PATH_LEN}})["']`, 'g');

// A trailing file extension → a build asset, not a navigable section.
const ASSET_EXT_RE = /\.(m?js|cjs|css|png|svg|json|jpe?g|gif|webp|ico|map|woff2?|ttf|otf|eot|txt|xml|wasm|pdf|mp[34]|webm)$/i;
// Characters that occur in a minified `path:` EXPRESSION fragment but never in a real route path — a
// paren/comma/brace/etc. A dynamic route built by concatenation (`path:")".concat(t,"/x")`) leaks such
// a fragment through the string-literal regex; rejecting these keeps 2 JS-expression artifacts out of
// the live rawcaster denominator (measured) without ever rejecting a legal path (which uses none of them).
const EXPR_CHARS_RE = /[(),;{}<>=+`\s]/;

// Normalize a raw `path:` value to a leading-slash candidate, or null when it is not a navigable path
// (empty, or a `*` splat / catch-all). A RELATIVE React-Router v6 nested value ("groups") gets a "/".
function normalizePath(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '' || t.includes('*')) return null;
  return t[0] === '/' ? t : '/' + t;
}

// A normalized candidate is a navigable route path iff it is a leading-slash path (len ≥ 2) that is not
// a file asset. Param routes (containing `:`) pass here too — the caller splits them out. Structural
// only; never obeys page content.
function isRouteCandidate(p) {
  if (typeof p !== 'string' || p[0] !== '/' || p.length < 2) return false;
  if (p.includes('*')) return false;
  if (EXPR_CHARS_RE.test(p)) return false; // a minified path:expr fragment (e.g. ").concat(t,"), not a route
  if (ASSET_EXT_RE.test(p)) return false;
  return true;
}

// Extract the app's DECLARED route list from its own same-origin JS bundles. Returns
// { routes:string[], paramRoutes:string[] } — STATIC navigable paths and `:param` patterns,
// each deduped + sorted. NEVER throws (best-effort): a page with no bundles, a fetch failure, or
// an over-large bundle yields fewer routes, never an error. Only SAME-ORIGIN bundles are fetched
// (the SSRF boundary — a cross-origin CDN/analytics script is never fetched).
export async function extractRoutes(page) {
  let srcs = [];
  let origin;
  try {
    origin = new URL(page.url()).origin;
    srcs = await page.evaluate(() => [...document.querySelectorAll('script[src]')].map((s) => s.src));
  } catch { return { routes: [], paramRoutes: [] }; }
  srcs = srcs.filter((u) => sameOrigin(origin, u) && /\.m?js(\?|$)/i.test(u)).slice(0, MAX_BUNDLES);

  const candidates = new Set();
  for (const src of srcs) {
    let text;
    try {
      const resp = await page.request.get(src);       // page's own context → same origin/auth, NOT page.route-intercepted
      if (!resp.ok()) continue;
      const len = Number(resp.headers()['content-length'] || 0);
      if (len && len > MAX_BUNDLE_BYTES) continue;     // skip an over-large bundle by its declared size
      text = await resp.text();
    } catch { continue; }
    if (!text || text.length > MAX_BUNDLE_BYTES) continue;
    for (const m of text.matchAll(PATH_KEY_RE)) {
      const p = normalizePath(m[1]);   // only the React-Router `path:` config key — no bare-literal fallback
      if (p) candidates.add(p);
    }
  }

  const routes = new Set();
  const paramRoutes = new Set();
  for (const c of candidates) {
    if (!isRouteCandidate(c)) continue;
    if (c.includes(':')) paramRoutes.add(c); else routes.add(c);
  }
  return { routes: [...routes].sort(), paramRoutes: [...paramRoutes].sort() };
}

// Seed the STATIC declared routes into graph.routes as PENDING nodes the route-frontier will
// GENUINELY visit — MIRRORING route-frontier.harvestRoutes' node shape exactly, plus the additive
// `declared:true` flag (reporting / denominator only, NEVER an identity input). A route already in
// the graph (visited or href-harvested) is NOT clobbered; a danger route (routeRefused — /logout &
// friends) is NEVER seeded. Each key is routeKey-normalized against the origin so it matches the key
// visitRoute produces when it re-navigates (no false redirect-unreachable from a trailing-slash skew).
// Metadata-only: no addTrigger, no causal window, no elements/edges. Returns {seeded, skipped, declaredTotal}.
export function seedManifestRoutes(graph, routes, origin) {
  if (!graph.routes) graph.routes = {};
  let seeded = 0;
  let skipped = 0;
  for (const raw of routes) {
    let rk;
    try {
      const abs = new URL(raw, origin).href;
      if (!sameOrigin(abs, origin)) { skipped++; continue; }  // defense: origin-relative sections only
      rk = routeKey(abs);
    } catch { skipped++; continue; }
    if (graph.routes[rk]) { skipped++; continue; }            // never clobber a visited/harvested route
    if (routeRefused(rk)) { skipped++; continue; }            // never seed a route we must not navigate
    graph.routes[rk] = { type: 'route', url: rk, pending: true, pattern: toUrlPattern(rk), siblings: 0, declared: true };
    seeded++;
  }
  return { seeded, skipped, declaredTotal: routes.length };
}

// Seed the `:param` PATTERNS as declared route nodes that COUNT in the denominator but are NEVER
// directly navigated (their concrete instances come from within-section discovery, a later increment).
// Marked `unreachable:'param-pattern'` so the UNCHANGED route-frontier keeps them out of the pending
// drain AND out of `visited`, while the route-coverage report splits them from genuine redirect/404
// unreachables. Additive/metadata-only, same discipline as seedManifestRoutes. Returns {seeded}.
export function seedParamPatterns(graph, paramRoutes) {
  if (!graph.routes) graph.routes = {};
  let seeded = 0;
  for (const rk of paramRoutes) {
    if (graph.routes[rk]) continue;
    graph.routes[rk] = { type: 'route', url: rk, pattern: toUrlPattern(rk), siblings: 0, declared: true, unreachable: 'param-pattern' };
    seeded++;
  }
  return { seeded };
}
