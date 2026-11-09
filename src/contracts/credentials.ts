/**
 * Office of Equity Open Notebook — Credential & Secret Storage Contract
 *
 * Typed facade over the canonical shared implementation in
 * `scripts/lib/credentials.js`.
 *
 * The canonical implementation lives in plain CommonJS under `scripts/` for a
 * specific reason: `scripts/package.js` copies `scripts/` into the packaged
 * Electron app's `resources/app` directory, but it does *not* copy `dist/`.
 * The runtime therefore has to be able to reach the credential logic without
 * going through the compiled TypeScript output. This module gives the typed
 * contract and test layer a checked view of that same implementation, so the
 * two can never drift.
 *
 * The Rust, Go and C# hosts implement the identical on-disk format natively;
 * `tests/contracts/credentials-cases.json` pins the shared behaviour for all
 * five implementations.
 */

import path from 'path';
import credentialsModule from '../../scripts/lib/credentials';
import {
  CredentialEnvironment,
  CredentialStoreLayout,
  CredentialStoreResult,
  DatabaseCredentialErrorCode,
  DatabaseCredentialSource,
  DatabaseCredentials,
} from '../types';

/** File names of the on-disk secret store. */
export const KEY_FILENAME: string = credentialsModule.KEY_FILENAME;
export const SECRETS_FILENAME: string = credentialsModule.SECRETS_FILENAME;

/** The fixed password used by installs that predate per-install credentials. */
export const LEGACY_DATABASE_PASSWORD: string = credentialsModule.LEGACY_DATABASE_PASSWORD;

/** The SurrealDB root user name. Fixed, because it is not itself a secret. */
export const DATABASE_USER: string = credentialsModule.DATABASE_USER;

/** The credential-state identifiers shared by every host. */
export const CREDENTIAL_SOURCE_LEGACY_UNMIGRATED: DatabaseCredentialSource =
  credentialsModule.CREDENTIAL_SOURCE_LEGACY_UNMIGRATED as DatabaseCredentialSource;
export const CREDENTIAL_SOURCE_STORED: DatabaseCredentialSource =
  credentialsModule.CREDENTIAL_SOURCE_STORED as DatabaseCredentialSource;
export const CREDENTIAL_SOURCE_GENERATED: DatabaseCredentialSource =
  credentialsModule.CREDENTIAL_SOURCE_GENERATED as DatabaseCredentialSource;

/** The failure codes shared by every host. */
export const CREDENTIAL_ERROR_INVALID_SECRETS_FILE: DatabaseCredentialErrorCode =
  credentialsModule.CREDENTIAL_ERROR_INVALID_SECRETS_FILE as DatabaseCredentialErrorCode;
export const CREDENTIAL_ERROR_INVALID_SECRET_VALUE: DatabaseCredentialErrorCode =
  credentialsModule.CREDENTIAL_ERROR_INVALID_SECRET_VALUE as DatabaseCredentialErrorCode;
export const CREDENTIAL_ERROR_PERMISSIONS_TOO_OPEN: DatabaseCredentialErrorCode =
  credentialsModule.CREDENTIAL_ERROR_PERMISSIONS_TOO_OPEN as DatabaseCredentialErrorCode;
export const CREDENTIAL_ERROR_DATASTORE_UNREADABLE: DatabaseCredentialErrorCode =
  credentialsModule.CREDENTIAL_ERROR_DATASTORE_UNREADABLE as DatabaseCredentialErrorCode;

/** Marker prefix identifying an obfuscated value in a secret file. */
export const OBFUSCATION_PREFIX: string = credentialsModule.OBFUSCATION_PREFIX;

/** App-specific salt mixed into the obfuscation key derivation. */
export const OBFUSCATION_SALT: string = credentialsModule.OBFUSCATION_SALT;

/**
 * Describes the on-disk layout of the secret store for `dataDir`.
 */
export function describeCredentialStore(dataDir: string): CredentialStoreLayout {
  return {
    dataDir,
    encryptionKeyFile: path.join(dataDir, KEY_FILENAME),
    secretsFile: path.join(dataDir, SECRETS_FILENAME),
  };
}

/**
 * Resolves the SurrealDB credentials to start the database with.
 *
 * SurrealDB applies initial root credentials only when no root user exists
 * yet, so a freshly generated password has no effect on a datastore created by
 * an older build. An install in that position is reported as
 * `legacy-unmigrated` with a null password; the caller must run the migration
 * instead of connecting as `root`. Only fresh installs receive a randomly
 * generated password.
 *
 * @throws {Error} Carrying one of the `DatabaseCredentialErrorCode` values.
 */
