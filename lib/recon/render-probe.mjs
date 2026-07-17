#!/usr/bin/env node
// render-probe — a READ-ONLY calibration CLI for the GOAL-1 phantom-route classifier. It answers, per
// declared route, the two questions the honest denominator rests on WITHOUT a full crawl or any graph
// mutation: (Q1) does the route CLIENT-REDIRECT, and at which poll index does the URL diverge (so the
// bounded poll window POLL_MAX×POLL_MS can be tuned to the app's slowest redirect)? (Q2) does the route
// render the shared Not-Found shell — i.e. does its structural contentSig equal the negative-control
// probe sig (graph.notFoundSig) — and does any REAL section collide with it?
//
// It reuses the PRODUCTION primitives (the visitRoute redirect poll, contentSig, probeNotFound) against
// an EPHEMERAL in-memory graph and prints raw per-route signals plus a derived verdict. It NEVER writes
// state/graph.json, never acts, never opens a causal window — a pure diagnostic. Every gate is reused:
// navigateGated (SSRF), routeKey/sameOrigin/isOffOriginHttp (scope). Authed runs honour
// BUGHUNTER_STORAGE_STATE (loaded in contextOptions at newContext, same as every other CLI).
//
// Usage: [PW_ALLOW_PRIVATE=1] node lib/recon/render-probe.mjs --url=<url> [--json]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnvelope, exitCode } from '../core/envelope.mjs';
import { attach, navigateGated } from '../browser/session.mjs';
import { waitSettled } from '../browser/causal.mjs';
import { makeGraph } from '../graph/graph-store.mjs';
import { snapshotDom, contentSig } from '../graph/dom-snapshot.mjs';
import { extractRoutes } from './route-manifest.mjs';
import { probeNotFound } from './route-frontier.mjs';
import { routeKey, sameOrigin, isOffOriginHttp } from './scope.mjs';
import { dismissOverlays } from './overlays.mjs';

const POLL_MS = 50;   // MUST mirror route-frontier.visitRoute — this probe calibrates that exact window
const POLL_MAX = 6;

// Classify ONE route the way visitRoute does, but report the RAW signals (poll-divergence index, sig,
// counts) instead of mutating a graph. Navigate → bounded redirect poll → contentSig → interactive
// counts → a derived verdict mirroring route-frontier + route-coverage.
async function classifyRoute(page, rk, origin, notFoundSig) {
  const navUrl = new URL(rk, origin).href;
  let response;
  try { ({ response } = await navigateGated(page, navUrl)); }
  catch { return { route: rk, verdict: 'nav-error', httpStatus: 0 }; }
  const httpStatus = response ? response.status() : 0;
  if (httpStatus >= 400) return { route: rk, verdict: 'http-4xx', httpStatus };

  await waitSettled(page);
  // Bounded redirect poll — early-out on the FIRST routeKey divergence, recording the poll index so the
  // window can be tuned. Never early-confirms on stability (a late redirect must not slip).
  let pollDivergedAt = null;
  let redirect = null;
  for (let i = 0; i < POLL_MAX; i++) {
    const u = page.url();
    if (!sameOrigin(origin, u) || isOffOriginHttp(origin, u)) { pollDivergedAt = i; redirect = 'redirect-offorigin'; break; }
    if (routeKey(u) !== rk) { pollDivergedAt = i; redirect = 'redirect'; break; }
    if (i < POLL_MAX - 1) await new Promise((r) => setTimeout(r, POLL_MS));
  }
  const settledUrl = page.url();
  if (redirect) return { route: rk, verdict: redirect, httpStatus, settledUrl, pollDivergedAt };

  await dismissOverlays(page);
  const sig = await contentSig(page);
  let snap;
  try { snap = await snapshotDom(page); } catch { snap = { elements: [] }; }
  const interactiveTotal = snap.elements.length;
  // Controls OUTSIDE a nav landmark ≈ the route's OWN content (the shell nav is on every page). A rough
  // stand-in for route-coverage's el.route attribution, enough to eyeball collected-vs-empty here.
  const contentInteractive = snap.elements.filter((e) => e.inNav !== true).length;
  const sigMatchesNotFound = notFoundSig != null && sig === notFoundSig;
  // Verdict mirrors route-coverage: an empty page whose sig matches the Not-Found probe is client-404;
  // an empty page with a distinct sig is a real content-starved section; anything with own content is
  // collected. (visitRoute keys "own content" on el.route; the empty-only client-404 guard holds here too.)
  let verdict;
  if (contentInteractive > 0) verdict = 'collected';
  else if (sigMatchesNotFound) verdict = 'client-404';
  else verdict = 'visited-empty';
  return { route: rk, verdict, httpStatus, settledUrl, pollDivergedAt: null, contentSig: sig, sigMatchesNotFound, interactiveTotal, contentInteractive };
}

