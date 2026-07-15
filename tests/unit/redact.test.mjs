// Unit test for the PURE body-redaction core (redact.mjs) — no browser, no disk. Redaction is
// what makes opt-in body capture safe on an AUTHENTICATED crawl, so each case is revert-proven.
// It pins: KEY-level secret redaction, VALUE-level secret detection on every string leaf (a
// secret under an INNOCENT key must still be caught — the H1 bypass), structural form-urlencoded
// redaction incl. identity fields, the pre-cap/size-cap, LINEAR (no-ReDoS) behavior on a
// pathological body, and the content-type allowlist.
//
// Guards: redactBody's key + value redaction, structural form walk, capString, bounded work,
//   and bodyAllowed gate.
// FAIL-ON-REVERT (key): drop `keyIsSecret(k)` in redactValue → "a secret-named key is redacted"
//   fails (raw password survives).
// FAIL-ON-REVERT (value/H1): drop the JWT/Bearer replaces in redactString → "a JWT under a
//   NON-secret key is redacted" fails (eyJ… survives).
// FAIL-ON-REVERT (form): make redactForm return `raw` → "form secret + identity fields redacted"
//   fails.
// FAIL-ON-REVERT (cap): make capString return `str` → "a body over the cap is truncated" fails.
// FAIL-ON-REVERT (ReDoS): reintroduce a `[\w.-]*(?:secret)[\w.-]*` text regex → the pathological
//   body backtracks for seconds → "a pathological body is redacted in bounded time" fails.
// FAIL-ON-REVERT (allowlist): make bodyAllowed return true → "text/html + binary refused" fails.
// FAIL-ON-REVERT (provider values): drop the STRIPE/GITHUB/SLACK/GOOGLE replaces in redactString →
//   "provider secrets in a value are redacted" fails.
// FAIL-ON-REVERT (segment key): drop the SEGMENT_SECRETS split in keyIsSecret → "a bare …_key/
//   …_token segment key is redacted" fails.
// FAIL-ON-REVERT (acronym): remove the `([A-Z]+)([A-Z][a-z])` split in normalizeKey → "an ACRONYM-
//   prefixed key (APIToken) is redacted" fails.
// FAIL-ON-REVERT (number leaf): drop redactNumber in redactValue → "a card as a JSON number is
//   redacted" fails.
// FAIL-ON-REVERT (straddle cap): pre-cap the RAW before redaction (cut then redact) → "a secret
//   straddling the output cap is fully redacted" fails (a raw prefix leaks).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactBody, bodyAllowed, BODY_CAP } from '../../lib/browser/redact.mjs';

test('JSON: a secret-named key is redacted, real fields preserved', () => {
  const raw = JSON.stringify({
    username: 'neo', email: 'neo@example.com', items: [1, 2, 3],
    password: 'trinity123', session: { sessionid: 'abc', note: 'keep-me' },
    nested: { api_key: 'sk-live-xyz', accessToken: 'tok_abc' },
  });
  const out = JSON.parse(redactBody(raw, 'application/json'));
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.nested.api_key, '[REDACTED]', 'snake_case secret key');
  assert.equal(out.nested.accessToken, '[REDACTED]', 'camelCase secret key');
  assert.equal(out.session, '[REDACTED]', 'a whole object under a secret key');
  assert.equal(out.username, 'neo', 'non-secret field preserved');
  assert.deepEqual(out.items, [1, 2, 3]);
  assert.ok(!redactBody(raw, 'application/json').includes('trinity123'), 'raw secret never present');
});

test('JSON: a secret in a VALUE under a NON-secret key is redacted (the H1 bypass)', () => {
  const raw = JSON.stringify({
    data: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sigsigsig', // JWT under innocent key
    result: 'Bearer sk_live_deadbeef',
    note: 'plain text is fine',
    arr: ['eyJx.eyJy.eyJz'], // JWT in an array leaf
  });
  const out = redactBody(raw, 'application/json');
  const parsed = JSON.parse(out);
  assert.ok(!/eyJhbGc/.test(out), 'no JWT survives anywhere');
  assert.equal(parsed.data, '[REDACTED]', 'JWT value under a non-secret key redacted');
  assert.ok(parsed.result.includes('[REDACTED]') && !parsed.result.includes('sk_live'), 'Bearer value redacted');
  assert.equal(parsed.arr[0], '[REDACTED]', 'JWT in an array leaf redacted');
  assert.equal(parsed.note, 'plain text is fine', 'innocent value untouched');
});

