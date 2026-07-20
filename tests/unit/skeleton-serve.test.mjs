// The DOM-skeleton artifact's WRITE and SERVE halves: trace.writeSkeleton puts the JSON under the
// run's own skel/ dir and returns a relative ref (mirroring makeCapture's writeBody), and
// admin-server serves it through the SAME containment fence as shots/ — loopback Host, access
// token, resolved-path check.
//
// A skeleton carries the rendered text and layout of a possibly-logged-in app, so it is the same
// sensitivity class as a key-frame screenshot, and the fence around it is load-bearing rather than
// cosmetic. A route that accepts `..` is a security defect, hence the traversal half.
//
// Guards:
//   (A) writeSkeleton returns a `skel/<stem>.json` ref and the bytes land inside the run dir.
//   (B) The stem is SANITIZED, not trusted: a stem carrying path parts (`../../etc/passwd`) can
//       never write outside the run's own skel/ dir.
//   (C) writeSkeleton is BEST-EFFORT — a null skeleton (the module's degraded return, since it is
//       called from a catch block) writes nothing and returns null rather than throwing.
//   (D) GET /api/runs/:id/skel/<file> serves the JSON with the access token; the same request
//       WITHOUT the token is 403'd.
//   (E) TRAVERSAL: /api/runs/:id/skel/../../etc/passwd — raw and percent-encoded — never returns
//       200 and never returns file bytes; AND a symlink planted inside skel/ that resolves outside
//       the run dir is refused. The symlink is the case that actually exercises safeArtifact: the
//       two `..` spellings are already dead on arrival (URL normalization / the filename regex)
//       and would still be refused with the containment guard deleted, so on their own they would
//       have made this guard vacuous.
//   (F) captureSkeleton never throws on a non-page argument (the catch-block contract).
// FAIL-ON-REVERT:
//   (B) drop the `.replace(/[^A-Za-z0-9._-]/g, '_')` sanitizer in trace.writeSkeleton → the ref
//       escapes skel/ → "the sanitized stem stays inside skel/" goes red.
//   (D) delete the `seg[3] === 'skel'` branch in admin-server → the skeleton 404s → "the skeleton
//       is served" goes red.
//   (E) swap safeArtifact for a raw path.join in the skel branch → the planted symlink resolves
//       outside the run dir and is served 200 with foreign bytes → "the resolved-path containment
//       guard is load-bearing" goes red. (Verified: the `..` spellings alone do NOT go red under
//       this revert — which is why the symlink case is here.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openRun, writeSkeleton, runDir } from '../../lib/debug/trace.mjs';
import { startAdmin } from '../../lib/debug/admin-server.mjs';
import { captureSkeleton } from '../../lib/graph/dom-skeleton.mjs';

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const SKELETON = {
  v: 1, w: 1440, h: 900, truncated: 12,
  nodes: [
    { d: 1, tag: 'body', x: 0, y: 0, w: 1440, h: 900, vis: 1 },
    { d: 3, tag: 'button', id: 'save', role: 'button', name: 'Save', x: 10, y: 20, w: 80, h: 32, vis: 1 },
  ],
};

