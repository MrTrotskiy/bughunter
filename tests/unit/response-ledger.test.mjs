// Unit test for the per-requestId RESPONSE LEDGER (makeLedgerTracker) — the CDP-free half
// of the initiator tracker, driven here by SYNTHETIC requestWillBeSent / responseReceived /
// loadingFinished params (no browser). It pins the two behaviors the response-metadata join
// depends on: (1) the act cursor scopes takeResponse to the current window (a pre-cursor
// load-burst on the same path is NOT joined), and (2) duplicate (method,pathname) fires in
// one window pair with responses in FIRE ORDER via ordered take-and-mark. The live test
// proves this over real chromium; this pins the logic fast without paying for a page.
//
// Guards: makeLedgerTracker's cursor scoping + ordered take-and-mark + duration derivation.
// FAIL-ON-REVERT (order): drop `e.taken = true` in takeResponse → both same-path takes
//   return the FIRST entry → "second fire pairs with the second response" (202) fails.
// FAIL-ON-REVERT (cursor): make markCursor a no-op → takeResponse matches the pre-cursor
//   load-burst → "takeResponse ignores the pre-cursor load-burst" (204 expected) fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLedgerTracker } from '../../lib/browser/response-ledger.mjs';

const req = (requestId, method, path, { type = 'Fetch', timestamp = 1 } = {}) => ({
  requestId, request: { url: `http://x${path}`, method }, initiator: { type: 'script' }, type, timestamp,
});
const res = (requestId, status, { mimeType = 'application/json', type = 'Fetch' } = {}) => ({
  requestId, response: { status, mimeType }, type,
});
const fin = (requestId, timestamp) => ({ requestId, timestamp });

test('takeResponse pairs duplicate (method,pathname) fires in FIRE ORDER', () => {
  const lt = makeLedgerTracker();
  lt.onRequest(req('1', 'GET', '/api/seq'));
  lt.onRequest(req('2', 'GET', '/api/seq'));
  lt.onResponse(res('1', 201));
  lt.onResponse(res('2', 202));

  const first = lt.takeResponse('GET', '/api/seq');
  const second = lt.takeResponse('GET', '/api/seq');
  assert.equal(first.status, 201, 'first fire pairs with the first response');
  assert.equal(second.status, 202, 'second fire pairs with the second response');
  // The two entries are exhausted — a third take on the same path finds nothing.
  assert.equal(lt.takeResponse('GET', '/api/seq'), null, 'ordered take-and-mark exhausts the pair');
});

test('the act cursor scopes takeResponse to THIS act window (pre-cursor load-burst ignored)', () => {
  const lt = makeLedgerTracker();
  // A page-load fetch to /api/config lands BEFORE the act begins (before markCursor).
  lt.onRequest(req('L', 'GET', '/api/config'));
  lt.onResponse(res('L', 200));
  lt.markCursor(); // the act begins here
  // The act's OWN request to the same path, with a different status.
  lt.onRequest(req('1', 'GET', '/api/config'));
  lt.onResponse(res('1', 204));

  const taken = lt.takeResponse('GET', '/api/config');
  assert.equal(taken.status, 204, 'takeResponse ignores the pre-cursor load-burst, takes the act request');
});

test('durationMs is derived from the CDP monotonic timestamps (seconds → ms)', () => {
  const lt = makeLedgerTracker();
  lt.onRequest(req('1', 'POST', '/api/create', { timestamp: 10 }));
  lt.onResponse(res('1', 201));
  lt.onFinished(fin('1', 10.6));

  const meta = lt.takeResponse('POST', '/api/create');
  assert.equal(meta.status, 201);
  assert.equal(meta.resourceType, 'Fetch', 'resourceType carried from the request event');
  assert.equal(meta.durationMs, 600, '(10.6 - 10) * 1000, rounded');
});

test('a miss returns null and never throws (graceful degradation)', () => {
  const lt = makeLedgerTracker();
  lt.markCursor();
  lt.onRequest(req('1', 'GET', '/api/a'));
  // no response recorded yet → status stays null, duration null, but the entry is takeable.
  const a = lt.takeResponse('GET', '/api/a');
  assert.equal(a.status, null);
  assert.equal(a.durationMs, null, 'no loadingFinished → null duration, not a crash');
  // an unknown path finds nothing.
  assert.equal(lt.takeResponse('GET', '/api/missing'), null);
});

test('reset clears the ledger and restarts the cursor', () => {
  const lt = makeLedgerTracker();
  lt.onRequest(req('1', 'GET', '/api/a'));
  lt.onResponse(res('1', 200));
  lt.reset();
  assert.equal(lt.cursor(), 0, 'ledger emptied');
  assert.equal(lt.takeResponse('GET', '/api/a'), null, 'nothing survives reset');
});

