'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs').promises;
const path = require('node:path');
const os = require('node:os');

const { project, readEventsFromFile } = require('./state');
const { stateToMermaid } = require('./mermaid');

const VERSION = '0.2.0';
const NAME = 'system-orca';

const PORT = Number(process.env.SYSTEM_ORCA_PORT) || 8765;
const HOST = '127.0.0.1';
const HOME = process.env.SYSTEM_ORCA_HOME || path.join(os.homedir(), '.claude', 'system-orca');
const STATIC_DIR = path.join(__dirname, 'static');
const PID_FILE = path.join(HOME, 'server.pid');
const WORKFLOWS_DIR = path.join(HOME, 'workflows');

const STARTED_AT = new Date();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.mmd':  'text/plain; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const EVENT_TYPES = new Set([
  // v1 base
  'workflow_init',
  'plan_declared',
  'stage_register',
  'stage_start',
  'stage_update',
  'stage_complete',
  'stage_fail',
  'workflow_complete',
  'note',
  // v2-applicable in v1 base
  'workflow_fail',
  // v2 wave-mode Phase 2
  'wave_register',
  'band_register',
  'issue_register',
  // v2 wave-mode Phase 3
  'step_set',
  'review_cycle',
  // v2 wave-mode Phase 4–5
  'github_state_set',
  'critical_path_update',
  'escalation_add',
  'escalation_clear',
]);

const STEP_KEY_ENUM = new Set([
  '0_claim', '1_reconcile', '2_worktree', '3_implement', '4_gate',
  '5_bot_review', '6_verdict', '7_mergify', '8_verify_merge', '9_cleanup',
]);
const STEP_STATUS_ENUM = new Set(['pending', 'running', 'done', 'failed']);
const REVIEW_VERDICT_ENUM = new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);

const WORKFLOW_ID_RE = /^[a-z0-9_-]{1,64}$/;
const BODY_CAP_BYTES = 1024 * 1024;

function jsonResponse(res, status, body, extraHeaders) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    ...(extraHeaders || {}),
  });
  res.end(buf);
}

function jsonError(res, status, code, message) {
  return jsonResponse(res, status, { error: { code, message } });
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found\n');
}

function serveStatic(res, relPath) {
  const safe = path.normalize(relPath).replace(/^([/\\]|\.\.)+/, '');
  const abs = path.join(STATIC_DIR, safe);
  if (!abs.startsWith(STATIC_DIR + path.sep) && abs !== STATIC_DIR) return notFound(res);
  fs.readFile(abs, (err, data) => {
    if (err) return notFound(res);
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const ctype = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ctype && ctype !== 'application/json') {
      const err = new Error(`unsupported content-type: ${ctype}`);
      err.statusCode = 415;
      return reject(err);
    }
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > BODY_CAP_BYTES) {
        const err = new Error(`request body exceeds ${BODY_CAP_BYTES}-byte cap`);
        err.statusCode = 413;
        req.destroy();
        return reject(err);
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) {
        const err = new Error(`invalid JSON: ${e.message}`);
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function validateEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'event must be a JSON object';
  }
  if (typeof body.workflow_id !== 'string' || !WORKFLOW_ID_RE.test(body.workflow_id)) {
    return 'workflow_id must match /^[a-z0-9_-]{1,64}$/';
  }
  if (!EVENT_TYPES.has(body.type)) {
    return `type must be one of: ${[...EVENT_TYPES].join(', ')}`;
  }
  if (body.stage_id != null && typeof body.stage_id !== 'string') {
    return 'stage_id must be a string when present';
  }
  if (body.agent != null && typeof body.agent !== 'string') {
    return 'agent must be a string when present';
  }
  if (body.data != null && (typeof body.data !== 'object' || Array.isArray(body.data))) {
    return 'data must be an object when present';
  }
  if (body.type === 'workflow_init' && body.data && body.data.mode != null) {
    if (body.data.mode !== 'wave') {
      return `unknown mode '${body.data.mode}' — supported: "wave" or omitted`;
    }
  }
  if (body.type === 'step_set') {
    const d = body.data || {};
    if (typeof d.issue_id !== 'string') return 'step_set requires data.issue_id';
    if (!STEP_KEY_ENUM.has(d.step_key)) return `unknown step_key for mode:wave: '${d.step_key}'`;
    if (!STEP_STATUS_ENUM.has(d.status)) return `unknown step_set status '${d.status}' (n/a is set only by issue_register)`;
  }
  if (body.type === 'review_cycle') {
    const d = body.data || {};
    if (typeof d.issue_id !== 'string') return 'review_cycle requires data.issue_id';
    if (typeof d.cycle_n !== 'number') return 'review_cycle requires numeric data.cycle_n';
    if (!REVIEW_VERDICT_ENUM.has(d.verdict)) return `unknown review_cycle verdict '${d.verdict}'`;
  }
  return null;
}

