// scope — the route-identity + same-origin primitive the multi-route recon hangs on.
// Pure, no browser.
//
// Guards: (1) routeKey is a STABLE, NAVIGABLE route key — query and plain #anchor are
//   dropped (so /products?sort=x and /products#top are ONE route), path-like SPA hashes
//   are kept (they name a real page), the concrete path is NOT masked (it must stay
//   re-navigable — ":param" is not a URL), and LEADING slashes collapse to one so the key
//   cannot reconstruct as a protocol-relative off-origin url. (2) sameOrigin enforces the
//   scope boundary by scheme+host+PORT — two localhost ports are DIFFERENT origins. (3)
//   isOffOriginHttp only flags http(s) cross-origin links, so a javascript:/mailto: href
//   (opaque origin) is NOT treated as an off-origin link and falls through to the click.
// FAIL-ON-REVERT: (a) drop the query/hash normalization in routeKey → routeKey with a
//   query returns '/products?sort=asc' → the "query dropped" assertion fails; (b) compare
//   only hostname (not origin) in sameOrigin → the different-PORT case returns true → the
//   "different port" assertion fails; (c) drop the leading-slash collapse → '//evil.com'
//   survives → the protocol-relative assertion fails; (d) make isOffOriginHttp `!sameOrigin`
//   (drop the scheme gate) → a javascript: href reads as off-origin → its assertion fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeKey, sameOrigin, isOffOriginHttp } from '../../lib/recon/scope.mjs';

test('routeKey is a stable, navigable route key', () => {
  assert.equal(routeKey('http://x/'), '/', 'root stays /');
  assert.equal(routeKey('http://x/products'), '/products');
  assert.equal(routeKey('http://x/products/'), '/products', 'trailing slash normalized');
  assert.equal(routeKey('http://x/products?sort=asc&page=2'), '/products', 'query dropped');
  assert.equal(routeKey('http://x/page#section'), '/page', 'plain #anchor dropped (same page)');
  // Concrete path segments are KEPT, not masked — the key must be re-navigable.
  assert.equal(routeKey('http://x/product/42'), '/product/42', 'numeric path kept navigable');
  // Path-like SPA hash routing names a real page → preserved.
  assert.equal(routeKey('http://x/app#!/dashboard'), '/app#!/dashboard', 'hashbang route kept');
  assert.equal(routeKey('http://x/app#/settings'), '/app#/settings', 'hash route kept');
  // Leading slashes collapse to one — a `//evil.com` path must not survive to reconstruct
  // as a protocol-relative off-origin url via new URL(key, origin).
  assert.equal(routeKey('http://target.com//evil.com'), '/evil.com', 'leading // collapsed to /');
  assert.equal(new URL(routeKey('http://target.com//evil.com'), 'http://target.com').origin, 'http://target.com', 'reconstructs same-origin');
});

test('isOffOriginHttp flags only http(s) cross-origin links, not special-scheme hrefs', () => {
  assert.equal(isOffOriginHttp('http://a/', 'http://b/'), true, 'http different host is off-origin');
  assert.equal(isOffOriginHttp('http://a:1/', 'http://a:2/'), true, 'http different port is off-origin');
  assert.equal(isOffOriginHttp('http://a/', 'http://a/x'), false, 'same-origin path is in scope');
  // Special schemes have an opaque origin but must NOT be dropped as off-origin links.
  assert.equal(isOffOriginHttp('http://a/', 'javascript:void(0)'), false, 'javascript: is an in-page control');
  assert.equal(isOffOriginHttp('http://a/', 'mailto:x@y.co'), false, 'mailto: is not an off-origin link');
  assert.equal(isOffOriginHttp('http://a/', 'tel:+123'), false, 'tel: is not an off-origin link');
  assert.equal(isOffOriginHttp('http://a/', 'data:text/html,hi'), false, 'data: is not an http link');
});

test('sameOrigin compares scheme + host + port (a different port is out of scope)', () => {
  assert.equal(sameOrigin('http://127.0.0.1:3000/a', 'http://127.0.0.1:3000/b'), true, 'same origin, different path');
  assert.equal(sameOrigin('http://127.0.0.1:3000/', 'http://127.0.0.1:3001/'), false, 'different port');
  assert.equal(sameOrigin('http://x/', 'https://x/'), false, 'different scheme');
  assert.equal(sameOrigin('http://a/', 'http://b/'), false, 'different host');
  assert.equal(sameOrigin('http://x/', 'data:text/html,hi'), false, 'opaque origin is never same-origin');
});
