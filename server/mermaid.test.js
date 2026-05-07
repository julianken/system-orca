'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { stateToMermaid } = require('./mermaid');

test('empty state — header + classDefs only', () => {
  const out = stateToMermaid({ stages: [] });
  assert.match(out, /^flowchart TD\n/);
  for (const c of ['pending', 'blocked', 'running', 'completed', 'failed', 'critic']) {
    assert.match(out, new RegExp(`classDef ${c} `));
  }
});

test('two-stage chain emits the right edge', () => {
  const out = stateToMermaid({ stages: [
    { id: '1', label: 'A', name: 'one', status: 'completed' },
    { id: '2', label: 'B', name: 'two', status: 'pending', blocked_by: ['1'] },
  ]});
  assert.match(out, /1 --> 2/);
  assert.match(out, /1\["A: one"\]:::completed/);
  assert.match(out, /2\["B: two"\]:::pending/);
});

test('critic stage gets :::critic + secondary status class for status-based CSS', () => {
  const out = stateToMermaid({ stages: [
    { id: 'c1', label: 'crit', name: 'review', type: 'critic', status: 'completed' },
  ]});
  assert.match(out, /c1\["crit: review"\]:::critic/);
  assert.doesNotMatch(out, /:::completed/);
  assert.match(out, /class c1 completed/);
});

test('running critic gets both critic and running classes', () => {
  const out = stateToMermaid({ stages: [
    { id: 'cr', label: 'critic', name: 'live', type: 'critic', status: 'running' },
  ]});
  assert.match(out, /cr\["critic: live"\]:::critic/);
  assert.match(out, /class cr running/);
});

test('parent + two children produces a subgraph', () => {
  const out = stateToMermaid({ stages: [
    { id: 'p',  label: 'parent', name: 'fanout', status: 'running' },
    { id: 'p1', label: 'child1', name: 'a', status: 'pending', parent_id: 'p' },
    { id: 'p2', label: 'child2', name: 'b', status: 'pending', parent_id: 'p' },
  ]});
  assert.match(out, /subgraph p_group \["parent"\]/);
  assert.match(out, /\n {4}p1\["child1: a"\]:::pending/);
  assert.match(out, /\n {4}p2\["child2: b"\]:::pending/);
  assert.match(out, /\n {2}end/);
});

test('non-critic stages emit no secondary class statement', () => {
  const out = stateToMermaid({ stages: [
    { id: '1', label: 'A', name: 'one', status: 'running' },
  ]});
  assert.match(out, /1\["A: one"\]:::running/);
  assert.doesNotMatch(out, /class 1 running/);
});

test('include_status:false omits ::: suffix and secondary class', () => {
  const out = stateToMermaid(
    { stages: [
      { id: '1', label: 'A', name: 'one', status: 'completed' },
      { id: 'c', label: 'C', name: 'crit', type: 'critic', status: 'running' },
    ]},
    { include_status: false },
  );
  assert.doesNotMatch(out, /:::/);
  assert.doesNotMatch(out, /^\s*class /m);
  assert.match(out, /1\["A: one"\]/);
});

test('label with [ and " is escaped', () => {
  const out = stateToMermaid({ stages: [
    { id: 's', label: 'a [b] "quote"', name: 'n', status: 'pending' },
  ]});
  assert.match(out, /s\["a \\\[b\\\] \\"quote\\": n"\]/);
});
