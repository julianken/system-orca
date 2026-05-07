'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { project } = require('./state');

const TS = (n) => `2026-05-07T00:00:0${n}.000Z`;
const ev = (type, opts = {}) => ({
  ts: opts.ts || TS(0),
  workflow_id: opts.workflow_id || 'wf_shape',
  agent: opts.agent || 'orchestrator',
  type,
  stage_id: opts.stage_id == null ? null : opts.stage_id,
  data: opts.data || {},
});

test('base-mode workflow returns top-level keys exactly {meta, stages, feed}', () => {
  const events = [
    ev('workflow_init', { ts: TS(0), data: { title: 'T', goal: 'G' } }),
    ev('plan_declared', { ts: TS(1), data: { stages: [{ id: '1', label: 'A' }] } }),
    ev('stage_start',   { ts: TS(2), stage_id: '1' }),
    ev('stage_complete',{ ts: TS(3), stage_id: '1', data: { summary: 'done' } }),
  ];
  const s = project(events);
  const keys = Object.keys(s).sort();
  assert.deepEqual(keys, ['feed', 'meta', 'stages']);
  for (const wf of ['waves', 'bands', 'issues', 'escalations', 'critical_path', 'summary']) {
    assert.equal(s[wf], undefined, `base-mode state must not leak ${wf}`);
  }
});

test('wave-mode workflow includes wave fields', () => {
  const events = [
    ev('workflow_init', { ts: TS(0), data: { title: 'T', goal: 'G', mode: 'wave' } }),
  ];
  const s = project(events);
  const keys = Object.keys(s).sort();
  assert.deepEqual(keys, ['bands', 'critical_path', 'escalations', 'feed', 'issues', 'meta', 'stages', 'summary', 'waves']);
});