test('JSON: value-level PII/keys — AWS key, card, SSN, email under innocent keys', () => {
  const raw = JSON.stringify({ a: 'AKIA' + 'IOSFODNN7EXAMPLE', card: '4111 1111 1111 1111', ss: '123-45-6789', who: 'a@b.com' });
  const out = JSON.parse(redactBody(raw, 'application/json'));
  assert.equal(out.a, '[REDACTED]', 'AWS access key');
  assert.equal(out.card, '[REDACTED]', 'credit-card-like run');
  assert.equal(out.ss, '[REDACTED]', 'US SSN');
  assert.equal(out.who, '[REDACTED]', 'email PII');
});

test('JSON: opaque PROVIDER secrets in a VALUE under an innocent key are redacted', () => {
  const out = JSON.parse(redactBody(JSON.stringify({
    a: 'sk_live_' + '51ABCDEFghijKLMNopqrSTUV', // Stripe secret key
    b: 'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456', // GitHub PAT
    c: 'xoxb-' + '1111-2222-abcDEFghiJKL', // Slack bot token
    d: 'AIzaSy' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456', // Google API key
    ok: 'pk_live_publishableIsFine', // publishable → intentionally NOT matched
  }), 'application/json'));
  assert.equal(out.a, '[REDACTED]', 'Stripe sk_live');
  assert.equal(out.b, '[REDACTED]', 'GitHub ghp_');
  assert.equal(out.c, '[REDACTED]', 'Slack xoxb-');
  assert.equal(out.d, '[REDACTED]', 'Google AIza');
  assert.equal(out.ok, 'pk_live_publishableIsFine', 'publishable pk_ is left (not a secret)');
});

test('JSON: a bare …_key/…_token/…_secret SEGMENT key is redacted; lookalikes are not', () => {
  const out = JSON.parse(redactBody(JSON.stringify({
    stripe_key: 'v1', encryption_key: 'v2', session_token: 'v3', publishable_key: 'v4', client_secret: 'v5',
    keyboard: 'typed', monkey: 'business', tokenizer: 'bpe', description: 'ok',
  }), 'application/json'));
  assert.equal(out.stripe_key, '[REDACTED]', 'bare key segment');
  assert.equal(out.encryption_key, '[REDACTED]');
  assert.equal(out.session_token, '[REDACTED]', 'bare token segment');
  assert.equal(out.publishable_key, '[REDACTED]', 'even a publishable_KEY name is redacted (key segment)');
  assert.equal(out.client_secret, '[REDACTED]');
  assert.equal(out.keyboard, 'typed', '"key" must be a whole segment, not a substring of keyboard');
  assert.equal(out.monkey, 'business', 'not a substring of monkey');
  assert.equal(out.tokenizer, 'bpe', 'not a substring of tokenizer');
  assert.equal(out.description, 'ok');
});

test('JSON: an ACRONYM-prefixed key (APIToken / AUTHToken) is redacted (normalizeKey fix)', () => {
  const out = JSON.parse(redactBody(JSON.stringify({ APIToken: 'a', AUTHToken: 'b', accessToken: 'c', 'X-Api-Key': 'd', keep: 'e' }), 'application/json'));
  assert.equal(out.APIToken, '[REDACTED]', 'all-caps acronym run gets a boundary');
  assert.equal(out.AUTHToken, '[REDACTED]');
  assert.equal(out.accessToken, '[REDACTED]', 'camelCase still works');
  assert.equal(out['X-Api-Key'], '[REDACTED]', 'kebab still works');
  assert.equal(out.keep, 'e');
});

test('JSON: a card-shaped NUMBER leaf is redacted; an ordinary number is not', () => {
  const out = JSON.parse(redactBody(JSON.stringify({ cc: 4111111111111111, year: 2024, qty: 5 }), 'application/json'));
  assert.equal(out.cc, '[REDACTED]', '16-digit integer treated as a card');
  assert.equal(out.year, 2024, 'a 4-digit number is untouched');
  assert.equal(out.qty, 5);
});

