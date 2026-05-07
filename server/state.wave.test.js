'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { project, project_base, project_wave, STEP_KEYS } = require('./state');

const TS = (n) => `2026-05-07T00:00:0${n}.000Z`;
const ev = (type, opts = {}) => ({
  ts: opts.ts || TS(0),
  workflow_id: opts.workflow_id || 'wf_w',
  agent: opts.agent || 'orchestrator',
  type,
  stage_id: opts.stage_id == null ? null : opts.stage_id,
  data: opts.data || {},
});

const init = (mode) => ev('workflow_init', { ts: TS(0), data: { title: 'T', goal: 'G', ...(mode ? { mode } : {}) } });

test('2.1 — wave/band/issue happy path: registers populate state, issue synthesises a stage', () => {
  const s = project([
    init('wave'),
    ev('wave_register',  { ts: TS(1), data: { wave_id: 'W1', name: 'Setup', layout: 'horizontal' } }),
    ev('band_register',  { ts: TS(2), data: { wave_id: 'W1', band_id: 'W1.A', concurrency: 2 } }),
    ev('issue_register', { ts: TS(3), data: { issue_id: 'W1.A.1', wave_id: 'W1', band_id: 'W1.A', title: 'First',
                                                github: { repo: 'x/y', issue_num: 42 } } }),
  ]);
  assert.equal(s.waves.length, 1);
  assert.equal(s.waves[0].wave_id, 'W1');
  assert.deepEqual(s.waves[0].bands, ['W1.A']);
  assert.equal(s.bands.length, 1);
  assert.equal(s.bands[0].band_id, 'W1.A');
  assert.equal(s.bands[0].concurrency, 2);
  assert.equal(s.issues.length, 1);
  assert.equal(s.issues[0].issue_id, 'W1.A.1');
  assert.equal(s.issues[0].title, 'First');
  // Step grid seeded to pending (not a tracker).
  for (const k of STEP_KEYS) assert.equal(s.issues[0].steps[k], 'pending');
  // Synthetic base stage exists.
  const synth = s.stages.find((x) => x.id === 'W1.A.1');
  assert.ok(synth, 'synthetic stage missing');
  assert.equal(synth.parent_id, 'W1.A');
  assert.equal(synth.label, 'First');
});

test('2.2 — issue_register before band_register: deferred grid seed; band arrival sweeps', () => {
  const s = project([
    init('wave'),
    ev('issue_register', { ts: TS(1), data: { issue_id: 'W1.A.1', wave_id: 'W1', band_id: 'W1.A',
                                                title: 'orphan', github: { repo: 'x/y', issue_num: 1 } } }),
    ev('band_register',  { ts: TS(2), data: { wave_id: 'W1', band_id: 'W1.A', concurrency: 1 } }),
  ]);
  const issue = s.issues.find((x) => x.issue_id === 'W1.A.1');
  // After deferral + sweep, grid is seeded and the deferred flag is gone.
  assert.ok(issue.steps, 'steps map missing after sweep');
  for (const k of STEP_KEYS) assert.equal(issue.steps[k], 'pending');
  assert.equal(issue._steps_pending_seed, undefined);
  // A warning note recorded the deferral.
  const warn = s.feed.find((f) => f.type === 'note' && /arrived before band_register/.test(f.text || ''));
  assert.ok(warn, 'expected deferral warning in feed');
});

test('2.3 — tracker bands seed all 10 cells to "n/a"', () => {
  const sZeroConcurrency = project([
    init('wave'),
    ev('wave_register',  { data: { wave_id: 'W1', name: 'Track', layout: 'horizontal' } }),
    ev('band_register',  { data: { wave_id: 'W1', band_id: 'W1.T', concurrency: 0 } }),
    ev('issue_register', { data: { issue_id: 'W1.T.x', wave_id: 'W1', band_id: 'W1.T', title: 'tracker', github: { repo: 'x/y', issue_num: 9 } } }),
  ]);
  const issueZ = sZeroConcurrency.issues[0];
  for (const k of STEP_KEYS) assert.equal(issueZ.steps[k], 'n/a');

  const sIsTracker = project([
    init('wave'),
    ev('wave_register',  { data: { wave_id: 'W2', name: 'Mix', layout: 'horizontal' } }),
    ev('band_register',  { data: { wave_id: 'W2', band_id: 'W2.A', concurrency: 1 } }),
    ev('issue_register', { data: { issue_id: 'W2.A.t', wave_id: 'W2', band_id: 'W2.A', title: 't',
                                    github: { repo: 'x/y', issue_num: 7 }, is_tracker: true } }),
  ]);
  const issueT = sIsTracker.issues[0];
  for (const k of STEP_KEYS) assert.equal(issueT.steps[k], 'n/a');
});

