'use strict';

/**
 * lib/credentials.js — shared on-disk secret storage for every desktop host.
 *
 * The Electron launcher, the headless CLI, the Rust/Tauri host, the Go/Wails
 * host and the C#/WinUI host all need the same two secrets, in the same
 * format, so that a user data directory can be moved between hosts:
 *
 *   1. `encryption-key.txt` — the key that encrypts provider API keys.
 *   2. `secrets.json`       — the SurrealDB root password.
 *
 * This module is the canonical implementation. `src/contracts/credentials.ts`
 * is a typed facade over it, and the Rust, Go and C# hosts implement the same
 * on-disk format natively (see the cross-language notes on each format).
 *
 * Security model
 * --------------
 * A fixed `root`/`root` credential on a loopback-bound service is not a
 * defense: any other process or account on the machine can reach the local
 * port and read the whole notebook database. Each install therefore gets its
 * own randomly generated database password.
 *
 * Secrets are stored obfuscated (XOR with a machine-and-user-bound
 * derivation) rather than in plaintext, and the files are restricted to the
 * current OS user via ACLs. This is deliberately not presented as equivalent
 * to a hardware-backed key store; it raises the bar against casual reads by
 * other processes and avoids the plaintext-secret-file pattern that
 * endpoint-protection software flags. It does not defend against an attacker
 * who already runs as the current user.
 *
 * Legacy installs
 * ---------------
 * SurrealDB applies the initial root credentials *only when no root user
 * exists yet*. A datastore created by an older build already has a root user,
 * so a newly generated password has no effect and the backend would be locked
 * out of its own data. Existing datastores therefore keep their original
 * `root` password until the operator explicitly rotates it; only fresh
 * installs receive a random one.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');

/** File holding the obfuscated provider-API-key encryption key. */
const KEY_FILENAME = 'encryption-key.txt';
/** File holding the obfuscated SurrealDB root password. */
const SECRETS_FILENAME = 'secrets.json';
/** The root password used by builds that predate per-install credentials. */
const LEGACY_DATABASE_PASSWORD = 'root';
/** The SurrealDB root username. Fixed, because it is not itself a secret. */
const DATABASE_USER = 'root';

/** Directory and file names of the SurrealDB datastore, relative to the data dir. */
const DATABASE_DIRNAME = 'surrealdb';
const DATABASE_FILENAME = 'mydatabase.db';

/** Marker prefix identifying an obfuscated value in a secret file. */
const OBFUSCATION_PREFIX = 'obf:';
/** App-specific salt mixed into the obfuscation key derivation. */
const OBFUSCATION_SALT = 'Office-Equity-Open-Notebook';

/** Length in bytes of the generated encryption key. */
const ENCRYPTION_KEY_BYTES = 32;
/** Length in bytes of the generated database password. */
const DATABASE_PASSWORD_BYTES = 24;

/**
 * Strips a domain qualifier from an account name.
 *
 * Windows APIs disagree about whether the account name is domain-qualified:
 * `GetUserNameW` reports `cruzmars` while `user.Current()` in Go reports
 * `UNIVERSITY\cruzmars`. The obfuscation key has to be identical across all
 * five hosts, so the domain qualifier is removed everywhere.
 *
 * @param {unknown} name
 * @returns {string}
 */
function stripUserDomain(name) {
  const raw = typeof name === 'string' ? name.trim() : '';
  if (!raw) return '';
  const cut = Math.max(raw.lastIndexOf('\\'), raw.lastIndexOf('/'));
  return cut >= 0 ? raw.slice(cut + 1).trim() : raw;
}

/**
 * The current OS user name, or an empty string when it cannot be determined.
 *
 * The environment is consulted first because every host can read it, whereas
 * the OS account APIs differ in what they return (see `stripUserDomain`).
 * The order is fixed so that all five hosts resolve the same value:
 * `USERNAME`, then `USER`, then the OS account API.
 *
 * @returns {string}
 */
function currentUsername() {
  const fromEnv = stripUserDomain(process.env.USERNAME) || stripUserDomain(process.env.USER);
  if (fromEnv) return fromEnv;
  try {
    const info = os.userInfo();
    if (info) {
      const fromApi = stripUserDomain(info.username);
      if (fromApi) return fromApi;
    }
  } catch (_) {
    // os.userInfo() can fail in restricted sandboxes; fall through.
  }
  return '';
}

/**
 * The current machine name, or an empty string when it cannot be determined.
 *
 * The order is fixed so that all five hosts resolve the same value:
 * `COMPUTERNAME`, then `HOSTNAME`, then the OS API.
 *
 * @returns {string}
 */
function currentHostname() {
  const fromEnv =
    typeof process.env.COMPUTERNAME === 'string' ? process.env.COMPUTERNAME.trim() : '';
  if (fromEnv) return fromEnv;
  const hostEnv = typeof process.env.HOSTNAME === 'string' ? process.env.HOSTNAME.trim() : '';
  if (hostEnv) return hostEnv;
  try {
    const name = os.hostname();
    if (typeof name === 'string' && name.trim()) return name.trim();
  } catch (_) {
    // os.hostname() can fail in restricted sandboxes; fall through.
  }
  return '';
}