test('a secret straddling the OUTPUT cap is fully redacted (redact runs before the cut)', () => {
  const cap = 4096;
  const secret = 'sk_live_' + 'A'.repeat(20); // matchable in full; a short prefix would not match
  const start = cap - 13;                      // secret straddles the cap; only ~5 chars survive a pre-cut
  const raw = 'x'.repeat(start - 1) + ' ' + secret; // a delimiter gives the leading \b
  const out = redactBody(raw, 'text/plain', { cap });
  assert.ok(out.includes('[REDACTED]'), 'the straddling secret is fully redacted');
  assert.ok(!out.includes('sk_live_'), 'no raw secret prefix leaks past the output cap');
});

test('JSON: expanded vocab hits sid/csrf/jwt/pin; innocent lookalikes are NOT redacted', () => {
  const out = JSON.parse(redactBody(JSON.stringify({
    sid: 's1', csrf: 'c1', jwt: 'j1', pin: '0000',
    shipping: 'fast', author: 'neo', description: 'ok',
  }), 'application/json'));
  assert.equal(out.sid, '[REDACTED]');
  assert.equal(out.csrf, '[REDACTED]');
  assert.equal(out.jwt, '[REDACTED]');
  assert.equal(out.pin, '[REDACTED]');
  assert.equal(out.shipping, 'fast', '"pin" inside "shipping" must NOT match');
  assert.equal(out.author, 'neo', '"auth" inside "author" must NOT match');
  assert.equal(out.description, 'ok');
});

test('application/*+json is treated structurally', () => {
  const out = JSON.parse(redactBody('{"pwd":"x","ok":1}', 'application/vnd.api+json'));
  assert.equal(out.pwd, '[REDACTED]');
  assert.equal(out.ok, 1);
});

test('form-urlencoded: secret + identity fields redacted structurally, others kept', () => {
  const out = redactBody('username=neo&password=trinity123&email=neo@x.com&remember=1', 'application/x-www-form-urlencoded');
  assert.ok(out.includes('password=[REDACTED]'), 'secret field redacted');
  assert.ok(out.includes('username=[REDACTED]'), 'identity username redacted (credential POST)');
  assert.ok(out.includes('email=[REDACTED]'), 'identity email redacted');
  assert.ok(out.includes('remember=1'), 'non-secret field kept');
  assert.ok(!out.includes('trinity123') && !out.includes('neo@x.com'), 'no raw secret/PII');
});

test('a body over the cap is truncated (never emits > cap)', () => {
  const cap = 256;
  const out = redactBody('a'.repeat(5000), 'text/plain', { cap });
  assert.ok(out.length <= cap, `capped to <= ${cap}, got ${out.length}`);
  assert.ok(out.endsWith('…[truncated]'), 'truncation marker present');
  assert.equal(redactBody('a'.repeat(10), 'text/plain').length, 10, 'small body untouched');
  assert.equal(BODY_CAP, 64 * 1024, 'default cap is 64 KiB');
});

test('a pathological word-char body is redacted in BOUNDED time (no ReDoS)', () => {
  // A long run of `[\w.-]` chars that does NOT contain a secret word — the exact input that
  // makes a `[\w.-]*(?:secret)[\w.-]*` regex backtrack O(n²) (the reviewer measured 80KB→20s).
  // The linear patterns + pre-cap keep this in milliseconds.
  const evil = 'ab-cd.ef_'.repeat(30000); // ~270 KB, all word/./-/_ chars, no secret substring
  const t = Date.now();
  const out = redactBody(evil, 'text/plain');
  const dt = Date.now() - t;
  assert.ok(dt < 1000, `redaction must be linear+bounded, took ${dt}ms`);
  assert.ok(out.length <= BODY_CAP, 'output stays within the cap');
});

test('bodyAllowed: json + text yes, text/html + binary no', () => {
  assert.equal(bodyAllowed('application/json'), true);
  assert.equal(bodyAllowed('application/json; charset=utf-8'), true, 'params stripped');
  assert.equal(bodyAllowed('application/vnd.api+json'), true);
  assert.equal(bodyAllowed('text/plain'), true);
  assert.equal(bodyAllowed('text/csv'), true);
  assert.equal(bodyAllowed('text/html'), false, 'whole pages excluded');
  assert.equal(bodyAllowed('image/png'), false);
  assert.equal(bodyAllowed('application/octet-stream'), false);
  assert.equal(bodyAllowed(undefined), false);
  assert.equal(bodyAllowed(''), false);
});
