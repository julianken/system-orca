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

function feedEntry(e, post_mortem) {
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
  if (post_mortem) entry.post_mortem = true;
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

function project_base(events) {
  let meta = {};
  const stages = new Map();
  const feed = [];
  let post_mortem = false;

  for (const e of events) {
    feed.push(feedEntry(e, post_mortem));

    switch (e.type) {
      case 'workflow_init': {
        const data = e.data || {};
        meta = {
          id: e.workflow_id,
          title: data.title || '',
          goal: data.goal || '',
          started_at: e.ts,
          status: 'running',
        };
        if (data.mode === 'wave') meta.mode = 'wave';
        // archived and artifact_root are server-side fields persisted on
        // disk via /archive + applyWorkflowInit; projection doesn't track
        // them so the response merge can pull them from persistedMeta.
        break;
      }

      case 'workflow_complete': {
        meta.status = 'completed';
        if (e.data && typeof e.data.summary === 'string') {
          meta.summary = e.data.summary;
        }
        post_mortem = false;
        break;
      }

      case 'workflow_fail': {
        meta.status = 'failed';
        meta.failed_at = e.ts;
        meta.failure = { ...(e.data || {}) };
        post_mortem = true;
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

const STEP_KEYS = [
  '0_claim',
  '1_reconcile',
  '2_worktree',
  '3_implement',
  '4_gate',
  '5_bot_review',
  '6_verdict',
  '7_mergify',
  '8_verify_merge',
  '9_cleanup',
];

const STEP_STATUS_VALUES = ['pending', 'running', 'done', 'failed'];

// Cells reset on a REQUEST_CHANGES review cycle: implementation through bot verdict.
const REVIEW_LOOP_BACK_KEYS = ['3_implement', '4_gate', '5_bot_review', '6_verdict'];

// Expected emitter set per step. Mismatches warn but don't reject.
const STEP_EXPECTED_EMITTERS = {
  '0_claim':        new Set(['orchestrator']),
  '1_reconcile':    new Set(['impl', 'orchestrator']),
  '2_worktree':     new Set(['impl', 'orchestrator']),
  '3_implement':    new Set(['impl']),
  '4_gate':         new Set(['impl']),
  '5_bot_review':   new Set(['bot', 'heartbeat']),
  '6_verdict':      new Set(['bot', 'heartbeat']),
  '7_mergify':      new Set(['orchestrator', 'bot']),
  '8_verify_merge': new Set(['merged', 'heartbeat']),
  '9_cleanup':      new Set(['orchestrator']),
};

function emptyWaveSummary() {
  return { total: 0, done: 0, in_progress: 0, blocked: 0, needs_human: 0 };
}

function emptyStepGrid(value) {
  const grid = {};
  for (const k of STEP_KEYS) grid[k] = value;
  return grid;
}

function isTrackerBand(band, issueData) {
  if (issueData && issueData.is_tracker === true) return true;
  if (band && Number(band.concurrency) === 0) return true;
  return false;
}

function upsertStatic(map, def, dynamicKeys) {
  const id = def.id;
  if (map.has(id)) {
    const existing = map.get(id);
    const merged = { ...existing };
    for (const [k, v] of Object.entries(def)) {
      if (!dynamicKeys.has(k)) merged[k] = v;
    }
    map.set(id, merged);
    return merged;
  }
  const fresh = { ...def };
  map.set(id, fresh);
  return fresh;
}

const ISSUE_DYNAMIC = new Set([
  'steps',
  'review_cycles',
  'state',
  '_steps_pending_seed',
]);

const WAVE_DYNAMIC = new Set([]);
const BAND_DYNAMIC = new Set([]);

function pushWaveWarning(feed, e, message) {
  feed.push({
    ts: e.ts,
    agent: e.agent,
    type: 'note',
    stage_id: null,
    level: 'warn',
    text: message,
    data: { level: 'warn', text: message },
  });
}

function project_wave(events) {
  const base = project_base(events);
  const wavesMap = new Map();
  const bandsMap = new Map();
  const issuesMap = new Map();
  const escalationsMap = new Map();
  const feed = base.feed.slice();
  let criticalPath = null;

  // Synthetic stages for issues — kept in a Map so issue_register can
  // upsert without disturbing v1's stage_register-derived stages.
  const stages = base.stages.slice();
  const stagesById = new Map(stages.map((s, i) => [s.id, i]));
  function syntheticStage(data) {
    const id = data.issue_id;
    const stage = {
      id,
      label: data.title || id,
      parent_id: data.band_id,
      type: 'issue',
      status: 'pending',
    };
    if (stagesById.has(id)) {
      stages[stagesById.get(id)] = { ...stages[stagesById.get(id)], ...stage };
    } else {
      stagesById.set(id, stages.length);
      stages.push(stage);
    }
  }

  function seedIssueGrid(issue, band) {
    const value = isTrackerBand(band, issue) ? 'n/a' : 'pending';
    issue.steps = emptyStepGrid(value);
    delete issue._steps_pending_seed;
  }

  for (const e of events) {
    switch (e.type) {
      case 'wave_register': {
        const data = e.data || {};
        if (typeof data.wave_id !== 'string') {
          pushWaveWarning(feed, e, 'wave_register missing wave_id; dropped');
          break;
        }
        const def = { id: data.wave_id, ...data, bands: (wavesMap.get(data.wave_id)?.bands) || [] };
        upsertStatic(wavesMap, def, WAVE_DYNAMIC);
        break;
      }

      case 'band_register': {
        const data = e.data || {};
        if (typeof data.wave_id !== 'string' || typeof data.band_id !== 'string') {
          pushWaveWarning(feed, e, 'band_register missing wave_id/band_id; dropped');
          break;
        }
        const def = { id: data.band_id, ...data };
        const band = upsertStatic(bandsMap, def, BAND_DYNAMIC);
        const wave = wavesMap.get(data.wave_id);
        if (wave) {
          if (!Array.isArray(wave.bands)) wave.bands = [];
          if (!wave.bands.includes(data.band_id)) wave.bands.push(data.band_id);
        }
        // Sweep deferred-seed issues that pointed at this band.
        for (const issue of issuesMap.values()) {
          if (issue.band_id === data.band_id && issue._steps_pending_seed) {
            seedIssueGrid(issue, band);
          }
        }
        break;
      }

      case 'issue_register': {
        const data = e.data || {};
        if (typeof data.issue_id !== 'string') {
          pushWaveWarning(feed, e, 'issue_register missing issue_id; dropped');
          break;
        }
        const def = { id: data.issue_id, ...data };
        const issue = upsertStatic(issuesMap, def, ISSUE_DYNAMIC);
        // Always synthesise (or refresh) a base stage so v1 mermaid sees the issue.
        syntheticStage(data);
        // Initial seeding of the 10-step grid (only on fresh register).
        if (!issue.steps) {
          const band = bandsMap.get(data.band_id);
          if (!band) {
            issue._steps_pending_seed = true;
            pushWaveWarning(feed, e, `issue_register for ${data.issue_id} arrived before band_register ${data.band_id}; deferring step-grid seed`);
          } else {
            seedIssueGrid(issue, band);
          }
        }
        break;
      }

      case 'step_set': {
        const data = e.data || {};
        if (typeof data.issue_id !== 'string' || typeof data.step_key !== 'string') {
          pushWaveWarning(feed, e, 'step_set missing issue_id or step_key; dropped');
          break;
        }
        const issue = issuesMap.get(data.issue_id);
        if (!issue) {
          pushWaveWarning(feed, e, `step_set for unregistered issue ${data.issue_id}; dropped`);
          break;
        }
        if (!issue.steps) {
          pushWaveWarning(feed, e, `step_set for ${data.issue_id} but step grid not yet seeded; dropped`);
          break;
        }
        if (issue.steps[data.step_key] === 'n/a') {
          pushWaveWarning(feed, e, `step_set rejected: ${data.issue_id}.${data.step_key} is n/a (tracker band); use issue_register to change`);
          break;
        }
        // Emitter discipline (warn-only).
        const expected = STEP_EXPECTED_EMITTERS[data.step_key];
        if (expected && e.agent && !expected.has(e.agent)) {
          pushWaveWarning(feed, e, `step_set ${data.step_key} emitted by '${e.agent}' (expected: ${[...expected].join('|')})`);
        }
        issue.steps[data.step_key] = data.status;
        // Mirror as a stage_update on the synthesised stage (projection-only).
        feed.push({
          ts: e.ts,
          agent: e.agent,
          type: 'stage_update',
          stage_id: data.issue_id,
          summary: `step ${data.step_key}: ${data.status}`,
        });
        break;
      }

      case 'review_cycle': {
        const data = e.data || {};
        if (typeof data.issue_id !== 'string') {
          pushWaveWarning(feed, e, 'review_cycle missing issue_id; dropped');
          break;
        }
        const issue = issuesMap.get(data.issue_id);
        if (!issue) {
          pushWaveWarning(feed, e, `review_cycle for unregistered issue ${data.issue_id}; dropped`);
          break;
        }
        const cycleN = Number(data.cycle_n) || 0;
        const prior = Number(issue.review_cycles) || 0;
        issue.review_cycles = Math.max(prior, cycleN);
        if (data.verdict === 'REQUEST_CHANGES' && issue.steps) {
          for (const k of REVIEW_LOOP_BACK_KEYS) {
            if (issue.steps[k] !== 'n/a') issue.steps[k] = 'pending';
          }
          feed.push({
            ts: e.ts,
            agent: e.agent,
            type: 'note',
            stage_id: data.issue_id,
            level: 'info',
            text: `loop-back: review cycle ${cycleN} REQUEST_CHANGES on ${data.issue_id}; reset 3_implement..6_verdict to pending`,
          });
        }
        // Threshold synthesis (projection-level, not real events).
        if (issue.review_cycles >= 3 && !issue._cycle_warn_3) {
          issue._cycle_warn_3 = true;
          feed.push({
            ts: e.ts,
            agent: 'system-orca',
            type: 'note',
            stage_id: data.issue_id,
            level: 'warn',
            text: `${data.issue_id}: review_cycles=${issue.review_cycles} (≥3); investigate stuck PR`,
          });
        }
        if (issue.review_cycles >= 5 && !issue._cycle_escalated) {
          issue._cycle_escalated = true;
          escalationsMap.set(data.issue_id, {
            issue_id: data.issue_id,
            reason: 'review_cycles_exhausted',
            source: 'heartbeat-cycles',
          });
        }
        break;
      }

      case 'critical_path_update': {
        const data = e.data || {};
        const allNull = (data.next_dispatch == null && data.blocking_issue == null
                         && data.blocking_pr == null && data.eta == null);
        criticalPath = allNull ? null : { ...data };
        break;
      }

      case 'escalation_add': {
        const data = e.data || {};
        if (typeof data.issue_id !== 'string') {
          pushWaveWarning(feed, e, 'escalation_add missing issue_id; dropped');
          break;
        }
        escalationsMap.set(data.issue_id, {
          issue_id: data.issue_id,
          reason: data.reason || '',
          source: data.source || 'orchestrator',
        });
        break;
      }

      case 'escalation_clear': {
        const data = e.data || {};
        if (typeof data.issue_id === 'string') {
          escalationsMap.delete(data.issue_id);
        }
        break;
      }

      case 'github_state_set': {
        const data = e.data || {};
        if (typeof data.issue_id !== 'string') {
          pushWaveWarning(feed, e, 'github_state_set missing issue_id; dropped');
          break;
        }
        const issue = issuesMap.get(data.issue_id);
        if (!issue) {
          pushWaveWarning(feed, e, `github_state_set for unregistered issue ${data.issue_id}; dropped`);
          break;
        }
        if (!issue.github) issue.github = {};
        const { issue_id: _id, ...rest } = data;
        Object.assign(issue.github, rest);
        break;
      }

      default:
        break;
    }
  }

  // Compute summary + derive needs_human from escalations.
  const issuesArr = Array.from(issuesMap.values());
  for (const issue of issuesArr) {
    issue.needs_human = escalationsMap.has(issue.issue_id);
  }
  const summary = computeWaveSummary(issuesArr, escalationsMap);

  return {
    ...base,
    stages,
    feed,
    meta: { ...base.meta, mode: 'wave' },
    waves: Array.from(wavesMap.values()),
    bands: Array.from(bandsMap.values()),
    issues: issuesArr,
    escalations: Array.from(escalationsMap.values()),
    critical_path: criticalPath,
    summary,
  };
}

function computeWaveSummary(issues, escalationsMap) {
  let total = 0, done = 0, in_progress = 0, blocked = 0;
  for (const issue of issues) {
    if (!issue.steps) continue;
    const cells = Object.values(issue.steps);
    if (cells.every((v) => v === 'n/a')) continue;  // tracker — exclude from summary
    total++;
    if (cells.every((v) => v === 'done' || v === 'n/a')) done++;
    else if (cells.some((v) => v === 'running')) in_progress++;
    else if (cells.some((v) => v === 'failed')) blocked++;
  }
  return { total, done, in_progress, blocked, needs_human: escalationsMap.size };
}

function detectMode(events) {
  for (const e of events) {
    if (e && e.type === 'workflow_init') {
      const m = e.data && e.data.mode;
      return typeof m === 'string' ? m : null;
    }
  }
  return null;
}

function project(events) {
  return detectMode(events) === 'wave' ? project_wave(events) : project_base(events);
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

module.exports = { project, project_base, project_wave, detectMode, readEventsFromFile, deriveStatus, STEP_KEYS };
