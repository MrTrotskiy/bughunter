// Acceptance test for the vertical slice. Boots the search fixture on an ephemeral
// port and drives the whats-new CLI against it (real spawn → real envelope + exit
// code). Proves the two theses:
//   1. Causal attribution: /api/search IS credited to the search button; the
//      load-burst /api/config and background poll /api/ping are NOT.
//   2. Two-level identity: the result rows' Edit buttons share ONE templateId but
//      have DISTINCT instanceKeys (one template, many addressable instances).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../fixtures/search-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { beginCause, endCause, waitSettled } from '../../lib/browser/causal.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', '..', 'lib', 'recon', 'whats-new.mjs');

function runCli(args, stateDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, PW_ALLOW_PRIVATE: '1', BUGHUNTER_STATE_DIR: stateDir },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

// Guards: causal attribution end-to-end (the wire->request contract: /api/search
//   is credited to #search with a causal edge, load-burst /api/config + poll
//   /api/ping stay uncredited) AND two-level identity (one Edit template, N
//   addressable row instances) through the real whats-new CLI + graph.
// FAIL-ON-REVERT: neuter causal attribution (endCause `return kept` -> `return []`)
//   -> "AssertionError [ERR_ASSERTION]: search must be attributed, got []".
test('whats-new: causal attribution + two-level identity on a live page', async (t) => {
  const server = await start(0);
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-'));
  t.after(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  // --- baseline run: discover the interactive elements, populate the ledger ---
  const base = await runCli([`--url=${url}`], stateDir);
  assert.equal(base.code, 0, `baseline should exit 0, stderr=${base.err}`);
  const baseEnv = JSON.parse(base.out);
  assert.equal(baseEnv.ok, true);
  assert.equal(baseEnv.route, '/');
  assert.ok(baseEnv.baseline.total >= 2, `expected >=2 baseline elements, got ${baseEnv.baseline.total}`);
  assert.ok('opaque' in baseEnv.baseline, 'opaque coverage is reported, not hidden');
  assert.equal(typeof baseEnv.baseline.opaque, 'number');

  // The search button has a stable id, so its template key is deterministic.
  const ledger = JSON.parse(readFileSync(path.join(stateDir, 'element-ids.json'), 'utf8'));
  const searchId = ledger.ids['tpl:#search'];
  assert.ok(Number.isInteger(searchId), 'search button received a stable template id');

  // --- action run: click search with a fill, attribute what it caused ---
  const acted = await runCli([`--url=${url}`, `--act-template=${searchId}`, '--fill=hello'], stateDir);
  assert.equal(acted.code, 0, `action run should exit 0, stderr=${acted.err}`);
  const env = JSON.parse(acted.out);
  assert.equal(env.ok, true);
  assert.ok(env.acted, 'acted block present');
  assert.equal(env.acted.cause, String(searchId));

  const patterns = env.acted.requests.map((r) => r.urlPattern);
  // 1a. the search request IS attributed to the search button's cause.
  assert.ok(
    env.acted.requests.some((r) => r.method === 'GET' && r.urlPattern === '/api/search?q=:param'),
    `search must be attributed, got ${JSON.stringify(patterns)}`,
  );
  // 1b. the load-burst and the background poll are NOT attributed.
  assert.ok(!patterns.some((p) => p.includes('/api/config')), `config must stay uncredited, got ${JSON.stringify(patterns)}`);
  assert.ok(!patterns.some((p) => p.includes('/api/ping')), `ping must stay uncredited, got ${JSON.stringify(patterns)}`);

  // 2a. the action revealed new element instances (the result rows).
  assert.ok(env.acted.newElements.length >= 1, 'result rows revealed as new instances');

  // 2b. graph proves the two-level model: one Edit-button template, N instances.
  const graph = JSON.parse(readFileSync(path.join(stateDir, 'graph.json'), 'utf8'));
  const editEl = Object.values(graph.elements).find((e) => String(e.templateSelector).endsWith('button.edit'));
  assert.ok(editEl, 'a single Edit-button template exists');
  assert.ok(editEl.instances.length >= 2, `expected multiple row instances, got ${editEl.instances.length}`);
  const keys = new Set(editEl.instances.map((i) => i.instanceKey));
  assert.equal(keys.size, editEl.instances.length, 'each row instance has a distinct instanceKey');

  // the causal edge was persisted with provenance "causal".
  const edge = graph.edges.find((e) => e.from === `element:${searchId}` && e.provenance === 'causal');
  assert.ok(edge, 'search element has a causal triggers edge to a request');
});

// Deterministic guard for the initiator mechanism specifically: the CLI window is
// short, so a 400ms poll only SOMETIMES lands inside it. Here we hold the window
// open long enough that pings MUST tick, then prove the token alone would have
// miscredited them (they carry the search cause) but the initiator classifier
// rejects them — the exact race that a time-window attribution gets wrong.
// Guards: the CDP-initiator classifier specifically — a setInterval-rooted poll
//   that ticks INSIDE a control's causal window carries the control's cause token,
//   so the token alone would miscredit it; only classifyInitiator's timer-parent
//   rejection drops it. Chromium-specific (needs CDP async call stacks).
// FAIL-ON-REVERT: neuter classifyInitiator (first line `return {background:false}`)
//   -> the poll's cause token is no longer overridden ->
//   "AssertionError [ERR_ASSERTION]: initiator rejected the in-window poll".
test('background poll that ticks inside the causal window is rejected by initiator, not token', async (t) => {
  process.env.PW_ALLOW_PRIVATE = '1';
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browser, page } = await launch();
  t.after(async () => { await close(browser); server.close(); });

  await gotoGated(page, url);
  await waitSettled(page);
  await page.fill('#q', 'hello');

  const cause = 'SEARCH_BTN';
  const seq0 = await beginCause(page, cause);
  await page.click('#search');
  await new Promise((r) => setTimeout(r, 1000)); // force >=2 poll ticks into the window
  const kept = await endCause(page, seq0, cause);

  // The raw ring shows what the TOKEN alone would credit: search + the pings that
  // ticked mid-window all carry our cause.
  const raw = await page.evaluate(({ c, s }) => window.__bughuntFires
    .filter((f) => f.cause === c && f.seq >= s)
    .map((f) => f.url), { c: cause, s: seq0 });
  assert.ok(raw.some((u) => u.includes('/api/ping')), 'a ping must tick inside the window (else this guard is vacuous)');
  assert.ok(raw.some((u) => u.includes('/api/search')), 'search is in the raw window too');

  // The kept (attributed) set keeps the click-caused search and drops every poll.
  const keptUrls = kept.map((f) => f.url);
  assert.ok(keptUrls.some((u) => u.includes('/api/search')), 'search survives attribution');
  assert.ok(!keptUrls.some((u) => u.includes('/api/ping')), 'initiator rejected the in-window poll');
});
