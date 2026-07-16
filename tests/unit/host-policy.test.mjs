// Unit test for the SSRF gate: isPrivateHost must classify every private/loopback
// textual form as private (true) and only genuinely public hosts as reachable
// (false). This guards the gate against an SSRF bypass — a private target that
// slips through as "public" lets a hunt reach loopback / cloud-metadata.
//
// Guards: isPrivateHost SSRF classification across IPv4 literals, IPv6 loopback,
//   IPv4-mapped IPv6, link-local + cloud metadata, and trust-local name suffixes.
//   AND isLoopbackHost — the strictly-narrower daemon-endpoint trust boundary:
//   loopback-only (127.0.0.0/8, ::1, localhost) accepted; every private-but-not-
//   loopback form (RFC1918 / CGNAT / link-local / metadata) rejected, so a tampered
//   session.json pointing at a LAN Playwright server is refused.
// FAIL-ON-REVERT: neuter the gate (isPrivateHost first line `return false`, the
//   SSRF bypass) -> "AssertionError [ERR_ASSERTION]: 127.0.0.1 must be private".
// FAIL-ON-REVERT: widen isLoopbackHost to `return isPrivateHost(hostname)` -> the
//   LAN/metadata rejects go red ("192.168.1.50 must NOT be loopback"); revert the
//   IPv6-bracket handling (match against the raw '[::1]') -> "[::1] must be loopback".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateHost, isLoopbackHost } from '../../lib/browser/host-policy.mjs';

const PRIVATE = [
  '127.0.0.1',            // IPv4 loopback
  '::1',                  // IPv6 loopback
  '10.0.0.1',             // RFC1918 10/8
  '192.168.1.10',         // RFC1918 192.168/16
  '172.16.0.1',           // RFC1918 172.16/12 low edge
  '172.31.255.255',       // RFC1918 172.16/12 high edge
  '169.254.1.1',          // link-local
  '169.254.169.254',      // AWS/GCP cloud metadata
  '::ffff:127.0.0.1',     // IPv4-mapped IPv6 loopback
  'localhost',
  'db.internal',          // *.internal trust suffix
  'printer.local',        // *.local trust suffix
];

const PUBLIC = [
  'example.com',
  '93.184.216.34',        // example.com's public A record
];

test('every private/loopback/metadata form is gated as private', () => {
  for (const h of PRIVATE) {
    assert.equal(isPrivateHost(h), true, `${h} must be private`);
  }
});

test('genuinely public hosts are reachable (not private)', () => {
  for (const h of PUBLIC) {
    assert.equal(isPrivateHost(h), false, `${h} must be public`);
  }
});

// isLoopbackHost — the daemon-endpoint trust boundary. Loopback ONLY; a strict
// subset of isPrivateHost. The bracketed '[::1]' form is the macOS launchServer
// endpoint that the old `LOOPBACK.has(host)` check silently rejected.
const LOOPBACK_ACCEPT = [
  '[::1]',                // bracketed IPv6 loopback — WHATWG URL.hostname form (the bug)
  '::1',                  // bare IPv6 loopback
  '0:0:0:0:0:0:0:1',      // fully-expanded IPv6 loopback
  '127.0.0.1',            // IPv4 loopback
  '127.0.0.5',            // anywhere in 127.0.0.0/8
  'localhost',
  'foo.localhost',        // *.localhost suffix
  '::ffff:127.0.0.1',     // IPv4-mapped IPv6 loopback (flattened by normalizeHost)
];

// Private but NOT loopback — the daemon never binds these, so accepting one would
// let a tampered session.json route our pages/credentials through an attacker's host.
const LOOPBACK_REJECT = [
  '192.168.1.50',         // RFC1918 LAN
  '10.0.0.1',             // RFC1918 10/8
  '169.254.169.254',      // link-local / cloud metadata
  '172.16.0.1',           // RFC1918 172.16/12
  'evil.example',         // public
  '127.evil.com',         // look-alike a `startsWith('127.')` check would wrongly accept
  '',                     // empty / malformed — refuse, never trust
];

test('isLoopbackHost accepts only loopback forms (incl. bracketed IPv6)', () => {
  for (const h of LOOPBACK_ACCEPT) {
    assert.equal(isLoopbackHost(h), true, `${h} must be loopback`);
  }
});

test('isLoopbackHost rejects every private-but-not-loopback + public + malformed host', () => {
  for (const h of LOOPBACK_REJECT) {
    assert.equal(isLoopbackHost(h), false, `${h} must NOT be loopback`);
  }
});