function workflowDir(id) {
  return path.join(WORKFLOWS_DIR, id);
}

function eventsPath(id) {
  return path.join(workflowDir(id), 'events.jsonl');
}

function metaPath(id) {
  return path.join(workflowDir(id), 'meta.json');
}

const queues = new Map();

function enqueue(id, work) {
  const prev = queues.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(work);
  queues.set(id, next.catch(() => {}));
  return next;
}

async function appendEventLine(id, event) {
  const line = JSON.stringify(event) + '\n';
  await fsp.appendFile(eventsPath(id), line);
}

async function ensureWorkflowDir(id) {
  await fsp.mkdir(workflowDir(id), { recursive: true });
}

async function workflowExists(id) {
  try { await fsp.access(workflowDir(id)); return true; }
  catch { return false; }
}

async function writeMeta(id, meta) {
  await fsp.writeFile(metaPath(id), JSON.stringify(meta, null, 2) + '\n');
}

async function readMeta(id) {
  try { return JSON.parse(await fsp.readFile(metaPath(id), 'utf8')); }
  catch { return null; }
}

async function applyWorkflowInit(id, event) {
  await ensureWorkflowDir(id);
  const data = event.data || {};
  const meta = {
    id,
    title: data.title || '',
    goal: data.goal || '',
    started_at: event.ts,
    status: 'running',
    archived: false,
    artifact_root: data.artifact_root || null,
  };
  if (data.mode === 'wave') meta.mode = 'wave';
  await writeMeta(id, meta);
}

async function applyWorkflowComplete(id) {
  const meta = (await readMeta(id)) || {};
  meta.status = 'completed';
  await writeMeta(id, meta);
}

async function handleEventsPost(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) {
    const status = e.statusCode || 400;
    const code = status === 415 ? 'unsupported_media_type'
               : status === 413 ? 'payload_too_large'
               : 'bad_request';
    return jsonError(res, status, code, e.message);
  }

  const validationError = validateEvent(body);
  if (validationError) return jsonError(res, 400, 'invalid_event', validationError);

  const id = body.workflow_id;
  const event = {
    ts: typeof body.ts === 'string' ? body.ts : new Date().toISOString(),
    workflow_id: id,
    agent: body.agent || 'orchestrator',
    type: body.type,
    stage_id: body.stage_id == null ? null : body.stage_id,
    data: body.data || {},
  };

  try {
    await enqueue(id, async () => {
      if (event.type === 'workflow_init') {
        await applyWorkflowInit(id, event);
      } else if (!(await workflowExists(id))) {
        const err = new Error(`workflow not found: ${id}`);
        err.statusCode = 404;
        throw err;
      }
      await appendEventLine(id, event);
      if (event.type === 'workflow_complete') {
        await applyWorkflowComplete(id);
      }
    });
  } catch (e) {
    const status = e.statusCode || 500;
    const code = status === 404 ? 'workflow_not_found' : 'append_failed';
    return jsonError(res, status, code, e.message);
  }

  return jsonResponse(res, 200, { ts: event.ts, accepted: true });
}

async function handleGetWorkflow(req, res, id) {
  if (!WORKFLOW_ID_RE.test(id)) return notFound(res);
  if (!(await workflowExists(id))) return notFound(res);
  const persistedMeta = (await readMeta(id)) || {};
  let events;
  try { events = readEventsFromFile(eventsPath(id)); }
  catch (e) { return jsonError(res, 500, 'corrupt_events', e.message); }
  const projected = project(events);
  // Projection is authoritative for derived fields (status, failure,
  // summary, started_at). Persisted meta is authoritative for the
  // server-side attributes it owns (archived, artifact_root, id).
  const meta = {
    ...persistedMeta,
    ...projected.meta,
    archived: !!persistedMeta.archived,
    artifact_root: persistedMeta.artifact_root ?? null,
  };
  return jsonResponse(res, 200, { ...projected, meta });
}