test('2.4 — duplicate issue_register overwrites static fields, preserves dynamic', () => {
  const s = project([
    init('wave'),
    ev('wave_register',  { data: { wave_id: 'W1', name: 'X', layout: 'horizontal' } }),
    ev('band_register',  { data: { wave_id: 'W1', band_id: 'W1.A', concurrency: 2 } }),
    ev('issue_register', { ts: TS(2), data: { issue_id: 'W1.A.1', wave_id: 'W1', band_id: 'W1.A',
                                                title: 'first title', github: { repo: 'x/y', issue_num: 1 } } }),
    ev('issue_register', { ts: TS(3), data: { issue_id: 'W1.A.1', wave_id: 'W1', band_id: 'W1.A',
                                                title: 'second title', github: { repo: 'x/y', issue_num: 1 } } }),
  ]);
  assert.equal(s.issues.length, 1);
  assert.equal(s.issues[0].title, 'second title');
  // Step grid not reseeded — value still pending (not undefined / not double-seeded).
  for (const k of STEP_KEYS) assert.equal(s.issues[0].steps[k], 'pending');
});

// ---- Phase 5 ----

const setupOneIssueP5 = (extra = []) => [
  init('wave'),
  ev('wave_register',  { ts: TS(1), data: { wave_id: 'W1', name: 'S', layout: 'horizontal' } }),
  ev('band_register',  { ts: TS(2), data: { wave_id: 'W1', band_id: 'W1.A', concurrency: 1 } }),
  ev('issue_register', { ts: TS(3), data: { issue_id: 'W1.A.1', wave_id: 'W1', band_id: 'W1.A',
                                              title: 'T', github: { repo: 'x/y', issue_num: 1 } } }),
  ...extra,
];

test('5.1 — critical_path_update single-slot, last-write-wins; all-null clears', () => {
  const s1 = project(setupOneIssueP5([
    ev('critical_path_update', { ts: TS(4), data: { next_dispatch: 'A', blocking_issue: 'W1.A.1', blocking_pr: 1, eta: '5m' } }),
  ]));
  assert.equal(s1.critical_path.next_dispatch, 'A');
  assert.equal(s1.critical_path.blocking_pr, 1);

  const s2 = project(setupOneIssueP5([
    ev('critical_path_update', { ts: TS(4), data: { next_dispatch: 'A', blocking_issue: 'W1.A.1', blocking_pr: 1 } }),
    ev('critical_path_update', { ts: TS(5), data: { next_dispatch: 'B', blocking_issue: 'W1.A.1', blocking_pr: 2 } }),
  ]));
  assert.equal(s2.critical_path.next_dispatch, 'B');
  assert.equal(s2.critical_path.blocking_pr, 2);

  const s3 = project(setupOneIssueP5([
    ev('critical_path_update', { ts: TS(4), data: { next_dispatch: 'A', blocking_issue: 'W1.A.1' } }),
    ev('critical_path_update', { ts: TS(5), data: { next_dispatch: null, blocking_issue: null, blocking_pr: null, eta: null } }),
  ]));
  assert.equal(s3.critical_path, null);
});

test('5.2 — escalation_add upsert, escalation_clear no-op when absent', () => {
  const s1 = project(setupOneIssueP5([
    ev('escalation_add', { ts: TS(4), data: { issue_id: 'W1.A.1', reason: 'first', source: 'orchestrator' } }),
    ev('escalation_add', { ts: TS(5), data: { issue_id: 'W1.A.1', reason: 'second', source: 'label' } }),
  ]));
  assert.equal(s1.escalations.length, 1);
  assert.equal(s1.escalations[0].reason, 'second');
  assert.equal(s1.escalations[0].source, 'label');

  const s2 = project(setupOneIssueP5([
    ev('escalation_clear', { ts: TS(4), data: { issue_id: 'never-existed' } }),
  ]));
  assert.equal(s2.escalations.length, 0);
});

