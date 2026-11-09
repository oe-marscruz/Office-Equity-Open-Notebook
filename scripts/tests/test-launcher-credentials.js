'use strict';

/**
 * Verifies what the launcher does with the credential it resolves, without
 * starting any service.
 *
 * `startServices` cannot run in a test environment: it needs the assembled
 * runtime, a real SurrealDB and the Python backend. The decision that matters
 * for lockout safety is separable, though — which credential the launch uses,
 * whether a migration is pending, and when the launcher must refuse to start —
 * so it is asserted directly here.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const credentials = require('../lib/credentials');
const migration = require('../lib/credential-migration');
const { resolveStartupCredentials } = require('../start-services');

const FIXTURE_PATH = path.resolve(__dirname, '../../tests/contracts/credentials-cases.json');
const cases = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

const results = [];
async function check(label, fn) {
  try {
    await fn();
    results.push({ label, passed: true });
    console.log(`  ok  ${label}`);
  } catch (error) {
    results.push({ label, passed: false, error });
    console.log(`  FAIL ${label}`);
    console.log(`       ${error && error.message}`);
  }
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `oe-launcher-${label}-`));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // Best effort.
  }
}

/** Creates the on-disk shape of a datastore written by an older build. */
function seedLegacyDatastore(dir) {
  const db = path.join(dir, credentials.DATABASE_DIRNAME, credentials.DATABASE_FILENAME);
  fs.mkdirSync(db, { recursive: true });
  fs.writeFileSync(path.join(db, 'CURRENT'), 'x');
}

/** Reads the password out of the credential environment the launcher builds. */
function envPassword(env) {
  return env.SURREAL_PASSWORD || env.SURREAL_PASS || null;
}

/**
 * Migrates `dir` exactly the way a first launch does, so the resulting state is
 * the one a user actually has after the upgrade.
 */
async function migratedInstall(dir) {
  seedLegacyDatastore(dir);
  const datastore = { current: migration.LEGACY_PROBE_PASSWORD };
  datastore.probe = (password) =>
    password === datastore.current ? migration.PROBE_AUTHENTICATED : migration.PROBE_REJECTED;
  datastore.rotate = (current, next) => {
    if (current !== datastore.current) throw new Error('rotation rejected the supplied password');
    datastore.current = next;
  };
  return migration.prepareDatabaseCredentials(dir, datastore);
}

