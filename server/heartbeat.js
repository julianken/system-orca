'use strict';

const fs = require('node:fs');
const fsp = require('node:fs').promises;
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');

// ---- pure helpers (exported for unit tests) ----

const VERDICT_MAP = {
  APPROVED: 'APPROVE',
  CHANGES_REQUESTED: 'REQUEST_CHANGES',
  REVIEW_REQUIRED: 'COMMENT',
};

function normalizeVerdict(reviewDecision) {
  if (reviewDecision == null) return null;
  return VERDICT_MAP[String(reviewDecision).toUpperCase()] || null;
}

function parseReviewCycles(comments) {
  if (!Array.isArray(comments)) return 0;
  let n = 0;
  for (const c of comments) {
    const body = (c && (c.body || c.text)) || '';
    if (typeof body !== 'string') continue;
    if (body.includes('Review verdict')) n++;
  }
  return n;
}

function computeLabelDiff(prev, curr) {
  const prevSet = new Set((prev || []).map(String));
  const currSet = new Set((curr || []).map(String));
  const added = [];
  const removed = [];
  for (const l of currSet) if (!prevSet.has(l)) added.push(l);
  for (const l of prevSet) if (!currSet.has(l)) removed.push(l);
  return { added: added.sort(), removed: removed.sort() };
}

function nextBackoff(state, signal) {
  const baseInterval = Number(state.baseInterval) || 120;
  const cap = 600;
  const cur = Number(state.currentInterval) || baseInterval;
  const fails = Number(state.consecutiveFails) || 0;
  if (signal === 'success') {
    return { ...state, consecutiveFails: 0, currentInterval: baseInterval };
  }
  if (signal === 'rate_limit') {
    return {
      ...state,
      consecutiveFails: fails + 1,
      currentInterval: Math.min(cap, cur * 2),
      lastSignal: 'rate_limit',
    };
  }
  // generic error
  return {
    ...state,
    consecutiveFails: fails + 1,
    currentInterval: Math.min(cap, Math.max(baseInterval, Math.round(cur * 1.5))),
    lastSignal: 'error',
  };
}

// ---- runtime entry point ----

const NAME = 'system-orca';
const HOST = '127.0.0.1';
const PORT = Number(process.env.SYSTEM_ORCA_PORT) || 8765;
const HOME = process.env.SYSTEM_ORCA_HOME || path.join(os.homedir(), '.claude', 'system-orca');

function postEvent(envelope) {
  return new Promise((resolve) => {
    const buf = Buffer.from(JSON.stringify(envelope));
    const req = http.request({
      host: HOST, port: PORT, path: '/api/events', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => req.destroy());
    req.write(buf);
    req.end();
  });
}

function getJson(pathname) {
  return new Promise((resolve) => {
    http.request({ host: HOST, port: PORT, path: pathname, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { resolve({ status: res.statusCode, json: null }); }
      });
    }).on('error', () => resolve(null)).end();
  });
}

async function ghCheckAuth() {
  return new Promise((resolve) => {
    const child = spawn('gh', ['auth', 'status'], { stdio: 'ignore' });
    child.on('error', () => resolve({ ok: false, code: 127 }));
    child.on('exit', (code) => resolve({ ok: code === 0, code: code == null ? 1 : code }));
  });
}

function ghJson(args) {
  return new Promise((resolve) => {
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', () => resolve({ ok: false, json: null, err: 'gh-not-found' }));
    child.on('exit', (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(err).toString('utf8');
        const rateLimit = /API rate limit exceeded|secondary rate limit/i.test(stderr);
        return resolve({ ok: false, json: null, err: stderr, rateLimit });
      }
      try { resolve({ ok: true, json: JSON.parse(Buffer.concat(out).toString('utf8')) }); }
      catch { resolve({ ok: false, json: null, err: 'parse-error' }); }
    });
  });
}

async function fetchIssueAndPR(repo, issueNum) {
  const issue = await ghJson(['api', `repos/${repo}/issues/${issueNum}`]);
  let pr = null;
  if (issue.ok && issue.json && issue.json.pull_request) {
    const prNum = (issue.json.pull_request.url || '').split('/').pop();
    if (prNum) {
      pr = await ghJson(['pr', 'view', prNum, '--repo', repo, '--json',
        'state,mergeable,mergeStateStatus,reviewDecision,comments,labels']);
    }
  } else if (issue.ok && issue.json && Array.isArray(issue.json.labels)) {
    // not a PR-bound issue; still has labels
  }
  return { issue, pr };
}

