#!/usr/bin/env node
'use strict';

const http = require('node:http');

const HOST = '127.0.0.1';
const PORT = Number(process.env.SYSTEM_ORCA_PORT) || 8765;

const workflowId = process.argv[2];
const count = Number(process.argv[3] || 200);
const payloadSize = Number(process.argv[4] || 4096);

if (!workflowId) {
  process.stderr.write('usage: stress-mutex.js <workflow_id> [count=200] [payloadSize=4096]\n');
  process.exit(2);
}

function postOne(i) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      workflow_id: workflowId,
      type: 'note',
      agent: `stress-${i}`,
      data: { text: 'x'.repeat(payloadSize), index: i },
    });
    const buf = Buffer.from(body);
    const req = http.request({
      host: HOST, port: PORT, path: '/api/events', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 200) return resolve();
        reject(new Error(`POST ${i}: HTTP ${res.statusCode} ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error(`POST ${i}: timeout`)));
    req.write(buf);
    req.end();
  });
}

async function main() {
  const tasks = [];
  for (let i = 0; i < count; i++) tasks.push(postOne(i));
  await Promise.all(tasks);
  process.stdout.write(`OK: ${count} POSTs of ${payloadSize}B each succeeded\n`);
}

main().catch((err) => {
  process.stderr.write(`FAIL: ${err.message}\n`);
  process.exit(1);
});
