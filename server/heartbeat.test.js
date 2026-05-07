'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeVerdict, parseReviewCycles, computeLabelDiff, nextBackoff } = require('./heartbeat');
const { prSignature } = require('./monitor');

test('normalizeVerdict: GitHub reviewDecision → canonical enum', () => {
  assert.equal(normalizeVerdict('APPROVED'), 'APPROVE');
  assert.equal(normalizeVerdict('approved'), 'APPROVE');
  assert.equal(normalizeVerdict('CHANGES_REQUESTED'), 'REQUEST_CHANGES');
  assert.equal(normalizeVerdict('REVIEW_REQUIRED'), 'COMMENT');
  assert.equal(normalizeVerdict(null), null);
  assert.equal(normalizeVerdict('weird-value'), null);
});

test('parseReviewCycles: counts comments containing "Review verdict"', () => {
  assert.equal(parseReviewCycles([]), 0);
  assert.equal(parseReviewCycles(null), 0);
  assert.equal(parseReviewCycles([
    { body: 'Review verdict: APPROVE\n' },
    { body: 'unrelated comment' },
    { body: 'Review verdict: REQUEST_CHANGES\nlots more' },
  ]), 2);
  assert.equal(parseReviewCycles([
    { text: 'Review verdict: nope but using `text` field' },
  ]), 1);
});

test('computeLabelDiff: added vs removed', () => {
  assert.deepEqual(computeLabelDiff([], []), { added: [], removed: [] });
  assert.deepEqual(
    computeLabelDiff(['a', 'b'], ['b', 'c']),
    { added: ['c'], removed: ['a'] },
  );
  assert.deepEqual(
    computeLabelDiff([], ['needs:human']),
    { added: ['needs:human'], removed: [] },
  );
  assert.deepEqual(
    computeLabelDiff(['needs:human'], []),
    { added: [], removed: ['needs:human'] },
  );
});

test('nextBackoff: success resets; rate_limit doubles to cap; error grows 1.5×', () => {
  const start = { baseInterval: 120, currentInterval: 120, consecutiveFails: 0 };
  // success on a clean state stays at base
  assert.deepEqual(nextBackoff(start, 'success'), { baseInterval: 120, currentInterval: 120, consecutiveFails: 0 });

  // rate_limit doubles
  const r1 = nextBackoff(start, 'rate_limit');
  assert.equal(r1.currentInterval, 240);
  assert.equal(r1.consecutiveFails, 1);

  // rate_limit doubles again, capped at 600
  let s = start;
  for (let i = 0; i < 10; i++) s = nextBackoff(s, 'rate_limit');
  assert.equal(s.currentInterval, 600);

  // error: ×1.5 (180), then again 270, capped at 600
  let e = nextBackoff(start, 'error');
  assert.equal(e.currentInterval, 180);
  e = nextBackoff(e, 'error');
  assert.equal(e.currentInterval, 270);
  // success after errors resets
  e = nextBackoff(e, 'success');
  assert.equal(e.currentInterval, 120);
  assert.equal(e.consecutiveFails, 0);
});

test('prSignature: changes when any tracked field changes', () => {
  const a = { state: 'OPEN', mergeable: true, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' };
  const b = { state: 'OPEN', mergeable: true, mergeStateStatus: 'CLEAN', reviewDecision: 'CHANGES_REQUESTED' };
  const c = { state: 'CLOSED', mergeable: false, mergeStateStatus: 'BLOCKED', reviewDecision: null };
  assert.equal(prSignature(a), prSignature({ ...a }));
  assert.notEqual(prSignature(a), prSignature(b));
  assert.notEqual(prSignature(a), prSignature(c));
  assert.equal(prSignature(null), null);
});
