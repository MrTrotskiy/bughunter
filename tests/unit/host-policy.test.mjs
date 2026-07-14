// Unit test for the SSRF gate: isPrivateHost must classify every private/loopback
// textual form as private (true) and only genuinely public hosts as reachable
// (false). This guards the gate against an SSRF bypass — a private target that
// slips through as "public" lets a hunt reach loopback / cloud-metadata.
//
// Guards: isPrivateHost SSRF classification across IPv4 literals, IPv6 loopback,
//   IPv4-mapped IPv6, link-local + cloud metadata, and trust-local name suffixes.
// FAIL-ON-REVERT: neuter the gate (isPrivateHost first line `return false`, the
//   SSRF bypass) -> "AssertionError [ERR_ASSERTION]: 127.0.0.1 must be private".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateHost } from '../../lib/browser/host-policy.mjs';

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
