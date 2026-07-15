// Live proof of AUTHENTICATED recon: a login pre-step produces a Playwright storageState,
// and the existing crawl — loading that state at BOTH newContext sites — maps the
// logged-in surface with the same graph machinery. Real chromium + a cookie-session
// fixture. Four guards, four failure classes:
//
// Guards:
//   T1 storageState injection (session.mjs contextOptions at newContext) makes the crawl
//      authenticated — the authed-only #account control is mapped, not the login form — AND
//      causal capture still works logged-in (the click-caused edge is credited, the in-window
//      poll rejected). The fixture's login page carries a DECOY form before the real one, so
//      T1 also guards login.mjs's form-scoped field discovery (B1).
//   T2 login VERIFIES success before persisting — wrong creds never write a storageState
//      (a run must not silently crawl the logged-out surface believing it is in).
//   T3 the route guard (recon-run persistentStep) refuses to NAVIGATE to a /logout route,
//      so the crawl never logs itself out — the hole the name-only click gate cannot see.
//   T5 login output carries counts only — the credentials never appear in its envelope.
//   T6 login refuses an OFF-ORIGIN form action before typing the creds (a compromised login
//      page cannot POST the password to an attacker).
// FAIL-ON-REVERT:
//   T1 drop `storageState` from contextOptions() in session.mjs → /dashboard 302→/login →
//      no 'Account' node → "the crawl was logged in" goes red. Also: revert login.mjs to a
//      document-order field search (drop the password-form scoping) → the decoy newsletter
//      email is filled → no session → same red.
//   T2 remove the loginSucceeded() check in login.mjs → wrong creds "succeed" + write a
//      storageState → the assert.rejects(LOGIN_FAILED) goes red.
//   T3 remove the routeRefused() guard in recon-run.mjs → the crawl navigates to /logout →
//      server.logoutHits() becomes >= 1 → "never navigated to /logout" goes red.
//   T5 add the username/password to login()'s returned envelope → the sentinel appears in
//      the serialized result → "credentials never appear" goes red.
//   T6 remove the off-origin form-action check in login.mjs → it fills + submits to the
//      off-origin action → the error is a network failure, not the 'off-origin' refusal →
//      the message assertion goes red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/auth-app/server.mjs';
import { login } from '../../lib/recon/login.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { loadGraph, SCHEMA_VERSION } from '../../lib/graph/graph-store.mjs';

// Set env for the duration of one test, restoring exactly on teardown (including vars
// reassigned mid-test — captured `prev` is what existed BEFORE the test).
function setEnv(t, vars) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  t.after(() => {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  });
}

