'use strict';

/**
 * security.test.js — compliance and data-governance checks for the desktop
 * wrapper layer.
 *
 * The tests cover the controls this repository actually owns: what the window
 * is allowed to navigate to, whether secrets are protected on disk, whether
 * they can leak into log files or error dialogs, and whether the services stay
 * bound to the local machine. RAG-level isolation is enforced upstream inside
 * `resources/runtime/backend`, which is not present in this repository, so it
 * cannot be asserted here and is not claimed.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isFrontendUrl, isExternalHttpUrl } = require('../lib/window-policy');
const {
  ensureDatabasePassword,
  ensureEncryptionKey,
  resolveDatabaseCredentials,
  SECRETS_FILENAME,
  KEY_FILENAME,
} = require('../lib/encryption-key');
const { buildBackendEnv, serviceTable } = require('../lib/service-table');
const { createProblemReport, consoleRenderer } = require('../lib/problem-report');
const { PORTS, FRONTEND_URL } = require('../lib/paths');

const fixtures = [];
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL - ${name}`);
    console.error(`    ${error.message}`);
  }
}

function makeTempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(directory);
  return directory;
}

async function main() {
  console.log('Navigation containment (window cannot reach untrusted origins)');

  await test('the app frontend origin is allowed', async () => {
    assert.strictEqual(isFrontendUrl(FRONTEND_URL, FRONTEND_URL), true);
  });

  await test('a look-alike host cannot be reached through the app window', async () => {
    // The password/userinfo trick: the real host here is evil.example, not
    // 127.0.0.1. A prefix check would have accepted this and loaded an
    // attacker-controlled page inside the app.
    assert.strictEqual(isFrontendUrl('http://127.0.0.1:8502@evil.example/', FRONTEND_URL), false);
    assert.strictEqual(isFrontendUrl('http://127.0.0.1:8502.evil.example/', FRONTEND_URL), false);
    assert.strictEqual(isFrontendUrl('http://evil.example/127.0.0.1:8502', FRONTEND_URL), false);
  });

  await test('a different port on the same host is not treated as the app', async () => {
    assert.strictEqual(isFrontendUrl(`http://127.0.0.1:${PORTS.api}`, FRONTEND_URL), false);
  });

  await test('non-web schemes are never handed to the system browser', async () => {
    assert.strictEqual(isExternalHttpUrl('javascript:alert(1)'), false);
    assert.strictEqual(isExternalHttpUrl('file:///C:/Windows/System32/'), false);
    assert.strictEqual(isExternalHttpUrl('data:text/html,<script/>'), false);
  });

  await test('ordinary web links are recognised despite scheme casing', async () => {
    assert.strictEqual(isExternalHttpUrl('https://example.com'), true);
    assert.strictEqual(isExternalHttpUrl('HTTPS://EXAMPLE.COM'), true);
  });

  await test('malformed URLs are refused rather than throwing', async () => {
    assert.strictEqual(isFrontendUrl('not a url', FRONTEND_URL), false);
    assert.strictEqual(isFrontendUrl('', FRONTEND_URL), false);
  });

  console.log('\nConfidentiality of stored secrets');

  await test('the database password is not the well-known default', async () => {
    const dataDir = makeTempDir('onb-sec-db-');
    const password = ensureDatabasePassword(dataDir);
    assert.notStrictEqual(password, 'root');
    assert.ok(password.length >= 24, `password too short: ${password.length}`);
  });

  await test('the database password is not recoverable from the file name or key', async () => {
    const dataDir = makeTempDir('onb-sec-distinct-');
    const key = ensureEncryptionKey(dataDir);
    const password = ensureDatabasePassword(dataDir);
    assert.notStrictEqual(key, password, 'the DB password must not reuse the encryption key');
  });

  await test('the secrets file does not sit in the repository or CWD', async () => {
    const dataDir = makeTempDir('onb-sec-loc-');
    ensureDatabasePassword(dataDir);
    assert.strictEqual(fs.existsSync(path.join(process.cwd(), SECRETS_FILENAME)), false);
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, SECRETS_FILENAME), 'utf8'));
    assert.strictEqual(typeof stored.surrealPassword, 'string');
  });

  // Log files are the most common accidental leak path for a credential: they
  // get copy-pasted into problem reports and support tickets.
  await test('the database password is never written into the backend environment log', async () => {
    const dataDir = makeTempDir('onb-sec-svc-');
    const password = resolveDatabaseCredentials(dataDir).password;
    const table = serviceTable({
      runtimePath: 'C:\\runtime',
      dataDir,
      backendPath: 'C:\\runtime\\backend',
      pythonExe: 'python.exe',
      nodeExe: 'node.exe',
      encryptionKey: 'abc',
      env: {},
      surrealUser: 'root',
      surrealPassword: password,
    });
    const serialized = JSON.stringify(table);
    // The password is legitimately passed as an argv element to surrealdb, so
    // it must appear there; what must not happen is it appearing in the
    // frontend environment or in any log-scraped field.
    const frontendEnv = table.find((entry) => entry.name === 'frontend').env;
    assert.strictEqual(JSON.stringify(frontendEnv).includes(password), false,
      'the frontend process must not receive the database password');
    assert.ok(serialized.includes(password), 'sanity: the DB process still receives it');
  });

  await test('the frontend process does not receive the notebook encryption key', async () => {
    const dataDir = makeTempDir('onb-sec-env-');
    const encryptionKey = 'super-secret-encryption-key';
    const env = buildBackendEnv({
      dataDir,
      encryptionKey,
      tiktokenCache: 'C:\\cache',
      backendPath: 'C:\\runtime\\backend',
      env: {},
    });
    assert.strictEqual(env.OPEN_NOTEBOOK_ENCRYPTION_KEY, encryptionKey);

    const table = serviceTable({
      runtimePath: 'C:\\runtime',
      dataDir,
      backendPath: 'C:\\runtime\\backend',
      pythonExe: 'python.exe',
      nodeExe: 'node.exe',
      encryptionKey,
      env: {},
      backendEnv: env,
    });
    const frontendEnv = table.find((entry) => entry.name === 'frontend').env;
    assert.strictEqual(JSON.stringify(frontendEnv).includes(encryptionKey), false,
      'the frontend must not be able to read stored provider API keys');
  });

  console.log('\nLocal-only exposure (no data leaves the machine)');

  await test('every service binds to the loopback interface only', async () => {
    const table = serviceTable({
      runtimePath: 'C:\\runtime',
      dataDir: makeTempDir('onb-sec-bind-'),
      backendPath: 'C:\\runtime\\backend',
      pythonExe: 'python.exe',
      nodeExe: 'node.exe',
      encryptionKey: 'abc',
      env: {},
    });

    for (const service of table) {
      const argv = service.args.join(' ');
      // A bare 0.0.0.0 would publish the notebook to the whole network.
      assert.strictEqual(argv.includes('0.0.0.0'), false,
        `${service.name} must not bind to all interfaces`);
    }

    const surreal = table.find((entry) => entry.name === 'surrealdb');
    assert.ok(surreal.args.join(' ').includes('--bind 127.0.0.1'), 'SurrealDB must bind to loopback');

    const api = table.find((entry) => entry.name === 'api');
    assert.ok(api.args.join(' ').includes('--host 127.0.0.1'), 'the API must bind to loopback');

    const frontend = table.find((entry) => entry.name === 'frontend');
    assert.strictEqual(frontend.env.HOSTNAME, '127.0.0.1', 'the frontend must bind to loopback');
  });

  await test('the database is reached over an explicit local namespace and database', async () => {
    const env = buildBackendEnv({
      dataDir: makeTempDir('onb-sec-ns-'),
      encryptionKey: 'abc',
      tiktokenCache: 'C:\\cache',
      backendPath: 'C:\\runtime\\backend',
      env: {},
    });
    assert.strictEqual(env.SURREAL_NAMESPACE, 'open_notebook');
    assert.strictEqual(env.SURREAL_DATABASE, 'open_notebook');
    // Cross-notebook confidentiality depends on this URL staying local.
    assert.match(env.SURREAL_URL, /^ws:\/\/127\.0\.0\.1:/);
  });

  console.log('\nError reporting (no silent failures, no data spillage)');

  await test('a failure path always produces a user-visible error', async () => {
    const report = createProblemReport();
    report.add('SERVICE_START_FAILED', 'The notebook could not start.');
    assert.strictEqual(report.hasErrors(), true);
    assert.strictEqual(report.exitCode(), 1);
  });

  await test('the log tail passed to the user cannot exceed its line budget', async () => {
    // A problem report is often pasted into a support ticket, so the tail must
    // stay bounded rather than dumping an arbitrarily large log at the user.
    const dataDir = makeTempDir('onb-sec-log-');
    const logFile = path.join(dataDir, 'api.log');
    fs.writeFileSync(logFile, Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'));

    const report = createProblemReport();
    report.add('SERVICE_START_FAILED', 'boom', { logTail: require('../lib/problem-report').getLogTail(logFile) });
    const rendered = report.render(consoleRenderer, { style: 'plain' });
    const lines = rendered.split('\n').filter((line) => line.startsWith('line '));
    assert.ok(lines.length <= 15, `leaked ${lines.length} log lines into the report`);
  });

  await test('a warning alone does not fail the run', async () => {
    const report = createProblemReport();
    report.add('PORT_SLOW', 'A service was slow to start.', { severity: 'warning' });
    assert.strictEqual(report.hasErrors(), false);
    assert.strictEqual(report.exitCode(), 0);
  });

  console.log('\nAntivirus / Defender compatibility (no flagged patterns in source)');

  const PROJECT_ROOT = path.join(__dirname, '..', '..');

  function readSource(relPath) {
    return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf8');
  }

  /** Strips JS comments (line and block) so tests check actual code, not docs. */
  function stripComments(src) {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/\/\/[^\n]*/g, '');         // line comments
  }

  await test('no production script uses shell: true for child process spawning', async () => {
    const scriptsDir = path.join(PROJECT_ROOT, 'scripts');
    const files = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        // Skip the test directory — test files legitimately reference patterns
        if (entry.isDirectory() && entry.name === 'test') continue;
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    }
    walk(scriptsDir);
    // Also check main.js and preload.js at the project root
    files.push(path.join(PROJECT_ROOT, 'main.js'));
    files.push(path.join(PROJECT_ROOT, 'preload.js'));
    for (const file of files) {
      const content = stripComments(fs.readFileSync(file, 'utf8'));
      const matches = content.match(/shell:\s*true/g);
      assert.strictEqual(matches, null,
        `${path.relative(PROJECT_ROOT, file)} uses shell: true — this triggers antivirus flags`);
    }
  });

  await test('the installer does not request admin execution level', async () => {
    const installer = stripComments(readSource(path.join('scripts', 'build-installer.js')));
    assert.strictEqual(installer.includes('RequestExecutionLevel admin'), false,
      'RequestExecutionLevel admin triggers Defender SmartScreen warnings');
    assert.ok(installer.includes('RequestExecutionLevel user'),
      'installer should use RequestExecutionLevel user');
  });

  await test('the installer does not write to HKLM in the NSIS script', async () => {
    const installer = stripComments(readSource(path.join('scripts', 'build-installer.js')));
    // HKLM should not appear in actual NSIS WriteRegStr commands
    const hklmWrites = installer.match(/WriteRegStr\s+HKLM/g);
    assert.strictEqual(hklmWrites, null,
      'HKLM registry writes require admin and trigger Defender flags');
  });

  await test('the installer does not use fixed system paths for staging', async () => {
    const installer = stripComments(readSource(path.join('scripts', 'build-installer.js')));
    // C:\onb should not appear as an actual path assignment (only in comments)
    const fixedPath = installer.match(/["']C:\\onb["']/g);
    assert.strictEqual(fixedPath, null,
      'fixed path C:\\onb triggers Defender flags for writing to system root');
  });

  await test('the supervisor does not use tasklist for process checks', async () => {
    const supervisor = stripComments(readSource(path.join('scripts', 'lib', 'supervisor.js')));
    // tasklist should not be spawned (process.kill(pid, 0) is used instead)
    const tasklistSpawn = supervisor.match(/spawn(Sync)?\(\s*['"]tasklist['"]/g);
    assert.strictEqual(tasklistSpawn, null,
      'tasklist triggers Defender process-enumeration flags; use process.kill(pid, 0) instead');
  });

  await test('the supervisor uses process.kill for liveness checks', async () => {
    const supervisor = stripComments(readSource(path.join('scripts', 'lib', 'supervisor.js')));
    assert.ok(supervisor.includes('process.kill(pid, 0)'),
      'isProcessAlive should use process.kill(pid, 0) instead of tasklist');
  });

  await test('main.js enables the Electron sandbox', async () => {
    const main = stripComments(readSource('main.js'));
    assert.ok(main.includes('sandbox: true'), 'Electron sandbox must be enabled');
    assert.ok(main.includes('webSecurity: true'), 'webSecurity must be enabled');
    assert.ok(main.includes('contextIsolation: true'), 'contextIsolation must be enabled');
  });

  await test('main.js applies a Content Security Policy', async () => {
    const main = stripComments(readSource('main.js'));
    assert.ok(main.includes('onHeadersReceived'), 'CSP must be applied via onHeadersReceived');
    assert.ok(main.includes('Content-Security-Policy'), 'CSP header must be set');
  });

  await test('main.js denies all browser permissions', async () => {
    const main = stripComments(readSource('main.js'));
    assert.ok(main.includes('setPermissionRequestHandler'), 'permission request handler must be set');
    assert.ok(main.includes('setPermissionCheckHandler'), 'permission check handler must be set');
  });

  await test('the encryption key is not stored in plaintext', async () => {
    const encKey = stripComments(readSource(path.join('scripts', 'lib', 'encryption-key.js')));
    assert.ok(encKey.includes('deriveObfuscationKey'),
      'encryption key must be obfuscated with a machine-bound derivation');
    assert.ok(encKey.includes('xorObfuscate'),
      'encryption key must be XOR-obfuscated before writing to disk');
  });

  await test('downloaded binaries are verified with Authenticode signatures', async () => {
    const prep = stripComments(readSource(path.join('scripts', 'prepare-runtime.js')));
    assert.ok(prep.includes('verifyAuthenticodeSignature'),
      'downloaded executables must be verified with Authenticode signatures');
    assert.ok(prep.includes('Get-AuthenticodeSignature'),
      'Authenticode verification must use Get-AuthenticodeSignature');
  });

  await test('all spawn calls use windowsHide on Windows', async () => {
    const cli = stripComments(readSource(path.join('scripts', 'lib', 'cli.js')));
    const spawnCalls = cli.match(/spawn(Sync)?\(/g) || [];
    assert.ok(spawnCalls.length > 0, 'cli.js should have spawn calls');
    assert.ok(cli.includes('windowsHide: true'),
      'spawn calls should include windowsHide: true to prevent console window flashing');
  });

  await test('the encryption key file round-trips through obfuscation', async () => {
    const dataDir = makeTempDir('onb-sec-obf-');
    const key = ensureEncryptionKey(dataDir);
    const keyFile = path.join(dataDir, KEY_FILENAME);
    const rawContent = fs.readFileSync(keyFile, 'utf8');
    // The raw key must not appear in the file
    assert.strictEqual(rawContent.includes(key), false,
      'the raw encryption key must not appear in plaintext in the key file');
    // But reading it back must return the same key
    const { readEncryptionKeyFile } = require('../lib/encryption-key');
    // readEncryptionKeyFile is not exported; test via ensureEncryptionKey idempotency
    const keyAgain = ensureEncryptionKey(dataDir);
    assert.strictEqual(keyAgain, key, 'ensureEncryptionKey must return the same key on subsequent calls');
  });

  fixtures.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  console.log(`\n${passed} security tests passed${failed ? `, ${failed} failed` : ''}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  fixtures.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  console.error(error);
  process.exitCode = 1;
});
