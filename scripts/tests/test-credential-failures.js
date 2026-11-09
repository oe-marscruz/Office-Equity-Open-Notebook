'use strict';

// Fault-injection coverage for the credential store, written against the
// module-level API in `scripts/lib/credentials.js`. The module binds `fs`
// directly, so tests exercise real filesystem behaviours - exclusive creation,
// junction redirection and concurrent startup - instead of patched calls.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const credentials = require('../lib/credentials');

const RECOVERY = credentials.CREDENTIAL_ERROR_INVALID_SECRETS_FILE;
const root = path.resolve(__dirname, '../..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-credential-failures-'));

function dir(name) {
  const value = path.join(fixtureRoot, name);
  fs.mkdirSync(value);
  return value;
}
function seedDatabase(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'surrealdb/mydatabase.db'), { recursive: true });
}

async function main() {
  // Exclusive creation: a competing writer that wins the race must keep its
  // bytes, and the loser must report a recovery-style error instead of
  // overwriting the winner's secret.
  const race = dir('exclusive-write');
  const won = path.join(race, credentials.SECRETS_FILENAME);
  fs.writeFileSync(won, 'synthetic competing writer', { flag: 'wx' });
  assert.throws(
    () => credentials.writeSecretFile(won, 'loser bytes'),
    (error) => error instanceof credentials.CredentialError && error.code === RECOVERY
  );
  assert.equal(fs.readFileSync(won, 'utf8'), 'synthetic competing writer');

  // Protected-before-write: the module reserves a new file exclusively and
  // establishes the owner-only restriction before any secret byte is written,
  // re-reading the resulting ACL to prove it took effect. A reader therefore
  // refuses a file whose ACL lets other principals read it, and the bytes are
  // preserved so recovery stays possible.
  const widened = dir('widened-secrets');
  const widenedFile = path.join(widened, credentials.SECRETS_FILENAME);
  credentials.writeSecretFile(widenedFile, '{"surrealPassword":"obf:YWJj"}');
  if (process.platform === 'win32') {
    const { spawnSync } = require('node:child_process');
    const grant = spawnSync('icacls', [widenedFile, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8' });
    assert.equal(grant.status, 0, grant.stderr || 'could not widen the fixture ACL');
  } else {
    fs.chmodSync(widenedFile, 0o644);
  }
  assert.throws(
    () => credentials.readProtectedSecretFile(widenedFile),
    (error) => error instanceof credentials.CredentialError && error.code === credentials.CREDENTIAL_ERROR_PERMISSIONS_TOO_OPEN
  );
  assert.equal(fs.readFileSync(widenedFile, 'utf8'), '{"surrealPassword":"obf:YWJj"}');

  // A symlink or junction at a credential path must be rejected rather than
  // followed, so a planted redirect cannot capture a secret or feed a forged
  // one back.
  const linked = dir('linked-store');
  const outside = path.join(fixtureRoot, 'outside-secret');
  fs.writeFileSync(outside, 'preserved');
  // Directory junctions are available without Developer Mode on Windows.
  const externalDir = dir('external-dir');
  fs.symlinkSync(
    externalDir,
    path.join(linked, credentials.SECRETS_FILENAME),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  assert.throws(
    () => credentials.resolveDatabaseCredentials(linked),
    (error) => error instanceof credentials.CredentialError && error.code === RECOVERY
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preserved');

  // A corrupt secrets file is reported and preserved, never rewritten.
  const corrupted = dir('corrupt-initialized');
  seedDatabase(corrupted);
  const corruptFile = path.join(corrupted, credentials.SECRETS_FILENAME);
  credentials.writeSecretFile(corruptFile, '{"surrealPassword":"obf:%%%"}');
  assert.throws(
    () => credentials.resolveDatabaseCredentials(corrupted),
    (error) => error instanceof credentials.CredentialError
  );
  assert.equal(fs.readFileSync(corruptFile, 'utf8'), '{"surrealPassword":"obf:%%%"}');

  // The launcher must fail on credential errors before spawning any child
  // service. `scripts/start-services.js` is evaluated in a sandbox whose
  // `./lib/credentials` is the real module over a fixture data directory.
  const launcherDataDir = dir('launcher');
  seedDatabase(launcherDataDir);
  credentials.writeSecretFile(path.join(launcherDataDir, credentials.SECRETS_FILENAME), '{"surrealPassword":"obf:%%%"}');
  const runtime = dir('runtime');
  fs.mkdirSync(path.join(runtime, 'python'));
  fs.writeFileSync(path.join(runtime, 'python/python.exe'), 'synthetic executable; never launched');
  let spawns = 0;
  class ClosedSocket extends EventEmitter {
    setTimeout() {}
    destroy() {}
    connect() { setImmediate(() => this.emit('error', Error('fixture unavailable'))); }
  }
  const moduleValue = { exports: {} };
  const deps = {
    child_process: { execFileSync: () => { throw Error('Unexpected executable lookup'); } },
    './service-diagnostics': { spawnServiceProcess: () => { spawns++; throw Error('Unexpected spawn'); } },
    './lib/credentials': credentials,
    './lib/credential-migration': require('../lib/credential-migration'),
    net: { Socket: ClosedSocket },
    http: require('http'),
    path,
    fs,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/start-services.js'), 'utf8'), {
    module: moduleValue,
    exports: moduleValue.exports,
    require: (name) => {
      assert.ok(Object.hasOwn(deps, name), name);
      return deps[name];
    },
    process,
    console,
    setTimeout,
    setImmediate,
    __dirname: path.join(root, 'scripts'),
  });
  await assert.rejects(
    moduleValue.exports.startServices({
      runtimePath: runtime,
      dataDir: launcherDataDir,
      encryptionKey: 'synthetic-key',
      waitReady: false,
    }),
    (error) => error instanceof credentials.CredentialError
  );
  assert.equal(spawns, 0, 'Credential failure must precede any database/API/worker process.');

  // Two processes starting the same fresh install race over the secret files:
  // one creates them, the loser reports a recovery error, and any winner
  // digests agree with what is finally on disk.
  const concurrent = dir('concurrent');
  const script = [
    'const c=require(' + JSON.stringify(path.join(root, 'scripts/lib/credentials.js')) + ');',
    'const crypto=require("crypto");',
    'try {const p=c.resolveDatabaseCredentials(process.argv[1]).password;',
    'const k=c.ensureEncryptionKey(process.argv[1]);',
    'console.log(JSON.stringify({ok:true,digest:crypto.createHash("sha256").update(p+"|"+k).digest("hex")}));}',
    'catch(e){console.log(JSON.stringify({ok:false,code:e.code}));}',
  ].join('');
  function child() {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['-e', script, concurrent], { windowsHide: true });
      let output = '', errors = '';
      const timer = setTimeout(() => { proc.kill(); reject(Error('Concurrent fixture timeout')); }, 60000);
      proc.stdout.on('data', (data) => { output += data; });
      proc.stderr.on('data', (data) => { errors += data; });
      proc.on('error', (error) => { clearTimeout(timer); reject(error); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(Error(errors || 'Concurrent fixture failed'));
        else { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } }
      });
    });
  }
  const results = await Promise.all([child(), child()]);
  const successes = results.filter((result) => result.ok);
  assert.ok(successes.length >= 1);
  for (const result of results.filter((item) => !item.ok)) {
    assert.equal(result.code, RECOVERY);
  }
  const password = credentials.resolveDatabaseCredentials(concurrent).password;
  const key = credentials.ensureEncryptionKey(concurrent);
  const digest = crypto.createHash('sha256').update(password + '|' + key).digest('hex');
  for (const result of successes) assert.equal(result.digest, digest);

  console.log('Credential fault injection, protected-before-write, exclusive/racing startup, recovery preservation and no-child startup checks passed.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  const relative = path.relative(os.tmpdir(), fixtureRoot);
  assert.ok(relative.startsWith('oe-credential-failures-') && !relative.includes(path.sep));
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});