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
  DatabaseCredentials,
} from '../types';

/** File names of the on-disk secret store. */
export const KEY_FILENAME: string = credentialsModule.KEY_FILENAME;
export const SECRETS_FILENAME: string = credentialsModule.SECRETS_FILENAME;

/** The fixed password used by installs that predate per-install credentials. */
export const LEGACY_DATABASE_PASSWORD: string = credentialsModule.LEGACY_DATABASE_PASSWORD;

/** The SurrealDB root user name. Fixed, because it is not itself a secret. */
export const DATABASE_USER: string = credentialsModule.DATABASE_USER;

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
 * An install whose datastore predates per-install credentials keeps the
 * original `root` password, because SurrealDB applies initial root
 * credentials only when no root user exists yet. Only fresh installs receive
 * a randomly generated password.
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
 */
export function hasExistingDatastore(dataDir: string): boolean {
  return credentialsModule.hasExistingDatastore(dataDir) as boolean;
}

/**
 * Restricts a file to the current OS user.
 *
 * Best effort by design: a failure here must never stop the app from
 * starting.
 */
export function restrictToCurrentUser(file: string): boolean {
  return credentialsModule.restrictToCurrentUser(file) as boolean;
}

/**
 * Builds the environment variables that carry database credentials to the
 * SurrealDB server and the Python backend.
 *
 * The credentials travel through the process environment rather than the
 * command line, so they never appear in a process listing.
 */
export function buildCredentialEnvironment(credentials: {
  user: string;
  password: string;
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
    aclRestricted: true,
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
    aclRestricted: true,
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
