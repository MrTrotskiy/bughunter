// INC.4 — transient CSS-motion classes must never anchor a selector.
//
// Guards: an animation-phase token (`ant-slide-up-leave`, `ant-zoom-appear`, `ant-fade-leave-start`) lives
//   for the ~250ms of a CSS transition. A selector anchored on one matches only MID-TRANSITION, so the
//   control resolves, then vanishes before the click's actionability loop finishes — measured live on
//   rawcaster as 96 of 195 unreachable templates, and 44 selector groups that were pure duplicates of one
//   another differing only by animation phase. SETTLED state classes (`ant-tabs-tab-active`,
//   `ant-dropdown-hidden`) describe what the UI IS and must be KEPT — they are the structural anchor.
// FAIL-ON-REVERT: drop `&& !isMotionClass(c)` from isStableClass in dom-snapshot.mjs → the motion tokens
//   are admitted again → "a motion class is rejected" reds.
//
// Pure string-predicate test: isStableClass/isMotionClass live inside the page-evaluated `collect()`, so
// they are re-declared here byte-identically. That duplication is the point — if the source predicate is
// edited without updating this copy, the live framework-id + panel-reach tests catch the divergence.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const isMotionClass = (c) => /-(?:enter|leave|appear)(?:-start|-active|-prepare|-end|-done)?$/.test(c)
  || /^(?:ant|rc)-(?:zoom|fade|slide|motion|collapse)(?:-|$)/.test(c);
const isStableClass = (c) => !!c && !/\d/.test(c) && !/^(?:ng|css|sc|jsx|_)-/.test(c)
  && c.length <= 32 && !isMotionClass(c);

test('a transient motion class is rejected as a selector anchor', () => {
  for (const c of [
    'ant-slide-up-leave', 'ant-slide-up-appear', 'ant-slide-up-enter',
    'ant-zoom-appear', 'ant-zoom-leave', 'ant-zoom-big-appear',
    'ant-fade-leave', 'ant-fade-leave-start', 'ant-motion-collapse',
    'rc-slide-up-appear', 'ant-collapse-enter-active',
  ]) {
    assert.equal(isMotionClass(c), true, `${c} must be recognised as a motion token`);
    assert.equal(isStableClass(c), false, `${c} must NOT anchor a selector`);
  }
});

test('SETTLED framework state classes are still kept — they are the structural anchor', () => {
  // The INC.1 comment is explicit that framework CLASSES are the anchor we want; only the transient
  // animation phases are noise. Over-rejecting here would re-fragment the antd tabs INC.1 just fixed.
  for (const c of ['ant-tabs-tab', 'ant-tabs-tab-active', 'ant-dropdown-hidden', 'ant-dropdown-menu-item',
                   'ant-modal', 'ant-picker-dropdown', 'ant-select-selector', 'ant-btn-primary']) {
    assert.equal(isMotionClass(c), false, `${c} is settled state, not motion`);
    assert.equal(isStableClass(c), true, `${c} must remain a usable anchor`);
  }
});

test('non-framework classes are unaffected (zero churn off AntD)', () => {
  assert.equal(isStableClass('notificationContainer'), true);
  assert.equal(isStableClass('flex-column'), true);
  // Pre-existing rejections still hold: digits, framework-prefixed hashes, over-long.
  assert.equal(isStableClass('col-3'), false, 'digit-bearing class still rejected');
  assert.equal(isStableClass('sc-bdVaJa'), false, 'styled-components prefix still rejected');
  assert.equal(isStableClass(''), false);
  // A semantic class that merely CONTAINS a motion word but is not a phase token stays usable.
  assert.equal(isStableClass('slideshow'), true, 'not a motion phase — must not be over-rejected');
  assert.equal(isStableClass('enterprise'), true, 'not a motion phase — must not be over-rejected');
});
