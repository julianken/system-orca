'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');

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
      res.on('end', () => resolve({ status: res.statusCode }));
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

function ghJson(args) {
  return new Promise((resolve) => {
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    child.stdout.on('data', (c) => out.push(c));
    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      if (code !== 0) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(out).toString('utf8'))); }
      catch { resolve(null); }
    });
  });
}

function prSignature(pr) {
  if (!pr) return null;
  return [pr.state, pr.mergeable, pr.mergeStateStatus, pr.reviewDecision].join('|');
}

async function tickOnce(ctx) {
  const wfState = await getJson(`/api/workflows/${encodeURIComponent(ctx.workflow)}`);
  const issues = (wfState && wfState.json && Array.isArray(wfState.json.issues)) ? wfState.json.issues : [];
  for (const issue of issues) {
    const repo = (issue.github && issue.github.repo) || ctx.repo;
    const num = issue.github && issue.github.issue_num;
    if (!repo || num == null) continue;
    const issueData = await ghJson(['api', `repos/${repo}/issues/${num}`]);
    if (!issueData || !issueData.pull_request) continue;
    const prNum = (issueData.pull_request.url || '').split('/').pop();
    if (!prNum) continue;
    const pr = await ghJson(['pr', 'view', prNum, '--repo', repo, '--json',
      'state,mergeable,mergeStateStatus,reviewDecision']);
    if (!pr) continue;
    const sig = prSignature(pr);
    const lastSig = ctx.lastSignatures.get(issue.issue_id);
    ctx.lastSeenAt.set(issue.issue_id, Date.now());
    if (lastSig && lastSig === sig) continue;
    ctx.lastSignatures.set(issue.issue_id, sig);
    await postEvent({
      workflow_id: ctx.workflow,
      type: 'github_state_set',
      agent: 'monitor',
      stage_id: issue.issue_id,
      data: {
        issue_id: issue.issue_id,
        pr_state: pr.state,
        mergeable: pr.mergeable,
        mergeStateStatus: pr.mergeStateStatus,
        review_decision: pr.reviewDecision || null,
      },
    });
    if (pr.mergeStateStatus === 'BLOCKED') {
      const blockedTicks = (ctx.blockedCounts.get(issue.issue_id) || 0) + 1;
      ctx.blockedCounts.set(issue.issue_id, blockedTicks);
      if (blockedTicks >= 2 && !ctx.escalated.has(issue.issue_id)) {
        ctx.escalated.add(issue.issue_id);
        await postEvent({
          workflow_id: ctx.workflow,
          type: 'escalation_add',
          agent: 'monitor',
          stage_id: issue.issue_id,
          data: { issue_id: issue.issue_id, reason: 'mergeStateStatus_blocked', source: 'heartbeat-cycles' },
        });
      }
    } else {
      ctx.blockedCounts.set(issue.issue_id, 0);
      ctx.escalated.delete(issue.issue_id);
    }
  }
  // Stall detection: any tracked issue with no signature change for > stallAfter
  const now = Date.now();
  const stallAfterMs = ctx.stallAfterSec * 1000;
  for (const [id, lastSeen] of ctx.lastSeenAt) {
    if (ctx.lastSignatures.has(id)) continue;
    if (now - lastSeen > stallAfterMs && !ctx.stalled.has(id)) {
      ctx.stalled.add(id);
      await postEvent({
        workflow_id: ctx.workflow,
        type: 'note',
        agent: 'monitor',
        stage_id: id,
        data: { level: 'warn', text: `${id}: no PR change for ${ctx.stallAfterSec}s` },
      });
    }
  }
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
        'interval-sec': { type: 'string' },
        'stall-after-sec': { type: 'string' },
      },
      allowPositionals: false,
    });
  } catch (err) {
    process.stderr.write(`monitor: ${err.message}\n`);
    process.exit(1);
  }

  const { workflow, mode, 'github-repo': repo,
          'interval-sec': intervalRaw, 'stall-after-sec': stallRaw } = parsed.values;
  if (!workflow) { process.stderr.write('monitor: --workflow is required\n'); process.exit(1); }
  if (mode && mode !== 'wave') { process.stderr.write(`monitor: unknown --mode ${mode}\n`); process.exit(1); }
  const interval = Math.max(5, Number(intervalRaw) || 60);
  const stallAfterSec = Math.max(60, Number(stallRaw) || 1800);

  const pidFile = path.join(HOME, 'workflows', workflow, 'monitor.pid');
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));

  let stopping = false;
  const cleanup = () => {
    if (stopping) return;
    stopping = true;
    try { fs.unlinkSync(pidFile); } catch { /* gone */ }
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  await postEvent({
    workflow_id: workflow,
    type: 'note',
    agent: 'monitor',
    data: { level: 'info', text: `monitor started (interval ${interval}s, stall ${stallAfterSec}s)` },
  });

  const ctx = {
    workflow, mode, repo,
    stallAfterSec,
    lastSignatures: new Map(),
    lastSeenAt: new Map(),
    blockedCounts: new Map(),
    escalated: new Set(),
    stalled: new Set(),
  };

  while (!stopping) {
    try { await tickOnce(ctx); }
    catch (err) { process.stderr.write(`monitor tick error: ${err && err.message}\n`); }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`monitor fatal: ${err && err.stack || err}\n`);
    process.exit(1);
  });
}

module.exports = { prSignature };
