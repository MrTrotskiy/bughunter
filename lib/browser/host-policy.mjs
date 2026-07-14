// Canonical host policy checks — the SSRF gate on Playwright target URLs.
//
// Ported verbatim from bughunt-agents. One canonical normalizer eliminates
// drift between callers: a hostname must be classified the same regardless of
// its textual form (IPv4 literal, IPv6 loopback, IPv4-mapped IPv6, etc.).
//
// Public API:
//   normalizeHost(hostname)   → canonical form (lowercased, trailing-dot
//                               stripped, IPv6 brackets removed, IPv4-mapped
//                               IPv6 flattened to IPv4)
//   isPrivateHost(hostname)   → true for loopback, RFC1918, link-local,
//                               ULA, unspecified (0.0.0.0 / ::), and every
//                               `*.local` / `*.internal` / `*.localhost`
//                               suffix
//   isPublicHttpUrl(url)      → true for http(s):// targets with a public
//                               hostname (convenience wrapper over
//                               isPrivateHost)

export function normalizeHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return '';
  // Lowercase + strip a single trailing FQDN dot. Browsers treat
  // "foo.example.com" and "foo.example.com." as equivalent; the regex
  // families below do not, so normalize here.
  let h = hostname.toLowerCase().replace(/\.$/, '');
  // IPv6 literal in URL form keeps the brackets; node's URL parser already
  // strips them from `.hostname`, but defensive-strip here makes the helper
  // safe to call on raw host strings too.
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  // IPv4-mapped IPv6 dotted form: ::ffff:127.0.0.1 → 127.0.0.1
  const mappedDotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mappedDotted) return mappedDotted[1];
  // IPv4-mapped IPv6 hex form: ::ffff:7f00:1 → 127.0.0.1 (rare but spec)
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  // IPv4-compatible IPv6 dotted form: ::127.0.0.1 → 127.0.0.1 (deprecated but
  // still resolvable, classified public without flattening — SSRF bypass).
  const compatDotted = h.match(/^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (compatDotted) return compatDotted[1];
  // IPv4-compatible IPv6 hex form: ::7f00:1 → 127.0.0.1, ::a9fe:a9fe → metadata.
  const compatHex = h.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (compatHex) {
    const hi = parseInt(compatHex[1], 16);
    const lo = parseInt(compatHex[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return h;
}

export function isPrivateHost(hostname) {
  const h = normalizeHost(hostname);
  // Empty hostname: treat as private. A bare-empty host landing here means
  // malformed input; refusing is the safe default.
  if (!h) return true;
  // Unspecified / wildcards — never public destinations.
  if (h === '0.0.0.0' || h === '::' || h === '::0' || h === '0:0:0:0:0:0:0:0') return true;
  // Localhost and trust-local suffixes.
  if (h === 'localhost' ||
      h.endsWith('.localhost') ||
      h.endsWith('.internal') ||
      h.endsWith('.local')) {
    return true;
  }
  // IPv4 literal — RFC1918 + loopback + link-local + cloud metadata + CGNAT.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = m.slice(1).map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + AWS/GCP metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    // RFC 6598 CGNAT 100.64.0.0/10 — IANA shared address space, never publicly
    // routable. In practice covers Tailscale (100.64–100.127 default range)
    // and carrier-grade NAT. Classifying as private lets injection-gate
    // probe trusted VPN/lab endpoints and keeps SSRF gates closed for the
    // same range.
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  // IPv6 loopback and expanded loopback.
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  // fc00::/7 Unique Local Addresses.
  if (/^(fc|fd)[0-9a-f:]/.test(h)) return true;
  // fe80::/10 link-local.
  if (/^fe[89ab][0-9a-f]*:/.test(h)) return true;
  return false;
}

export function isPublicHttpUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return !isPrivateHost(u.hostname);
}