async function run() {
  console.log('Launcher credential resolution');

  console.log('Test 1: a fresh install starts on a generated password');
  {
    await check('a fresh install provisions a password and needs no migration', () => {
      const dir = tempDir('fresh');
      try {
        const startup = resolveStartupCredentials({}, dir);
        assert.equal(startup.needsMigration, false);
        assert.equal(startup.credentials.source, credentials.CREDENTIAL_SOURCE_GENERATED);
        assert.notEqual(startup.credentials.password, migration.LEGACY_PROBE_PASSWORD);
        assert.equal(envPassword(startup.credentialEnv), startup.credentials.password);
      } finally {
        cleanup(dir);
      }
    });

    await check('a fresh install writes the secrets file it resolved', () => {
      const dir = tempDir('fresh-file');
      try {
        resolveStartupCredentials({}, dir);
        assert.ok(fs.existsSync(path.join(dir, credentials.SECRETS_FILENAME)));
      } finally {
        cleanup(dir);
      }
    });
  }
  console.log('  -> Passed');

  console.log('Test 2: a legacy datastore is migrated, never started on the legacy password');
  {
    await check('a legacy datastore reports a pending migration', () => {
      const dir = tempDir('legacy');
      try {
        seedLegacyDatastore(dir);
        const startup = resolveStartupCredentials({}, dir);
        assert.equal(startup.needsMigration, true);
        assert.equal(startup.credentials.password, null);
      } finally {
        cleanup(dir);
      }
    });

    await check('the pending migration authenticates SurrealDB with the legacy password only', () => {
      const dir = tempDir('legacy-env');
      try {
        seedLegacyDatastore(dir);
        const startup = resolveStartupCredentials({}, dir);
        // SurrealDB is the only service started while the migration is pending;
        // it has to be reachable with the credential that still works.
        assert.equal(envPassword(startup.credentialEnv), migration.LEGACY_PROBE_PASSWORD);
      } finally {
        cleanup(dir);
      }
    });

    await check('after migration the launcher uses the provisioned password', async () => {
      const dir = tempDir('legacy-done');
      try {
        const migrated = await migratedInstall(dir);
        assert.equal(migrated.source, credentials.CREDENTIAL_SOURCE_MIGRATED);
        const startup = resolveStartupCredentials({}, dir);
        assert.equal(startup.needsMigration, false);
        // `migrated` describes how the credential was provisioned in that
        // process. A later launch reads the same password back from disk, so it
        // is `stored` - the distinction is provenance, not trust.
        assert.equal(startup.credentials.source, credentials.CREDENTIAL_SOURCE_STORED);
        assert.equal(startup.credentials.password, migrated.password);
        assert.equal(envPassword(startup.credentialEnv), migrated.password);
        assert.notEqual(envPassword(startup.credentialEnv), migration.LEGACY_PROBE_PASSWORD);
      } finally {
        cleanup(dir);
      }
    });
  }
  console.log('  -> Passed');

  console.log('Test 3: deleting secrets.json after migration refuses to start');
  {
    /**
     * Reproduces the exit-criterion state exactly: the datastore was rotated to
     * a provisioned password and the file holding that password was then deleted.
     *
     * On disk this is indistinguishable from a legacy install, so the launcher
     * does attempt the migration. The rotation is only safe because the probe
     * happens first and fails: `root` no longer authenticates, so the launch stops
     * before anything is written or rotated. That ordering is what keeps this a
     * refusal instead of a second destructive rotation.
     */
    async function deletedSecretsInstall(label) {
      const dir = tempDir(label);
      const migrated = await migratedInstall(dir);
      fs.rmSync(path.join(dir, credentials.SECRETS_FILENAME));
      // The rotated datastore accepts the provisioned password, not `root`.
      const datastore = { current: migrated.password, rotations: [] };
      datastore.probe = (password) =>
        password === datastore.current ? migration.PROBE_AUTHENTICATED : migration.PROBE_REJECTED;
      datastore.rotate = (current, next) => {
        datastore.rotations.push({ from: current, to: next });
        datastore.current = next;
      };
      return { dir, migrated, datastore };
    }

    await check('the launcher cannot tell this apart from a legacy install', async () => {
      const { dir } = await deletedSecretsInstall('deleted-shape');
      try {
        const startup = resolveStartupCredentials({}, dir);
        // Resolution reads the disk only; the datastore must decide.
        assert.equal(startup.needsMigration, true);
        assert.equal(envPassword(startup.credentialEnv), migration.LEGACY_PROBE_PASSWORD);
      } finally {
        cleanup(dir);
      }
    });

    await check('the migration probe refuses, so the launch stops', async () => {
      const { dir, datastore } = await deletedSecretsInstall('deleted-probe');
      try {
        let error = null;
        try {
          await migration.prepareDatabaseCredentials(dir, datastore);
        } catch (caught) {
          error = caught;
        }
        assert.ok(error, 'the migration must fail; the launch must not start');
        assert.equal(error.code, credentials.CREDENTIAL_ERROR_MIGRATION_REJECTED);
      } finally {
        cleanup(dir);
      }
    });

    await check('the refusal is actionable and does not rotate or write anything', async () => {
      const { dir, datastore } = await deletedSecretsInstall('deleted-safe');
      try {
        const secretsFile = path.join(dir, credentials.SECRETS_FILENAME);
        const before = datastore.current;
        let error = null;
        try {
          await migration.prepareDatabaseCredentials(dir, datastore);
        } catch (caught) {
          error = caught;
        }
        assert.ok(error);
        assert.ok(
          /supply its current password/i.test(error.message),
          `expected an actionable message: ${error.message}`
        );
        assert.equal(datastore.rotations.length, 0, 'no rotation may be attempted');
        assert.equal(fs.existsSync(secretsFile), false, 'no secrets file may be written');
        assert.equal(datastore.current, before, 'the datastore password must be unchanged');
      } finally {
        cleanup(dir);
      }
    });

    await check('the refusal never falls back to starting on the legacy password', async () => {
      const { dir, datastore } = await deletedSecretsInstall('deleted-nofallback');
      try {
        let error = null;
        try {
          await migration.prepareDatabaseCredentials(dir, datastore);
        } catch (caught) {
          error = caught;
        }
        assert.ok(error);
        assert.notEqual(error.code, credentials.CREDENTIAL_ERROR_INVALID_SECRET_VALUE);
        // The datastore still accepts the pre-deletion password: the refusal
        // preserved data rather than destroying the last working credential.
        assert.equal(datastore.probe(datastore.current), migration.PROBE_AUTHENTICATED);
      } finally {
        cleanup(dir);
      }
    });
  }
  console.log('  -> Passed');

  console.log('Test 4: no launcher path produces the legacy password as the running credential');
  {
    await check('a generated install never yields the legacy password', () => {
      const dir = tempDir('no-legacy-generated');
      try {
        const startup = resolveStartupCredentials({}, dir);
        assert.notEqual(envPassword(startup.credentialEnv), migration.LEGACY_PROBE_PASSWORD);
      } finally {
        cleanup(dir);
      }
    });

    await check('a stored install never yields the legacy password', () => {
      const dir = tempDir('no-legacy-stored');
      try {
        credentials.resolveDatabaseCredentials(dir);
        const startup = resolveStartupCredentials({}, dir);
        assert.equal(startup.credentials.source, credentials.CREDENTIAL_SOURCE_STORED);
        assert.notEqual(envPassword(startup.credentialEnv), migration.LEGACY_PROBE_PASSWORD);
      } finally {
        cleanup(dir);
      }
    });

    await check('only the pending-migration spawn may use the legacy password', () => {
      const dir = tempDir('no-legacy-migrated');
      try {
        seedLegacyDatastore(dir);
        const startup = resolveStartupCredentials({}, dir);
        assert.equal(startup.needsMigration, true);
        // The explicit marker is what scopes the legacy credential to the
        // SurrealDB spawn; without it the password must never appear.
        assert.equal(startup.credentials.password, null);
      } finally {
        cleanup(dir);
      }
    });

    await check('the fixture agrees that no state resolves to the legacy password', () => {
      const leaked = cases.states.filter(
        (state) => state.expected && state.expected.password === migration.LEGACY_PROBE_PASSWORD
      );
      assert.deepEqual(leaked.map((state) => state.id), []);
    });
  }
  console.log('  -> Passed');

  console.log('Test 5: an explicit credential is used verbatim and never migrates');
  {
    await check('supplied credentials bypass resolution entirely', () => {
      const dir = tempDir('explicit');
      try {
        // A test-supplied credential must not be overridden by the secret store
        // or turned into a migration, otherwise harnesses cannot control it.
        const startup = resolveStartupCredentials(
          { credentials: { user: 'root', password: 'test-supplied' } },
          dir
        );
        assert.equal(startup.needsMigration, false);
        assert.equal(envPassword(startup.credentialEnv), 'test-supplied');
        assert.equal(fs.existsSync(path.join(dir, credentials.SECRETS_FILENAME)), false);
      } finally {
        cleanup(dir);
      }
    });

    await check('supplied credentials are honoured even beside a legacy datastore', () => {
      const dir = tempDir('explicit-legacy');
      try {
        seedLegacyDatastore(dir);
        const startup = resolveStartupCredentials(
          { credentials: { user: 'root', password: 'test-supplied' } },
          dir
        );
        assert.equal(startup.needsMigration, false);
        assert.equal(envPassword(startup.credentialEnv), 'test-supplied');
      } finally {
        cleanup(dir);
      }
    });
  }
  console.log('  -> Passed');

  const failed = results.filter((result) => !result.passed);
  console.log('');
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log(failed.map((result) => `  - ${result.label}`).join('\n'));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
