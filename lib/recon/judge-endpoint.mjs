#!/usr/bin/env node
// judge-endpoint — the recon agent's READ/WRITE verdict tool for the read-only WRITE-FIREWALL. Modeled on
// observe.mjs: a THIN file-only CLI the Sonnet agent calls to record whether a captured endpoint is a READ
// (a list/search over POST that must be CONTINUED so content loads) or a WRITE (a mutation that must stay
// ABORTED). The read/write call is a SEMANTIC judgment → the agent (the model split), never a hard-coded
// heuristic beyond the firewall's write-verb backstop. This writes ONLY to state/read-allowlist.json; it
// touches no graph node, edge, or browser — the same file-only handoff observe.mjs uses. NEVER the operator
// override (--allow-benign-post lives in recon-run argv, unreachable from the agent).
//
// Usage: node lib/recon/judge-endpoint.mjs --endpoint='POST /rawcaster/listnuggets' --class=read|write
//   read  → the endpoint is added to the allowlist (the firewall CONTINUES it) — POST only.
//   write → recorded as judged, but the gate stays CLOSED (default abort holds).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnvelope, envelopeError, exitCode } from '../core/envelope.mjs';
import { recordEndpointClass, reqKey } from './read-allowlist.mjs';

const CLASS = new Set(['read', 'write']);
// `METHOD /path` — an uppercase HTTP method. The urlPattern may carry :param / ?k=:param (graph-store's
// mask), so anything non-whitespace after the leading '/' is allowed.
const METHOD_RE = /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE|CONNECT|TRACE)$/;

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}

export function judge(opts) {
  const endpoint = String(opts.endpoint || '').trim();
  const parts = endpoint.split(/\s+/);
  const method = (parts[0] || '').toUpperCase();
  const rest = parts.slice(1).join(' ');
  if (parts.length !== 2 || !METHOD_RE.test(method) || !rest.startsWith('/')) {
    throw envelopeError({ code: 'USAGE', message: `--endpoint must be "METHOD /path" (e.g. 'POST /api/listnuggets')`, exit: 'USAGE' });
  }
  const cls = String(opts.class || '');
  if (!CLASS.has(cls)) {
    throw envelopeError({ code: 'USAGE', message: `--class must be one of ${[...CLASS].join('|')}`, exit: 'USAGE' });
  }
  // A READ verdict only opens the gate for a POST (GET/HEAD/OPTIONS are already continued; a PUT/PATCH/
  // DELETE is never a read — mirrors reveal-firewall's L2 defense). Reject a non-POST read loudly rather
  // than write a dead entry the loader would silently drop.
  if (cls === 'read' && method !== 'POST') {
    throw envelopeError({ code: 'USAGE', message: `only a POST endpoint is read-allowlist-eligible (GET/HEAD/OPTIONS already pass, other verbs are never reads); got ${method}`, exit: 'USAGE' });
  }
  const key = reqKey(method, rest);
  const rec = recordEndpointClass(key, cls);
  return { ok: true, endpoint: key, class: cls, allowed: rec.allowed };
}

function emitError(env) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: env.code, message: env.message } }) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  try {
    const result = judge({ endpoint: args.endpoint, class: args.class });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (err) {
    const env = err?.envelope || makeEnvelope({ code: 'INTERNAL', message: err?.message || 'unknown error', exit: 'VIOLATION' });
    emitError(env);
    process.exit(exitCode(env));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