test('5.3 — needs_human derived from escalations on each issue', () => {
  const s = project(setupOneIssueP5([
    ev('escalation_add', { ts: TS(4), data: { issue_id: 'W1.A.1', reason: 'r', source: 'label' } }),
  ]));
  const issue = s.issues.find((i) => i.issue_id === 'W1.A.1');
  assert.equal(issue.needs_human, true);

  const sCleared = project(setupOneIssueP5([
    ev('escalation_add',   { ts: TS(4), data: { issue_id: 'W1.A.1', reason: 'r', source: 'label' } }),
    ev('escalation_clear', { ts: TS(5), data: { issue_id: 'W1.A.1' } }),
  ]));
  assert.equal(sCleared.issues.find((i) => i.issue_id === 'W1.A.1').needs_human, false);
});

test('5.4 — escalation source preserved across all 3 source values', () => {
  for (const source of ['label', 'orchestrator', 'heartbeat-cycles']) {
    const s = project(setupOneIssueP5([
      ev('escalation_add', { ts: TS(4), data: { issue_id: 'W1.A.1', reason: source, source } }),
    ]));
    assert.equal(s.escalations[0].source, source);
  }
});

// ---- Phase 3 ----

const setupOneIssue = (extra = []) => [
  init('wave'),
  ev('wave_register',  { ts: TS(1), data: { wave_id: 'W1', name: 'S', layout: 'horizontal' } }),
  ev('band_register',  { ts: TS(2), data: { wave_id: 'W1', band_id: 'W1.A', concurrency: 2 } }),
  ev('issue_register', { ts: TS(3), data: { issue_id: 'W1.A.1', wave_id: 'W1', band_id: 'W1.A',
                                              title: 'T', github: { repo: 'x/y', issue_num: 1 } } }),
  ...extra,
];

test('3.1 — step_set happy path mutates one cell + mirrors to feed', () => {
  const s = project(setupOneIssue([
    ev('step_set', { ts: TS(4), agent: 'impl', data: { issue_id: 'W1.A.1', step_key: '3_implement', status: 'running' } }),
  ]));
  assert.equal(s.issues[0].steps['3_implement'], 'running');
  assert.equal(s.issues[0].steps['0_claim'], 'pending');  // unaffected
  const mirror = s.feed.find((f) => f.type === 'stage_update' && f.stage_id === 'W1.A.1' && f.summary === 'step 3_implement: running');
  assert.ok(mirror, 'expected step_set to mirror as a stage_update feed entry');
});

test('3.2 — review_cycle REQUEST_CHANGES resets steps 3-6, increments review_cycles, leaves 0-2 + 7-9 alone', () => {
  const events = setupOneIssue([
    ev('step_set',     { ts: TS(4), agent: 'orchestrator', data: { issue_id: 'W1.A.1', step_key: '0_claim',     status: 'done' } }),
    ev('step_set',     { ts: TS(5), agent: 'impl',         data: { issue_id: 'W1.A.1', step_key: '1_reconcile', status: 'done' } }),
    ev('step_set',     { ts: TS(6), agent: 'impl',         data: { issue_id: 'W1.A.1', step_key: '2_worktree',  status: 'done' } }),
    ev('step_set',     { ts: TS(7), agent: 'impl',         data: { issue_id: 'W1.A.1', step_key: '3_implement', status: 'done' } }),
    ev('step_set',     { ts: TS(8), agent: 'impl',         data: { issue_id: 'W1.A.1', step_key: '4_gate',      status: 'done' } }),
    ev('step_set',     { ts: TS(9), agent: 'bot',          data: { issue_id: 'W1.A.1', step_key: '5_bot_review',status: 'done' } }),
    ev('review_cycle', { ts: '2026-05-07T00:00:10.000Z', agent: 'bot', data: { issue_id: 'W1.A.1', cycle_n: 1, verdict: 'REQUEST_CHANGES' } }),
  ]);
  const s = project(events);
  const issue = s.issues[0];
  assert.equal(issue.review_cycles, 1);
  // Reset block 3-6
  for (const k of ['3_implement', '4_gate', '5_bot_review', '6_verdict']) {
    assert.equal(issue.steps[k], 'pending', `${k} should reset on REQUEST_CHANGES`);
  }
  // Cells 0-2 stay done
  for (const k of ['0_claim', '1_reconcile', '2_worktree']) {
    assert.equal(issue.steps[k], 'done', `${k} should stay done after loop-back`);
  }
  // Cells 7-9 untouched (still pending from initial seed)
  for (const k of ['7_mergify', '8_verify_merge', '9_cleanup']) {
    assert.equal(issue.steps[k], 'pending', `${k} should stay pending`);
  }
  const loopback = s.feed.find((f) => f.type === 'note' && /loop-back/.test(f.text || ''));
  assert.ok(loopback, 'expected loop-back feed entry');
});

