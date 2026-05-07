#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');

const HOST = '127.0.0.1';
const PORT = Number(process.env.SYSTEM_ORCA_PORT) || 8765;

const statusPath = process.argv[2];
const workflowId = process.argv[3];
if (!statusPath || !workflowId) {
  process.stderr.write('usage: agentic-bridge-replay.js <STATUS.json path> <workflow_id>\n');
  process.exit(2);
}

const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));

function postEvent(envelope) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(envelope));
    const req = http.request({
      host: HOST, port: PORT, path: '/api/events', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 200) return resolve();
        reject(new Error(`HTTP ${res.statusCode} ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function stageDef(s) {
  const def = {
    id: String(s.id),
    label: s.label,
    name: s.name,
    type: s.type === 'critic' ? 'critic' : 'stage',
  };
  if (s.model) def.model = s.model;
  return def;
}

async function main() {
  const stages = status.stages.map(stageDef);
  await postEvent({
    workflow_id: workflowId,
    type: 'plan_declared',
    agent: 'orchestrator',
    data: { stages },
  });

  for (const s of status.stages) {
    const id = String(s.id);
    if (s.status === 'completed' || s.status === 'running' || s.status === 'failed') {
      await postEvent({
        workflow_id: workflowId,
        type: 'stage_start',
        agent: `stage-${id}`,
        stage_id: id,
      });
    }
    if (s.status === 'completed') {
      const data = {};
      if (s.summary) data.summary = s.summary;
      if (Array.isArray(s.key_findings)) data.key_findings = s.key_findings;
      if (Array.isArray(s.open_questions)) data.open_questions = s.open_questions;
      if (s.verdict) data.verdict = s.verdict;
      if (s.artifact) data.artifact = s.artifact;
      if (typeof s.artifact_size_bytes === 'number') data.artifact_size_bytes = s.artifact_size_bytes;
      await postEvent({
        workflow_id: workflowId,
        type: 'stage_complete',
        agent: `stage-${id}`,
        stage_id: id,
        data,
      });
    } else if (s.status === 'failed') {
      const data = {};
      if (s.summary) data.summary = s.summary;
      if (s.error) data.error = s.error;
      if (s.verdict) data.verdict = s.verdict;
      await postEvent({
        workflow_id: workflowId,
        type: 'stage_fail',
        agent: `stage-${id}`,
        stage_id: id,
        data,
      });
    }
  }

  process.stdout.write(`replayed ${status.stages.length} stages into ${workflowId}\n`);
}

main().catch((err) => {
  process.stderr.write(`FAIL: ${err.message}\n`);
  process.exit(1);
});
