'use strict';

const path = require('path');
const { PORTS, SURREAL_URL } = require('./paths');

const STARTUP_TIMEOUTS = {
  surreal: 120000,
  api: 300000,
  frontend: 180000,
};

function buildBackendEnv({ dataDir, encryptionKey, tiktokenCache, backendPath, env = process.env, surrealUser = 'root', surrealPassword = 'root' }) {
  return {
    ...env,
    PYTHONPATH: backendPath,
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    DATA_FOLDER: path.join(dataDir, 'data'),
    SURREAL_URL,
    SURREAL_USER: surrealUser,
    SURREAL_PASSWORD: surrealPassword,
    SURREAL_NAMESPACE: 'open_notebook',
    SURREAL_DATABASE: 'open_notebook',
    OPEN_NOTEBOOK_ENCRYPTION_KEY: encryptionKey,
    OPEN_NOTEBOOK_ENABLE_DOCLING: 'true',
    TIKTOKEN_CACHE_DIR: tiktokenCache,
    API_HOST: '127.0.0.1',
    API_PORT: String(PORTS.api),
  };
}

function serviceTable({ runtimePath, dataDir, backendPath, pythonExe, nodeExe, encryptionKey, env = process.env, backendEnv, surrealUser = 'root', surrealPassword = 'root' }) {
  const resolvedBackendPath = backendPath || path.join(runtimePath, 'backend');
  const commonEnv = backendEnv || buildBackendEnv({
    dataDir,
    encryptionKey,
    tiktokenCache: path.join(runtimePath, 'tiktoken-cache'),
    backendPath: resolvedBackendPath,
    env,
    surrealUser,
    surrealPassword,
  });
  const frontendEnv = {
    ...env,
    NODE_ENV: 'production',
    PORT: String(PORTS.frontend),
    HOSTNAME: '127.0.0.1',
    INTERNAL_API_URL: `http://127.0.0.1:${PORTS.api}`,
  };
  const surrealDbFile = path.join(dataDir, 'surrealdb', 'mydatabase.db');

  return [
    {
      name: 'surrealdb',
      cmd: path.join(runtimePath, 'surreal', 'surreal.exe'),
      args: ['start', '--log', 'info', '--user', surrealUser, '--pass', surrealPassword, '--bind', `127.0.0.1:${PORTS.surreal}`, `rocksdb:${surrealDbFile}`],
      cwd: dataDir,
      env: commonEnv,
      readyPort: PORTS.surreal,
      portKey: 'surreal',
      label: 'SurrealDB',
      timeoutKey: 'surreal',
      timeoutMs: STARTUP_TIMEOUTS.surreal,
      critical: true,
    },
    {
      name: 'api',
      cmd: pythonExe,
      args: ['-m', 'uvicorn', 'api.main:app', '--host', '127.0.0.1', '--port', String(PORTS.api)],
      cwd: resolvedBackendPath,
      env: commonEnv,
      readyPort: PORTS.api,
      portKey: 'api',
      label: 'API',
      timeoutKey: 'api',
      timeoutMs: STARTUP_TIMEOUTS.api,
      critical: true,
    },
    {
      name: 'worker',
      cmd: pythonExe,
      // `--max-tasks` caps *concurrent* tasks; the worker listens for commands
      // indefinitely. It is therefore a long-lived daemon that should only
      // ever exit when we shut it down.
      args: ['-m', 'surreal_commands.cli.worker', '--import-modules', 'commands', '--max-tasks', '5'],
      cwd: resolvedBackendPath,
      env: commonEnv,
      readyPort: null,
      critical: true,
    },
    {
      name: 'frontend',
      cmd: nodeExe,
      args: ['server.js'],
      cwd: path.join(runtimePath, 'frontend'),
      env: frontendEnv,
      readyPort: PORTS.frontend,
      portKey: 'frontend',
      label: 'Frontend',
      timeoutKey: 'frontend',
      timeoutMs: STARTUP_TIMEOUTS.frontend,
      readiness: 'optional',
      critical: true,
    },
  ];
}

module.exports = { buildBackendEnv, serviceTable, STARTUP_TIMEOUTS };