function mkState(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bughunter-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const USER = 'admin@example.test';
const PASS = 'correct-horse';

test('T1: storageState from login makes the crawl authenticated', async (t) => {
  const server = await start(0, { user: USER, pass: PASS });
  const base = `http://127.0.0.1:${server.address().port}`;
  const stateDir = mkState(t);
  t.after(() => server.close());
  setEnv(t, {
    PW_ALLOW_PRIVATE: '1', BUGHUNTER_STATE_DIR: stateDir,
    BUGHUNTER_LOGIN_USER: USER, BUGHUNTER_LOGIN_PASS: PASS, BUGHUNTER_STORAGE_STATE: undefined,
  });

  const loginRes = await login({ loginUrl: `${base}/login` });
  assert.equal(loginRes.ok, true, 'login succeeded');
  assert.ok(loginRes.cookies >= 1, 'a session cookie was captured into storageState');

  // Hand the crawl the session: contextOptions() reads this at newContext.
  process.env.BUGHUNTER_STORAGE_STATE = loginRes.out;

  const res = await crawl({ url: `${base}/dashboard`, steps: 5 });
  assert.equal(res.ok, true, 'crawl completed');
  const graph = loadGraph(path.join(stateDir, 'graph.json'));
  const account = Object.values(graph.elements).find((n) => n.name === 'Account');
  assert.ok(account, 'the authed-only #account control is mapped → the crawl was logged in (not bounced to /login)');

  // Causal capture works on the LOGGED-IN surface: the click-caused edge is credited, and the
  // in-window background poll is NOT (storageState seeding cookies did not perturb the
  // token+CDP-initiator attribution). This discharges the "auth doesn't touch causal" claim.
  const loadMore = Object.values(graph.elements).find((n) => n.name === 'Load more');
  assert.ok(loadMore, 'the authed Load more control is mapped');
  assert.ok(Object.keys(graph.requests).some((k) => /\/api\/nuggets/.test(k)), 'POST /api/nuggets is credited on the authed page');
  assert.ok(
    graph.edges.some((e) => e.from === `element:${loadMore.templateId}` && /nuggets/.test(e.to)),
    'the causal edge is attributed to Load more (capture works while logged in)',
  );
  assert.ok(
    !Object.keys(graph.requests).some((k) => /\/api\/ping/.test(k)),
    'the background poll /api/ping is not credited (causal attribution intact under auth)',
  );
});

test('T2: login refuses to persist a session for wrong credentials', async (t) => {
  const server = await start(0, { user: USER, pass: PASS });
  const base = `http://127.0.0.1:${server.address().port}`;
  const stateDir = mkState(t);
  t.after(() => server.close());
  setEnv(t, {
    PW_ALLOW_PRIVATE: '1', BUGHUNTER_STATE_DIR: stateDir,
    BUGHUNTER_LOGIN_USER: USER, BUGHUNTER_LOGIN_PASS: 'wrong-password', BUGHUNTER_STORAGE_STATE: undefined,
  });

  await assert.rejects(
    () => login({ loginUrl: `${base}/login` }),
    (err) => err?.envelope?.code === 'LOGIN_FAILED',
    'wrong credentials must reject with LOGIN_FAILED',
  );
  assert.ok(!fs.existsSync(path.join(stateDir, 'storage-state.json')), 'no storageState is written for a failed login');

  // Right credentials then succeed and DO persist.
  process.env.BUGHUNTER_LOGIN_PASS = PASS;
  const ok = await login({ loginUrl: `${base}/login` });
  assert.equal(ok.ok, true, 'correct credentials succeed');
  assert.ok(ok.cookies >= 1, 'and capture the session cookie');
});

test('T3: the crawl refuses to navigate to a danger route (no self-logout)', async (t) => {
  const server = await start(0, { user: USER, pass: PASS });
  const base = `http://127.0.0.1:${server.address().port}`;
  const stateDir = mkState(t);
  t.after(() => server.close());
  setEnv(t, { PW_ALLOW_PRIVATE: '1', BUGHUNTER_STATE_DIR: stateDir, BUGHUNTER_STORAGE_STATE: undefined });

  // Seed a control whose ROUTE is /logout but whose NAME is safe — only the route guard
  // (not the name-only click gate) can stop the crawl from navigating there. Seed the id
  // ledger past the trap's ids so the baseline's freshly-minted /welcome control cannot
  // collide onto templateId 1 (an empty ledger would re-mint id 1 and merge the two).
  const seed = {
    schemaVersion: SCHEMA_VERSION, // current-scheme seed: loadGraph must NOT reset it (INC.1 gate)
    routes: { '/logout': { type: 'route', url: '/logout' } },
    elements: {
      1: {
        type: 'element', templateId: 1, role: 'link', name: 'Proceed', route: '/logout', explored: false,
        instances: [{ instanceId: 2, instanceKey: '', instanceSelector: '#seeded-logout' }],
      },
    },
    requests: {}, edges: [],
  };
  fs.writeFileSync(path.join(stateDir, 'graph.json'), JSON.stringify(seed));
  fs.writeFileSync(path.join(stateDir, 'element-ids.json'), JSON.stringify({ next: 100, ids: {} }));

  const res = await crawl({ url: `${base}/welcome`, steps: 10 });
  assert.equal(res.ok, true, 'crawl completed');

  assert.equal(server.logoutHits(), 0, 'the crawl NEVER navigated to /logout');
  const graph = loadGraph(path.join(stateDir, 'graph.json'));
  assert.ok(graph.elements['1'].unreachable, 'the /logout-route control is honestly marked unreachable');
  const go = Object.values(graph.elements).find((n) => n.name === 'Browse');
  assert.ok(go && go.explored, 'the crawl still made progress on the public /welcome control');
});

test('T5: login output never contains the credentials', async (t) => {
  const SENT_USER = 'sentinel-user@example.test';
  const SENT_PASS = 'S3NT1NEL-pw-do-not-leak';
  const server = await start(0, { user: SENT_USER, pass: SENT_PASS });
  const base = `http://127.0.0.1:${server.address().port}`;
  const stateDir = mkState(t);
  t.after(() => server.close());
  setEnv(t, {
    PW_ALLOW_PRIVATE: '1', BUGHUNTER_STATE_DIR: stateDir,
    BUGHUNTER_LOGIN_USER: SENT_USER, BUGHUNTER_LOGIN_PASS: SENT_PASS, BUGHUNTER_STORAGE_STATE: undefined,
  });

  const res = await login({ loginUrl: `${base}/login` });
  assert.equal(res.ok, true, 'login succeeded');
  const serialized = JSON.stringify(res);
  assert.ok(!serialized.includes(SENT_PASS), 'the password never appears in the login result envelope');
  assert.ok(!serialized.includes(SENT_USER), 'the username never appears in the login result envelope');
});

test('T6: login refuses an off-origin form action before submitting the credentials', async (t) => {
  const server = await start(0, { user: USER, pass: PASS });
  const base = `http://127.0.0.1:${server.address().port}`;
  const stateDir = mkState(t);
  t.after(() => server.close());
  setEnv(t, {
    PW_ALLOW_PRIVATE: '1', BUGHUNTER_STATE_DIR: stateDir,
    BUGHUNTER_LOGIN_USER: USER, BUGHUNTER_LOGIN_PASS: PASS, BUGHUNTER_STORAGE_STATE: undefined,
  });

  await assert.rejects(
    () => login({ loginUrl: `${base}/login-offsite` }),
    (err) => err?.envelope?.code === 'LOGIN_FAILED' && /off-origin/.test(err.message),
    'an off-origin form action must be refused with an off-origin LOGIN_FAILED',
  );
  assert.ok(!fs.existsSync(path.join(stateDir, 'storage-state.json')), 'no storageState written when the form is off-origin');
});
