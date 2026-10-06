'use strict';

const fs = require('fs');
const path = require('path');
const { PORTS } = require('./lib/paths');
const { resolveRuntimes } = require('./lib/resolve-runtimes');
const { buildBackendEnv, serviceTable, STARTUP_TIMEOUTS } = require('./lib/service-table');
const { resolveDatabaseCredentials } = require('./lib/encryption-key');
const { supervise, isPortOpen, waitForPort, sleep } = require('./lib/supervisor');

// How long a service gets to bind its port after it reports ready.
const PORT_RELEASE_TIMEOUT_MS = 5000;

/**
 * Waits until a port stops accepting connections. Used after shutdown to catch
 * a service that died but left its socket bound, which is what makes the next
 * launch fail with "port already in use".
 */
async function waitForPortRelease(port, timeoutMs = PORT_RELEASE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return true;
    await sleep(150);
  }
  return !(await isPortOpen(port));
}

/**
 * Wraps the supervisor's stop so that a shutdown only reports success once the
 * services are gone *and* their ports are free. Survivors are surfaced instead
 * of being swallowed, so a failed shutdown is visible rather than silent.
 */
function withPortVerification(result) {
  const ports = result.ports || {};
  const names = new Map(Object.entries(ports).map(([key, port]) => [port, key]));
  return async function stop() {
    const outcome = (await result.stop()) || { survivors: [] };
    const survivors = [...(outcome.survivors || [])];
    for (const [port, name] of names) {
      if (!(await waitForPortRelease(port))) {
        console.error(`WARNING: ${name} port ${port} is still in use after shutdown.`);
        survivors.push({ name, port });
      }
    }
    if (survivors.length > 0) {
      console.error(
        `WARNING: ${survivors.length} service(s) did not shut down cleanly. ` +
        'The next launch may fail until they exit.'
      );
    }
    return { ...outcome, survivors };
  };
}

async function startServices(cfg) {
  const { runtimePath, dataDir, encryptionKey } = cfg;
  const backendPath = path.join(runtimePath, 'backend');
  const tiktokenCache = path.join(runtimePath, 'tiktoken-cache');
  const { python, node } = resolveRuntimes(runtimePath);

  for (const directory of [backendPath, dataDir, path.join(dataDir, 'surrealdb'), path.join(dataDir, 'logs')]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  for (const [name, port] of Object.entries(PORTS)) {
    if (await isPortOpen(port)) {
      throw new Error(
        `Port ${port} is already in use (${name}). Another Open Notebook instance or another service is running. Close it and try again.`
      );
    }
  }

  const dataFolder = path.join(dataDir, 'data');
  fs.mkdirSync(dataFolder, { recursive: true });
  const env = cfg.env || process.env;
  // A per-install password replaces the well-known root/root default, so the
  // notebook database is not readable by any other process on the machine.
  // Datastores created before this change keep their original credentials.
  const surrealUser = cfg.surrealUser || 'root';
  const surrealPassword = cfg.surrealPassword || resolveDatabaseCredentials(dataDir).password;
  const backendEnv = buildBackendEnv({
    dataDir,
    encryptionKey,
    tiktokenCache,
    backendPath,
    env,
    surrealUser,
    surrealPassword,
  });
  const table = serviceTable({
    runtimePath,
    dataDir,
    backendPath,
    pythonExe: python.path,
    nodeExe: node.path,
    env,
    backendEnv,
    surrealUser,
    surrealPassword,
  });
  const logsDir = path.join(dataDir, 'logs');

  const supervised = await supervise(table, {
    waitReady: cfg.waitReady !== false,
    timeouts: { ...STARTUP_TIMEOUTS, ...(cfg.timeouts || {}) },
    onCriticalExit: cfg.onCriticalExit,
    env,
    logsDir,
  });

  return { ...supervised, stop: withPortVerification(supervised) };
}

module.exports = { startServices, PORTS, STARTUP_TIMEOUTS, isPortOpen, waitForPort };
