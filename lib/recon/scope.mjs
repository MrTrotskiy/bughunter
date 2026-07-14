// The route-identity + same-origin primitive the multi-route recon hangs on. Pure, no
// browser. Two jobs, both structural (never obey page content):
//   routeKey(url)   — a STABLE, NAVIGABLE key for "which page is this". The whole graph
//                     keys routes through here so there is ONE route identity, never two.
//   sameOrigin(a,b) — RFC 6454 origin equality (scheme + host + port) via URL.origin, the
//                     scope boundary: recon maps ONE origin and never wanders off it.
//
// routeKey deliberately keeps the CONCRETE pathname (it does NOT mask /product/42 →
// /product/:param the way request urlPatterns do). A route key must be re-navigable: the
// loop revisits a template's own node.route to reach it, and ":param" is not a real URL.
// Over-counting is bounded structurally — the frontier follows only ONE instance per link
// template, so a 1000-product listing yields one visited product route, not a thousand.

// Pathname (query dropped, trailing slash normalized) plus a PATH-LIKE hash — SPA hash
// routing (`#!/x`, `#/x`) names a real page, so it stays; a plain `#anchor` is same-page
// and is dropped. An unparseable input is returned verbatim rather than thrown on.
export function routeKey(url) {
  let u;
  try { u = new URL(url); } catch { return String(url); }
  let pathname = u.pathname || '/';
  // Collapse LEADING slashes to exactly one. A pathname like `//evil.com` (a real double-
  // slash path on the target) would otherwise reconstruct via `new URL(key, origin)` as a
  // PROTOCOL-RELATIVE url (→ https://evil.com/), escaping the origin scope. One leading
  // slash guarantees the key is always origin-relative when re-navigated.
  pathname = pathname.replace(/^\/+/, '/');
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '') || '/';
  const pathLikeHash = /^#!?\//.test(u.hash) ? u.hash : '';
  return pathname + pathLikeHash;
}

// True iff `href` is an http(s) link to a DIFFERENT origin than `base` — the ONLY class the
// fire path refuses to click. A `javascript:`/`mailto:`/`tel:`/`data:` href has an opaque
// origin (sameOrigin would call it "foreign"), but it is an in-page control (`javascript:`
// is the classic button-as-anchor idiom) or a harmless no-op — it must fall through to the
// normal click, not be dropped as an off-origin link. Scheme-gating on http(s) is what
// keeps those in scope.
export function isOffOriginHttp(base, href) {
  let u;
  try { u = new URL(href); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return !sameOrigin(base, href);
}

// True iff both URLs share an origin (scheme + host + port). An opaque origin (URL.origin
// === "null", e.g. data:/blob:) is never same-origin as anything — treat as out of scope.
export function sameOrigin(a, b) {
  let oa, ob;
  try { oa = new URL(a).origin; ob = new URL(b).origin; } catch { return false; }
  if (oa === 'null' || ob === 'null') return false;
  return oa === ob;
}