export function resolveDatabaseCredentials(dataDir: string): DatabaseCredentials {
  return credentialsModule.resolveDatabaseCredentials(dataDir) as DatabaseCredentials;
}

/**
 * Returns the persisted provider-API-key encryption key for `dataDir`,
 * generating a random 32-byte key on first use.
 *
 * The key is stored obfuscated, so it never appears in plaintext on disk.
 */
export function ensureEncryptionKey(dataDir: string): string {
  return credentialsModule.ensureEncryptionKey(dataDir) as string;
}

/**
 * Returns the persisted SurrealDB root password for `dataDir`, generating a
 * random 24-byte password on first use.
 */
export function ensureDatabasePassword(dataDir: string): string {
  return credentialsModule.ensureDatabasePassword(dataDir) as string;
}

/**
 * True when `dataDir` already holds a SurrealDB datastore from an earlier run.
 *
 * @throws {Error} `datastore-unreadable` when the datastore cannot be
 * inspected — guessing "no datastore" would overwrite a live install's
 * password.
 */
export function hasExistingDatastore(dataDir: string): boolean {
  return credentialsModule.hasExistingDatastore(dataDir) as boolean;
}

/**
 * Restricts a file to the current OS user and returns whether that worked.
 *
 * Enforced, not best effort: callers that write a secret treat `false` as a
 * failure rather than continuing with a world-readable file.
 */
export function restrictToCurrentUser(file: string): boolean {
  return credentialsModule.restrictToCurrentUser(file) as boolean;
}

/**
 * Reports whether `file` is currently restricted to the current OS user.
 *
 * The check is a post-condition, so it also catches a restriction that
 * silently failed or was widened afterwards.
 */
export function checkRestrictedToCurrentUser(file: string): boolean {
  return credentialsModule.checkRestrictedToCurrentUser(file) as boolean;
}

/**
 * Builds the environment variables that carry database credentials to the
 * SurrealDB server and the Python backend.
 *
 * The credentials travel through the process environment rather than the
 * command line, so they never appear in a process listing.
 *
 * @throws {Error} `invalid-secret-value` when no password is available.
 */
export function buildCredentialEnvironment(credentials: {
  user: string;
  password: string | null;
}): CredentialEnvironment {
  return credentialsModule.buildCredentialEnvironment(credentials) as CredentialEnvironment;
}

/**
 * Reports whether a stored secret file holds its value in plaintext.
 *
 * Used by the credential tests to prove that the secret is not readable by a
 * casual `cat` of the secret file.
 */
export function isObfuscatedAtRest(file: string): boolean {
  const contents = readFileSafe(file);
  if (contents === null) return false;
  return contents.trim().startsWith(OBFUSCATION_PREFIX);
}

/**
 * Reads a file, returning null when it cannot be read.
 */
function readFileSafe(file: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

/**
 * Reports the storage state of the encryption key for `dataDir`.
 */
export function inspectEncryptionKeyStore(dataDir: string): CredentialStoreResult {
  const layout = describeCredentialStore(dataDir);
  const existedBefore = fileExists(layout.encryptionKeyFile);
  const value = ensureEncryptionKey(dataDir);
  return {
    value,
    persisted: existedBefore,
    obfuscatedAtRest: isObfuscatedAtRest(layout.encryptionKeyFile),
    aclRestricted: checkRestrictedToCurrentUser(layout.encryptionKeyFile),
  };
}

/**
 * Reports the storage state of the database password for `dataDir`.
 */
export function inspectDatabasePasswordStore(dataDir: string): CredentialStoreResult {
  const layout = describeCredentialStore(dataDir);
  const existedBefore = fileExists(layout.secretsFile);
  const value = ensureDatabasePassword(dataDir);
  return {
    value,
    persisted: existedBefore,
    obfuscatedAtRest: isPasswordObfuscatedAtRest(layout.secretsFile),
    aclRestricted: checkRestrictedToCurrentUser(layout.secretsFile),
  };
}

/**
 * Reports whether the stored database password is obfuscated at rest.
 *
 * The password lives inside a JSON document, so the marker prefix is checked
 * on the `surrealPassword` field rather than on the file as a whole.
 */
function isPasswordObfuscatedAtRest(file: string): boolean {
  const contents = readFileSafe(file);
  if (contents === null) return false;
  try {
    const parsed = JSON.parse(contents) as { surrealPassword?: unknown };
    return (
      typeof parsed.surrealPassword === 'string' &&
      parsed.surrealPassword.trim().startsWith(OBFUSCATION_PREFIX)
    );
  } catch (_) {
    return false;
  }
}

/**
 * True when `file` exists.
 */
function fileExists(file: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    return fs.existsSync(file);
  } catch (_) {
    return false;
  }
}
