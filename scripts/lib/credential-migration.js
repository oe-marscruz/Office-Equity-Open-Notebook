'use strict';

/**
 * lib/credential-migration.js — one-time migration of a legacy datastore.
 *
 * `credentials.js` classifies an install but never talks to the network. This
 * module performs the part that has to: an install whose datastore predates
 * per-install credentials is probed once with the historical credential, and
 * if that authenticates, the password is rotated to a freshly provisioned one.
 *
 * Ordering is the entire point (see ADR 002). The new password is written to a
 * recovery file *before* the rotation commits, because a crash between the
 * rotation and persisting the password would otherwise leave a datastore whose
 * password exists only in a destroyed variable — an unrecoverable lockout.
 *
 *   .migration-pending  obf:<base64>   provisioned password, rotation in flight
 *   secrets.json        {"surrealPassword": "obf:<base64>"}
 *
 * The datastore is reached through a small adapter so every host supplies its
 * own HTTP client while sharing this sequence exactly:
 *
 *   { probe(password) => 'authenticated' | 'rejected' | 'unreachable',
 *     rotate(currentPassword, newPassword) => Promise<void> }
 *
 * `probe` must distinguish a rejected credential (HTTP 401/403) from an
 * unreachable datastore (connection refused, timeout). Conflating them would
 * turn a stopped service into a "wrong password" verdict.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  CredentialError,
  CREDENTIAL_ERROR_DATASTORE_UNREADABLE,
  CREDENTIAL_ERROR_INVALID_SECRETS_FILE,
  CREDENTIAL_ERROR_MIGRATION_REJECTED,
  CREDENTIAL_SOURCE_MIGRATED,
  CREDENTIAL_SOURCE_STORED,
  DATABASE_PASSWORD_BYTES,
  DATABASE_USER,
  SECRETS_FILENAME,
  decodeSecretChecked,
  encodeSecret,
  isUsableSecretValue,
  resolveDatabaseCredentials,
  writeSecretFile,
} = require('./credentials');

/** Recovery file holding a provisioned password whose rotation may be in flight. */
const MIGRATION_PENDING_FILENAME = '.migration-pending';

/**
 * The password every build before per-install credentials used.
 *
 * This is an *authentication probe*, never a provisioned credential: it is
 * offered to an existing datastore exactly once to establish whether that
 * datastore is a legacy one, and it is never returned by any resolver. Once a
 * datastore has been migrated this value no longer authenticates, so deleting
 * `secrets.json` afterwards cannot re-enter a migrated install.
 */
const LEGACY_PROBE_PASSWORD = 'root';

/** Outcome identifiers returned by `probe`. */
const PROBE_AUTHENTICATED = 'authenticated';
const PROBE_REJECTED = 'rejected';
const PROBE_UNREACHABLE = 'unreachable';

/** The loopback host SurrealDB is bound to. */
const DEFAULT_SURREAL_HOST = '127.0.0.1';

/**
 * Reads a provisioned-but-uncommitted password from the recovery file.
 *
 * A recovery file that cannot be decoded is deleted rather than reported: it
 * is never the only copy of a live credential, because the rotation it guards
 * has not committed. Leaving it in place would wedge every later launch.
 *
 * @param {string} pendingFile
 * @returns {string | null}
 */
function readPendingPassword(pendingFile) {
  let contents;
  try {
    contents = fs.readFileSync(pendingFile, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new CredentialError(
      'Could not read the pending credential file',
      CREDENTIAL_ERROR_INVALID_SECRETS_FILE,
      pendingFile
    );
  }
  try {
    const value = decodeSecretChecked(contents.trim());
    return isUsableSecretValue(value) ? value : null;
  } catch (_) {
    return null;
  }
}

/**
 * Discards the recovery file. Absence is success: the caller only ever wants
 * the file gone.
 *
 * @param {string} pendingFile
 */
function clearPendingPassword(pendingFile) {
  try {
    fs.unlinkSync(pendingFile);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw new CredentialError(
        'Could not remove the pending credential file',
        CREDENTIAL_ERROR_INVALID_SECRETS_FILE,
        pendingFile
      );
    }
  }
}

/**
 * Migrates a datastore that has no credential file to a provisioned password.
 *
 * Idempotent and crash-safe: every restart re-derives what remains to be done
 * from what is on disk, so a crash between any two steps is recoverable.
 *
 * @param {string} dataDir Directory holding the app's user data.
 * @param {{ probe: (password: string) => Promise<string>, rotate: (currentPassword: string, newPassword: string) => Promise<void> }} datastore
 * @returns {Promise<{ user: string, password: string, migrationRequired: boolean, source: string, recovered: boolean }>}
 */
