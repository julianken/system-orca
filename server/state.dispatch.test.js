'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { project, project_base, project_wave, detectMode } = require('./state');

const TS = (n) => `2026-05-07T00:00:0${n}.000Z`;
const ev = (type, opts = {}) => ({
  ts: opts.ts || TS(0),
  workflow_id: opts.workflow_id || 'wf_dispatch',
  agent: opts.agent || 'orchestrator',
  type,
  stage_id: opts.stage_id == null ? null : opts.stage_id,
  data: opts.data || {},
});

test('dispatcher: no workflow_init → BaseState', () => {
  const s = project([]);
  const baseKeys = ['meta', 'stages', 'feed'];
  assert.deepEqual(Object.keys(s).sort(), baseKeys.sort());
});

test('dispatcher: workflow_init.data.mode absent → BaseState', () => {
  const s = project([
    ev('workflow_init', { data: { title: 'T', goal: 'G' } }),
  ]);
  const baseKeys = ['meta', 'stages', 'feed'];
  assert.deepEqual(Object.keys(s).sort(), baseKeys.sort());
  assert.equal(s.meta.mode, undefined);
});

test('dispatcher: mode="wave" with no wave events → WaveState with empty wave arrays', () => {
  const s = project([
    ev('workflow_init', { data: { title: 'T', goal: 'G', mode: 'wave' } }),
  ]);
  assert.equal(s.meta.mode, 'wave');
  assert.deepEqual(s.waves, []);
  assert.deepEqual(s.bands, []);
  assert.deepEqual(s.issues, []);
  assert.deepEqual(s.escalations, []);
  assert.equal(s.critical_path, null);
  assert.deepEqual(s.summary, { total: 0, done: 0, in_progress: 0, blocked: 0, needs_human: 0 });
});

test('detectMode: returns "wave" only when workflow_init declares it', () => {
  assert.equal(detectMode([]), null);
  assert.equal(detectMode([ev('note', { data: { text: 'hi' } })]), null);
  assert.equal(detectMode([ev('workflow_init', { data: { title: 'T', goal: 'G' } })]), null);
  assert.equal(detectMode([ev('workflow_init', { data: { mode: 'wave', title: 'T', goal: 'G' } })]), 'wave');
});

test('project_base ignores mode entirely (legacy compat)', () => {
  const events = [ev('workflow_init', { data: { title: 'T', goal: 'G', mode: 'wave' } })];
  const baseState = project_base(events);
  assert.equal(baseState.meta.mode, 'wave');
  assert.equal(baseState.meta.title, 'T');
  // base never grows wave fields
  assert.equal(baseState.waves, undefined);
  assert.equal(baseState.issues, undefined);
});

test('project_wave is a strict superset of project_base', () => {
  const events = [
    ev('workflow_init', { data: { title: 'T', goal: 'G', mode: 'wave' } }),
    ev('plan_declared', { data: { stages: [{ id: '1' }] } }),
    ev('stage_complete', { ts: TS(2), stage_id: '1', data: { summary: 'done' } }),
  ];
  const base = project_base(events);
  const wave = project_wave(events);
  assert.deepEqual(wave.stages, base.stages);
  assert.deepEqual(wave.feed, base.feed);
  assert.equal(wave.meta.mode, 'wave');
});
