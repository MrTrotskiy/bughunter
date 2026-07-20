// REQUIRED MUST REACH fieldFacts — the AntD wrapper case that read 0/70 on the live target.
//
// docs/GOAL.md's form ladder ("submit empty → one required field → two → invalid values") cannot start if
// no field is known to be required: knowledge.batteryFor owes no `fill-empty` probe, so form study collapses
// to a single click ("one touch is not a study"). Measured on run hunt4: 70 fields carried fieldFacts and
// `required` was true on ZERO of them, because the live app is Ant Design and AntD does NOT set `required`
// on the <input> — it renders requiredness as a CLASS on the field's <label> (`.ant-form-item-required`,
// inside `.ant-form-item-label`), with no native attribute at all. `fieldFactsOf` read that class on the
// `.ant-form-item` CONTAINER (`item.classList.contains(...)`), which never carries it, so every
// wrapper-required field read false. Reading `el.required` alone (the native path) works and is NOT the
// bug — the live target simply has no native required attributes.
//
// Drives the REAL path (snapshotDom → mergeSnapshot via snapshotStep), reading fieldFacts back out of the
// graph, so a green projection that still lands 0 required in the graph cannot pass this.
//
// Guards:
//   - a field required VIA THE ANTD WRAPPER (label.ant-form-item-required, no native attribute) lands
//     fieldFacts.required === true — the live-target case and the whole point;
//   - a field with a NATIVE `required` attribute ALSO lands required === true (the native path is intact);
//   - a NON-required field does NOT read required true (no false positive);
//   - maxLength / disabled / label carry through the SAME projection alongside the wrapper-required read.
//
// FAIL-ON-REVERT: restore `item.classList.contains('ant-form-item-required')` (reading the CONTAINER) in
//   lib/graph/dom-snapshot.mjs fieldFactsOf → the wrapper-required Full Name field reads null → the merge
//   skips it → "the ANTD WRAPPER-required field must land required:true" reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/antd-form-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep } from '../../lib/recon/step.mjs';
import { makeGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';

// The field template whose fieldFacts carry `label` (a plain-input field) or `placeholder` (the textarea,
// whose innerText label is read off its own <label>). Match on the label text the projection recorded.
const byLabel = (graph, label) => {
  const node = Object.values(graph.elements).find((n) => n.fieldFacts && n.fieldFacts.label === label);
  assert.ok(node, `the "${label}" field must be discovered by the snapshot`);
  return node;
};

test('required reaches fieldFacts for BOTH the AntD wrapper and the native attribute', async (t) => {
  const server = await start(0);
  const port = server.address().port;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-required-'));
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;

  const cold = await launch();
  t.after(async () => {
    await close(cold.browser);
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });

  const page = cold.page;
  const graph = makeGraph();
  const ledger = makeLedger();
  await gotoGated(page, `http://127.0.0.1:${port}/`);
  await waitSettled(page);

  // The REAL path: snapshotDom → mergeSnapshot, fieldFacts written onto the graph node.
  await snapshotStep(page, graph, ledger, '/');

  // THE CASE THAT MATTERS: required marked ONLY by the AntD wrapper class on the <label>, no native
  // attribute anywhere. Under the container-class read this landed null — the 0/70 defect.
  const name = byLabel(graph, 'Full Name');
  assert.equal(name.fieldFacts.required, true, 'the ANTD WRAPPER-required field must land required:true');
  assert.equal(name.fieldFacts.maxLength, 50, 'its declared limit carries through the same projection');
  assert.equal(name.fieldFacts.label, 'Full Name', 'its authored label carries through');
  assert.equal(name.fieldFacts.disabled, false, 'its live state carries through');

  // The native path is intact — a field with a real `required` attribute still reads true.
  const mail = byLabel(graph, 'Email');
  assert.equal(mail.fieldFacts.required, true, 'the NATIVE required attribute still lands required:true');
  assert.equal(mail.fieldFacts.maxLength, 120, 'the native field carries its declared limit too');

  // No false positive: a field with no required marker (native or wrapper) is not reported required.
  const nick = byLabel(graph, 'Nickname');
  assert.notEqual(nick.fieldFacts.required, true, 'a NON-required field must NOT read required:true');

  // The wrapper-required read composes with a carried-through DISABLED state and a textarea maxLength.
  const bio = byLabel(graph, 'Bio');
  assert.equal(bio.fieldFacts.required, true, 'a wrapper-required TEXTAREA also lands required:true');
  assert.equal(bio.fieldFacts.maxLength, 200, 'the textarea maxLength carries through');
  assert.equal(bio.fieldFacts.disabled, true, 'the textarea disabled state carries through alongside required');

  // The headline: required is non-zero on real AntD fields — the acceptance bar (0 → non-zero).
  const requiredCount = Object.values(graph.elements)
    .filter((n) => n.fieldFacts && n.fieldFacts.required === true).length;
  assert.equal(requiredCount, 3, 'three of four fields are required (two via wrapper, one native) — not 0/70');
});