async function handleGetDiagram(req, res, id, url) {
  if (!WORKFLOW_ID_RE.test(id)) return notFound(res);
  if (!(await workflowExists(id))) return notFound(res);
  let events;
  try { events = readEventsFromFile(eventsPath(id)); }
  catch (e) { return jsonError(res, 500, 'corrupt_events', e.message); }
  const projected = project(events);
  const includeStatus = url.searchParams.get('include_status') !== 'false';
  const text = stateToMermaid({ stages: projected.stages }, { include_status: includeStatus });
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

async function handleGetWaveState(req, res, id) {
  if (!WORKFLOW_ID_RE.test(id)) return notFound(res);
  if (!(await workflowExists(id))) return notFound(res);
  const persistedMeta = (await readMeta(id)) || {};
  if (persistedMeta.mode !== 'wave') {
    return jsonError(res, 409, 'not_wave_mode', 'wave-state endpoint requires meta.mode==="wave"');
  }
  let events;
  try { events = readEventsFromFile(eventsPath(id)); }
  catch (e) { return jsonError(res, 500, 'corrupt_events', e.message); }
  const projected = project(events);
  return jsonResponse(res, 200, {
    meta: { ...projected.meta, archived: !!persistedMeta.archived, artifact_root: persistedMeta.artifact_root ?? null },
    waves: projected.waves || [],
    bands: projected.bands || [],
    issues: projected.issues || [],
    escalations: projected.escalations || [],
    critical_path: projected.critical_path || null,
    summary: projected.summary || null,
  });
}

async function handleGetIssues(req, res, id) {
  if (!WORKFLOW_ID_RE.test(id)) return notFound(res);
  if (!(await workflowExists(id))) return notFound(res);
  const persistedMeta = (await readMeta(id)) || {};
  if (persistedMeta.mode !== 'wave') {
    return jsonError(res, 409, 'not_wave_mode', 'issues endpoint requires meta.mode==="wave"');
  }
  let events;
  try { events = readEventsFromFile(eventsPath(id)); }
  catch (e) { return jsonError(res, 500, 'corrupt_events', e.message); }
  const projected = project(events);
  const issues = (projected.issues || []).slice().sort((a, b) => {
    const wA = a.wave_id || '', wB = b.wave_id || '';
    if (wA !== wB) return wA.localeCompare(wB);
    const bA = a.band_id || '', bB = b.band_id || '';
    if (bA !== bB) return bA.localeCompare(bB);
    return (a.issue_id || '').localeCompare(b.issue_id || '');
  });
  return jsonResponse(res, 200, issues);
}

async function handleGetIssueActivity(req, res, id, issueId) {
  if (!WORKFLOW_ID_RE.test(id)) return notFound(res);
  if (!(await workflowExists(id))) return notFound(res);
  let events;
  try { events = readEventsFromFile(eventsPath(id)); }
  catch (e) { return jsonError(res, 500, 'corrupt_events', e.message); }
  // Verify issue exists in projection.
  const projected = project(events);
  const found = (projected.issues || []).some((i) => i.issue_id === issueId);
  if (!found) return notFound(res);
  const lines = events
    .filter((e) => (e.data && e.data.issue_id === issueId) || e.stage_id === issueId)
    .map((e) => JSON.stringify(e))
    .join('\n');
  const body = lines + (lines ? '\n' : '');
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

async function handleGetEventsFile(req, res, id) {
  if (!WORKFLOW_ID_RE.test(id)) return notFound(res);
  const file = eventsPath(id);
  let stat;
  try { stat = await fsp.stat(file); }
  catch { return notFound(res); }
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Content-Length': stat.size,
  });
  fs.createReadStream(file).pipe(res);
}