async function tickOnce(ctx) {
  const wfState = await getJson(`/api/workflows/${encodeURIComponent(ctx.workflow)}`);
  const issues = (wfState && wfState.json && Array.isArray(wfState.json.issues)) ? wfState.json.issues : [];
  if (!issues.length) return { ok: true, pollNext: ctx.state.baseInterval };

  let anyError = false;
  let rateLimited = false;
  for (const issue of issues) {
    const repo = (issue.github && issue.github.repo) || ctx.repo;
    const num = (issue.github && issue.github.issue_num);
    if (!repo || num == null) continue;
    const { issue: ghIssue, pr } = await fetchIssueAndPR(repo, num);
    if (!ghIssue.ok) {
      if (ghIssue.rateLimit) rateLimited = true;
      anyError = true;
      continue;
    }
    const ghIssueData = ghIssue.json;
    const labels = (ghIssueData.labels || []).map((l) => typeof l === 'string' ? l : l.name);
    const githubState = {
      issue_id: issue.issue_id,
      issue_state: ghIssueData.state,
    };
    if (pr && pr.ok && pr.json) {
      githubState.pr_state = pr.json.state;
      githubState.mergeable = pr.json.mergeable;
      githubState.mergeStateStatus = pr.json.mergeStateStatus;
      githubState.review_decision = normalizeVerdict(pr.json.reviewDecision);
      const cycles = parseReviewCycles(pr.json.comments || []);
      if (cycles > 0) {
        await postEvent({
          workflow_id: ctx.workflow,
          type: 'review_cycle',
          agent: 'heartbeat',
          stage_id: issue.issue_id,
          data: {
            issue_id: issue.issue_id,
            cycle_n: cycles,
            verdict: githubState.review_decision || 'COMMENT',
          },
        });
      }
    }
    await postEvent({
      workflow_id: ctx.workflow,
      type: 'github_state_set',
      agent: 'heartbeat',
      stage_id: issue.issue_id,
      data: githubState,
    });
  }

  return { ok: !anyError, rateLimited };
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        workflow: { type: 'string' },
        mode: { type: 'string' },
        'github-repo': { type: 'string' },
        'github-epic': { type: 'string' },
        'interval-sec': { type: 'string' },
      },
      allowPositionals: false,
    });
  } catch (err) {
    process.stderr.write(`heartbeat: ${err.message}\n`);
    process.exit(1);
  }

  const { workflow, mode, 'github-repo': repo, 'interval-sec': intervalRaw } = parsed.values;
  if (!workflow) { process.stderr.write('heartbeat: --workflow is required\n'); process.exit(1); }
  if (mode && mode !== 'wave') { process.stderr.write(`heartbeat: unknown --mode ${mode}\n`); process.exit(1); }

  const baseInterval = Math.max(5, Number(intervalRaw) || 120);

  // Version check
  const ver = await getJson('/api/version');
  if (!ver || !ver.json || !/^0\.[2-9]\d*\.\d+/.test(ver.json.version || '')) {
    await postEvent({
      workflow_id: workflow,
      type: 'note',
      agent: 'heartbeat',
      data: { level: 'error', text: `heartbeat refusing to run: server version ${ver?.json?.version} < 0.2.0` },
    });
    process.exit(4);
  }

  // gh auth check
  const auth = await ghCheckAuth();
  if (!auth.ok) {
    await postEvent({
      workflow_id: workflow,
      type: 'note',
      agent: 'heartbeat',
      data: { level: 'error', text: `gh auth status failed (code ${auth.code})` },
    });
    process.exit(auth.code === 127 ? 127 : 2);
  }

  // PID file
  const pidFile = path.join(HOME, 'workflows', workflow, 'heartbeat.pid');
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));

  let state = { baseInterval, currentInterval: baseInterval, consecutiveFails: 0 };
  let stopping = false;
  const cleanup = () => {
    if (stopping) return;
    stopping = true;
    try { fs.unlinkSync(pidFile); } catch { /* gone */ }
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  const ctx = { workflow, mode, repo, state };
  await postEvent({
    workflow_id: workflow,
    type: 'note',
    agent: 'heartbeat',
    data: { level: 'info', text: `heartbeat started (interval ${baseInterval}s, repo ${repo || 'auto'})` },
  });

  while (!stopping) {
    const result = await tickOnce({ ...ctx, state });
    if (result.rateLimited) {
      state = nextBackoff(state, 'rate_limit');
      await postEvent({
        workflow_id: workflow,
        type: 'note',
        agent: 'heartbeat',
        data: { level: 'warn', text: `gh rate-limited; backoff to ${state.currentInterval}s` },
      });
    } else if (!result.ok) {
      state = nextBackoff(state, 'error');
      if (state.consecutiveFails >= 3 && state.consecutiveFails % 3 === 0) {
        await postEvent({
          workflow_id: workflow,
          type: 'note',
          agent: 'heartbeat',
          data: { level: 'warn', text: `${state.consecutiveFails} consecutive heartbeat ticks failed` },
        });
      }
    } else {
      state = nextBackoff(state, 'success');
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, state.currentInterval * 1000));
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`heartbeat fatal: ${err && err.stack || err}\n`);
    process.exit(1);
  });
}

module.exports = { normalizeVerdict, parseReviewCycles, computeLabelDiff, nextBackoff };
