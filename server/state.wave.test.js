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