test('the DOM skeleton is written into the run dir and served behind the artifact fence', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-skel-'));
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = stateDir;

  const runId = 'r-20260720000000-bbbb';
  openRun({ runId, target: 'http://example.test/' });

  // ---- (A) the writer returns a relative ref and the bytes land in skel/ -------------------
  const ref = writeSkeleton(runId, 'a0007-t42-fail', SKELETON);
  assert.equal(ref, 'skel/a0007-t42-fail.json', 'writeSkeleton returns a skel/-relative ref');
  const onDisk = path.join(runDir(runId), ref);
  assert.ok(fs.existsSync(onDisk), 'the skeleton bytes landed in the run dir');
  assert.deepEqual(JSON.parse(fs.readFileSync(onDisk, 'utf8')), SKELETON, 'the artifact round-trips');

  // ---- (B) the stem is sanitized, not trusted ---------------------------------------------
  // Two shapes, because they fail differently without the sanitizer. `../../etc/passwd` escapes to
  // a directory that does not exist (the write errors out), while `../shots/pwned` escapes into an
  // EXISTING sibling dir of the same run — that one SUCCEEDS unsanitized, which is the shape that
  // actually corrupts the trail, so it is the one asserted on disk.
  const skelRoot = path.resolve(runDir(runId), 'skel');
  for (const stem of ['../../etc/passwd', '../shots/pwned', 'a/b/c']) {
    const out = writeSkeleton(runId, stem, SKELETON);
    assert.ok(typeof out === 'string' && out.startsWith('skel/'),
      `a hostile stem must still produce a skel/-relative ref, got ${JSON.stringify(out)} for ${stem}`);
    assert.ok(!out.includes('..'), `no traversal survives the stem sanitizer (stem ${stem} -> ${out})`);
    assert.ok(path.resolve(runDir(runId), out).startsWith(skelRoot + path.sep),
      `the resolved write path stays inside the run's own skel/ dir (stem ${stem} -> ${out})`);
  }
  // ...and nothing was created outside skel/ as a side effect.
  assert.ok(!fs.existsSync(path.join(runDir(runId), 'shots', 'pwned.json')),
    'a ../shots/ stem never writes into a sibling artifact dir');

  // ---- (C) best-effort: a null skeleton (the degraded catch-path return) writes nothing ----
  assert.equal(writeSkeleton(runId, 'nothing', null), null, 'a null skeleton writes nothing and returns null');
  assert.ok(!fs.existsSync(path.join(runDir(runId), 'skel', 'nothing.json')), 'no empty artifact is created');

  const TOK = 'testtoken00000000';
  const { server, port } = await startAdmin({ port: 0, token: TOK });
  const q = (p) => p + (p.includes('?') ? '&' : '?') + 't=' + TOK;
  t.after(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });

  // ---- (D) the route serves it, and the token gate still applies ---------------------------
  const served = await get(port, q(`/api/runs/${runId}/skel/a0007-t42-fail.json`));
  assert.equal(served.status, 200, 'the skeleton is served');
  assert.match(served.headers['content-type'], /application\/json/, 'served as JSON');
  assert.deepEqual(JSON.parse(served.body), SKELETON, 'the served bytes are the skeleton');
  assert.equal(served.headers['access-control-allow-origin'], undefined, 'no CORS header on a skeleton');

  const noTok = await get(port, `/api/runs/${runId}/skel/a0007-t42-fail.json`);
  assert.equal(noTok.status, 403, 'the access token gates the skeleton route too');

  const foreign = await get(port, q(`/api/runs/${runId}/skel/a0007-t42-fail.json`), { Host: 'evil.example.com' });
  assert.equal(foreign.status, 403, 'a foreign Host cannot read a skeleton');

  // ---- (E) traversal is never served -------------------------------------------------------
  // Three spellings of `..`, and they are refused at three DIFFERENT layers. Recording which is
  // which matters, because two of them never reach safeArtifact at all and would keep passing if
  // the containment guard were deleted — only the symlink case below actually exercises it.
  //   raw `..`        — WHATWG URL normalization collapses it in the pathname before routing, so
  //                     the request lands on an unknown route.
  //   percent-encoded — stays literal in the pathname (nothing here ever decodes a segment), so
  //                     it fails the SKEL filename regex.
  const rawTrav = await get(port, q(`/api/runs/${runId}/skel/../../etc/passwd`));
  assert.notEqual(rawTrav.status, 200, 'traversal is never served (raw ..)');
  const encTrav = await get(port, q(`/api/runs/${runId}/skel/..%2f..%2fetc%2fpasswd`));
  assert.notEqual(encTrav.status, 200, 'traversal is never served (percent-encoded ..)');
  const upTrav = await get(port, q(`/api/runs/${runId}/skel/..%2frun.json`));
  assert.notEqual(upTrav.status, 200, 'traversal cannot reach a sibling artifact in the run dir');

  // THE VECTOR THAT ACTUALLY TESTS THE GUARD. A symlink planted inside skel/ has a perfectly
  // well-formed name — it passes the regex and lexical containment — and resolves OUTSIDE the run
  // dir. This is precisely what safeArtifact's realpath half exists for, and a raw path.join would
  // serve it. Without it, guard (E) would be vacuous: swapping safeArtifact for path.join leaves
  // the three `..` spellings above still refused, so they prove routing, not containment.
  const secret = path.join(stateDir, 'outside-the-run.json');
  fs.writeFileSync(secret, JSON.stringify({ secret: 'NOT-FOR-SERVING' }));
  fs.symlinkSync(secret, path.join(runDir(runId), 'skel', 'escape.json'));
  const symTrav = await get(port, q(`/api/runs/${runId}/skel/escape.json`));
  assert.notEqual(symTrav.status, 200,
    'a symlink out of skel/ is never served — the resolved-path containment guard is load-bearing');
  assert.ok(!symTrav.body.toString().includes('NOT-FOR-SERVING'),
    'a symlinked artifact never leaks bytes from outside the run dir');

  for (const r of [rawTrav, encTrav, upTrav, symTrav]) {
    assert.ok(!r.body.toString().includes('"startedAt"') && !r.body.toString().includes('root:'),
      'a traversal response never carries file bytes');
  }

  // A well-formed name that simply does not exist is a plain 404, not a 200 or a crash.
  const missing = await get(port, q(`/api/runs/${runId}/skel/nope.json`));
  assert.equal(missing.status, 404, 'a missing skeleton is a 404');
});

// ---- (F) the catch-block contract, without a browser -------------------------------------
test('captureSkeleton returns null instead of throwing when there is no usable page', async () => {
  assert.equal(await captureSkeleton(null), null, 'null page → null');
  assert.equal(await captureSkeleton(undefined), null, 'undefined page → null');
  assert.equal(await captureSkeleton({}), null, 'a non-page object → null');
  // A page-shaped object whose evaluate REJECTS (navigation mid-capture, execution context
  // destroyed) is the realistic failure — it must degrade, not propagate.
  const rejecting = { isClosed: () => false, evaluate: async () => { throw new Error('Execution context was destroyed'); } };
  assert.equal(await captureSkeleton(rejecting), null, 'a rejecting evaluate → null, never a throw');
  // A page that reports itself closed is short-circuited before evaluate is even attempted.
  let called = false;
  const closed = { isClosed: () => true, evaluate: async () => { called = true; return {}; } };
  assert.equal(await captureSkeleton(closed), null, 'a closed page → null');
  assert.equal(called, false, 'a closed page is never evaluated');
});