async function migrateLegacyDatastore(dataDir, datastore) {
  if (!datastore || typeof datastore.probe !== 'function' || typeof datastore.rotate !== 'function') {
    throw new TypeError('migrateLegacyDatastore requires a datastore adapter with probe and rotate');
  }

  const secretsFile = path.join(dataDir, SECRETS_FILENAME);
  const pendingFile = path.join(dataDir, MIGRATION_PENDING_FILENAME);
  const pending = readPendingPassword(pendingFile);

  // A valid secrets file is authoritative. Reaching here with one present means
  // the caller re-ran migration after it already succeeded; the recovery file is
  // stale by definition and carries nothing still needed.
  if (fs.existsSync(secretsFile)) {
    if (pending !== null) clearPendingPassword(pendingFile);
    const resolved = resolveDatabaseCredentials(dataDir);
    return { ...resolved, recovered: false };
  }

  if (pending !== null) {
    // A previous run provisioned `pending`. Did its rotation commit?
    const pendingState = await datastore.probe(pending);
    if (pendingState === PROBE_UNREACHABLE) {
      throw new CredentialError(
        'The datastore exists but could not be reached to complete its credential migration',
        CREDENTIAL_ERROR_DATASTORE_UNREADABLE,
        dataDir
      );
    }
    if (pendingState === PROBE_AUTHENTICATED) {
      // The rotation committed before the crash. Finish steps 6 and 7.
      writeSecretFile(
        secretsFile,
        `${JSON.stringify({ surrealPassword: encodeSecret(pending) }, null, 2)}\n`
      );
      clearPendingPassword(pendingFile);
      return {
        user: DATABASE_USER,
        password: pending,
        migrationRequired: false,
        source: CREDENTIAL_SOURCE_MIGRATED,
        recovered: true,
      };
    }
    // The provisioned password does not authenticate, so no rotation committed.
    // The datastore is therefore still on the legacy credential; drop the stale
    // recovery file and start the migration cleanly below.
    clearPendingPassword(pendingFile);
  }

  const legacyState = await datastore.probe(LEGACY_PROBE_PASSWORD);
  if (legacyState === PROBE_UNREACHABLE) {
    throw new CredentialError(
      'The datastore exists but could not be reached to migrate its credentials',
      CREDENTIAL_ERROR_DATASTORE_UNREADABLE,
      dataDir
    );
  }
  if (legacyState !== PROBE_AUTHENTICATED) {
    throw new CredentialError(
      'The existing datastore does not accept the legacy credential; an operator must supply its current password',
      CREDENTIAL_ERROR_MIGRATION_REJECTED,
      secretsFile
    );
  }

  const provisioned = crypto.randomBytes(DATABASE_PASSWORD_BYTES).toString('base64url');

  // Step 2: persist before rotating. This is the window that covers a crash
  // between the rotation committing and `secrets.json` being written.
  writeSecretFile(pendingFile, encodeSecret(provisioned));

  try {
    await datastore.rotate(LEGACY_PROBE_PASSWORD, provisioned);
  } catch (rotateError) {
    // The rotation may have committed even though the call failed — a dropped
    // response looks identical to a rejected statement. Probe for the new
    // password before concluding the datastore is unchanged, because discarding
    // the recovery file on a committed rotation would destroy the password.
    let after = PROBE_UNREACHABLE;
    try {
      after = await datastore.probe(provisioned);
    } catch (_) {
      after = PROBE_UNREACHABLE;
    }
    if (after !== PROBE_AUTHENTICATED) {
      clearPendingPassword(pendingFile);
      throw new CredentialError(
        'Credential rotation failed; the existing datastore is unchanged',
        CREDENTIAL_ERROR_MIGRATION_REJECTED,
        secretsFile
      );
    }
  }

  // Step 6 and 7.
  writeSecretFile(
    secretsFile,
    `${JSON.stringify({ surrealPassword: encodeSecret(provisioned) }, null, 2)}\n`
  );
  clearPendingPassword(pendingFile);

  return {
    user: DATABASE_USER,
    password: provisioned,
    migrationRequired: false,
    source: CREDENTIAL_SOURCE_MIGRATED,
    recovered: false,
  };
}

/**
 * Resolves credentials, migrating a legacy datastore when one is found.
 *
 * This is the launcher entry point: the pure classifier reports what the files
 * say, and the migration runs only for the one state that needs the network.
 *
 * @param {string} dataDir
 * @param {{ probe: Function, rotate: Function }} datastore
 * @returns {Promise<{ user: string, password: string, migrationRequired: boolean, source: string, recovered?: boolean }>}
 */
