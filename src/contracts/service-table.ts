/**
 * Office of Equity Open Notebook — Service Table Contract & Utilities
 */

import {
  ServiceTable,
  ServiceDefinition,
  ServicePorts,
  BackendEnvironment,
} from '../types';

export const DEFAULT_PORTS: ServicePorts = Object.freeze({
  surreal: 8000,
  api: 5055,
  frontend: 8502,
});

export const SERVICE_TABLE: ServiceTable = Object.freeze({
  version: '1.0.0',
  defaultPorts: DEFAULT_PORTS,
  services: [
    {
      name: 'surrealdb',
      command: 'surreal',
      // The root credentials are *not* passed on the command line. SurrealDB
      // reads them from `SURREAL_USER` / `SURREAL_PASS`, so they never show
      // up in a process listing.
      args: ['start', '--log', 'info', '--bind', '127.0.0.1:8000'],
      readinessPolicy: {
        type: 'http' as const,
        port: DEFAULT_PORTS.surreal,
        httpUrl: `http://127.0.0.1:${DEFAULT_PORTS.surreal}/health`,
        timeoutMs: 60000,
        label: 'SurrealDB',
      },
    },
    {
      name: 'api',
      command: 'python',
      args: ['-m', 'uvicorn', 'api.main:app', '--host', '127.0.0.1', '--port', '5055'],
      readinessPolicy: {
        type: 'http' as const,
        port: DEFAULT_PORTS.api,
        httpUrl: `http://127.0.0.1:${DEFAULT_PORTS.api}/`,
        timeoutMs: 120000,
        label: 'API',
      },
    },
    {
      name: 'worker',
      command: 'python',
      args: ['-m', 'surreal_commands.cli.worker', '--import-modules', 'commands', '--max-tasks', '5'],
      readinessPolicy: {
        type: 'process' as const,
      },
    },
  ],
});

export function validateServiceDefinition(def: unknown): ServiceDefinition {
  if (typeof def !== 'object' || def === null) {
    throw new TypeError('ServiceDefinition must be an object');
  }
  const d = def as Record<string, unknown>;
  if (typeof d['name'] !== 'string' || d['name'].trim() === '') {
    throw new TypeError('ServiceDefinition.name must be a non-empty string');
  }
  if (typeof d['command'] !== 'string' || d['command'].trim() === '') {
    throw new TypeError('ServiceDefinition.command must be a non-empty string');
  }
  if (!Array.isArray(d['args']) || !d['args'].every((a) => typeof a === 'string')) {
    throw new TypeError('ServiceDefinition.args must be an array of strings');
  }
  return {
    name: d['name'],
    command: d['command'],
    args: d['args'] as string[],
    cwd: typeof d['cwd'] === 'string' ? d['cwd'] : undefined,
    env: typeof d['env'] === 'object' && d['env'] !== null ? (d['env'] as Record<string, string>) : undefined,
    readinessPolicy: typeof d['readinessPolicy'] === 'object' && d['readinessPolicy'] !== null
      ? (d['readinessPolicy'] as ServiceDefinition['readinessPolicy'])
      : undefined,
  };
}

export function validateServiceTable(table: unknown): ServiceTable {
  if (typeof table !== 'object' || table === null) {
    throw new TypeError('ServiceTable must be an object');
  }
  const t = table as Record<string, unknown>;
  if (typeof t['version'] !== 'string') {
    throw new TypeError('ServiceTable.version must be a string');
  }
  if (typeof t['defaultPorts'] !== 'object' || t['defaultPorts'] === null) {
    throw new TypeError('ServiceTable.defaultPorts must be an object');
  }
  if (!Array.isArray(t['services'])) {
    throw new TypeError('ServiceTable.services must be an array');
  }

  const validatedServices = t['services'].map((s) => validateServiceDefinition(s));

  return {
    version: t['version'],
    defaultPorts: t['defaultPorts'] as ServicePorts,
    services: validatedServices,
  };
}

export function createBackendEnvironment(params: {
  backendPath: string;
  dataFolder: string;
  encryptionKey: string;
  tiktokenCache: string;
  apiPort?: number | undefined;
  enableDocling?: boolean | string | undefined;
  existingEnv?: Record<string, string | undefined> | undefined;
  /**
   * The resolved SurrealDB credentials for this install.
   *
   * When omitted, the legacy fixed `root` password is used. That keeps the
   * contract helpers usable without touching the filesystem, but it is *not*
   * a secure default: every launcher resolves real credentials through
   * `scripts/lib/credentials.js` and passes them in here.
   */
  credentials?: { user: string; password: string } | undefined;
}): BackendEnvironment {
  const {
    backendPath,
    dataFolder,
    encryptionKey,
    tiktokenCache,
    apiPort = DEFAULT_PORTS.api,
    enableDocling = process.env['OPEN_NOTEBOOK_ENABLE_DOCLING'] ?? 'true',
    existingEnv = process.env,
    credentials,
  } = params;

  const surrealUser = credentials?.user ?? 'root';
  const surrealPassword = credentials?.password ?? 'root';

  const doclingValue =
    typeof enableDocling === 'boolean'
      ? (enableDocling ? 'true' : 'false')
      : String(enableDocling);

  return {
    ...existingEnv,
    PYTHONPATH: backendPath,
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    DATA_FOLDER: dataFolder,
    SURREAL_URL: 'ws://127.0.0.1:8000/rpc',
    SURREAL_USER: surrealUser,
    SURREAL_PASSWORD: surrealPassword,
    SURREAL_PASS: surrealPassword,
    SURREAL_NAMESPACE: 'open_notebook',
    SURREAL_DATABASE: 'open_notebook',
    OPEN_NOTEBOOK_ENCRYPTION_KEY: encryptionKey,
    OPEN_NOTEBOOK_ENABLE_DOCLING: doclingValue,
    TIKTOKEN_CACHE_DIR: tiktokenCache,
    API_HOST: '127.0.0.1',
    API_PORT: String(apiPort),
  };
}
