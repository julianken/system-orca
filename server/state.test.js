'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { project } = require('./state');

const TS = (n) => `2026-05-07T00:00:0${n}.000Z`;
const ev = (type, opts = {}) => ({
  ts: opts.ts || TS(0),
  workflow_id: opts.workflow_id || 'wf_test',
  agent: opts.agent || 'orchestrator',
  type,
  stage_id: opts.stage_id == null ? null : opts.stage_id,
  data: opts.data || {},
});

test('empty event list', () => {
  const s = project([]);
  assert.deepEqual(s.meta, {});
  assert.deepEqual(s.stages, []);
  assert.deepEqual(s.feed, []);
});

test('workflow_init populates meta', () => {
  const s = project([
    ev('workflow_init', { ts: TS(0), data: { title: 'T', goal: 'G' } }),
  ]);
  assert.equal(s.meta.title, 'T');
  assert.equal(s.meta.goal, 'G');
  assert.equal(s.meta.started_at, TS(0));
  assert.equal(s.meta.status, 'running');
});

test('plan_declared with chain marks deps as blocked', () => {
  const s = project([
    ev('workflow_init', { ts: TS(0), data: { title: 'T', goal: 'G' } }),
    ev('plan_declared', { ts: TS(1), data: { stages: [
      { id: '1', label: 'A' },
      { id: '2', label: 'B', blocked_by: ['1'] },
      { id: '3', label: 'C', blocked_by: ['2'] },
    ]}}),
  ]);
  const byId = Object.fromEntries(s.stages.map(x => [x.id, x]));
  assert.equal(byId['1'].status, 'pending');
  assert.equal(byId['2'].status, 'blocked');
  assert.equal(byId['3'].status, 'blocked');
});

test('stage_start sets running + started_at', () => {
  const s = project([
    ev('plan_declared', { data: { stages: [{ id: '1' }] } }),
    ev('stage_start', { ts: TS(2), stage_id: '1' }),
  ]);
  assert.equal(s.stages[0].status, 'running');
  assert.equal(s.stages[0].started_at, TS(2));
});

test('stage_update shallow-merges into stage', () => {
  const s = project([
    ev('plan_declared', { data: { stages: [{ id: '1' }] } }),
    ev('stage_update', { stage_id: '1', data: { summary: 'a' } }),
    ev('stage_update', { stage_id: '1', data: { key_findings: ['k'] } }),
  ]);
  assert.equal(s.stages[0].summary, 'a');
  assert.deepEqual(s.stages[0].key_findings, ['k']);
});

test('stage_complete unblocks dependents and only direct ones', () => {
  const s = project([
    ev('plan_declared', { data: { stages: [
      { id: '1' },
      { id: '2', blocked_by: ['1'] },
      { id: '3', blocked_by: ['2'] },
    ]}}),
    ev('stage_complete', { ts: TS(3), stage_id: '1', data: { summary: 'done' } }),
  ]);
  const byId = Object.fromEntries(s.stages.map(x => [x.id, x]));
  assert.equal(byId['1'].status, 'completed');
  assert.equal(byId['1'].summary, 'done');
  assert.equal(byId['1'].completed_at, TS(3));
  assert.equal(byId['2'].status, 'pending');
  assert.equal(byId['3'].status, 'blocked');
});

test('stage_fail sets failed with verdict', () => {
  const s = project([
    ev('plan_declared', { data: { stages: [{ id: '1' }] } }),
    ev('stage_fail', { stage_id: '1', data: { verdict: 'FAIL', error: 'oops' } }),
  ]);
  assert.equal(s.stages[0].status, 'failed');
  assert.equal(s.stages[0].verdict, 'FAIL');
  assert.equal(s.stages[0].error, 'oops');
});

test('workflow_complete flips meta.status', () => {
  const s = project([
    ev('workflow_init', { data: { title: 'T', goal: 'G' } }),
    ev('workflow_complete', { data: { summary: 'wrap' } }),
  ]);
  assert.equal(s.meta.status, 'completed');
  assert.equal(s.meta.summary, 'wrap');
});

test('critic-class type is preserved on stage', () => {
  const s = project([
    ev('plan_declared', { data: { stages: [
      { id: '1', label: 'crit', type: 'critic' },
    ]}}),
  ]);
  assert.equal(s.stages[0].type, 'critic');
});

test('late stage_register adds to stages', () => {
  const s = project([
    ev('workflow_init', { data: { title: 'T', goal: 'G' } }),
    ev('stage_register', { data: { id: 'late', label: 'Late' } }),
  ]);
  assert.equal(s.stages[0].id, 'late');
  assert.equal(s.stages[0].status, 'pending');
});

