'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const credentials = require('../lib/credentials');
const root = path.resolve(__dirname, '../..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-credential-failures-'));

function dir(name) { const value = path.join(fixtureRoot, name); fs.mkdirSync(value); return value; }
function ioWith(methods) { return Object.assign(Object.create(fs), methods); }
function unavailable(fn) { assert.throws(fn, { message: 'CREDENTIAL_STORE_UNAVAILABLE' }); }
function recovery(fn) { assert.throws(fn, { message: 'CREDENTIAL_RECOVERY_REQUIRED' }); }
function seedDatabase(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'surrealdb/mydatabase.db'), { recursive: true });
}
const protectedStore = (extra = {}) => credentials.createCredentialStore({ restrict: () => true, ...extra });

async function main() {
  for (const method of ['resolveDatabaseCredentials', 'ensureEncryptionKey']) {
    for (const mode of ['throw', 'short']) {
      const dataDir = dir('rng-' + method + '-' + mode);
      const store = protectedStore({ randomBytes: () => {
        if (mode === 'throw') throw Error('synthetic RNG internals');
        return Buffer.alloc(1);
      } });
      assert.throws(() => store[method](dataDir), { message: 'CREDENTIAL_RANDOMNESS_UNAVAILABLE' });
      assert.deepEqual(fs.readdirSync(dataDir), []);
    }
    for (const operation of ['openSync', 'writeFileSync', 'fsyncSync', 'mkdirSync']) {
      const dataDir = dir('io-' + method + '-' + operation);
      const store = protectedStore({ fs: ioWith({ [operation]: () => { throw Error('synthetic I/O internals'); } }) });
      unavailable(() => store[method](dataDir));
      // No credentials were returned. A failed new-file reservation is retained for recovery.
    }
    const dataDir = dir('acl-' + method);
    let sawEmptyFile = false;
    const store = credentials.createCredentialStore({ restrict: (file) => {
      sawEmptyFile = fs.statSync(file).size === 0; return false;
    } });
    unavailable(() => store[method](dataDir));
    assert.equal(sawEmptyFile, true, 'ACL must be established before writing secrets.');
    for (const file of fs.readdirSync(dataDir)) assert.equal(fs.statSync(path.join(dataDir, file)).size, 0);
  }

  const saved = dir('saved');
  const stableStore = protectedStore();
  const stablePassword = stableStore.resolveDatabaseCredentials(saved).password;
  const savedBytes = fs.readFileSync(path.join(saved, credentials.SECRETS_FILENAME));
  const noRead = protectedStore({ fs: ioWith({ readFileSync: () => { throw Error('denied read'); } }) });
  unavailable(() => noRead.resolveDatabaseCredentials(saved));
  unavailable(() => credentials.createCredentialStore({ restrict: () => false }).resolveDatabaseCredentials(saved));
  assert.deepEqual(fs.readFileSync(path.join(saved, credentials.SECRETS_FILENAME)), savedBytes);
  assert.equal(stableStore.resolveDatabaseCredentials(saved).password, stablePassword);

  const inaccessible = dir('inaccessible-datastore');
  const inaccessibleStore = protectedStore({ fs: ioWith({ lstatSync: (file) => {
    if (file.endsWith('mydatabase.db')) { const error = Error('denied'); error.code = 'EACCES'; throw error; }
    return fs.lstatSync(file);
  } }) });
  unavailable(() => inaccessibleStore.resolveDatabaseCredentials(inaccessible));
  assert.deepEqual(fs.readdirSync(inaccessible), []);

  const corrupted = dir('corrupt-initialized');
  seedDatabase(corrupted);
  const corruptFile = path.join(corrupted, credentials.SECRETS_FILENAME);
  fs.writeFileSync(corruptFile, '{"surrealPassword":"obf:%%%"}');
  recovery(() => stableStore.resolveDatabaseCredentials(corrupted));
  assert.equal(fs.readFileSync(corruptFile, 'utf8'), '{"surrealPassword":"obf:%%%"}');

  const race = dir('exclusive-write');
  const won = path.join(race, credentials.SECRETS_FILENAME);
  const racingStore = protectedStore({ fs: ioWith({ openSync: (file, flags, mode) => {
    fs.writeFileSync(file, 'synthetic competing writer', { flag: 'wx' });
    return fs.openSync(file, flags, mode);
  } }) });
  recovery(() => racingStore.resolveDatabaseCredentials(race));
  assert.equal(fs.readFileSync(won, 'utf8'), 'synthetic competing writer');

  const linked = dir('linked-store');
  const outside = path.join(fixtureRoot, 'outside-secret');
  fs.writeFileSync(outside, 'preserved');
  // Directory junctions are available without Developer Mode on Windows.
  const externalDir = dir('external-dir');
  fs.symlinkSync(externalDir, path.join(linked, credentials.SECRETS_FILENAME), process.platform === 'win32' ? 'junction' : 'dir');
  recovery(() => stableStore.resolveDatabaseCredentials(linked));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preserved');

  const dataDir = dir('launcher');
  seedDatabase(dataDir);
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
    './lib/credentials': { ...credentials, ...stableStore },
    net: { Socket: ClosedSocket }, http: require('http'), path, fs,
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/start-services.js'), 'utf8'), {
    module: moduleValue, exports: moduleValue.exports, require: (name) => {
      assert.ok(Object.hasOwn(deps, name), name); return deps[name];
    }, process, console, setTimeout, setImmediate, __dirname: path.join(root, 'scripts'),
  });
  await assert.rejects(moduleValue.exports.startServices({
    runtimePath: runtime, dataDir, encryptionKey: 'synthetic-key', waitReady: false,
  }), /CREDENTIAL_RECOVERY_REQUIRED/);
  assert.equal(spawns, 0, 'Credential failure must precede any database/API/worker process.');

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
  for (const result of results.filter((item) => !item.ok)) assert.equal(result.code, 'CREDENTIAL_RECOVERY_REQUIRED');
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
