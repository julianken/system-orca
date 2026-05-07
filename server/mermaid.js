'use strict';

const CLASS_DEFS = [
  'classDef pending   fill:#27272a,color:#a1a1aa,stroke:#3f3f46',
  'classDef blocked   fill:#27272a,color:#71717a,stroke:#3f3f46,stroke-dasharray:3 3',
  'classDef running   fill:#84cc16,color:#000,stroke:#22c55e,stroke-width:2px',
  'classDef completed fill:#22c55e,color:#fff,stroke:#16a34a',
  'classDef failed    fill:#ef4444,color:#fff,stroke:#dc2626',
  'classDef critic    fill:#0ea5e9,color:#fff,stroke:#0284c7',
];

function escapeLabel(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\r?\n/g, ' ');
}

function nodeText(stage) {
  const label = escapeLabel(stage.label || stage.id || '');
  const name = escapeLabel(stage.name || '');
  return name ? `${label}: ${name}` : label;
}

function nodeClass(stage) {
  if (stage.type === 'critic') return 'critic';
  return stage.status || 'pending';
}

function stateToMermaid(state, opts = {}) {
  const includeStatus = opts.include_status !== false;
  const stages = (state && Array.isArray(state.stages)) ? state.stages : [];

  const childrenByParent = new Map();
  const topLevel = [];
  for (const s of stages) {
    if (s.parent_id && stages.some((x) => x.id === s.parent_id)) {
      if (!childrenByParent.has(s.parent_id)) childrenByParent.set(s.parent_id, []);
      childrenByParent.get(s.parent_id).push(s);
    } else {
      topLevel.push(s);
    }
  }

  const lines = ['flowchart TD'];

  function emitStage(s, indent = '  ') {
    const inner = nodeText(s);
    const suffix = includeStatus ? `:::${nodeClass(s)}` : '';
    lines.push(`${indent}${s.id}["${inner}"]${suffix}`);
  }

  for (const s of topLevel) {
    emitStage(s);
    if (childrenByParent.has(s.id)) {
      lines.push(`  subgraph ${s.id}_group ["${escapeLabel(s.label || s.id)}"]`);
      for (const child of childrenByParent.get(s.id)) emitStage(child, '    ');
      lines.push('  end');
    }
  }

  for (const [parentId, children] of childrenByParent.entries()) {
    if (!stages.some((x) => x.id === parentId)) {
      for (const child of children) emitStage(child);
    }
  }

  for (const s of stages) {
    const deps = Array.isArray(s.blocked_by) ? s.blocked_by : [];
    for (const dep of deps) {
      lines.push(`  ${dep} --> ${s.id}`);
    }
  }

  for (const def of CLASS_DEFS) lines.push(def);

  return lines.join('\n') + '\n';
}

module.exports = { stateToMermaid };
