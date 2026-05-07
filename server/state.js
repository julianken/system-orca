'use strict';

const fs = require('node:fs');

const DYNAMIC_FIELDS = new Set([
  'status',
  'started_at',
  'completed_at',
  'summary',
  'key_findings',
  'open_questions',
  'verdict',
  'artifact',
  'artifact_size_bytes',
  'error',
  'percent',
]);

function staticFieldsOnly(input) {
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!DYNAMIC_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

function deriveStatus(stage, stages) {
  const deps = Array.isArray(stage.blocked_by) ? stage.blocked_by : [];
  if (deps.length === 0) return 'pending';
  const allCompleted = deps.every((dep) => {
    const s = stages.get(dep);
    return s && s.status === 'completed';
  });
  return allCompleted ? 'pending' : 'blocked';
}

function unblockDependents(stages) {
  for (const stage of stages.values()) {
    if (stage.status !== 'blocked') continue;
    if (deriveStatus(stage, stages) === 'pending') stage.status = 'pending';
  }
}

function feedEntry(e) {
  const entry = {
    ts: e.ts,
    agent: e.agent,
    type: e.type,
    stage_id: e.stage_id == null ? null : e.stage_id,
  };
  const d = e.data;
  if (d && typeof d === 'object') {
    if (typeof d.summary === 'string') entry.summary = d.summary;
    if (typeof d.level === 'string') entry.level = d.level;
    if (typeof d.text === 'string') entry.text = d.text;
  }
  return entry;
}

function warningEntry(e, message) {
  return {
    ts: e.ts,
    agent: e.agent,
    type: 'note',
    stage_id: e.stage_id == null ? null : e.stage_id,
    level: 'warn',
    text: message,
    data: { level: 'warn', text: message },
  };
}

function registerStage(stages, def) {
  if (stages.has(def.id)) {
    const existing = stages.get(def.id);
    stages.set(def.id, { ...existing, ...staticFieldsOnly(def) });
  } else {
    const fresh = { ...def };
    fresh.status = deriveStatus(fresh, stages);
    stages.set(def.id, fresh);
  }
}

function project(events) {
  let meta = {};
  const stages = new Map();
  const feed = [];

  for (const e of events) {
    feed.push(feedEntry(e));

    switch (e.type) {
      case 'workflow_init': {
        const data = e.data || {};
        meta = {
          id: e.workflow_id,
          title: data.title || '',
          goal: data.goal || '',
          started_at: e.ts,
          status: 'running',
          archived: false,
          artifact_root: data.artifact_root || null,
        };
        break;
      }

      case 'workflow_complete': {
        meta.status = 'completed';
        if (e.data && typeof e.data.summary === 'string') {
          meta.summary = e.data.summary;
        }
        break;
      }

      case 'plan_declared': {
        const list = (e.data && Array.isArray(e.data.stages)) ? e.data.stages : [];
        for (const def of list) {
          if (def && typeof def.id === 'string') registerStage(stages, def);
        }
        break;
      }

      case 'stage_register': {
        const def = e.data || {};
        if (typeof def.id === 'string') registerStage(stages, def);
        break;
      }

      case 'stage_start': {
        const stage = stages.get(e.stage_id);
        if (!stage) {
          feed.push(warningEntry(e, `out-of-order: stage_start for unregistered stage ${e.stage_id}`));
          break;
        }
        stage.status = 'running';
        stage.started_at = e.ts;
        break;
      }

      case 'stage_update': {
        const stage = stages.get(e.stage_id);
        if (!stage) {
          feed.push(warningEntry(e, `out-of-order: stage_update for unregistered stage ${e.stage_id}`));
          break;
        }
        Object.assign(stage, e.data || {});
        break;
      }

      case 'stage_complete': {
        const stage = stages.get(e.stage_id);
        if (!stage) {
          feed.push(warningEntry(e, `out-of-order: stage_complete for unregistered stage ${e.stage_id}`));
          break;
        }
        if (stage.status === 'completed' || stage.status === 'failed') {
          feed.push(warningEntry(e, `out-of-order: stage_complete for already-${stage.status} stage ${e.stage_id}`));
          break;
        }
        stage.status = 'completed';
        stage.completed_at = e.ts;
        Object.assign(stage, e.data || {});
        unblockDependents(stages);
        break;
      }

      case 'stage_fail': {
        const stage = stages.get(e.stage_id);
        if (!stage) {
          feed.push(warningEntry(e, `out-of-order: stage_fail for unregistered stage ${e.stage_id}`));
          break;
        }
        stage.status = 'failed';
        stage.completed_at = e.ts;
        Object.assign(stage, e.data || {});
        break;
      }

      case 'note':
        break;

      default:
        break;
    }
  }

  return {
    meta,
    stages: Array.from(stages.values()),
    feed,
  };
}

function readEventsFromFile(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const lines = raw.split('\n');
  const events = [];
  const errors = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try { events.push(JSON.parse(line)); }
    catch (e) { errors.push(`line ${i + 1}: ${e.message}`); }
  }
  if (errors.length) {
    const err = new Error(`malformed events.jsonl: ${errors.join('; ')}`);
    err.lines = errors;
    throw err;
  }
  return events;
}

module.exports = { project, readEventsFromFile, deriveStatus };
