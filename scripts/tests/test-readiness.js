'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { isHttpReady } = require('../start-services');

async function run() {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/ready' ? 200 : 503);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await isHttpReady(`${url}/ready`), true);
    assert.equal(await isHttpReady(`${url}/unavailable`), false);
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
  assert.equal(await isHttpReady(`${url}/ready`), false);
  console.log('Readiness: HTTP success, failure, and connection refusal passed.');
}

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
