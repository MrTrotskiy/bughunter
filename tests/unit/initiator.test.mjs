// Unit test for the anti-vacuous mechanism itself: classifyInitiator over
// SYNTHETIC CDP initiator objects (no browser). The live test proves the
// classifier works against a real chromium; this pins its exact verdict on each
// hand-built initiator shape so a regression in the timer/parser walk is caught
// without paying for a page. Shapes mirror CDP Runtime.StackTrace: an initiator
// carries { type, stack }, and stack is a chain of frames linked by `.parent`,
// each async boundary tagged with a `.description` (e.g. "setInterval").
//
// Guards: classifyInitiator's background verdict — timer/parser-rooted fires are
//   flagged background:true (dropped from causal attribution), while real
//   script/click stacks and null/empty initiators stay background:false so a
//   genuine control->request edge is never dropped.
// FAIL-ON-REVERT: neuter classifyInitiator (first line `return {background:false}`)
//   -> timer/parser cases go red: "Expected values to be strictly equal: false !== true".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInitiator, bodyCaptureEnabled } from '../../lib/browser/initiator.mjs';

// A CDP async-parent frame carrying a description (the timer boundary tag).
const asyncFrame = (description, parent = null) => ({ description, callFrames: [], parent });

test('setInterval-rooted async parent chain -> background:true', () => {
  const initiator = {
    type: 'script',
    stack: { callFrames: [{ functionName: 'poll' }], parent: asyncFrame('setInterval') },
  };
  assert.equal(classifyInitiator(initiator).background, true);
});

test('setTimeout-rooted async parent chain -> background:true', () => {
  const initiator = {
    type: 'script',
    // timer boundary sits two hops up the async chain — the walk is unbounded-ish.
    stack: { callFrames: [], parent: asyncFrame('Promise.then', asyncFrame('setTimeout')) },
  };
  assert.equal(classifyInitiator(initiator).background, true);
});

test('parser initiator with no stack -> background:true (page-load markup)', () => {
  assert.equal(classifyInitiator({ type: 'parser' }).background, true);
});

test('plain script/click stack with no timer -> background:false (keep the edge)', () => {
  const initiator = {
    type: 'script',
    stack: { callFrames: [{ functionName: 'onClick' }], parent: asyncFrame('') },
  };
  assert.equal(classifyInitiator(initiator).background, false);
});

test('null and empty initiators -> background:false (never drop a real edge)', () => {
  // A missing or shapeless initiator must NOT be classified background: dropping
  // it would silently discard a real causal edge the CDP simply did not annotate.
  assert.equal(classifyInitiator(null).background, false);
  assert.equal(classifyInitiator(undefined).background, false);
  assert.equal(classifyInitiator({}).background, false);
});

// The body-capture DOUBLE GATE, as a pure predicate over env. HALF-OPEN (flag set, no run) must
// be false — that is the login pre-step's state (it clears both before wiring) and the guarantee
// that no body is captured without a trail to hold it.
// Guards: bodyCaptureEnabled requires BOTH BUGHUNTER_CAPTURE_BODIES=1 AND BUGHUNTER_RUN_ID.
// FAIL-ON-REVERT: make it `env.BUGHUNTER_CAPTURE_BODIES === '1'` (drop the run clause) → the
//   half-open case flips to true → "flag set but no run → false" fails.
test('bodyCaptureEnabled: ON only with BOTH flag and run; half-open is false', () => {
  assert.equal(bodyCaptureEnabled({ BUGHUNTER_CAPTURE_BODIES: '1', BUGHUNTER_RUN_ID: 'r1' }), true, 'both set → on');
  assert.equal(bodyCaptureEnabled({ BUGHUNTER_CAPTURE_BODIES: '1' }), false, 'flag set but NO run → false (half-open / login)');
  assert.equal(bodyCaptureEnabled({ BUGHUNTER_RUN_ID: 'r1' }), false, 'run but no flag → false (default off)');
  assert.equal(bodyCaptureEnabled({ BUGHUNTER_CAPTURE_BODIES: 'true', BUGHUNTER_RUN_ID: 'r1' }), false, 'flag must be exactly "1"');
  assert.equal(bodyCaptureEnabled({}), false, 'neither → false');
});