async function handleListWorkflows(req, res, url) {
  const includeArchived = url.searchParams.has('include_archived') || url.searchParams.has('all');
  let dirents;
  try { dirents = await fsp.readdir(WORKFLOWS_DIR, { withFileTypes: true }); }
  catch { return jsonResponse(res, 200, []); }

  const summaries = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const id = dirent.name;
    if (!WORKFLOW_ID_RE.test(id)) continue;
    const meta = await readMeta(id);
    if (!meta) continue;
    if (meta.archived && !includeArchived) continue;

    let events;
    try { events = readEventsFromFile(eventsPath(id)); }
    catch { events = []; }

    const projected = project(events);
    const lastEvent = events.length ? events[events.length - 1] : null;
    summaries.push({
      id: meta.id || id,
      title: meta.title || '',
      goal: meta.goal || '',
      started_at: meta.started_at,
      last_event_at: lastEvent ? lastEvent.ts : meta.started_at,
      status: meta.status || 'running',
      stage_count: projected.stages.length,
      completed_count: projected.stages.filter((s) => s.status === 'completed').length,
      archived: !!meta.archived,
    });
  }

  summaries.sort((a, b) => (b.last_event_at || '').localeCompare(a.last_event_at || ''));
  return jsonResponse(res, 200, summaries);
}

async function handleArchive(req, res, id) {
  if (!WORKFLOW_ID_RE.test(id)) return notFound(res);
  if (!(await workflowExists(id))) return notFound(res);
  try {
    await enqueue(id, async () => {
      const meta = (await readMeta(id)) || { id };
      meta.archived = true;
      const tmp = metaPath(id) + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify(meta, null, 2) + '\n');
      await fsp.rename(tmp, metaPath(id));
    });
  } catch (e) {
    return jsonError(res, 500, 'archive_failed', e.message);
  }
  return jsonResponse(res, 200, { id, archived: true });
}

function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/health') {
    return jsonResponse(res, 200, {
      status: 'ok',
      uptime_s: Math.round((Date.now() - STARTED_AT.getTime()) / 1000),
      started_at: STARTED_AT.toISOString(),
    });
  }

  if (route === 'GET /api/version') {
    return jsonResponse(res, 200, {
      name: NAME,
      version: VERSION,
      commit: process.env.SYSTEM_ORCA_COMMIT || null,
    }, { 'Cache-Control': 'no-store' });
  }

  if (route === 'POST /api/events') {
    return handleEventsPost(req, res);
  }

  if (route === 'GET /api/workflows') {
    return handleListWorkflows(req, res, url);
  }

  const wfMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)(\/.*)?$/);
  if (wfMatch) {
    const id = wfMatch[1];
    const sub = wfMatch[2] || '';
    if (req.method === 'GET' && sub === '') return handleGetWorkflow(req, res, id);
    if (req.method === 'GET' && sub === '/diagram.mmd') return handleGetDiagram(req, res, id, url);
    if (req.method === 'GET' && sub === '/events.jsonl') return handleGetEventsFile(req, res, id);
    if (req.method === 'GET' && sub === '/wave-state') return handleGetWaveState(req, res, id);
    if (req.method === 'GET' && sub === '/issues') return handleGetIssues(req, res, id);
    if (req.method === 'POST' && sub === '/archive') return handleArchive(req, res, id);
    const issueActivityMatch = sub.match(/^\/issues\/([^/]+)\/activity\.ndjson$/);
    if (req.method === 'GET' && issueActivityMatch) {
      return handleGetIssueActivity(req, res, id, issueActivityMatch[1]);
    }
  }

  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/') {
    return serveStatic(res, 'index.html');
  }

  if (req.method === 'GET' && url.pathname.startsWith('/w/')) {
    return serveStatic(res, 'workflow.html');
  }

  if (req.method === 'GET' && url.pathname.startsWith('/static/')) {
    return serveStatic(res, url.pathname.slice('/static/'.length));
  }

  notFound(res);
}

function writePidFile() {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function removePidFile() {
  try { fs.unlinkSync(PID_FILE); } catch { /* already gone */ }
}

function shutdown(signal) {
  removePidFile();
  process.exit(signal === 'uncaughtException' ? 1 : 0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  process.stderr.write(`uncaughtException: ${err && err.stack || err}\n`);
  shutdown('uncaughtException');
});

const server = http.createServer(handle);
server.listen(PORT, HOST, () => {
  writePidFile();
  process.stdout.write(`listening on http://${HOST}:${PORT}\n`);
});
server.on('error', (err) => {
  process.stderr.write(`server error: ${err.message}\n`);
  process.exit(1);
});
