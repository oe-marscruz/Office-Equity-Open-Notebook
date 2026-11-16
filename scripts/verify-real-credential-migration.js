'use strict';

// Opt-in integration check. All database files and credentials are disposable.
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { once } = require('events');
const credentials = require('./lib/credentials');
const migration = require('./lib/credential-migration');

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return port;
}

function healthy(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function waitForHealth(child, port) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Test database exited before readiness');
    if (await healthy(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Test database did not become ready');
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}

async function main() {
  const index = process.argv.indexOf('--surreal');
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error('Pass --surreal with the path to the SurrealDB executable');
  }
  const executable = path.resolve(process.argv[index + 1]);
  if (!fs.statSync(executable).isFile()) throw new Error('SurrealDB executable not found');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oeon-live-migration-'));
  const dataDir = path.join(root, 'data');
  const databaseDir = path.join(dataDir, 'surrealdb');
  fs.mkdirSync(databaseDir, { recursive: true });
  const databaseFile = path.join(databaseDir, 'mydatabase.db');
  const port = await freePort();
  let child;
  function start(password) {
    child = spawn(executable, ['start', '--log', 'none', '--bind', `127.0.0.1:${port}`, `rocksdb:${databaseFile}`], {
      env: { ...process.env, SURREAL_USER: 'root', SURREAL_PASS: password, SURREAL_PASSWORD: password },
      stdio: 'ignore',
      windowsHide: true,
    });
    return child;
  }

  try {
    start(migration.LEGACY_PROBE_PASSWORD);
    await waitForHealth(child, port);
    const datastore = migration.createSurrealHttpDatastore({ port });
    assert.equal(await datastore.probe(migration.LEGACY_PROBE_PASSWORD), migration.PROBE_AUTHENTICATED);
    assert.equal(credentials.resolveDatabaseCredentials(dataDir).migrationRequired, true);
    const result = await migration.prepareDatabaseCredentials(dataDir, datastore);
    assert.equal(result.source, credentials.CREDENTIAL_SOURCE_MIGRATED);
    assert.equal(await datastore.probe(result.password), migration.PROBE_AUTHENTICATED);
    assert.equal(await datastore.probe(migration.LEGACY_PROBE_PASSWORD), migration.PROBE_REJECTED);
    assert.equal(fs.existsSync(path.join(dataDir, migration.MIGRATION_PENDING_FILENAME)), false);

    await stop(child);
    start(result.password);
    await waitForHealth(child, port);
    const stored = credentials.resolveDatabaseCredentials(dataDir);
    assert.equal(stored.source, credentials.CREDENTIAL_SOURCE_STORED);
    assert.equal(await datastore.probe(stored.password), migration.PROBE_AUTHENTICATED);
    assert.equal(await datastore.probe(migration.LEGACY_PROBE_PASSWORD), migration.PROBE_REJECTED);
    console.log('PASS: legacy migration and restart against a disposable SurrealDB datastore');
  } finally {
    await stop(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('FAIL:', error.message);
  process.exitCode = 1;
});