/**
 * Derives the obfuscation key for secret files.
 *
 * The key is the SHA-256 of a fixed app salt, the current OS user name and
 * the machine name, joined by `|`. Tying the derivation to both the account
 * and the machine means a copied secret file does not decode elsewhere.
 *
 * The exact derivation string is part of the cross-language on-disk contract
 * and must stay byte-for-byte identical in the Rust, Go and C# hosts:
 *
 *     SHA-256("Office-Equity-Open-Notebook|<username>|<hostname>")
 *
 * @returns {Buffer} A 32-byte obfuscation key.
 */
function deriveObfuscationKey() {
  return deriveObfuscationKeyFrom(currentUsername(), currentHostname());
}

/**
 * Derives the obfuscation key for an explicit account and machine name.
 *
 * Exposed so that the cross-language parity tests can check a fixed vector
 * instead of depending on the machine the tests happen to run on.
 *
 * @param {string} username
 * @param {string} hostname
 * @returns {Buffer} A 32-byte obfuscation key.
 */
function deriveObfuscationKeyFrom(username, hostname) {
  const parts = [OBFUSCATION_SALT, username || '', hostname || ''];
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest();
}

/**
 * XOR-obfuscates data with the machine-bound key. The transform is symmetric:
 * applying it twice restores the original bytes.
 *
 * @param {Buffer|string} data
 * @param {Buffer} key
 * @returns {Buffer}
 */
function xorObfuscate(data, key) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    out[i] = buf[i] ^ key[i % key.length];
  }
  return out;
}

/**
 * Restricts a file to the current OS user.
 *
 * These files hold the key that protects stored provider API keys and the
 * database root password. `writeFileSync` inherits the parent directory's
 * permissions, which on Windows means other accounts on a shared machine can
 * read them. `icacls` is the supported way to drop the inherited entries.
 *
 * This is best effort by design: a failure here must never stop the app from
 * starting, so every error is swallowed.
 *
 * @param {string} file
 * @returns {boolean} True when the ACL was applied.
 */
function restrictToCurrentUser(file) {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
      return true;
    } catch (_) {
      // Best effort: a failure here must not stop the app from starting.
      return false;
    }
  }
  try {
    const user = process.env.USERNAME;
    if (!user) return false;
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch (_) {
    // Best effort: the file exists, so the app still works even if the ACL
    // could not be tightened.
    return false;
  }
}

/**
 * Writes `contents` to `file` and restricts it to the current OS user.
 *
 * @param {string} file
 * @param {string} contents
 */
function writeSecretFile(file, contents) {
  fs.writeFileSync(file, contents, 'utf8');
  restrictToCurrentUser(file);
}

/**
 * Obfuscates a secret and encodes it for storage.
 *
 * @param {string} secret
 * @returns {string} `obf:` followed by base64 of the obfuscated bytes.
 */
function encodeSecret(secret) {
  const obfuscated = xorObfuscate(secret, deriveObfuscationKey());
  return `${OBFUSCATION_PREFIX}${obfuscated.toString('base64')}`;
}

/**
 * Decodes a stored secret value.
 *
 * Values written before the obfuscated format existed are stored in plaintext
 * and are returned unchanged, so existing installs keep working.
 *
 * @param {string} stored
 * @returns {string}
 */
function decodeSecret(stored) {
  const raw = String(stored).trim();
  if (!raw.startsWith(OBFUSCATION_PREFIX)) {
    return raw;
  }
  const obfuscated = Buffer.from(raw.slice(OBFUSCATION_PREFIX.length), 'base64');
  return xorObfuscate(obfuscated, deriveObfuscationKey()).toString('utf8');
}

/**
 * Writes the encryption key, obfuscated, to `file`.
 *
 * @param {string} file
 * @param {string} key
 */
function writeEncryptionKeyFile(file, key) {
  writeSecretFile(file, encodeSecret(key));
}

/**
 * Reads the encryption key from `file`.
 *
 * @param {string} file
 * @returns {string}
 */
function readEncryptionKeyFile(file) {
  return decodeSecret(fs.readFileSync(file, 'utf8'));
}

/**
 * True when `dataDir` already holds a SurrealDB datastore from an earlier run.
 *
 * RocksDB stores its datastore in a directory, which reports a size of 0 on
 * Windows, so both shapes have to be checked.
 *
 * @param {string} dataDir
 * @returns {boolean}
 */
function hasExistingDatastore(dataDir) {
  const file = path.join(dataDir, DATABASE_DIRNAME, DATABASE_FILENAME);
  try {
    const st = fs.statSync(file);
    if (st.isDirectory()) {
      return fs.readdirSync(file).length > 0;
    }
    return st.size > 0;
  } catch (_) {
    return false;
  }
}

