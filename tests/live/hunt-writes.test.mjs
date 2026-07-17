// Live proof of WRITE-HUNT mode — the safe mutation-testing relaxation of the read-only firewall. The
// operator's rule: on a test account the agent MAY create / edit-own / delete-own / comment / like /
// pay, but NEVER edit or delete ANOTHER user's content, and delete an ACCOUNT only if THIS run created
// it. Ownership is proven by the HUNT-<runId> marker in the target's item DOM (hunt-gate.ownsTarget,
// fail-closed). The server enforces ownership too (403) as the ground-truth backstop; forbiddenHits===0
// proves the CLIENT gate refused BEFORE the server had to.
//
// Guards:
//   (A) OWNERSHIP RAIL (the critical safety test): delete on the "other"-owned (UNmarked) post is refused
//       HUNT_NOT_OWNED — the write never fires (deleteHits['other-1'] absent, forbiddenHits===0, post
//       still present); delete on OUR marked post commits (deleteHits['self-1']===1, post gone).
//   (B) ADDITIVE + OWN: like on the other's post is ALLOWED (additive, no ownership needed); create commits
//       (createHits===1); edit on OUR marked post commits (editHits===1).
//   (C) OFF BY DEFAULT: WITHOUT --hunt the same authed read-only crawl refuses the create + the like
//       (MUTATION_FLOOR) — no write reaches the server (createHits===0, likeHits===0). Byte-identical to today.
//   (D) ACCOUNT RAIL: "Delete account" is refused HUNT_ACCOUNT_PROTECTED unless THIS run created the account
//       (runCreatedAccount) — then it commits (accountDeleted 0 → 1).
//
// FAIL-ON-REVERT:
//   (A) drop the ownsTarget gate in step.mjs → the other's-post delete fires → the server 403s it →
//       forbiddenHits 0→1 (the client gate failed, the server caught it) → the "client refused first"
//       assertion reds. (deleteHits['other-1'] stays 0 because the server 403s — forbiddenHits is the sentinel.)
//   (E) drop the firewall destructive method-gate → the ICON-only delete on others' commits → the server
//       403s → forbiddenHits 0→1 → the "icon delete aborted" assertion reds (the name classifiers can't
//       catch a nameless control, so the firewall method-gate is the only client protection here).
//   (F) exempt AUTH in hunt → Logout fires → loggedOut 0→1 → the "auth refused" assertion reds.
//   (C) drop the `!huntWrites` guard on the MUTATION_FLOOR gate (or the hunt window in the firewall) →
//       either the read-only like commits (likeHits>0) or the hunt like is blocked → the OFF/ON reds.
//   (D) exempt account-deletion from the run-created gate → accountDeleted===1 without the flag → reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/hunt-social-app/server.mjs';
import { run } from '../../lib/recon/whats-new.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';

const RUN_ID = 'hunttest';
const MARKER = `HUNT-${RUN_ID}`;

