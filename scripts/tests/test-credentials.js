'use strict';

/**
 * test-credentials.js — contract tests for the shared credential store.
 *
 * The canonical implementation is `scripts/lib/credentials.js`. The Rust,
 * Go and C# hosts implement the identical on-disk format natively; the
 * shared fixture in `tests/contracts/credentials-cases.json` pins the
 * behaviour that all five hosts have to agree on byte-for-byte.
 *
 * These tests cover the parts that the launcher actually depends on:
 *
 *   1. The shared derivation and obfuscation vectors.
 *   2. A fresh install getting a random password.
 *   3. A legacy install being reported as unmigrated instead of falling back
 *      to the old fixed `root` password.
 *   4. A damaged secrets file being preserved and reported, never rewritten.
 *   5. Every state and ACL sample in the shared fixture.
 *   6. The secrets never being readable as plaintext on disk.
 *   7. The credentials reaching the child processes through the environment
 *      instead of the command line.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_PATH = path.join(ROOT, 'tests', 'contracts', 'credentials-cases.json');
const COMPILED_SERVICE_TABLE = path.join(ROOT, 'dist', 'src', 'contracts', 'service-table.js');
const COMPILED_CREDENTIALS = path.join(ROOT, 'dist', 'src', 'contracts', 'credentials.js');

const credentials = require(path.join(ROOT, 'scripts', 'lib', 'credentials.js'));

let failures = 0;

/**
 * Runs a named check and records a failure instead of aborting the run, so a
 * single broken expectation does not hide the rest of the report.
 */
function check(name, fn) {
  try {
    fn();
    console.log(`  -> ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  !! ${name}: ${error.message}`);
  }
}

function fixture() {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(`Fixture file missing: ${FIXTURE_PATH}`);
  }
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
}

/** Creates an isolated temporary directory for a single case. */
function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `oe-credentials-${label}-`));
}

/** Removes a temporary directory, ignoring failures. */
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // Best effort.
  }
}

/**
 * Creates a datastore that looks like one written by an older build.
 *
 * RocksDB keeps its datastore in a directory, so a file inside it is what
 * makes the directory non-empty.
 */
function seedLegacyDatastore(dir) {
  const db = path.join(dir, credentials.DATABASE_DIRNAME, credentials.DATABASE_FILENAME);
  fs.mkdirSync(db, { recursive: true });
  fs.writeFileSync(path.join(db, 'CURRENT'), 'x');
  return db;
}

/**
 * Widens a file's permissions so the "open" ACL case is reachable.
 *
 * The point is to prove the reader refuses such a file, so this deliberately
 * uses the platform's own tooling rather than the module under test. On
 * Windows the grant goes to Everyone by SID, because granting the current user
 * again would merge into the existing ACE and leave the file restricted.
 */
function widenPermissions(file) {
  if (process.platform === 'win32') {
    const result = spawnSync('icacls', [file, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`Could not widen permissions for the ACL case: ${result.stdout}${result.stderr}`);
    }
    return;
  }
  fs.chmodSync(file, 0o644);
}

/**
 * Writes a secrets file the way a shipped build would, so the ACL is already
 * restricted and the ACL cases stay independent of the parsing cases.
 *
 * @param {string} dir
 * @param {string | null} encodedPassword
 * @param {string} [rawContents] Used for the states that need exact bytes.
 */
function writeSecretsFile(dir, encodedPassword, rawContents) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, credentials.SECRETS_FILENAME);
  const contents =
    rawContents !== undefined
      ? rawContents
      : `${JSON.stringify({ surrealPassword: encodedPassword }, null, 2)}\n`;
  fs.writeFileSync(file, contents, { mode: 0o600 });
  credentials.restrictToCurrentUser(file);
  return file;
}

