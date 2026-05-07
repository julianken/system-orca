'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const VERSION = '0.1.0';
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

function jsonResponse(res, status, body, extraHeaders) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    ...(extraHeaders || {}),
  });
  res.end(buf);
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

function serveStaticFile(res, fileName) {
  serveStatic(res, fileName);
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

  if (req.method === 'GET' && url.pathname === '/') {
    return serveStaticFile(res, 'index.html');
  }

  if (req.method === 'GET' && url.pathname.startsWith('/w/')) {
    return serveStaticFile(res, 'workflow.html');
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
