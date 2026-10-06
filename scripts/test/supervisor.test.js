'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { resolveInterpreter } = require('../lib/resolve-runtimes');
const { buildBackendEnv, serviceTable } = require('../lib/service-table');
const { supervise, isPortOpen, waitForPort, isProcessAlive, killProcessTree } = require('../lib/supervisor');

const fixtures = [];
let passed = 0;

function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log(`  ok - ${name}`);
  });
}

function makeTempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(directory);
  return directory;
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function main() {
  await test('service table declares services in startup order with expected env and ports', () => {
    const runtimePath = path.join(os.tmpdir(), 'service-fixture');
    const dataDir = path.join(os.tmpdir(), 'service-data');
    const backendPath = path.join(runtimePath, 'backend');
    const env = { PATH: 'test-path', KEEP: 'inherited' };
    const backendEnv = buildBackendEnv({
      dataDir,
      encryptionKey: 'test-key',
      tiktokenCache: path.join(runtimePath, 'tiktoken-cache'),
      backendPath,
      env,
    });
    const table = serviceTable({
      runtimePath,
      dataDir,
      backendPath,
      pythonExe: path.join(runtimePath, 'python', 'python.exe'),
      nodeExe: path.join(runtimePath, 'node', 'node.exe'),
      encryptionKey: 'test-key',
      env,
      backendEnv,
    });

    assert.deepStrictEqual(table.map((service) => service.name), ['surrealdb', 'api', 'worker', 'frontend']);
    assert.deepStrictEqual(table.map((service) => service.readyPort), [8000, 5055, null, 8502]);
    assert.strictEqual(backendEnv.SURREAL_URL, 'ws://127.0.0.1:8000/rpc');
    assert.strictEqual(backendEnv.OPEN_NOTEBOOK_ENCRYPTION_KEY, 'test-key');
    assert.strictEqual(backendEnv.DATA_FOLDER, path.join(dataDir, 'data'));
    assert.strictEqual(backendEnv.OPEN_NOTEBOOK_ENABLE_DOCLING, 'true');
    assert.strictEqual(backendEnv.TIKTOKEN_CACHE_DIR, path.join(runtimePath, 'tiktoken-cache'));
    assert.strictEqual(backendEnv.PYTHONPATH, backendPath);
    assert.strictEqual(backendEnv.KEEP, 'inherited');
    assert.strictEqual(backendEnv.SURREAL_USER, 'root');
    assert.strictEqual(backendEnv.SURREAL_PASSWORD, 'root');
    assert.deepStrictEqual(table[0].args.slice(3, 7), ['--user', 'root', '--pass', 'root']);
    assert.strictEqual(table[2].readyPort, null);
    assert.deepStrictEqual(table[3].env, {
      ...env,
      NODE_ENV: 'production',
      PORT: '8502',
      HOSTNAME: '127.0.0.1',
      INTERNAL_API_URL: 'http://127.0.0.1:5055',
    });
  });

  await test('a generated database password reaches both the env and the surreal arguments', () => {
    const runtimePath = path.join(os.tmpdir(), 'service-fixture');
    const dataDir = path.join(os.tmpdir(), 'service-data');
    const backendPath = path.join(runtimePath, 'backend');
    const env = { PATH: 'test-path' };
    const surrealPassword = 'generated-secret-value';
    const backendEnv = buildBackendEnv({
      dataDir,
      encryptionKey: 'test-key',
      tiktokenCache: path.join(runtimePath, 'tiktoken-cache'),
      backendPath,
      env,
      surrealPassword,
    });
    const table = serviceTable({
      runtimePath,
      dataDir,
      backendPath,
      pythonExe: path.join(runtimePath, 'python', 'python.exe'),
      nodeExe: path.join(runtimePath, 'node', 'node.exe'),
      env,
      backendEnv,
      surrealPassword,
    });

    assert.strictEqual(backendEnv.SURREAL_PASSWORD, surrealPassword);
    assert.deepStrictEqual(table[0].args.slice(3, 7), ['--user', 'root', '--pass', surrealPassword]);
  });

  await test('waitForPort resolves when a real listener is available', async () => {
    const server = net.createServer();
    const port = await listen(server);
    try {
      assert.strictEqual(await waitForPort(port, 1000, 'test listener'), true);
    } finally {
      await close(server);
    }
  });

  await test('waitForPort rejects with the timeout message for a closed port', async () => {
    const server = net.createServer();
    const port = await listen(server);
    await close(server);
    await assert.rejects(
      waitForPort(port, 300, 'closed test port'),
      /Timed out waiting for closed test port on port \d+ after 0s\./
    );
  });

  await test('waitForPort preserves premature-exit detection and log context', async () => {
    await assert.rejects(
      waitForPort(12345, 300, 'fake service', { exitCode: 7, signalCode: null }, () => 'Recent log output: failure'),
      (error) => {
        assert.match(error.message, /fake service process exited prematurely with code 7/);
        assert.match(error.message, /Recent log output: failure/);
        return true;
      }
    );
  });

  await test('resolver prefers bundled runtime and reports invalid fallback versions', () => {
    const runtimePath = makeTempDir('onb-resolver-');
    const bundledPython = path.join(runtimePath, 'python', 'python.exe');
    fs.mkdirSync(path.dirname(bundledPython), { recursive: true });
    fs.writeFileSync(bundledPython, '');
    assert.deepStrictEqual(resolveInterpreter('python', runtimePath), { path: bundledPython, source: 'bundled' });

    const fallbackRuntime = path.join(runtimePath, 'no-bundled-runtime');
    const fakePathLookup = (command) => command === 'python.exe' ? 'C:\\fake\\python.exe' : null;
    const supportedFallback = resolveInterpreter('python', fallbackRuntime, {
      findOnPath: fakePathLookup,
      execFileSync: () => 'Python 3.12.2',
    });
    assert.deepStrictEqual(supportedFallback, { path: 'C:\\fake\\python.exe', source: 'system' });

    const fallback = resolveInterpreter('python', fallbackRuntime, {
      findOnPath: fakePathLookup,
      execFileSync: () => 'Python 3.10.0',
    });
    assert.deepStrictEqual(fallback, {
      path: 'C:\\fake\\python.exe',
      source: 'system',
      invalidVersion: '3.10',
    });
  });

  await test('supervise enriches readiness failures with logs and cleans up spawned processes', async () => {
    const activeProbe = net.createServer();
    const activePort = await listen(activeProbe);
    await close(activeProbe);
    const missingProbe = net.createServer();
    const missingPort = await listen(missingProbe);
    await close(missingProbe);
    const logsDir = makeTempDir('onb-supervisor-failure-');
    const script = `console.log('boot output retained'); require('net').createServer().listen(${activePort}, '127.0.0.1')`;

    await assert.rejects(
      supervise([{
        name: 'failing-service',
        cmd: process.execPath,
        args: ['-e', script],
        cwd: logsDir,
        env: process.env,
        readyPort: missingPort,
        timeoutMs: 300,
      }], { logsDir }),
      (error) => {
        assert.match(error.message, /Timed out waiting for failing-service/);
        assert.match(error.message, /Recent log output:[\s\S]*boot output retained/);
        return true;
      }
    );
    assert.strictEqual(await isPortOpen(activePort), false);
  });

  await test('supervise starts a service, waits for readiness, and stops it', async () => {
    const probe = net.createServer();
    const port = await listen(probe);
    await close(probe);
    const logsDir = makeTempDir('onb-supervisor-logs-');
    const script = `process.on('SIGTERM', () => {}); require('net').createServer().listen(${port}, '127.0.0.1')`;
    const result = await supervise([{
      name: 'smoke',
      cmd: process.execPath,
      args: ['-e', script],
      cwd: logsDir,
      env: process.env,
      readyPort: port,
      timeoutMs: 5000,
      critical: true,
    }], { logsDir });

    assert.strictEqual(result.children.length, 1);
    assert.strictEqual(result.ports.smoke, port);
    const child = result.children[0];
    const childClosed = new Promise((resolve) => child.once('close', resolve));
    await result.stop();
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    // Assert the outcome (the process is actually gone) rather than the
    // mechanism, since shutdown now terminates the whole process tree.
    assert.ok(child.signalCode !== null || child.exitCode !== null, 'service child should finish after stop');
    assert.strictEqual(isProcessAlive(child.pid), false, 'service child should be terminated after stop');
    assert.strictEqual(await isPortOpen(port), false);
  });

  await test('isProcessAlive reports live and exited processes accurately', async () => {
    const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.strictEqual(isProcessAlive(child.pid), true, 'running child should report alive');
      assert.strictEqual(isProcessAlive(0), false, 'invalid pid should report not alive');
      assert.strictEqual(isProcessAlive(2147483600), false);
    } finally {
      killProcessTree(child.pid, { force: true });
    }
    const exited = await new Promise((resolve) => child.once('exit', () => resolve(true)));
    assert.strictEqual(exited, true);
  });

  await test('stop() returns no survivors for a healthy shutdown', async () => {
    const logsDir = makeTempDir('onb-supervisor-survivor-');
    const result = await supervise([{
      name: 'daemon',
      cmd: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      cwd: logsDir,
      env: process.env,
      readyPort: null,
      critical: true,
      settleMs: 300,
    }], { logsDir });

    const outcome = await result.stop();
    assert.ok(Array.isArray(outcome.survivors), 'stop should report a survivors list');
    assert.deepStrictEqual(outcome.survivors, []);
    assert.strictEqual(isProcessAlive(result.children[0].pid), false, 'service tree should be gone');
  });

  await test('stop() is idempotent and safe to call concurrently', async () => {
    const logsDir = makeTempDir('onb-supervisor-idempotent-');
    const probe = net.createServer();
    const port = await listen(probe);
    await close(probe);
    const result = await supervise([{
      name: 'smoke-idem',
      cmd: process.execPath,
      args: ['-e', `require('net').createServer().listen(${port}, '127.0.0.1')`],
      cwd: logsDir,
      env: process.env,
      readyPort: port,
      timeoutMs: 5000,
      critical: true,
    }], { logsDir });

    const [first, second] = await Promise.all([result.stop(), result.stop()]);
    assert.deepStrictEqual(first.survivors, []);
    assert.deepStrictEqual(second.survivors, []);
    assert.strictEqual(await isPortOpen(port), false);
  });

  await test('supervise rejects when a critical portless service dies during startup', async () => {
    const logsDir = makeTempDir('onb-supervisor-worker-die-');
    await assert.rejects(
      supervise([{
        name: 'dies-immediately',
        cmd: process.execPath,
        args: ['-e', 'console.log("worker booted"); process.exit(0)'],
        cwd: logsDir,
        env: process.env,
        readyPort: null,
        critical: true,
        settleMs: 2000,
      }], { logsDir }),
      (error) => {
        assert.match(error.message, /dies-immediately exited with code 0/);
        assert.match(error.message, /Recent log output:[\s\S]*worker booted/);
        return true;
      }
    );
  });

  fixtures.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  console.log(`\n${passed} supervisor tests passed`);
}

main().catch((error) => {
  fixtures.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  console.error(error);
  process.exitCode = 1;
});