function run() {
  console.log('Testing Credential Store Contracts...');

  const cases = fixture();

  console.log('Test 1: Shared constants');
  check('obfuscation prefix matches the fixture', () => {
    assert.equal(credentials.OBFUSCATION_PREFIX, cases.obfuscationPrefix);
  });
  check('obfuscation salt matches the fixture', () => {
    assert.equal(credentials.OBFUSCATION_SALT, cases.obfuscationSalt);
  });
  check('legacy password is the documented fixed value', () => {
    assert.equal(credentials.LEGACY_DATABASE_PASSWORD, 'root');
  });
  check('database user is the documented fixed value', () => {
    assert.equal(credentials.DATABASE_USER, 'root');
  });
  console.log('  -> Passed');

  console.log('Test 2: Key derivation matches the shared vectors');
  for (const vector of cases.derivationVectors) {
    check(`derivation for "${vector.username}@${vector.hostname}"`, () => {
      const key = credentials.deriveObfuscationKeyFrom(vector.username, vector.hostname);
      assert.equal(key.toString('hex'), vector.keyHex);
    });
  }
  console.log('  -> Passed');

  console.log('Test 3: Obfuscation matches the shared vector');
  check('encoded secret matches the fixture', () => {
    const key = credentials.deriveObfuscationKeyFrom(
      cases.encodedSecretKeyUsername,
      cases.encodedSecretKeyHostname
    );
    const encoded =
      credentials.OBFUSCATION_PREFIX +
      credentials.xorObfuscate(cases.encodedSecretPlaintext, key).toString('base64');
    assert.equal(encoded, cases.encodedSecret);
  });
  check('the obfuscated secret round-trips', () => {
      const secret = 'round-trip-secret';
      assert.equal(credentials.decodeSecret(credentials.encodeSecret(secret)), secret);
    });
  check('legacy plaintext secrets are returned unchanged', () => {
    assert.equal(credentials.decodeSecret(cases.legacyPlaintextSecret), cases.legacyPlaintextSecret);
  });
  check('the XOR transform is symmetric', () => {
    const key = credentials.deriveObfuscationKeyFrom('testuser', 'testhost');
    const once = credentials.xorObfuscate('the quick brown fox', key);
    assert.notEqual(once.toString('utf8'), 'the quick brown fox');
    assert.equal(credentials.xorObfuscate(once, key).toString('utf8'), 'the quick brown fox');
  });
  console.log('  -> Passed');

  console.log('Test 4: Account name normalisation');
  check('the domain qualifier is stripped', () => {
    assert.equal(credentials.stripUserDomain(cases.domainQualifiedUsername), cases.strippedUsername);
  });
  check('a POSIX domain qualifier is stripped', () => {
    assert.equal(credentials.stripUserDomain('DOMAIN/user'), 'user');
  });
  check('a plain account name is untouched', () => {
    assert.equal(credentials.stripUserDomain('plain'), 'plain');
  });
  check('a blank account name is empty', () => {
    assert.equal(credentials.stripUserDomain('   '), '');
  });
  console.log('  -> Passed');

  console.log('Test 5: A fresh install gets a random password');
  {
    const dir = tempDir('fresh');
    try {
      const resolved = credentials.resolveDatabaseCredentials(dir);
      check('the user is the fixed root account', () => {
        assert.equal(resolved.user, credentials.DATABASE_USER);
      });
      check('the install is not flagged as legacy', () => {
        assert.equal(resolved.legacy, false);
      });
      check('the password was generated, not stored', () => {
        assert.equal(resolved.source, 'generated');
      });
      check('the password is not empty', () => {
        assert.ok(resolved.password.length > 0);
      });
      check('the password is not the legacy fixed value', () => {
        assert.notEqual(resolved.password, credentials.LEGACY_DATABASE_PASSWORD);
      });
      check('the secrets file is obfuscated at rest', () => {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(dir, credentials.SECRETS_FILENAME), 'utf8')
        );
        assert.ok(parsed.surrealPassword.startsWith(credentials.OBFUSCATION_PREFIX));
      });
      check('the plaintext password is absent from disk', () => {
        const contents = fs.readFileSync(path.join(dir, credentials.SECRETS_FILENAME), 'utf8');
        assert.ok(!contents.includes(resolved.password));
      });
    } finally {
      cleanup(dir);
    }
  }
  console.log('  -> Passed');

  console.log('Test 6: A legacy install is reported as unmigrated, not given a password');
  {
    const dir = tempDir('legacy');
    try {
      seedLegacyDatastore(dir);
      const resolved = credentials.resolveDatabaseCredentials(dir);
      check('no password is returned', () => {
        assert.equal(resolved.password, null);
      });
      check('the install is flagged as legacy', () => {
        assert.equal(resolved.legacy, true);
      });
      check('the source is reported as legacy-unmigrated', () => {
        assert.equal(resolved.source, 'legacy-unmigrated');
      });
      check('the legacy fixed password is never produced', () => {
        assert.notEqual(resolved.password, credentials.LEGACY_DATABASE_PASSWORD);
      });
      check('no secrets file is written for a legacy install', () => {
        assert.equal(fs.existsSync(path.join(dir, credentials.SECRETS_FILENAME)), false);
      });
      check('building the credential environment fails closed', () => {
        assert.throws(
          () => credentials.buildCredentialEnvironment(resolved),
          (error) => error.code === credentials.CREDENTIAL_ERROR_INVALID_SECRET_VALUE
        );
      });
      check('ensuring a password directly also refuses to guess', () => {
        assert.throws(
          () => credentials.ensureDatabasePassword(dir),
          (error) => error.code === credentials.CREDENTIAL_ERROR_INVALID_SECRETS_FILE
        );
        assert.equal(fs.existsSync(path.join(dir, credentials.SECRETS_FILENAME)), false);
      });
    } finally {
      cleanup(dir);
    }
  }
  console.log('  -> Passed');

  console.log('Test 7: The password is stable across restarts');
  {
    const dir = tempDir('restart');
    try {
      const first = credentials.resolveDatabaseCredentials(dir);
      const second = credentials.resolveDatabaseCredentials(dir);
      check('the password does not change', () => {
        assert.equal(first.password, second.password);
      });
      check('the second resolution reports a stored password', () => {
        assert.equal(second.source, 'stored');
      });
    } finally {
      cleanup(dir);
    }
  }
  console.log('  -> Passed');

  console.log('Test 8: A corrupt secrets file is preserved and reported');
  {
    const dir = tempDir('corrupt');
    try {
      const secretsFile = writeSecretsFile(dir, null, '{not json');
      check('resolving reports an invalid secrets file', () => {
        assert.throws(
          () => credentials.resolveDatabaseCredentials(dir),
          (error) => error.code === credentials.CREDENTIAL_ERROR_INVALID_SECRETS_FILE
        );
      });
      check('the damaged file is left byte-for-byte intact', () => {
        assert.equal(fs.readFileSync(secretsFile, 'utf8'), '{not json');
      });
    } finally {
      cleanup(dir);
    }
  }
  console.log('  -> Passed');

  console.log('Test 9: The encryption key is obfuscated at rest');
  {
    const dir = tempDir('key');
    try {
      const first = credentials.ensureEncryptionKey(dir);
      const second = credentials.ensureEncryptionKey(dir);
      check('the key does not change', () => {
        assert.equal(first, second);
      });
      check('the key has the documented length', () => {
        assert.equal(first.length, credentials.ENCRYPTION_KEY_BYTES * 2);
      });
      const stored = fs.readFileSync(path.join(dir, credentials.KEY_FILENAME), 'utf8');
      check('the key file is obfuscated at rest', () => {
        assert.ok(stored.trim().startsWith(credentials.OBFUSCATION_PREFIX));
      });
      check('the plaintext key is absent from disk', () => {
        assert.ok(!stored.includes(first));
      });
      check('a legacy plaintext key file is still readable', () => {
        const legacyDir = tempDir('legacy-key');
        try {
          const legacyKeyFile = path.join(legacyDir, credentials.KEY_FILENAME);
          const legacyKey = 'a'.repeat(credentials.ENCRYPTION_KEY_BYTES * 2);
          fs.mkdirSync(legacyDir, { recursive: true });
          fs.writeFileSync(legacyKeyFile, legacyKey, { mode: 0o600 });
          credentials.restrictToCurrentUser(legacyKeyFile);
          assert.equal(credentials.ensureEncryptionKey(legacyDir), legacyKey);
        } finally {
          cleanup(legacyDir);
        }
      });
      check('a key of the wrong shape is rejected', () => {
        const badDir = tempDir('bad-key');
        try {
          const badKeyFile = path.join(badDir, credentials.KEY_FILENAME);
          fs.mkdirSync(badDir, { recursive: true });
          fs.writeFileSync(badKeyFile, 'too-short', { mode: 0o600 });
          credentials.restrictToCurrentUser(badKeyFile);
          assert.throws(
            () => credentials.ensureEncryptionKey(badDir),
            (error) => error.code === credentials.CREDENTIAL_ERROR_INVALID_SECRET_VALUE
          );
          assert.equal(fs.readFileSync(badKeyFile, 'utf8'), 'too-short');
        } finally {
          cleanup(badDir);
        }
      });
    } finally {
      cleanup(dir);
    }
  }
  console.log('  -> Passed');

  console.log('Test 10: Credentials travel through the environment');
  {
    const env = credentials.buildCredentialEnvironment({ user: 'root', password: 's3cr3t' });
    check('SURREAL_USER carries the user', () => {
      assert.equal(env.SURREAL_USER, 'root');
    });
    check('SURREAL_PASSWORD carries the password', () => {
      assert.equal(env.SURREAL_PASSWORD, 's3cr3t');
    });
    check('SURREAL_PASS carries the same password', () => {
      assert.equal(env.SURREAL_PASS, 's3cr3t');
    });
  }
  console.log('  -> Passed');

  console.log('Test 11: No credential appears in a command line');
  {
    if (!fs.existsSync(COMPILED_SERVICE_TABLE)) {
      throw new Error(
        `Compiled contract module missing at ${COMPILED_SERVICE_TABLE}. Run 'npm run build:types' first.`
      );
    }
    const { SERVICE_TABLE, createBackendEnvironment } = require(COMPILED_SERVICE_TABLE);
    const surreal = SERVICE_TABLE.services.find((service) => service.name === 'surrealdb');
    check('the SurrealDB service table entry carries no credential flags', () => {
      const args = surreal.args.join(' ');
      assert.ok(!args.includes('--user'));
      assert.ok(!args.includes('--pass'));
    });
    check('the service table still binds SurrealDB to loopback', () => {
      assert.ok(surreal.args.join(' ').includes('127.0.0.1:8000'));
    });
    const env = createBackendEnvironment({
      backendPath: '/test/backend',
      dataFolder: '/test/data',
      encryptionKey: 'test-key-123',
      tiktokenCache: '/test/cache',
      apiPort: 5055,
      credentials: { user: 'root', password: 'per-install-secret' },
    });
    check('the supplied credentials reach the backend environment', () => {
      assert.equal(env.SURREAL_PASSWORD, 'per-install-secret');
      assert.equal(env.SURREAL_PASS, 'per-install-secret');
      assert.equal(env.SURREAL_USER, 'root');
    });
    check('the backend environment refuses to be built without credentials', () => {
      assert.throws(
        () =>
          createBackendEnvironment({
            backendPath: '/test/backend',
            dataFolder: '/test/data',
            encryptionKey: 'test-key-123',
            tiktokenCache: '/test/cache',
            apiPort: 5055,
          }),
        /resolved database credentials/
      );
    });
    check('the backend environment refuses a null password', () => {
      assert.throws(() =>
        createBackendEnvironment({
          backendPath: '/test/backend',
          dataFolder: '/test/data',
          encryptionKey: 'test-key-123',
          tiktokenCache: '/test/cache',
          apiPort: 5055,
          credentials: { user: 'root', password: null },
        })
      );
    });
  }
  console.log('  -> Passed');

  console.log('Test 12: The typed facade agrees with the canonical module');
  {
    if (!fs.existsSync(COMPILED_CREDENTIALS)) {
      throw new Error(
        `Compiled credential module missing at ${COMPILED_CREDENTIALS}. Run 'npm run build:types' first.`
      );
    }
    const facade = require(COMPILED_CREDENTIALS);
    check('the facade reports the same constants', () => {
      assert.equal(facade.KEY_FILENAME, credentials.KEY_FILENAME);
      assert.equal(facade.SECRETS_FILENAME, credentials.SECRETS_FILENAME);
      assert.equal(facade.OBFUSCATION_PREFIX, credentials.OBFUSCATION_PREFIX);
      assert.equal(facade.OBFUSCATION_SALT, credentials.OBFUSCATION_SALT);
      assert.equal(facade.LEGACY_DATABASE_PASSWORD, credentials.LEGACY_DATABASE_PASSWORD);
      assert.equal(facade.DATABASE_USER, credentials.DATABASE_USER);
    });
    const dir = tempDir('facade');
    try {
      check('the facade resolves the same password as the canonical module', () => {
        const canonical = credentials.resolveDatabaseCredentials(dir);
        const viaFacade = facade.resolveDatabaseCredentials(dir);
        assert.equal(viaFacade.password, canonical.password);
        assert.equal(viaFacade.user, canonical.user);
        assert.equal(viaFacade.legacy, canonical.legacy);
      });
      check('the facade reports that the secret is obfuscated at rest', () => {
        const store = facade.inspectDatabasePasswordStore(dir);
        assert.equal(store.obfuscatedAtRest, true);
      });
      check('the facade describes the on-disk layout', () => {
        const layout = facade.describeCredentialStore(dir);
        assert.equal(layout.encryptionKeyFile, path.join(dir, credentials.KEY_FILENAME));
        assert.equal(layout.secretsFile, path.join(dir, credentials.SECRETS_FILENAME));
      });
    } finally {
      cleanup(dir);
    }
  }
  console.log('  -> Passed');

  console.log('Test 13: Every shared credential state matches the fixture');
  {
    const states = cases.states || [];
    check('the fixture declares credential states', () => {
      assert.ok(Array.isArray(states) && states.length > 0);
    });
    const sources = cases.sources || [];
    for (const state of states) {
      const dir = tempDir(`state-${state.id}`);
      try {
        const secretsFile = path.join(dir, credentials.SECRETS_FILENAME);
        if (state.datastore === 'present') {
          seedLegacyDatastore(dir);
        } else if (state.datastore === 'unreadable') {
          // A *file* where the datastore directory belongs cannot be
          // descended into, which makes the inspection fail portably.
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, credentials.DATABASE_DIRNAME), 'not a directory');
        }

        if (state.secrets === 'valid') {
          writeSecretsFile(dir, credentials.encodeSecret('shared-fixture-secret'));
        } else if (state.secrets === 'corrupt') {
          writeSecretsFile(dir, null, '{not json');
        } else if (state.secrets === 'missing-field') {
          writeSecretsFile(dir, null, `${JSON.stringify({ unrelated: true }, null, 2)}\n`);
        } else if (state.secrets === 'undecodable') {
          writeSecretsFile(dir, null, `${JSON.stringify({ surrealPassword: 'obf:!!!!' }, null, 2)}\n`);
        } else if (state.secrets === 'empty') {
          writeSecretsFile(dir, credentials.encodeSecret(''));
        } else if (state.secrets === 'control-char') {
          writeSecretsFile(dir, credentials.encodeSecret('bad\u0007secret'));
        }

        if (state.acl === 'open') {
          widenPermissions(secretsFile);
        }

        check(`${state.id}: ${state.description}`, () => {
          const before = fs.existsSync(secretsFile) ? fs.readFileSync(secretsFile) : null;
          let resolved = null;
          let thrown = null;
          try {
            resolved = credentials.resolveDatabaseCredentials(dir);
          } catch (error) {
            thrown = error;
          }

          if (state.outcome === 'rejected') {
            assert.ok(thrown, 'expected the state to be rejected');
            assert.equal(thrown.code, state.errorCode);
          } else {
            assert.equal(thrown, null, `unexpected rejection: ${thrown && thrown.code}`);
            assert.equal(resolved.source, state.source);
            assert.equal(resolved.legacy, state.legacy);
            assert.equal(resolved.password !== null, state.passwordAvailable);
            if (state.passwordAvailable) {
              assert.ok(resolved.password.length > 0);
              assert.ok(sources.includes(resolved.source));
            }
          }

          // No state ever rewrites the secrets file: an install must not lose
          // the only copy of a password the datastore still accepts.
          if (before !== null && !state.writesSecretsFile) {
            assert.deepEqual(fs.readFileSync(secretsFile), before);
          }
          if (state.secrets === 'absent') {
            assert.equal(
              fs.existsSync(secretsFile),
              state.writesSecretsFile,
              'a secrets file may only appear when the state says it is written'
            );
          }
        });
      } finally {
        cleanup(dir);
      }
    }
  }
  console.log('  -> Passed');

  console.log('Test 14: ACL samples classify exactly as the fixture says');
  {
    const samples = cases.aclSamples || [];
    check('the fixture declares ACL samples', () => {
      assert.ok(Array.isArray(samples) && samples.length > 0);
    });
    for (const sample of samples) {
      check(`${sample.id}: ${sample.description}`, () => {
        if (sample.mode !== undefined) {
          assert.equal(credentials.isRestrictedPosixMode(sample.mode), sample.restricted);
        } else {
          assert.equal(credentials.isRestrictedAclListing(sample.icaclsOutput), sample.restricted);
        }
      });
    }
  }
  console.log('  -> Passed');

  console.log('Test 15: The error codes and sources match the fixture');
  {
    const codes = cases.errorCodes || {};
    check('invalid secrets file code', () => {
      assert.equal(credentials.CREDENTIAL_ERROR_INVALID_SECRETS_FILE, codes.invalidSecretsFile);
    });
    check('invalid secret value code', () => {
      assert.equal(credentials.CREDENTIAL_ERROR_INVALID_SECRET_VALUE, codes.invalidSecretValue);
    });
    check('permissions too open code', () => {
      assert.equal(credentials.CREDENTIAL_ERROR_PERMISSIONS_TOO_OPEN, codes.permissionsTooOpen);
    });
    check('datastore unreadable code', () => {
      assert.equal(credentials.CREDENTIAL_ERROR_DATASTORE_UNREADABLE, codes.datastoreUnreadable);
    });
    const sources = cases.sources || [];
    for (const name of ['LEGACY_UNMIGRATED', 'STORED', 'GENERATED']) {
      check(`source constant ${name} is declared in the fixture`, () => {
        assert.ok(sources.includes(credentials[`CREDENTIAL_SOURCE_${name}`]));
      });
    }
    check('the legacy unmigrated source is not spelled "legacy"', () => {
      assert.notEqual(credentials.CREDENTIAL_SOURCE_LEGACY_UNMIGRATED, 'legacy');
    });
  }
  console.log('  -> Passed');

  if (failures > 0) {
    throw new Error(`${failures} credential contract check(s) failed.`);
  }

  console.log('All Credential Store Contract tests passed successfully.');
}

run();