/**
 * Returns the persisted database password for `dataDir`, generating one on
 * first use.
 *
 * @param {string} dataDir
 * @returns {string}
 */
function ensureDatabasePassword(dataDir) {
  const secretsFile = path.join(dataDir, SECRETS_FILENAME);
  try {
    if (fs.existsSync(secretsFile)) {
      const parsed = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
      if (parsed && typeof parsed.surrealPassword === 'string' && parsed.surrealPassword.length > 0) {
        return decodeSecret(parsed.surrealPassword);
      }
    }
  } catch (_) {
    // A corrupt secrets file is rewritten below rather than crashing startup.
  }
  const surrealPassword = crypto.randomBytes(DATABASE_PASSWORD_BYTES).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  writeSecretFile(
    secretsFile,
    `${JSON.stringify({ surrealPassword: encodeSecret(surrealPassword) }, null, 2)}\n`
  );
  return surrealPassword;
}

/**
 * Resolves the SurrealDB credentials to start the database with.
 *
 * SurrealDB applies the initial root credentials only when no root user
 * exists yet, so a freshly generated password has no effect on a datastore
 * created by an older build: the stored root credentials win and the backend
 * would be locked out of its own data. Existing datastores therefore keep
 * their original password so upgrades never lose notebook content; only new
 * installs get a random one.
 *
 * @param {string} dataDir
 * @returns {{ user: string, password: string, legacy: boolean, source: 'legacy' | 'generated' | 'stored' }}
 */
function resolveDatabaseCredentials(dataDir) {
  const secretsFile = path.join(dataDir, SECRETS_FILENAME);
  const hadSecrets = fs.existsSync(secretsFile);
  if (hasExistingDatastore(dataDir) && !hadSecrets) {
    return {
      user: DATABASE_USER,
      password: LEGACY_DATABASE_PASSWORD,
      legacy: true,
      source: 'legacy',
    };
  }
  const password = ensureDatabasePassword(dataDir);
  return {
    user: DATABASE_USER,
    password,
    legacy: false,
    source: hadSecrets ? 'stored' : 'generated',
  };
}

/**
 * Returns the persisted encryption key for `dataDir`, generating a random
 * 32-byte key on first use.
 *
 * The key is stored obfuscated so it never appears in plaintext on disk.
 * Legacy plaintext key files are still readable, but new keys use the
 * obfuscated format.
 *
 * @param {string} dataDir Directory holding the app's user data.
 * @returns {string}
 */
function ensureEncryptionKey(dataDir) {
  const keyFile = path.join(dataDir, KEY_FILENAME);
  if (fs.existsSync(keyFile)) {
    const existing = readEncryptionKeyFile(keyFile);
    if (existing) return existing;
  }
  const key = crypto.randomBytes(ENCRYPTION_KEY_BYTES).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  writeEncryptionKeyFile(keyFile, key);
  return key;
}

/**
 * Builds the environment variables that carry the database credentials to the
 * SurrealDB server and the Python backend.
 *
 * SurrealDB's own CLI reads `SURREAL_USER` and `SURREAL_PASS`. The upstream
 * backend reads `SURREAL_USER` and `SURREAL_PASSWORD`, falling back to
 * `SURREAL_PASS`. Both are therefore set to the same value.
 *
 * The credentials are passed through the process environment rather than the
 * command line so they never appear in the process listing.
 *
 * @param {{ user: string, password: string }} credentials
 * @returns {{ SURREAL_USER: string, SURREAL_PASSWORD: string, SURREAL_PASS: string }}
 */
function buildCredentialEnvironment(credentials) {
  const user = credentials && credentials.user ? credentials.user : DATABASE_USER;
  const password =
    credentials && credentials.password ? credentials.password : LEGACY_DATABASE_PASSWORD;
  return {
    SURREAL_USER: user,
    SURREAL_PASSWORD: password,
    SURREAL_PASS: password,
  };
}

module.exports = {
  ensureEncryptionKey,
  ensureDatabasePassword,
  resolveDatabaseCredentials,
  hasExistingDatastore,
  restrictToCurrentUser,
  buildCredentialEnvironment,
  deriveObfuscationKey,
  deriveObfuscationKeyFrom,
  xorObfuscate,
  encodeSecret,
  decodeSecret,
  writeSecretFile,
  readEncryptionKeyFile,
  writeEncryptionKeyFile,
  stripUserDomain,
  currentUsername,
  currentHostname,
  KEY_FILENAME,
  SECRETS_FILENAME,
  LEGACY_DATABASE_PASSWORD,
  DATABASE_USER,
  DATABASE_DIRNAME,
  DATABASE_FILENAME,
  OBFUSCATION_PREFIX,
  OBFUSCATION_SALT,
  ENCRYPTION_KEY_BYTES,
  DATABASE_PASSWORD_BYTES,
};
