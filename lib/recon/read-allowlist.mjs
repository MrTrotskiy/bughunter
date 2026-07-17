// The agent-populated READ-ALLOWLIST for the session-wide read-only WRITE-FIREWALL. The firewall aborts
// every non-GET BY DEFAULT (the CTO blocker-1 inversion: a benign-named write must NEVER reach a live authed
// account just because its URL path lacks a write verb — the residual a live rawcaster run proved real when
// POST /rawcaster/followandunfollow fired). This file is the ONLY thing that widens that default: an endpoint
// the AGENT judged a READ (a list/search over POST — the rawcaster nav class where content loads over POST)
// is recorded here, and the firewall continues it. A `write` verdict is recorded too but NEVER opens the gate
// (default abort holds), so the file is an honest ledger of every judged endpoint.
//
// INVARIANT (mirrors reveal-firewall's allowlist + location-key #2): a reqKey here is a firewall HINT, never
// a graph node id / instanceKey / edge. It keys on `METHOD /urlPattern` (identical string to graph-store's
// request key) so a live-request key compares equal, and nothing more. Honors BUGHUNTER_STATE_DIR.

import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

// `METHOD /urlPattern` — the SAME shape graph-store mints for a request node, so an allowlist key and a
// live-request key are byte-identical. Exported as the ONE key builder this feature shares (firewall + CLI).
export function reqKey(method, urlPattern) {
  return `${String(method).toUpperCase()} ${urlPattern}`;
}

// state/read-allowlist.json (honors BUGHUNTER_STATE_DIR so tests never touch repo state/).
function allowlistPath() {
  const stateDir = process.env.BUGHUNTER_STATE_DIR || path.join(process.cwd(), 'state');
  return path.join(stateDir, 'read-allowlist.json');
}

// The raw { "<reqKey>": "read"|"write" } map, or {} when absent/corrupt (FAIL-SAFE: an unreadable allowlist
// opens NOTHING — the firewall stays abort-by-default, never fails open into allowing writes).
export function loadAllowMap() {
  const p = allowlistPath();
  try {
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch { return {}; }
}

// The Set the firewall consults. Only endpoints judged `read` AND fired over POST are eligible to open the
// gate: GET/HEAD/OPTIONS are already continued (never need allowlisting), and a PUT/PATCH/DELETE is NEVER a
// read (mirrors reveal-firewall's L2 defense), so even a hand-edited `DELETE …: read` cannot widen the abort.
export function loadReadAllowlist() {
  const map = loadAllowMap();
  const set = new Set();
  for (const [key, cls] of Object.entries(map)) {
    if (cls === 'read' && key.startsWith('POST ')) set.add(key);
  }
  return set;
}

// Record ONE endpoint's judged class. `read` opens the gate (POST only); `write` is stored as-is and leaves
// the default abort in force. Merge-write (never truncates the existing ledger). Returns whether the entry
// actually opens the gate, so the CLI can report an honest `allowed`.
export function recordEndpointClass(key, cls) {
  const map = loadAllowMap();
  map[key] = cls;
  const p = allowlistPath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(map, null, 2));
  return { key, class: cls, allowed: cls === 'read' && key.startsWith('POST ') };
}