export async function run(opts) {
  const origin = new URL(opts.url).origin;
  const { page, release } = await attach();
  try {
    await navigateGated(page, opts.url);
    await waitSettled(page);
    await dismissOverlays(page);
    // Declared route list from the app's own bundles (denominator source), computed WHILE on the entry page.
    const manifest = await extractRoutes(page);
    // Negative-control label: fingerprint the Not-Found shell once (ephemeral graph — never persisted).
    const graph = makeGraph();
    const notFoundSig = await probeNotFound(page, graph, origin);

    // Classify the entry route + every declared static route (dedup, sorted).
    const entry = routeKey(opts.url);
    const declared = [...new Set([entry, ...manifest.routes.map((r) => routeKey(new URL(r, origin).href))])].sort();
    const rows = [];
    for (const rk of declared) rows.push(await classifyRoute(page, rk, origin, notFoundSig));

    const by = (v) => rows.filter((r) => r.verdict === v).length;
    const summary = {
      declared: rows.length,
      collected: by('collected'),
      visitedEmpty: by('visited-empty'),
      client404: by('client-404'),
      redirect: by('redirect') + by('redirect-offorigin'),
      http4xx: by('http-4xx'),
      navError: by('nav-error'),
      paramPatterns: manifest.paramRoutes.length,
    };
    summary.collectable = summary.declared - summary.redirect - summary.client404 - summary.http4xx - summary.navError;
    return { ok: true, origin, notFoundSig, summary, routes: rows };
  } finally {
    await release();
  }
}

function renderText(res) {
  const L = [];
  L.push(`render-probe — ${res.origin}  (notFoundSig=${res.notFoundSig ?? 'unset'})`);
  const s = res.summary;
  L.push(`Declared: ${s.declared} · collected ${s.collected} · visited-empty ${s.visitedEmpty} · client-404 ${s.client404} · redirect ${s.redirect} · 4xx ${s.http4xx} · nav-error ${s.navError} · param ${s.paramPatterns}`);
  L.push(`Honest collectable base: ${s.collectable} (declared − redirect − client-404 − 4xx − nav-error)`);
  L.push('');
  for (const r of res.routes) {
    const extra = r.verdict === 'redirect' || r.verdict === 'redirect-offorigin'
      ? `→ ${r.settledUrl} (poll#${r.pollDivergedAt})`
      : `sig=${r.contentSig ?? '-'}${r.sigMatchesNotFound ? ' =404' : ''} own=${r.contentInteractive ?? '-'}/${r.interactiveTotal ?? '-'}`;
    L.push(`  ${String(r.verdict).padEnd(18)} ${String(r.route).padEnd(32)} ${extra}`);
  }
  return L.join('\n');
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    process.stderr.write(JSON.stringify({ ok: false, error: { code: 'USAGE', message: 'missing required --url=<url>' } }) + '\n');
    process.exit(64);
  }
  try {
    const res = await run({ url: args.url });
    process.stdout.write((args.json ? JSON.stringify(res) : renderText(res)) + '\n');
    process.exit(0);
  } catch (err) {
    let env = err && err.envelope;
    if (!env) env = makeEnvelope({ code: 'INTERNAL', message: err?.message || 'unknown error', exit: 'VIOLATION' });
    process.stderr.write(JSON.stringify({ ok: false, error: { code: env.code, message: env.message } }) + '\n');
    process.exit(exitCode(env));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
