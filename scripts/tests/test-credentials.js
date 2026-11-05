'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const credentials = require('../lib/credentials');
const facade = require('../../dist/src/contracts/credentials');
const { SERVICE_TABLE, createBackendEnvironment } = require('../../dist/src/contracts/service-table');
const cases = require('../../tests/contracts/credentials-cases.json');

function withStore(label, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-credentials-' + label + '-'));
  try { fn(dir); } finally {
    const relative = path.relative(os.tmpdir(), dir);
    assert.ok(relative.startsWith('oe-credentials-') && !relative.includes(path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
function seedDatabase(dir) {
  const db = path.join(dir, credentials.DATABASE_DIRNAME, credentials.DATABASE_FILENAME);
  fs.mkdirSync(db, { recursive: true });
  fs.writeFileSync(path.join(db, 'CURRENT'), 'synthetic datastore');
}
function recovery(fn) { assert.throws(fn, { message: 'CREDENTIAL_RECOVERY_REQUIRED' }); }

assert.equal(credentials.OBFUSCATION_PREFIX, cases.obfuscationPrefix);
assert.equal(credentials.OBFUSCATION_SALT, cases.obfuscationSalt);
for (const vector of cases.derivationVectors) {
  assert.equal(credentials.deriveObfuscationKeyFrom(vector.username, vector.hostname).toString('hex'), vector.keyHex);
}
const bytes = credentials.xorObfuscate(cases.encodedSecretPlaintext,
  credentials.deriveObfuscationKeyFrom(cases.encodedSecretKeyUsername, cases.encodedSecretKeyHostname));
assert.equal(credentials.OBFUSCATION_PREFIX + bytes.toString('base64'), cases.encodedSecret);
assert.equal(credentials.stripUserDomain(cases.domainQualifiedUsername), cases.strippedUsername);
assert.equal(credentials.decodeSecret(cases.legacyPlaintextSecret), cases.legacyPlaintextSecret);

withStore('fresh', (dir) => {
  const first = credentials.resolveDatabaseCredentials(dir);
  const key = credentials.ensureEncryptionKey(dir);
  assert.equal(first.source, 'generated');
  assert.equal(first.legacy, false);
  assert.equal(first.password.length, 32);
  assert.notEqual(first.password, credentials.LEGACY_DATABASE_PASSWORD);
  assert.equal(key.length, 64);
  const raw = fs.readFileSync(path.join(dir, credentials.SECRETS_FILENAME), 'utf8');
  assert.ok(JSON.parse(raw).surrealPassword.startsWith('obf:'));
  assert.ok(!raw.includes(first.password));
  assert.ok(!fs.readFileSync(path.join(dir, credentials.KEY_FILENAME), 'utf8').includes(key));
  seedDatabase(dir);
  const second = credentials.resolveDatabaseCredentials(dir);
  assert.equal(second.source, 'stored');
  assert.equal(second.password, first.password);
  assert.equal(credentials.ensureEncryptionKey(dir), key);
  assert.equal(facade.resolveDatabaseCredentials(dir).password, first.password);
  assert.equal(facade.inspectDatabasePasswordStore(dir).aclRestricted, true);
  assert.equal(facade.inspectEncryptionKeyStore(dir).aclRestricted, true);
  assert.equal(facade.describeCredentialStore(dir).secretsFile, path.join(dir, credentials.SECRETS_FILENAME));
});

withStore('initialized-missing', (dir) => {
  seedDatabase(dir);
  recovery(() => credentials.resolveDatabaseCredentials(dir));
  recovery(() => credentials.ensureDatabasePassword(dir));
  recovery(() => credentials.ensureEncryptionKey(dir));
  assert.equal(fs.existsSync(path.join(dir, credentials.SECRETS_FILENAME)), false);
  assert.equal(fs.existsSync(path.join(dir, credentials.KEY_FILENAME)), false);
});

for (const shape of ['file', 'empty-directory']) withStore(shape, (dir) => {
  const db = path.join(dir, credentials.DATABASE_DIRNAME, credentials.DATABASE_FILENAME);
  fs.mkdirSync(path.dirname(db));
  if (shape === 'file') fs.writeFileSync(db, '');
  else fs.mkdirSync(db);
  assert.equal(credentials.hasExistingDatastore(dir), true);
  recovery(() => credentials.resolveDatabaseCredentials(dir));
});

withStore('explicit-legacy', (dir) => {
  fs.writeFileSync(path.join(dir, credentials.SECRETS_FILENAME), JSON.stringify({ surrealPassword: 'explicit-synthetic-password' }));
  fs.writeFileSync(path.join(dir, credentials.KEY_FILENAME), 'legacy-plaintext-key');
  seedDatabase(dir);
  assert.equal(credentials.resolveDatabaseCredentials(dir).password, 'explicit-synthetic-password');
  assert.equal(credentials.ensureEncryptionKey(dir), 'legacy-plaintext-key');
});

for (const corrupt of ['{not json', '{}', 'null', '[]', '{"surrealPassword":""}', '{"surrealPassword":"obf:%%%"}']) {
  withStore('corrupt', (dir) => {
    const file = path.join(dir, credentials.SECRETS_FILENAME);
    fs.writeFileSync(file, corrupt);
    seedDatabase(dir);
    recovery(() => credentials.resolveDatabaseCredentials(dir));
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  });
}
for (const corrupt of ['', 'obf:', 'obf:@@@', 'obf:YQ', 'obf:====']) {
  withStore('corrupt-key', (dir) => {
    const file = path.join(dir, credentials.KEY_FILENAME);
    fs.writeFileSync(file, corrupt);
    recovery(() => credentials.ensureEncryptionKey(dir));
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  });
}

const env = credentials.buildCredentialEnvironment({ user: 'root', password: 'synthetic-per-install' });
assert.equal(env.SURREAL_PASS, env.SURREAL_PASSWORD);
for (const invalid of [undefined, null, {}, { user: '', password: 'x' }, { user: 'root', password: '' }]) {
  assert.throws(() => credentials.buildCredentialEnvironment(invalid), /CREDENTIALS_INVALID/);
}
const params = { backendPath: '/fixture/backend', dataFolder: '/fixture/data', encryptionKey: 'fixture-key', tiktokenCache: '/fixture/cache' };
assert.throws(() => createBackendEnvironment(params), /CREDENTIALS_INVALID/);
const backend = createBackendEnvironment({ ...params, credentials: { user: 'root', password: 'explicit-synthetic' } });
assert.equal(backend.SURREAL_PASSWORD, 'explicit-synthetic');
assert.equal(backend.SURREAL_PASS, 'explicit-synthetic');
assert.ok(!SERVICE_TABLE.services.find((s) => s.name === 'surrealdb').args.some((a) => a === '--user' || a === '--pass'));

console.log('Credential formats, durable restart, initialized-store recovery, corrupt-file preservation and explicit environments passed.');