test('orphan stage_start drops stage; emits warning to feed', () => {
  const s = project([
    ev('workflow_init', { data: { title: 'T', goal: 'G' } }),
    ev('stage_start', { stage_id: 'ghost' }),
  ]);
  assert.equal(s.stages.length, 0);
  const warns = s.feed.filter(f => f.type === 'note' && f.text && /out-of-order: stage_start for unregistered stage ghost/.test(f.text));
  assert.equal(warns.length, 1);
  assert.equal(warns[0].data.level, 'warn');
});

test('orphan stage_update / stage_complete / stage_fail all warn', () => {
  const s = project([
    ev('workflow_init', { data: { title: 'T', goal: 'G' } }),
    ev('stage_update', { stage_id: 'ghost' }),
    ev('stage_complete', { stage_id: 'ghost' }),
    ev('stage_fail', { stage_id: 'ghost' }),
  ]);
  assert.equal(s.stages.length, 0);
  const warns = s.feed.filter(f => f.type === 'note' && /out-of-order/.test(f.text || ''));
  assert.equal(warns.length, 3);
});

test('duplicate stage_register overwrites static, preserves dynamic', () => {
  const s = project([
    ev('stage_register', { data: { id: '1', label: 'A', blocked_by: [] } }),
    ev('stage_start', { ts: TS(2), stage_id: '1' }),
    ev('stage_register', { data: { id: '1', label: 'B' } }),
  ]);
  assert.equal(s.stages[0].label, 'B');
  assert.equal(s.stages[0].status, 'running');
  assert.equal(s.stages[0].started_at, TS(2));
});

test('second plan_declared is additive merge', () => {
  const s = project([
    ev('plan_declared', { data: { stages: [{ id: '1' }] } }),
    ev('stage_start', { ts: TS(2), stage_id: '1' }),
    ev('plan_declared', { data: { stages: [
      { id: '1', label: 'X' },
      { id: '2' },
    ]}}),
  ]);
  const byId = Object.fromEntries(s.stages.map(x => [x.id, x]));
  assert.equal(byId['1'].label, 'X');
  assert.equal(byId['1'].status, 'running');
  assert.equal(byId['1'].started_at, TS(2));
  assert.equal(byId['2'].status, 'pending');
});

test('workflow_fail flips meta.status and tags subsequent feed entries post_mortem', () => {
  const s = project([
    ev('workflow_init', { ts: TS(0), data: { title: 'T', goal: 'G' } }),
    ev('workflow_fail',  { ts: TS(3), data: { summary: 'crashed', error: 'oom', verdict: 'FAIL' } }),
    ev('note',           { ts: TS(4), data: { text: 'after', level: 'info' } }),
  ]);
  assert.equal(s.meta.status, 'failed');
  assert.equal(s.meta.failed_at, TS(3));
  assert.equal(s.meta.failure.error, 'oom');
  assert.equal(s.meta.failure.verdict, 'FAIL');
  const noteEntry = s.feed.find((f) => f.type === 'note' && f.text === 'after');
  assert.equal(noteEntry.post_mortem, true);
});

test('workflow_complete after workflow_fail recovers; clears post_mortem flag', () => {
  const s = project([
    ev('workflow_init',     { ts: TS(0), data: { title: 'T', goal: 'G' } }),
    ev('workflow_fail',     { ts: TS(2), data: { summary: 'oops', verdict: 'COURSE_CORRECT' } }),
    ev('note',              { ts: TS(3), data: { text: 'during-fail' } }),
    ev('workflow_complete', { ts: TS(4), data: { summary: 'recovered' } }),
    ev('note',              { ts: TS(5), data: { text: 'after-recover' } }),
  ]);
  assert.equal(s.meta.status, 'completed');
  assert.equal(s.meta.summary, 'recovered');
  const duringFail = s.feed.find((f) => f.type === 'note' && f.text === 'during-fail');
  const afterRecover = s.feed.find((f) => f.type === 'note' && f.text === 'after-recover');
  assert.equal(duringFail.post_mortem, true);
  assert.equal(afterRecover.post_mortem, undefined);
});

test('double stage_complete is no-op with warning', () => {
  const s = project([
    ev('stage_register', { data: { id: '1' } }),
    ev('stage_complete', { ts: TS(3), stage_id: '1', data: { summary: 'first' } }),
    ev('stage_complete', { ts: TS(4), stage_id: '1', data: { summary: 'again' } }),
  ]);
  assert.equal(s.stages[0].status, 'completed');
  assert.equal(s.stages[0].summary, 'first');
  assert.equal(s.stages[0].completed_at, TS(3));
  const warns = s.feed.filter(f => f.type === 'note' && /already-completed/.test(f.text || ''));
  assert.equal(warns.length, 1);
});