function boot(t) {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-hunt-'));
  const prev = {
    allow: process.env.PW_ALLOW_PRIVATE, state: process.env.BUGHUNTER_STATE_DIR,
    run: process.env.BUGHUNTER_RUN_ID, storage: process.env.BUGHUNTER_STORAGE_STATE,
  };
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  process.env.BUGHUNTER_RUN_ID = RUN_ID;      // the ownership marker needs a run id (resolveWritePolicy)
  delete process.env.BUGHUNTER_STORAGE_STATE; // readOnly comes from the explicit opt, not a storageState
  t.after(() => {
    rmSync(stateDir, { recursive: true, force: true });
    for (const [k, v] of [['PW_ALLOW_PRIVATE', prev.allow], ['BUGHUNTER_STATE_DIR', prev.state], ['BUGHUNTER_RUN_ID', prev.run], ['BUGHUNTER_STORAGE_STATE', prev.storage]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  return path.join(stateDir, 'graph.json');
}

const tpl = (graph, name) => Object.values(graph.elements).find((n) => n.name === name);
const keyFor = (t2, postId) => t2.instances.find((i) => String(i.instanceKey).includes(postId)).instanceKey;

async function baseline(url, graphFile) {
  await run({ url, readOnly: true });
  return loadGraph(graphFile);
}

test('write-hunt (A): the ownership rail — never delete others content, delete own', async (t) => {
  const server = await start(0, { marker: MARKER });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const graphFile = boot(t);
  t.after(() => server.close());
  const graph = await baseline(url, graphFile);
  const del = tpl(graph, 'Delete');
  assert.ok(del, 'the Delete control is discovered on both posts');

  // Delete on the OTHER user's (unmarked) post → refused before the click. The write never fires.
  await assert.rejects(
    run({ url, readOnly: true, hunt: true, actTemplate: del.templateId, instance: keyFor(del, 'other-1') }),
    (err) => err?.envelope?.code === 'HUNT_NOT_OWNED',
    'deleting a post this run did not create (no HUNT marker) must be refused HUNT_NOT_OWNED',
  );
  assert.ok(!server.counters().deleteHits['other-1'], 'the other-owned post was NEVER deleted (write did not fire)');
  assert.equal(server.counters().forbiddenHits, 0, 'the CLIENT gate refused BEFORE the server 403 (defense in depth, not last resort)');
  assert.ok(server.posts().some((p) => p.id === 'other-1'), 'the other-owned post is still present');

  // Delete on OUR marked post → the marker proves ownership → the delete commits.
  await run({ url, readOnly: true, hunt: true, actTemplate: del.templateId, instance: keyFor(del, 'self-1') });
  assert.equal(server.counters().deleteHits['self-1'], 1, 'our own HUNT-marked post was deleted (delete-own commits)');
  assert.ok(!server.posts().some((p) => p.id === 'self-1'), 'our post is gone (self-clean)');
});

test('write-hunt (B): additive on others + create + edit-own all commit', async (t) => {
  const server = await start(0, { marker: MARKER });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const graphFile = boot(t);
  t.after(() => server.close());
  const graph = await baseline(url, graphFile);
  const like = tpl(graph, 'Like');
  const post = tpl(graph, 'Post');
  const edit = tpl(graph, 'Edit');

  // Like on the OTHER's post — additive, no ownership needed → allowed.
  await run({ url, readOnly: true, hunt: true, actTemplate: like.templateId, instance: keyFor(like, 'other-1') });
  assert.equal(server.counters().likeHits, 1, 'liking another user post is allowed (additive, never destroys their data)');

  // Create — a mutation, no existing target → allowed under hunt (the firewall window continues the POST).
  await run({ url, readOnly: true, hunt: true, actTemplate: post.templateId });
  assert.equal(server.counters().createHits, 1, 'create commits under hunt (the write window opened)');

  // Edit on OUR marked post → ownsTarget sees the marker → allowed.
  await run({ url, readOnly: true, hunt: true, actTemplate: edit.templateId, instance: keyFor(edit, 'self-1') });
  assert.equal(server.counters().editHits, 1, 'editing our own HUNT-marked post commits');
});

test('write-hunt (C): OFF by default — no --hunt refuses create + like, byte-identical read-only', async (t) => {
  const server = await start(0, { marker: MARKER });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const graphFile = boot(t);
  t.after(() => server.close());
  const graph = await baseline(url, graphFile);
  const like = tpl(graph, 'Like');
  const post = tpl(graph, 'Post');

  // WITHOUT hunt, a mutation-named control is refused (MUTATION_FLOOR) and no write reaches the server.
  await assert.rejects(
    run({ url, readOnly: true, actTemplate: post.templateId }),
    (err) => err?.envelope?.code === 'MUTATION_FLOOR',
    'create is refused read-only WITHOUT --hunt',
  );
  await assert.rejects(
    run({ url, readOnly: true, actTemplate: like.templateId, instance: keyFor(like, 'other-1') }),
    (err) => err?.envelope?.code === 'MUTATION_FLOOR',
    'like is refused read-only WITHOUT --hunt',
  );
  assert.equal(server.counters().createHits, 0, 'no create reached the server read-only');
  assert.equal(server.counters().likeHits, 0, 'no like reached the server read-only');
});

test('write-hunt (E): H1 — an ICON-only delete on others content is ABORTED by the firewall method-gate', async (t) => {
  const server = await start(0, { marker: MARKER });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const graphFile = boot(t);
  t.after(() => server.close());
  const graph = await baseline(url, graphFile);
  // The nameless (icon-only) delete button — no accessible name for requiresOwnership/isAccountDeletion to read.
  const icon = Object.values(graph.elements).find((n) => n.role === 'button' && (!n.name) && n.instances.length >= 2);
  assert.ok(icon, 'the icon-only (nameless) delete control is discovered');

  // On the OTHER user's post: the name classifiers can't gate a nameless control, but the firewall's
  // destructive method-gate aborts the DELETE because ownership was not proven (huntOwned=false via ownsTarget).
  const res = await run({ url, readOnly: true, hunt: true, actTemplate: icon.templateId, instance: keyFor(icon, 'other-1') });
  assert.ok(res.blocked && res.blocked.huntUnownedBlocked >= 1, 'the icon DELETE on another user post was ABORTED (destructive method + unowned)');
  assert.equal(server.counters().forbiddenHits, 0, 'the firewall aborted it BEFORE the server (no 403 needed) — the client protection held even without a name');
  assert.ok(!server.counters().deleteHits['other-1'] && server.posts().some((p) => p.id === 'other-1'), 'the other-owned post was never deleted via the icon path');

  // On OUR marked post: ownsTarget proves ownership via the DOM marker (works for a nameless control) → commits.
  await run({ url, readOnly: true, hunt: true, actTemplate: icon.templateId, instance: keyFor(icon, 'self-1') });
  assert.equal(server.counters().deleteHits['self-1'], 1, 'the icon delete on our own marked post commits (DOM ownership works for icon-only)');
});

test('write-hunt (F): AUTH stays refused in hunt — no self-logout mid-crawl', async (t) => {
  const server = await start(0, { marker: MARKER });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const graphFile = boot(t);
  t.after(() => server.close());
  const graph = await baseline(url, graphFile);
  const logout = tpl(graph, 'Logout');
  assert.ok(logout, 'the Logout control is discovered');
  await assert.rejects(
    run({ url, readOnly: true, hunt: true, actTemplate: logout.templateId, instance: logout.instances[0].instanceKey }),
    (err) => err?.envelope?.code === 'DANGER_FLOOR',
    'a Logout control stays refused even in hunt mode (would end the authed session)',
  );
  assert.equal(server.counters().loggedOut, 0, 'the session was never ended by the crawl');
});

test('write-hunt (D): the account rail — delete-account only if THIS run created it', async (t) => {
  const server = await start(0, { marker: MARKER });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const graphFile = boot(t);
  t.after(() => server.close());
  const graph = await baseline(url, graphFile);
  const acct = tpl(graph, 'Delete account');
  assert.ok(acct, 'the Delete account control is discovered');
  const key = acct.instances[0].instanceKey;

  // WITHOUT runCreatedAccount → refused (protect a persistent test account).
  await assert.rejects(
    run({ url, readOnly: true, hunt: true, actTemplate: acct.templateId, instance: key }),
    (err) => err?.envelope?.code === 'HUNT_ACCOUNT_PROTECTED',
    'deleting an account this run did not create must be refused',
  );
  assert.equal(server.counters().accountDeleted, 0, 'the account was NOT deleted without the run-created signal');

  // WITH runCreatedAccount (the operator confirms this run made the account) → allowed.
  await run({ url, readOnly: true, hunt: true, runCreatedAccount: true, actTemplate: acct.templateId, instance: key });
  assert.equal(server.counters().accountDeleted, 1, 'a run-created account CAN be deleted (the operator rule)');
});
