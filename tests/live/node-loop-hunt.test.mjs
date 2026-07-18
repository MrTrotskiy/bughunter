// Live proof of NODE-LOOP HUNT (additive-only; decisions.md 2026-07-18 "NODE-LOOP HUNT"). The operator's
// goal #3: a SHELL-INVOCABLE loop that drains the whole surface WITH create/edit/delete of own content —
// not just the agent path. `recon-run --hunt` threads the SAME already-reviewed hunt machinery (ownsTarget
// marker, firewall method-gate, danger-floor) into the deterministic node-loop, so it commits SAFE own-
// content mutations autonomously. The one new risk of a judgment-less loop — unbounded create spam — is
// bounded by BUGHUNTER_HUNT_CREATE_BUDGET, enforced in persistentStep (never the shared actStep).
//
// Guards:
//   (A) HUNT ON the node-loop COMMITS own-content mutations that the read-only crawl refused (create/like/
//       comment/edit-own/delete-own reach the server), AND the OWNERSHIP RAIL HOLDS on the node-loop path:
//       an unowned (other-1) delete is refused client-side → forbiddenHits===0 (the server 403 never needed).
//   (B) CREATE BUDGET caps committed mutations: with BUGHUNTER_HUNT_CREATE_BUDGET=2 exactly 2 mutations
//       commit (server-side successful writes sum to 2), the rest revert to read-only — no spam.
//   (C) OFF BY DEFAULT: the same authed read-only crawl WITHOUT --hunt commits NOTHING (createHits===0,
//       likeHits===0, result.huntCreates undefined) — byte-identical to today. Plus a non-positive budget
//       (BUGHUNTER_HUNT_CREATE_BUDGET=0) forces hunt OFF (not unbounded) — no write commits.
//   (D) STRICT RAIL (security H1): a NAMELESS delete via a BENIGN method+path (POST /api/rpc {delete}) on
//       ANOTHER user's post slips the name gate AND the firewall method/path gate — the judge-free node-loop
//       declines it because the control sits in an unowned ownable item, so it never reaches the server.
//
// FAIL-ON-REVERT:
//   (A) revert persistentStep's hunt threading (armHunt always false) → committed 0, no own mutation reaches
//       the server → the "hunt committed a write" assertion reds. Drop the ownsTarget gate (step.mjs) → the
//       other-1 delete fires → server 403 → forbiddenHits 0→1 → the rail assertion reds.
//   (B) revert the overBudget gate (armHunt ignores the budget) → committed > 2 → the budget-cap reds.
//   (C) thread hunt unconditionally (ignore huntWrites=false) → the read-only crawl commits → (C) reds.
//   (D) drop huntStrict (or the inOwnableItem gate in step.mjs) → the RPC delete on other-1 commits → server
//       403 → forbiddenHits 0→1 → the strict-rail assertion reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/hunt-social-app/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';

const RUN_ID = 'nodehunt';
const MARKER = `HUNT-${RUN_ID}`;

