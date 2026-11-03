'use strict';

/**
 * start-services.js
 *
 * Spawns the four Open Notebook services (SurrealDB, FastAPI backend,
 * background worker, Next.js frontend) as child processes and exposes a
 * single `stop()` to tear them all down.
 *
 * This module is used both by the Electron main process (dev + packaged) and
 * by the standalone `scripts/run-services.js` CLI for headless verification.
 */

const { execFileSync } = require('child_process');
const { spawnServiceProcess } = require('./service-diagnostics');
const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORTS = {
  surreal: 8000,
  api: 5055,
  frontend: 8502,
};

/**
 * Resolve a bundled executable, falling back to a command on PATH.
 * Returns the absolute path or null if not found.
 */
function findOnPath(command) {
  try {
    const result = execFileSync('where', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = result.split('\n').find((line) => line.trim());
    return first ? first.trim() : null;
  } catch (_) {
    return null;
  }
}

function resolvePython(runtimePath) {
  const bundled = path.join(runtimePath, 'python', 'python.exe');
  if (fs.existsSync(bundled)) return { path: bundled, source: 'bundled' };

  const system = findOnPath('python.exe') || findOnPath('python');
  if (!system) return null;

  // The backend requires Python >=3.11 and <3.13.
  try {
    const out = execFileSync(system, ['--version'], { encoding: 'utf8' }).trim();
    const m = out.match(/Python (\d+)\.(\d+)/);
    if (!m) return null;
    const major = parseInt(m[1], 10);
    const minor = parseInt(m[2], 10);
    if (major !== 3 || minor < 11 || minor >= 13) {
      return { path: system, source: 'system', invalidVersion: `${major}.${minor}` };
    }
    return { path: system, source: 'system' };
  } catch (_) {
    return null;
  }
}

function resolveNode(runtimePath) {
  const bundled = path.join(runtimePath, 'node', 'node.exe');
  if (fs.existsSync(bundled)) return { path: bundled, source: 'bundled' };

  const system = findOnPath('node.exe') || findOnPath('node');
  if (!system) return null;

  try {
    const out = execFileSync(system, ['--version'], { encoding: 'utf8' }).trim();
    const m = out.match(/v(\d+)/);
    if (!m) return null;
    const major = parseInt(m[1], 10);
    if (major < 18) {
      return { path: system, source: 'system', invalidVersion: major };
    }
    return { path: system, source: 'system' };
  } catch (_) {
    return null;
  }
}

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const onDone = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => onDone(true));
    socket.once('timeout', () => onDone(false));
    socket.once('error', () => onDone(false));
    socket.connect(port, host);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPort(port, timeoutMs = 60000, label = String(port)) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(port)) return true;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label} on port ${port}`);
}

function isHttpReady(url, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServiceReady(port, url, timeoutMs = 60000, label = String(port)) {
  const start = Date.now();
  let portWasOpen = false;

  while (Date.now() - start < timeoutMs) {
    // Port open fallback until proven (check port first, then HTTP)
    if (!portWasOpen && await isPortOpen(port)) {
      portWasOpen = true;
    }

    if (portWasOpen) {
      if (await isHttpReady(url)) {
        return true;
      }
    }
    await sleep(500);
  }

  // If we time out but the port was open, we consider it a fallback success
  // per requirement: "keeping port-open fallback until proven"
  if (portWasOpen) {
    console.warn(`[WARNING] Service ${label} port ${port} is open but HTTP check at ${url} failed to become ready in time. Proceeding via port-open fallback.`);
    return true;
  }

  throw new Error(`Timed out waiting for ${label} on port ${port} and url ${url}`);
}

/**
 * Start all services.
 * @param {object} cfg
 * @param {string} cfg.runtimePath  Path to the assembled runtime folder.
 * @param {string} cfg.dataDir      Directory for user data (db, uploads, logs).
 * @param {string} cfg.encryptionKey OPEN_NOTEBOOK_ENCRYPTION_KEY value.
 * @param {boolean} cfg.waitReady   Wait for the frontend to be reachable.
 */
async function startServices(cfg) {
  const { runtimePath, dataDir, encryptionKey } = cfg;
  const backendPath = path.join(runtimePath, 'backend');
  const surrealExe = path.join(runtimePath, 'surreal', 'surreal.exe');
  const frontendDir = path.join(runtimePath, 'frontend');
  const tiktokenCache = path.join(runtimePath, 'tiktoken-cache');

  // Resolve Python: bundled runtime first, then system PATH.
  const python = resolvePython(runtimePath);
  if (!python) {
    throw new Error(
      'Python 3.11/3.12 was not found. Either install the bundled Python runtime, ' +
        'or ensure python.exe for Python 3.11 or 3.12 is on your PATH.'
    );
  }
  if (python.invalidVersion) {
    throw new Error(
      `Python ${python.invalidVersion} was found at ${python.path}, but the backend requires Python 3.11 or 3.12. ` +
        'Install the bundled Python runtime or a supported system Python.'
    );
  }

  const pythonExe = python.path;

  for (const p of [backendPath, dataDir]) {
    fs.mkdirSync(p, { recursive: true });
  }
  fs.mkdirSync(path.join(dataDir, 'surrealdb'), { recursive: true });
  const logsDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Check for port conflicts before starting anything.
  for (const [name, port] of Object.entries(PORTS)) {
    if (await isPortOpen(port)) {
      throw new Error(
        `Port ${port} is already in use (${name}). Another Open Notebook instance or another service is running. Close it and try again.`
      );
    }
  }

  // The backend resolves the database migrations and DATA_FOLDER relative to
  // its working directory. We run it from the backend dir so the migrations
  // resolve, and point DATA_FOLDER at the user-data directory so all user data
  // (uploads, sqlite, podcasts) lives outside the read-only app resources.
  const dataFolder = path.join(dataDir, 'data');
  fs.mkdirSync(dataFolder, { recursive: true });

  const backendEnv = {
    ...process.env,
    PYTHONPATH: backendPath,
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    DATA_FOLDER: dataFolder,
    SURREAL_URL: 'ws://127.0.0.1:8000/rpc',
    SURREAL_USER: 'root',
    SURREAL_PASSWORD: 'root',
    SURREAL_NAMESPACE: 'open_notebook',
    SURREAL_DATABASE: 'open_notebook',
    OPEN_NOTEBOOK_ENCRYPTION_KEY: encryptionKey,
    // Docling is pre-installed into the bundled runtime by prepare-runtime.js,
    // so it is always enabled in the desktop app.
    OPEN_NOTEBOOK_ENABLE_DOCLING: 'true',
    TIKTOKEN_CACHE_DIR: tiktokenCache,
    API_HOST: '127.0.0.1',
    API_PORT: String(PORTS.api),
  };

  const children = [];
  function spawnService(name, command, args, opts) {
    const child = spawnServiceProcess(name, command, args, {
      cwd: opts.cwd || dataDir,
      env: opts.env || backendEnv,
      logsDir,
    });
    children.push(child);
    return child;
  }

  // 1. SurrealDB
  const surrealDbFile = path.join(dataDir, 'surrealdb', 'mydatabase.db');
  spawnService(
    'surrealdb',
    surrealExe,
    ['start', '--log', 'info', '--user', 'root', '--pass', 'root', '--bind', `127.0.0.1:${PORTS.surreal}`, `rocksdb:${surrealDbFile}`],
    { cwd: dataDir, env: backendEnv }
  );
  await waitForServiceReady(PORTS.surreal, `http://127.0.0.1:${PORTS.surreal}/health`, 60000, 'SurrealDB');

  // 2. FastAPI backend
  spawnService(
    'api',
    pythonExe,
    ['-m', 'uvicorn', 'api.main:app', '--host', '127.0.0.1', '--port', String(PORTS.api)],
    { cwd: backendPath, env: backendEnv }
  );
  // Backend provides a root endpoint / and maybe /health
  await waitForServiceReady(PORTS.api, `http://127.0.0.1:${PORTS.api}/`, 120000, 'API');

  // 3. Background worker
  spawnService(
    'worker',
    pythonExe,
    ['-m', 'surreal_commands.cli.worker', '--import-modules', 'commands', '--max-tasks', '5'],
    { cwd: backendPath, env: backendEnv }
  );

  // 4. Native embedded frontend server (served on port 8502 by native host)
  if (cfg.waitReady !== false) {
    await waitForServiceReady(PORTS.frontend, `http://127.0.0.1:${PORTS.frontend}/`, 120000, 'Frontend');
  }

  return {
    children,
    ports: { ...PORTS },
    async stop() {
      // Kill in reverse order (frontend, worker, api, surreal)
      for (const child of [...children].reverse()) {
        try {
          if (!child.killed) child.kill();
        } catch (_) {
          /* ignore */
        }
      }
      // Give them a moment, then force-kill anything left.
      await sleep(1500);
      for (const child of children) {
        try {
          if (child.exitCode === null && !child.killed) {
            child.kill('SIGKILL');
          }
        } catch (_) {
          /* ignore */
        }
      }
    },
  };
}

module.exports = { startServices, PORTS, isPortOpen, waitForPort, waitForServiceReady, isHttpReady };
