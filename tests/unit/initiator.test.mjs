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
import { classifyInitiator } from '../../lib/browser/initiator.mjs';

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