async function prepareDatabaseCredentials(dataDir, datastore) {
  const resolved = resolveDatabaseCredentials(dataDir);
  if (!resolved.migrationRequired) return { ...resolved, recovered: false };
  if (!datastore) {
    throw new CredentialError(
      'The datastore exists but no database connection was supplied to migrate its credentials',
      CREDENTIAL_ERROR_DATASTORE_UNREADABLE,
      dataDir
    );
  }
  return migrateLegacyDatastore(dataDir, datastore);
}

/**
 * Issues one SQL statement against a running SurrealDB over its HTTP endpoint.
 *
 * Authentication is passed as an explicit `Authorization: Basic` header rather
 * than through a flag or the URL: SurrealDB's CLI has no non-interactive
 * password option that keeps the secret out of the process listing, and the
 * header is what its HTTP interface expects.
 *
 * @param {{ host?: string, port: number, username: string, password: string, namespace?: string, database?: string }} options
 * @param {string} statement
 * @param {number} [timeoutMs]
 * @returns {Promise<{ statusCode: number, body: string }>}
 */
function postSurrealSql(options, statement, timeoutMs = 15000) {
  const http = require('http');
  const host = options.host || DEFAULT_SURREAL_HOST;
  // SurrealDB 2.x picks the /sql dialect from the media types: text/plain is the
  // raw-SQL dialect, while application/json is the structured-query dialect that
  // silently echoes an unknown statement back with status OK instead of running
  // it. Accept must also be exactly application/json; the default `*/*` is
  // refused with 415.
  const body = Buffer.from(statement, 'utf8');
  const headers = {
    'Content-Type': 'text/plain',
    Accept: 'application/json',
    'Content-Length': body.length,
    Authorization: `Basic ${Buffer.from(`${options.username}:${options.password}`, 'utf8').toString('base64')}`,
  };
  if (options.namespace) headers['surreal-ns'] = options.namespace;
  if (options.database) headers['surreal-db'] = options.database;

  return new Promise((resolve, reject) => {
    const request = http.request(
      { host, port: options.port, path: '/sql', method: 'POST', headers, timeout: timeoutMs },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ statusCode: response.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    request.on('timeout', () => request.destroy(new Error('surreal request timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

/**
 * Adapts a running SurrealDB to the probe/rotate interface the migration needs.
 *
 * The two outcomes the migration hinges on are kept strictly apart: a 401 or
 * 403 is a *rejected* credential, while a connection failure is *unreachable*.
 * Treating a stopped database as a wrong password would send an operator
 * looking for a credential problem that does not exist.
 *
 * @param {{ port: number, host?: string, namespace?: string, database?: string, username?: string }} options
 */
function createSurrealHttpDatastore(options) {
  if (!options || !Number.isInteger(options.port)) {
    throw new TypeError('createSurrealHttpDatastore requires an integer port');
  }
  const username = options.username || DATABASE_USER;

  return {
    async probe(password) {
      try {
        const { statusCode } = await postSurrealSql({ ...options, username, password }, 'INFO FOR ROOT;');
        if (statusCode === 401 || statusCode === 403) return PROBE_REJECTED;
        if (statusCode >= 200 && statusCode < 300) return PROBE_AUTHENTICATED;
        // Any other status means the credential question was never answered.
        // Reporting it as a rejection would send an operator hunting for a
        // working password over what is really a protocol or server fault.
        return PROBE_UNREACHABLE;
      } catch (_) {
        return PROBE_UNREACHABLE;
      }
    },

    async rotate(currentPassword, newPassword) {
      // SurrealDB has no parameter binding over the raw SQL endpoint, so the
      // password is escaped defensively even though it is generated base64url.
      const escaped = newPassword.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const { statusCode, body } = await postSurrealSql(
        { ...options, username, password: currentPassword },
        `DEFINE USER OVERWRITE ${username} ON ROOT PASSWORD '${escaped}' ROLES OWNER;`
      );
      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`credential rotation was refused with HTTP ${statusCode}`);
      }
      const parsed = JSON.parse(body);
      const failed = Array.isArray(parsed) && parsed.some((entry) => entry && entry.status && entry.status !== 'OK');
      if (failed) throw new Error('credential rotation statement did not report OK');
    },
  };
}

module.exports = {
  CREDENTIAL_SOURCE_STORED,
  LEGACY_PROBE_PASSWORD,
  MIGRATION_PENDING_FILENAME,
  PROBE_AUTHENTICATED,
  PROBE_REJECTED,
  PROBE_UNREACHABLE,
  clearPendingPassword,
  createSurrealHttpDatastore,
  migrateLegacyDatastore,
  prepareDatabaseCredentials,
  readPendingPassword,
};
