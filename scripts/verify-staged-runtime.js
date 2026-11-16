'use strict';

// Opt-in smoke test for an isolated staged runtime; never uses application data.
const assert = require('assert');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { once } = require('events');

async function reservePort(port = 0) {
  const server = net.createServer();
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const selected = server.address().port;
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return selected;
}

function request(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: requestPath, timeout: 3000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

async function ready(child, port, route, label) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(label + ' exited before readiness');
    try {
      const response = await request(port, route);
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(label + ' did not become ready');
}

async function main() {
  const arg = (name) => {
    const index = process.argv.indexOf(name);
    if (index < 0 || !process.argv[index + 1]) throw new Error('Missing ' + name);
    return path.resolve(process.argv[index + 1]);
  };
  const runtime = arg('--runtime');
  const frontendServer = arg('--frontend-server');
  if (!frontendServer.startsWith(path.join(runtime, 'frontend') + path.sep)) {
    throw new Error('Frontend server must be inside the staged runtime');
  }
  const python = path.join(runtime, 'python', 'python.exe');
  const database = path.join(runtime, 'surreal', 'surreal.exe');
  const node = path.join(runtime, 'node', 'node.exe');
  for (const file of [python, database, node, frontendServer]) {
    if (!fs.statSync(file).isFile()) throw new Error('Missing a staged executable or frontend server');
  }

  // The upstream production build rewrites API calls to this fixed port.
  await reservePort(5055);
  const databasePort = await reservePort();
  const frontendPort = await reservePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oeon-staged-runtime-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const password = crypto.randomBytes(24).toString('base64url');
  const baseEnv = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'COMSPEC', 'PATHEXT']) {
    if (process.env[name]) baseEnv[name] = process.env[name];
  }
  const env = {
    ...baseEnv,
    SURREAL_USER: 'root',
    SURREAL_PASS: password,
    SURREAL_PASSWORD: password,
    SURREAL_URL: `ws://127.0.0.1:${databasePort}/rpc`,
    SURREAL_NAMESPACE: 'open_notebook',
    SURREAL_DATABASE: 'open_notebook',
    OPEN_NOTEBOOK_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    DATA_FOLDER: dataDir,
    PYTHONUTF8: '1',
    TIKTOKEN_CACHE_DIR: path.join(root, 'tiktoken'),
    NEXT_TELEMETRY_DISABLED: '1',
  };
  const children = [];
  function start(command, args, options, captureError = false) {
    const child = spawn(command, args, {
      ...options, stdio: ['ignore', 'ignore', captureError ? 'pipe' : 'ignore'], windowsHide: true,
    });
    child.errorText = '';
    if (child.stderr) child.stderr.on('data', (chunk) => {
      child.errorText = (child.errorText + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', () => {});
    children.push(child);
    return child;
  }

  try {
    const db = start(database, ['start', '--log', 'none', '--bind', `127.0.0.1:${databasePort}`, `rocksdb:${path.join(root, 'database.db')}`], { env });
    await ready(db, databasePort, '/health', 'SurrealDB');
    const backendDir = path.join(runtime, 'backend');
    const api = start(python, ['-m', 'uvicorn', 'api.main:app', '--host', '127.0.0.1', '--port', '5055'], { env, cwd: backendDir });
    await ready(api, 5055, '/health', 'API');
    const direct = await request(5055, '/api/notebooks');
    assert.equal(direct.status, 200);
    assert.deepEqual(JSON.parse(direct.body), []);
    const worker = start(python, ['-m', 'surreal_commands.cli.worker', '--import-modules', 'commands', '--max-tasks', '5'], { env, cwd: backendDir }, true);
    const frontend = start(node, [frontendServer], { env: { ...env, HOSTNAME: '127.0.0.1', PORT: String(frontendPort) }, cwd: path.dirname(frontendServer) });
    await ready(frontend, frontendPort, '/notebooks', 'Frontend');
    const proxied = await request(frontendPort, '/api/notebooks');
    assert.equal(proxied.status, 200);
    assert.deepEqual(JSON.parse(proxied.body), []);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (worker.exitCode !== null) {
      const safeError = worker.errorText.replaceAll(password, '[redacted]').replaceAll(env.OPEN_NOTEBOOK_ENCRYPTION_KEY, '[redacted]');
      throw new Error('worker exited during startup: ' + safeError);
    }
    console.log('PASS: staged database, API, worker and frontend; direct and proxied notebook API');
  } finally {
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('FAIL:', error.message);
  process.exitCode = 1;
});
