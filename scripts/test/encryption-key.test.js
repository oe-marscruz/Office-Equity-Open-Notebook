'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ensureEncryptionKey,
  ensureDatabasePassword,
  resolveDatabaseCredentials,
  hasExistingDatastore,
  KEY_FILENAME,
  SECRETS_FILENAME,
} = require('../lib/encryption-key');

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

async function main() {
  await test('ensureEncryptionKey generates a 32-byte hex key on first use', async () => {
    const dataDir = makeTempDir('onb-key-');
    const key = ensureEncryptionKey(dataDir);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.strictEqual(fs.readFileSync(path.join(dataDir, KEY_FILENAME), 'utf8'), key);
  });

  await test('ensureEncryptionKey returns the same key on later calls', async () => {
    const dataDir = makeTempDir('onb-key-stable-');
    const first = ensureEncryptionKey(dataDir);
    const second = ensureEncryptionKey(dataDir);
    assert.strictEqual(first, second);
  });

  await test('ensureDatabasePassword replaces the root default with a stable random value', async () => {
    const dataDir = makeTempDir('onb-secrets-');
    const password = ensureDatabasePassword(dataDir);
    assert.notStrictEqual(password, 'root');
    assert.ok(password.length >= 24, 'generated password should be long');
    assert.strictEqual(ensureDatabasePassword(dataDir), password);
  });

  await test('two installs never share a database password', async () => {
    const first = ensureDatabasePassword(makeTempDir('onb-secrets-a-'));
    const second = ensureDatabasePassword(makeTempDir('onb-secrets-b-'));
    assert.notStrictEqual(first, second);
  });

  await test('a corrupt secrets file is rewritten instead of crashing startup', async () => {
    const dataDir = makeTempDir('onb-secrets-corrupt-');
    fs.writeFileSync(path.join(dataDir, SECRETS_FILENAME), 'not json');
    const password = ensureDatabasePassword(dataDir);
    assert.ok(password.length >= 24);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, SECRETS_FILENAME), 'utf8')).surrealPassword, password);
  });

  await test('an existing datastore keeps its original password so upgrades do not lose data', async () => {
    const dataDir = makeTempDir('onb-secrets-legacy-');
    fs.mkdirSync(path.join(dataDir, 'surrealdb'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'surrealdb', 'mydatabase.db'), 'legacy-credentials');
    const credentials = resolveDatabaseCredentials(dataDir);
    assert.strictEqual(credentials.password, 'root');
    assert.strictEqual(credentials.legacy, true);
    // No secrets file is minted, so the stored root credentials stay valid.
    assert.strictEqual(fs.existsSync(path.join(dataDir, SECRETS_FILENAME)), false);
  });

  await test('an empty placeholder datastore is not treated as an existing one', async () => {
    const dataDir = makeTempDir('onb-secrets-empty-');
    fs.mkdirSync(path.join(dataDir, 'surrealdb'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'surrealdb', 'mydatabase.db'), '');
    assert.strictEqual(hasExistingDatastore(dataDir), false);
    const credentials = resolveDatabaseCredentials(dataDir);
    assert.strictEqual(credentials.legacy, false);
    assert.notStrictEqual(credentials.password, 'root');
  });

  await test('a new install with no datastore gets a random password', async () => {
    const dataDir = makeTempDir('onb-secrets-fresh-');
    assert.strictEqual(hasExistingDatastore(dataDir), false);
    const credentials = resolveDatabaseCredentials(dataDir);
    assert.strictEqual(credentials.legacy, false);
    assert.notStrictEqual(credentials.password, 'root');
  });

  await test('once a secrets file exists it wins even if a datastore appears', async () => {
    const dataDir = makeTempDir('onb-secrets-sticky-');
    const generated = ensureDatabasePassword(dataDir);
    fs.mkdirSync(path.join(dataDir, 'surrealdb'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'surrealdb', 'mydatabase.db'), 'x');
    assert.strictEqual(resolveDatabaseCredentials(dataDir).password, generated);
  });

  if (process.platform === 'win32') {
    await test('secret files are restricted to the current user on Windows', async () => {
      const dataDir = makeTempDir('onb-secrets-acl-');
      fs.writeFileSync(path.join(dataDir, `${SECRETS_FILENAME}.plain`), 'x');
      const password = ensureDatabasePassword(dataDir);
      assert.ok(password.length >= 24);
      const file = path.join(dataDir, SECRETS_FILENAME);
      const output = require('child_process').execFileSync('icacls', [file], { encoding: 'utf8' });
      assert.ok(!/Everyone|Users:/.test(output), `unexpected broad ACL:\n${output}`);
    });
  }

  fixtures.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  console.log(`\n${passed} encryption key tests passed`);
}

main().catch((error) => {
  fixtures.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }));
  console.error(error);
  process.exitCode = 1;
});
