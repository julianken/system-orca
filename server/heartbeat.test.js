'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeVerdict, parseReviewCycles, computeLabelDiff, nextBackoff,
        compute_critical_path, criticalPathEqual } = require('./heartbeat');
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

// ---- compute_critical_path (Phase 5) ----

const STEP_KEYS = ['0_claim','1_reconcile','2_worktree','3_implement','4_gate',
  '5_bot_review','6_verdict','7_mergify','8_verify_merge','9_cleanup'];

function makeIssue(opts) {
  const fillValue = opts.allDone ? 'done' : opts.tracker ? 'n/a' : 'pending';
  const steps = {};
  for (const k of STEP_KEYS) steps[k] = fillValue;
  if (opts.stepOverrides) Object.assign(steps, opts.stepOverrides);
  return {
    issue_id: opts.id,
    wave_id: opts.wave_id || 'W1',
    band_id: opts.band_id || 'W1.A',
    title: opts.title || opts.id,
    github: opts.github || { repo: 'x/y', issue_num: 0 },
    steps,
  };
}

test('compute_critical_path: all-pending → first issue blocking, step 0_claim', () => {
  const cp = compute_critical_path([
    makeIssue({ id: 'W1.A.1' }),
    makeIssue({ id: 'W1.A.2' }),
  ]);
  assert.equal(cp.blocking_issue, 'W1.A.1');
  assert.match(cp.next_dispatch, /0_claim on W1\.A\.1/);
});

test('compute_critical_path: one issue mid-pipeline → that issue + correct step', () => {
  const cp = compute_critical_path([
    makeIssue({ id: 'W1.A.1', stepOverrides: { '0_claim': 'done', '1_reconcile': 'done', '2_worktree': 'done', '3_implement': 'running' } }),
    makeIssue({ id: 'W1.A.2' }),
  ]);
  assert.equal(cp.blocking_issue, 'W1.A.1');
  assert.match(cp.next_dispatch, /3_implement on W1\.A\.1/);
});

test('compute_critical_path: all done → "all issues done"', () => {
  const cp = compute_critical_path([
    makeIssue({ id: 'W1.A.1', allDone: true }),
    makeIssue({ id: 'W1.A.2', allDone: true }),
  ]);
  assert.equal(cp.next_dispatch, 'all issues done');
  assert.equal(cp.blocking_issue, null);
});

test('compute_critical_path: tracker issue skipped (all n/a)', () => {
  const cp = compute_critical_path([
    makeIssue({ id: 'W1.T.x', tracker: true }),
    makeIssue({ id: 'W1.A.1' }),
  ]);
  assert.equal(cp.blocking_issue, 'W1.A.1');
});

test('compute_critical_path: failed step still surfaces as blocker', () => {
  const cp = compute_critical_path([
    makeIssue({ id: 'W1.A.1', stepOverrides: { '0_claim': 'done', '1_reconcile': 'done', '2_worktree': 'done', '3_implement': 'failed' } }),
  ]);
  assert.equal(cp.blocking_issue, 'W1.A.1');
  assert.match(cp.next_dispatch, /failed 3_implement/);
});

test('criticalPathEqual: structural equality suppresses re-emission', () => {
  const a = { next_dispatch: 'X', blocking_issue: 'i1', blocking_pr: 1, eta: null };
  const b = { next_dispatch: 'X', blocking_issue: 'i1', blocking_pr: 1, eta: null };
  const c = { next_dispatch: 'Y', blocking_issue: 'i1', blocking_pr: 1, eta: null };
  assert.equal(criticalPathEqual(a, b), true);
  assert.equal(criticalPathEqual(a, c), false);
  assert.equal(criticalPathEqual(null, null), true);
  assert.equal(criticalPathEqual(a, null), false);
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