test('3.3 — cycle thresholds: warn at >=3, escalation at >=5', () => {
  const events = setupOneIssue([
    ev('review_cycle', { ts: TS(4), agent: 'bot', data: { issue_id: 'W1.A.1', cycle_n: 3, verdict: 'REQUEST_CHANGES' } }),
  ]);
  const s3 = project(events);
  assert.equal(s3.issues[0].review_cycles, 3);
  const warn3 = s3.feed.find((f) => f.type === 'note' && f.level === 'warn' && /review_cycles=3/.test(f.text || ''));
  assert.ok(warn3, 'expected warn note at cycles >=3');
  assert.equal(s3.escalations.length, 0);

  const eventsHigh = setupOneIssue([
    ev('review_cycle', { ts: TS(4), agent: 'bot', data: { issue_id: 'W1.A.1', cycle_n: 5, verdict: 'REQUEST_CHANGES' } }),
  ]);
  const s5 = project(eventsHigh);
  assert.equal(s5.escalations.length, 1);
  assert.equal(s5.escalations[0].issue_id, 'W1.A.1');
  assert.equal(s5.escalations[0].reason, 'review_cycles_exhausted');
  assert.equal(s5.escalations[0].source, 'heartbeat-cycles');
});

test('3.4 — step_set rejected when target cell is n/a (tracker)', () => {
  const s = project([
    init('wave'),
    ev('wave_register',  { data: { wave_id: 'W1', name: 'X', layout: 'horizontal' } }),
    ev('band_register',  { data: { wave_id: 'W1', band_id: 'W1.T', concurrency: 0 } }),
    ev('issue_register', { data: { issue_id: 'W1.T.x', wave_id: 'W1', band_id: 'W1.T', title: 't',
                                    github: { repo: 'x/y', issue_num: 99 } } }),
    ev('step_set', { agent: 'impl', data: { issue_id: 'W1.T.x', step_key: '3_implement', status: 'running' } }),
  ]);
  assert.equal(s.issues[0].steps['3_implement'], 'n/a');
  const warn = s.feed.find((f) => f.type === 'note' && /n\/a \(tracker band\)/.test(f.text || ''));
  assert.ok(warn, 'expected tracker-reject warning');
});

test('3.5 — emitter mismatch on step_set warns but still mutates the cell', () => {
  // 5_bot_review expects bot|heartbeat; sending it as 'impl' should warn.
  const s = project(setupOneIssue([
    ev('step_set', { ts: TS(4), agent: 'impl', data: { issue_id: 'W1.A.1', step_key: '5_bot_review', status: 'done' } }),
  ]));
  assert.equal(s.issues[0].steps['5_bot_review'], 'done');  // mutation lands
  const warn = s.feed.find((f) => f.type === 'note' && /emitted by 'impl' \(expected: bot/.test(f.text || ''));
  assert.ok(warn, 'expected emitter-mismatch warning');
});

test('2.5 — wave events on base-mode workflow: project_base ignores them, no wave fields leak', () => {
  const events = [
    init(),
    ev('wave_register',  { data: { wave_id: 'W1', name: 'X', layout: 'horizontal' } }),
    ev('band_register',  { data: { wave_id: 'W1', band_id: 'W1.A', concurrency: 1 } }),
    ev('issue_register', { data: { issue_id: 'W1.A.1', wave_id: 'W1', band_id: 'W1.A', title: 'x', github: { repo: 'x/y', issue_num: 1 } } }),
  ];
  const s = project(events);  // dispatcher: no mode → project_base
  // No wave fields on base output.
  assert.equal(s.waves, undefined);
  assert.equal(s.bands, undefined);
  assert.equal(s.issues, undefined);
  // Wave events are still in feed (audit trail), but no synthesis.
  const synth = s.stages.find((x) => x.id === 'W1.A.1');
  assert.equal(synth, undefined, 'project_base must not synthesise issue stages');
});