function boot(t, { budget } = {}) {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-nodehunt-'));
  const prev = {
    allow: process.env.PW_ALLOW_PRIVATE, state: process.env.BUGHUNTER_STATE_DIR,
    run: process.env.BUGHUNTER_RUN_ID, storage: process.env.BUGHUNTER_STORAGE_STATE,
    budget: process.env.BUGHUNTER_HUNT_CREATE_BUDGET,
  };
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  process.env.BUGHUNTER_RUN_ID = RUN_ID;         // the ownership marker needs a run id (resolveWritePolicy)
  delete process.env.BUGHUNTER_STORAGE_STATE;    // readOnly comes from the explicit opt, not a storageState
  if (budget != null) process.env.BUGHUNTER_HUNT_CREATE_BUDGET = String(budget);
  else delete process.env.BUGHUNTER_HUNT_CREATE_BUDGET;
  t.after(() => {
    rmSync(stateDir, { recursive: true, force: true });
    for (const [k, v] of [['PW_ALLOW_PRIVATE', prev.allow], ['BUGHUNTER_STATE_DIR', prev.state], ['BUGHUNTER_RUN_ID', prev.run], ['BUGHUNTER_STORAGE_STATE', prev.storage], ['BUGHUNTER_HUNT_CREATE_BUDGET', prev.budget]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  return stateDir;
}

const sumVals = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const totalWrites = (c) => c.createHits + c.likeHits + c.commentHits + c.editHits
  + sumVals(c.deleteHits) + sumVals(c.rpcDeleteHits) + c.accountDeleted + c.loggedOut;

test('(A,B) node-loop --hunt commits own-content mutations, ownership rail holds, budget caps', async (t) => {
  boot(t, { budget: 2 });
  const server = await start(0, { marker: MARKER });
  const url = `http://127.0.0.1:${server.address().port}/`;
  t.after(() => server.close());

  const res = await crawl({ url, readOnly: true, hunt: true, steps: 25, seedManifest: false });

  const c = server.counters();
  // (A) the node-loop COMMITTED own-content mutations the read-only crawl would have refused.
  assert.ok((res.huntCreates?.committed || 0) > 0, 'the node-loop hunt COMMITTED at least one own-content mutation (was refused read-only)');
  assert.ok(totalWrites(c) > 0, 'a write reached the fixture server (create/like/comment/edit-own/delete-own)');
  // (A) OWNERSHIP RAIL — the critical safety invariant, proven on the NODE-LOOP path: an unowned delete is
  // refused client-side, so the server never had to 403 it. This holds because ownsTarget is deterministic.
  assert.equal(c.forbiddenHits, 0, 'the ownership rail held: no unowned edit/delete reached the server (client refused first)');
  assert.ok(!c.deleteHits['other-1'], "another user's post was NEVER deleted by the autonomous loop");
  assert.equal(c.accountDeleted, 0, 'account-deletion refused (this run did not create the account)');
  assert.equal(c.loggedOut, 0, 'auth (logout) refused in hunt — no self-logout');
  // (B) BUDGET caps committed mutations at exactly the budget (2), the rest revert to read-only.
  assert.equal(res.huntCreates.budget, 2, 'the create budget is surfaced');
  assert.equal(res.huntCreates.committed, 2, 'exactly BUDGET(2) mutations committed — the counter capped further writes');
  assert.equal(totalWrites(c), 2, 'the server saw exactly 2 successful writes — the budget bound the autonomous loop');
});

test('(D) node-loop ownership rail holds when the representative row is ANOTHER user — incl. the H1 benign-path RPC', async (t) => {
  boot(t, { budget: 50 });    // high budget so the cap never masks the rail — the gates are what must block it
  // otherFirst → the DRILL_PER_LIST representative feed row is other-1, so the judge-free loop actually ACTS
  // another user's edit/delete/rpc controls (a self-first feed would drill-skip them and vacuously pass).
  const server = await start(0, { marker: MARKER, otherFirst: true });
  const url = `http://127.0.0.1:${server.address().port}/`;
  t.after(() => server.close());

  await crawl({ url, readOnly: true, hunt: true, steps: 40, seedManifest: false });

  const c = server.counters();
  // NONE of the unowned mutation paths on other-1 may reach the server: PUT (named edit, method-gate), DELETE
  // (named + icon, method-gate), and — the H1 shape — POST /api/rpc {delete} (nameless + benign path, which
  // BOTH the name gate and the firewall method/path gate miss, so ONLY the node-loop's inOwnableItem strictness
  // stops it). forbiddenHits===0 = every one was refused client-side before the server had to 403.
  assert.equal(c.forbiddenHits, 0, 'the ownership rail held on ANOTHER user\'s representative row — no unowned edit/delete/rpc reached the server');
  assert.ok(!c.rpcDeleteHits['other-1'], "the H1 benign-path RPC never deleted another user's post");
  assert.ok(!c.deleteHits['other-1'], "another user's post was never deleted (named/icon DELETE)");
  assert.ok(server.posts().some((p) => p.id === 'other-1'), 'the other user\'s post is still present, untouched');
});

test('(C) node-loop is read-only WITHOUT --hunt — byte-identical, no mutation', async (t) => {
  boot(t);
  const server = await start(0, { marker: MARKER });
  const url = `http://127.0.0.1:${server.address().port}/`;
  t.after(() => server.close());

  const res = await crawl({ url, readOnly: true, steps: 25, seedManifest: false });
  const c = server.counters();
  assert.equal(res.huntCreates, undefined, 'no hunt summary on a non-hunt crawl');
  assert.equal(totalWrites(c), 0, 'NO write reached the server without --hunt (every mutation refused read-only)');
  assert.equal(c.forbiddenHits, 0, 'and nothing even attempted an unowned write');
});

test('(C2) budget=0 forces hunt OFF (not unbounded — the Number("0"||15) trap)', async (t) => {
  boot(t, { budget: 0 });   // fresh state dir + BUGHUNTER_HUNT_CREATE_BUDGET=0
  const server = await start(0, { marker: MARKER });
  const url = `http://127.0.0.1:${server.address().port}/`;
  t.after(() => server.close());

  const res = await crawl({ url, readOnly: true, hunt: true, steps: 25, seedManifest: false });
  assert.equal(res.huntCreates.budget, 0, 'the budget is surfaced as 0');
  assert.equal(res.huntCreates.committed, 0, 'budget=0 committed NOTHING (hunt disabled, not the inverted unbounded)');
  assert.equal(totalWrites(server.counters()), 0, 'no write reached the server under budget=0');
});