// --- Body capture: the DOUBLE-GATE default-off behavior + store-time redaction. --------------
// The login pre-step (login.mjs) opens NO run, so its wiring computes captureBodies=false;
// this is the effective ledger state during login. These pin that no body is retained when the
// gate is closed, and that when it IS open, the request body is redacted before it is stored.
//
// Guards: makeLedgerTracker's captureBodies gate on reqBody retention + wantsBody + onBody, and
//   store-time redaction of the request postData.
// FAIL-ON-REVERT (login/no-run guard): drop the `if (captureBodies)` guard in onRequest → a
//   reqBody is retained even with the gate closed → "no request body retained when the gate is
//   closed" fails. (The gate is captureBodies=false — the login pre-step's state, no run.)
// FAIL-ON-REVERT (store-time redaction): store `raw` instead of redactBody(raw,...) → "the
//   stored request body is redacted" fails (the raw password appears).
// FAIL-ON-REVERT (request allowlist): drop the requestBodyAllowed gate in extractPostData → the
//   multipart body is captured → "an off-allowlist request content-type is NOT captured" fails.

const reqWithBody = (requestId, method, path, body, ct = 'application/json') => ({
  requestId,
  request: { url: `http://x${path}`, method, postData: body, headers: { 'content-type': ct } },
  initiator: { type: 'script' }, type: 'Fetch', timestamp: 1,
});

test('gate CLOSED (login / no-run state): no request or response body is retained', () => {
  const lt = makeLedgerTracker({ captureBodies: false });
  lt.markCursor();
  lt.onRequest(reqWithBody('1', 'POST', '/api/login', '{"user":"neo","password":"secret"}'));
  lt.onResponse(res('1', 200));
  assert.equal(lt.wantsBody('1'), false, 'wantsBody is false with the gate closed');
  assert.equal(lt.onBody('1', { body: '{"token":"eyJ.a.b"}', base64Encoded: false }), null, 'onBody is a no-op');
  const meta = lt.takeResponse('POST', '/api/login');
  assert.equal(meta.reqBody, null, 'no request body retained when the gate is closed');
  assert.equal(meta.bodyPromise, null, 'no body promise when the gate is closed');
});

test('gate OPEN: the stored request body is REDACTED at store time', () => {
  const lt = makeLedgerTracker({ captureBodies: true });
  lt.markCursor();
  lt.onRequest(reqWithBody('1', 'POST', '/api/login', '{"user":"neo","password":"trinity123"}'));
  lt.onResponse(res('1', 200));
  assert.equal(lt.wantsBody('1'), true, 'wantsBody true for an allowed mime with the gate open');
  const meta = lt.takeResponse('POST', '/api/login');
  assert.ok(meta.reqBody, 'a request body was retained');
  assert.ok(!meta.reqBody.includes('trinity123'), 'the raw password is NOT stored');
  assert.ok(meta.reqBody.includes('[REDACTED]'), 'the password value is redacted at store time');
  assert.ok(meta.reqBody.includes('neo'), 'the non-secret field is kept');
});

test('gate OPEN: an off-allowlist request content-type (multipart) is NOT captured', () => {
  const lt = makeLedgerTracker({ captureBodies: true });
  lt.markCursor();
  lt.onRequest(reqWithBody('1', 'POST', '/api/upload', '--b\r\nContent-Disposition: form-data\r\npassword=secret', 'multipart/form-data; boundary=b'));
  lt.onResponse(res('1', 200));
  const meta = lt.takeResponse('POST', '/api/upload');
  assert.equal(meta.reqBody, null, 'a multipart/binary request body is skipped (secrets-first)');
});

test('gate OPEN: a form-urlencoded request body is captured + redacted (secret + identity)', () => {
  const lt = makeLedgerTracker({ captureBodies: true });
  lt.markCursor();
  lt.onRequest(reqWithBody('1', 'POST', '/api/login', 'username=neo&password=trinity&remember=1', 'application/x-www-form-urlencoded'));
  lt.onResponse(res('1', 200));
  const meta = lt.takeResponse('POST', '/api/login');
  assert.ok(meta.reqBody.includes('password=[REDACTED]'), 'form password redacted');
  assert.ok(meta.reqBody.includes('username=[REDACTED]'), 'form username (identity) redacted');
  assert.ok(!meta.reqBody.includes('trinity'), 'no raw credential');
});

test('gate OPEN: onBody redacts + stores an allowed response body, skips base64/binary', () => {
  const lt = makeLedgerTracker({ captureBodies: true });
  lt.markCursor();
  lt.onRequest(req('1', 'GET', '/api/me'));
  lt.onResponse(res('1', 200, { mimeType: 'application/json' }));
  const stored = lt.onBody('1', { body: '{"user":"neo","token":"eyJ.a.b"}', base64Encoded: false });
  assert.ok(stored.includes('[REDACTED]') && !stored.includes('eyJ.a.b'), 'response token redacted');
  assert.ok(stored.includes('neo'), 'response non-secret field kept');
  // A base64/binary payload is never stored, even with an allowed mime.
  lt.onRequest(req('2', 'GET', '/api/blob'));
  lt.onResponse(res('2', 200, { mimeType: 'application/json' }));
  assert.equal(lt.onBody('2', { body: 'AAAA', base64Encoded: true }), null, 'base64 body skipped');
});
