'use strict';

/**
 * lib/encryption-key.js — reads (or creates) the locally-generated key that
 * encrypts stored provider API keys.
 *
 * Shared by the Electron main process and the headless `run-services` CLI so
 * both resolve the same user-data directory to the same key.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const KEY_FILENAME = 'encryption-key.txt';
const SECRETS_FILENAME = 'secrets.json';

/**
 * Restricts a file to the current user only.
 *
 * These files hold the key that protects stored provider API keys and the
 * database password. `writeFileSync` inherits the parent directory's
 * permissions, which on Windows means other accounts on a shared machine can
 * read them. `icacls` is the supported way to drop the inherited entries.
 */
function restrictToCurrentUser(file) {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
    } catch (_) {
      // Best effort: a failure here must not stop the app from starting.
    }
    return;
  }
  try {
    const user = process.env.USERNAME;
    if (!user) return;
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (_) {
    // Best effort: the file exists, so the app still works even if the ACL
    // could not be tightened.
  }
}

/** Writes `contents` to `file` with permissions limited to the current user. */
function writeSecretFile(file, contents) {
  fs.writeFileSync(file, contents, 'utf8');
  restrictToCurrentUser(file);
}

/**
 * Returns the local database password for `dataDir`, generating a random one on
 * first use.
 *
 * A fixed `root`/`root` credential on a locally-bound service still matters:
 * any other process or account on the machine can read the whole notebook
 * database over the local port. Passwords are per-install and stored beside
 * the encryption key.
 */
function ensureDatabasePassword(dataDir) {
  const secretsFile = path.join(dataDir, SECRETS_FILENAME);
  try {
    if (fs.existsSync(secretsFile)) {
      const parsed = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
      if (parsed && typeof parsed.surrealPassword === 'string' && parsed.surrealPassword.length > 0) {
        return parsed.surrealPassword;
      }
    }
  } catch (_) {
    // A corrupt secrets file is rewritten below rather than crashing startup.
  }
  const surrealPassword = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  writeSecretFile(secretsFile, `${JSON.stringify({ surrealPassword }, null, 2)}\n`);
  return surrealPassword;
}

const LEGACY_DATABASE_PASSWORD = 'root';
const DATABASE_DIRNAME = 'surrealdb';
const DATABASE_FILENAME = 'mydatabase.db';

/** True when `dataDir` already holds a SurrealDB datastore from an earlier run. */
function hasExistingDatastore(dataDir) {
  const file = path.join(dataDir, DATABASE_DIRNAME, DATABASE_FILENAME);
  try {
    // A zero-byte placeholder holds no stored root credentials, so SurrealDB
    // initializes it fresh and the generated password does apply. Only a
    // non-empty datastore can lock the backend out.
    return fs.statSync(file).size > 0;
  } catch (_) {
    return false;
  }
}

/**
 * Resolves the SurrealDB credentials to start the database with.
 *
 * SurrealDB applies `--user`/`--pass` *only when no root user exists yet*, so a
 * freshly generated password has no effect on a datastore created by an older
 * build: the stored root credentials win and the backend would be locked out of
 * its own data. Existing datastores therefore keep their original password so
 * upgrades never lose notebook content; only new installs get a random one.
 *
 * @returns {{ user: string, password: string, legacy: boolean }}
 */
function resolveDatabaseCredentials(dataDir) {
  const secretsFile = path.join(dataDir, SECRETS_FILENAME);
  if (hasExistingDatastore(dataDir) && !fs.existsSync(secretsFile)) {
    return { user: 'root', password: LEGACY_DATABASE_PASSWORD, legacy: true };
  }
  return { user: 'root', password: ensureDatabasePassword(dataDir), legacy: false };
}

/**
 * Returns the persisted encryption key for `dataDir`, generating a 32-byte
 * random key on first use.
 *
 * @param {string} dataDir Directory holding the app's user data.
 */
function ensureEncryptionKey(dataDir) {
  const keyFile = path.join(dataDir, KEY_FILENAME);
  if (fs.existsSync(keyFile)) {
    return fs.readFileSync(keyFile, 'utf8').trim();
  }
  const key = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  writeSecretFile(keyFile, key);
  return key;
}

module.exports = {
  ensureEncryptionKey,
  ensureDatabasePassword,
  resolveDatabaseCredentials,
  hasExistingDatastore,
  restrictToCurrentUser,
  KEY_FILENAME,
  SECRETS_FILENAME,
  LEGACY_DATABASE_PASSWORD,
};
