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
 * The restriction is enforced, not best effort: a secrets file whose owner-only
 * ACL cannot be established is reported as an error rather than used.
 *
 * Credential states
 * -----------------
 * Every host classifies an install into one of four states, defined by the
 * shared fixture in `tests/contracts/credentials-cases.json`:
 *
 *   - `generated`          — a fresh install; a random password was created.
 *   - `stored`             — the password was read back from `secrets.json`.
 *   - `migrated`           — provisioned by the one-time migration described
 *                            in `credential-migration.js`.
 *   - `legacy-unmigrated`  — a datastore exists but `secrets.json` does not, so
 *                            the install predates per-install credentials and
 *                            has not been migrated yet.
 *
 * The last state carries *no* password. Returning the fixed `root` string
 * would hide the legacy case behind a value that looks like a real credential;
 * callers have to handle migration explicitly instead (see
 * `docs/compliance/ferpa/CREDENTIAL_STORE_HANDOFF.md`).
 *
 * Failure modes
 * -------------
 * A secrets file that cannot be parsed, decoded or validated is *reported* and
 * left byte-for-byte untouched. Silently rewriting it would destroy the only
 * copy of a credential that may still be the one the datastore accepts.
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
 * Stable identifiers for the credential states and failure modes.
 *
 * These strings are part of the cross-host contract: `legacy-unmigrated`,
 * `stored` and `generated` are the `source` values, and the error codes are
 * asserted against the shared fixture in every host's test suite.
 */
const CREDENTIAL_SOURCE_LEGACY_UNMIGRATED = 'legacy-unmigrated';
const CREDENTIAL_SOURCE_STORED = 'stored';
const CREDENTIAL_SOURCE_GENERATED = 'generated';
/** Provisioned by a one-time migration of a datastore that predates per-install credentials. */
const CREDENTIAL_SOURCE_MIGRATED = 'migrated';

const CREDENTIAL_ERROR_INVALID_SECRETS_FILE = 'invalid-secrets-file';
const CREDENTIAL_ERROR_INVALID_SECRET_VALUE = 'invalid-secret-value';
const CREDENTIAL_ERROR_PERMISSIONS_TOO_OPEN = 'permissions-too-open';
const CREDENTIAL_ERROR_DATASTORE_UNREADABLE = 'datastore-unreadable';
/** The datastore exists but does not accept the credential the migration offered it. */
const CREDENTIAL_ERROR_MIGRATION_REJECTED = 'migration-rejected';

/**
 * Thrown when the credential store cannot be used safely.
 *
 * Carries a stable `code` so launchers can render host-appropriate guidance
 * without matching on message text, and so the tests can assert the contract
 * rather than a sentence.
 */
class CredentialError extends Error {
  /**
   * @param {string} message Operator-facing explanation.
   * @param {string} code One of the `CREDENTIAL_ERROR_*` identifiers.
   * @param {string} [path] The file or directory the error concerns.
   */
  constructor(message, code, path) {
    super(message);
    this.name = 'CredentialError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

// The fixed password written by builds that predate per-install credentials is
// deliberately not defined here. The one place that may name it is the
// migration probe in `credential-migration.js`, which offers it to an existing
// datastore once to decide whether that datastore is a legacy one. No
// resolution path can return it: `resolveDatabaseCredentials` reports
// `legacy-unmigrated` with a null password instead, so a caller that forgets to
// handle migration fails loudly rather than quietly connecting as `root`.

/** The SurrealDB root username. Fixed, because it is not itself a secret. */
const DATABASE_USER = 'root';

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
 * Draws `size` random bytes, validating the generator's output.
 *
 * A silent RNG failure — a short or non-buffer return — would otherwise be
 * stored as a plausible-looking but predictable credential.
 *
 * @param {number} size
 * @returns {Buffer}
 */
function randomSecretBytes(size) {
  const bytes = crypto.randomBytes(size);
  if (!Buffer.isBuffer(bytes) || bytes.length !== size) {
    throw new CredentialError(
      'Secure random credential generation returned an invalid result',
      CREDENTIAL_ERROR_INVALID_SECRET_VALUE
    );
  }
  return bytes;
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
 * Reports whether an `icacls` listing shows a secrets file restricted to a
 * single, non-inherited ACE.
 *
 * `icacls` prints one ACE per line: the file name followed by the account and
 * the permission set, then the inherited/permission flags in parentheses.
 * Continued lines for the same file are indented. Three shapes have to be
 * rejected, and all three carry a marker that a restricted file never has:
 *
 *   - `(I)` on any ACE means the entry is inherited from the parent
 *     directory, so at least that account can read the secret.
 *   - `(R)`, `(M)` or `(F)` on any ACE other than the current user's means
 *     another principal was granted access explicitly.
 *   - No ACE at all means the ACL could not be read, so restriction cannot be
 *     proven.
 *
 * The command also emits `The trust relationship between this workstation and
 * the primary domain failed.` on domain-joined machines whose DC is
 * unreachable. That line is a diagnostic, not an ACE, and is ignored.
 *
 * @param {string} output Raw stdout from `icacls <file>`.
 * @returns {boolean} True when the file is readable by one non-inherited ACE.
 */
function isRestrictedAclListing(output) {
  if (typeof output !== 'string') return false;
  const aceLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith('Successfully processed') &&
        !line.startsWith('Failed processing') &&
        !line.startsWith('The trust relationship') &&
        // A mandatory integrity label is not a DACL entry; it appears when the
        // process is elevated and must not be read as an extra principal.
        !line.startsWith('Mandatory Label')
    );
  // `icacls` lists one ACE per line, so a restricted file has exactly one.
  if (aceLines.length !== 1) return false;
  const ace = aceLines[0];
  // An inherited entry means the parent directory's accounts keep their
  // access, which is exactly what the restriction exists to remove.
  if (ace.includes('(I)')) return false;
  // `icacls` renders a full-control grant as a trailing `(F)`.
  return ace.endsWith('(F)');
}

/**
 * Reports whether a POSIX mode is owner-only.
 *
 * @param {number} mode Permission bits, as returned by `fs.statSync().mode`
 *   or set explicitly for a fixture sample.
 * @returns {boolean}
 */
function isRestrictedPosixMode(mode) {
  return typeof mode === 'number' && (mode & 0o077) === 0;
}

/**
 * Applies the owner-only restriction to `file` and proves that it took effect.
 *
 * Unlike a best-effort `chmod`, this re-reads the resulting ACL and fails when
 * it is still readable by another principal. The distinction matters: the two
 * files this protects hold the key that decrypts every stored provider API key
 * and the database root password, so "we tried" is not an acceptable answer.
 *
 * @param {string} file
 * @returns {boolean} True when the file is provably owner-only afterwards.
 */
function restrictToCurrentUser(file) {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
    } catch (_) {
      return false;
    }
    return checkRestrictedToCurrentUser(file);
  }
  try {
    const user = currentUsername();
    if (!user) return false;
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (_) {
    return false;
  }
  return checkRestrictedToCurrentUser(file);
}

/**
 * Reports whether `file` is currently readable only by the current OS user.
 *
 * This is the enforced check: writers call it after restricting, and readers
 * call it before trusting an existing file, so a secrets file left world
 * readable by a previous release or by a manual copy is caught on next start.
 *
 * @param {string} file
 * @returns {boolean}
 */
function checkRestrictedToCurrentUser(file) {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('icacls', [file], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return isRestrictedAclListing(output);
    }
    return isRestrictedPosixMode(fs.statSync(file).mode & 0o777);
  } catch (_) {
    return false;
  }
}

/**
 * Reports `file` as an invalid secrets file when it is a symlink/junction or
 * any other non-regular entry.
 *
 * Credential paths are private files owned by this install. A planted redirect
 * must not be followed to capture a secret written through it or to feed a
 * forged secret back to the application.
 *
 * @param {string} file
 */
function rejectNonRegularEntry(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw new CredentialError(
      `Could not inspect ${path.basename(file)}`,
      CREDENTIAL_ERROR_INVALID_SECRETS_FILE,
      file
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CredentialError(
      `${path.basename(file)} is not a regular file`,
      CREDENTIAL_ERROR_INVALID_SECRETS_FILE,
      file
    );
  }
}

/**
 * Writes `contents` to `file` with protected-before-write semantics.
 *
 * The file is created exclusively (failing when it already exists), the
 * owner-only restriction is established while the file is still empty, and
 * only then are the secret bytes written and flushed. A plain
 * write-then-restrict leaves a window in which the plaintext secret exists on
 * disk readable by other principals. An `EEXIST` from the exclusive create is
 * reported rather than overwritten: the existing bytes may be the only copy of
 * a credential the datastore still accepts.
 *
 * @param {string} file
 * @param {string} contents
 */
function writeSecretFile(file, contents) {
  rejectNonRegularEntry(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      throw new CredentialError(
        `${path.basename(file)} already exists and was not created by this run; recovery is required`,
        CREDENTIAL_ERROR_INVALID_SECRETS_FILE,
        file
      );
    }
    throw new CredentialError(
      `Could not create ${path.basename(file)}`,
      CREDENTIAL_ERROR_INVALID_SECRETS_FILE,
      file
    );
  }
  try {
    // No secret bytes are written until protection succeeds.
    if (!restrictToCurrentUser(file)) {
      throw new CredentialError(
        `Could not restrict ${path.basename(file)} to the current user`,
        CREDENTIAL_ERROR_PERMISSIONS_TOO_OPEN,
        file
      );
    }
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Reads a secrets file, enforcing that it is owner-only.
 *
 * The permission check happens before the contents are used so a secret that
 * another account may already have read is never treated as trustworthy.
 *
 * @param {string} file
 * @returns {string | null} The contents, or null when the file is absent.
 */
function readProtectedSecretFile(file) {
  rejectNonRegularEntry(file);
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new CredentialError('Could not read credential file', CREDENTIAL_ERROR_INVALID_SECRETS_FILE, file);
  }
  if (!checkRestrictedToCurrentUser(file)) {
    throw new CredentialError(
      `${path.basename(file)} is readable by accounts other than the current user`,
      CREDENTIAL_ERROR_PERMISSIONS_TOO_OPEN,
      file
    );
  }
  return contents;
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
 * Decodes a stored secret value with validation.
 *
 * Mirrors the Rust `decode_checked`: a value carrying the obfuscation prefix
 * must be valid base64, must decode to valid UTF-8, and must be a non-empty
 * string free of control characters. Anything else is reported rather than
 * passed on, because a mangled password produces an unactionable connection
 * failure much later in startup.
 *
 * @param {string} stored
 * @returns {string}
 */
function decodeSecretChecked(stored) {
  const raw = String(stored).trim();
  let decoded;
  if (raw.startsWith(OBFUSCATION_PREFIX)) {
    const payload = raw.slice(OBFUSCATION_PREFIX.length);
    if (!isStrictBase64(payload)) {
      throw new CredentialError('Invalid encoded credential', CREDENTIAL_ERROR_INVALID_SECRET_VALUE);
    }
    const bytes = xorObfuscate(Buffer.from(payload, 'base64'), deriveObfuscationKey());
    decoded = bytes.toString('utf8');
    // `toString('utf8')` substitutes U+FFFD for invalid sequences rather than
    // throwing, so a round-trip check is the only reliable UTF-8 validation.
    if (!Buffer.from(decoded, 'utf8').equals(bytes)) {
      throw new CredentialError('Invalid credential encoding', CREDENTIAL_ERROR_INVALID_SECRET_VALUE);
    }
  } else {
    decoded = raw;
  }
  if (!isUsableSecretValue(decoded)) {
    throw new CredentialError('Invalid credential value', CREDENTIAL_ERROR_INVALID_SECRET_VALUE);
  }
  return decoded;
}

/**
 * True when `value` is a non-empty string without control characters.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isUsableSecretValue(value) {
  return typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/**
 * True when `value` is base64 that round-trips unchanged.
 *
 * `Buffer.from(value, 'base64')` never throws: it silently drops characters it
 * does not recognise, so a corrupted payload would otherwise decode to a
 * plausible-looking but wrong secret.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isStrictBase64(value) {
  if (value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
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
 * The answer decides whether a missing secrets file is a fresh install or a
 * legacy one, so an inspection error is reported rather than read as "no
 * datastore": guessing there would overwrite a live installation's password.
 *
 * @param {string} dataDir
 * @returns {boolean}
 */
function hasExistingDatastore(dataDir) {
  const dbDir = path.join(dataDir, DATABASE_DIRNAME);
  const file = path.join(dbDir, DATABASE_FILENAME);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      throw new CredentialError('Could not inspect datastore', CREDENTIAL_ERROR_DATASTORE_UNREADABLE, file);
    }
    // The file is absent. The directory itself still has to be inspectable:
    // a directory that exists but cannot be listed hides a legacy datastore
    // just as effectively as an unreadable file does.
    try {
      fs.readdirSync(dbDir);
    } catch (dirError) {
      if (dirError && dirError.code === 'ENOENT') return false;
      throw new CredentialError('Could not inspect datastore', CREDENTIAL_ERROR_DATASTORE_UNREADABLE, dbDir);
    }
    return false;
  }
  if (!stat.isDirectory()) return stat.size > 0;
  try {
    return fs.readdirSync(file).length > 0;
  } catch (_) {
    throw new CredentialError('Could not inspect datastore', CREDENTIAL_ERROR_DATASTORE_UNREADABLE, file);
  }
}

/**
 * Returns the persisted database password for `dataDir`, generating one on
 * first use.
 *
 * A secrets file that cannot be parsed or decoded is reported and left
 * untouched: it may still hold the only copy of the password the datastore
 * accepts, and rewriting it would turn a recoverable problem into a lockout.
 * The `legacy-unmigrated` case is signalled by `resolveDatabaseCredentials`,
 * not here.
 *
 * @param {string} dataDir
 * @returns {string}
 */
function ensureDatabasePassword(dataDir) {
  const secretsFile = path.join(dataDir, SECRETS_FILENAME);
  const contents = readProtectedSecretFile(secretsFile);
  if (contents !== null) {
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch (_) {
      throw new CredentialError(
        'Invalid database credential file',
        CREDENTIAL_ERROR_INVALID_SECRETS_FILE,
        secretsFile
      );
    }
    const stored = parsed && typeof parsed === 'object' ? parsed.surrealPassword : undefined;
    if (typeof stored !== 'string' || stored.length === 0) {
      throw new CredentialError(
        'Invalid database credential file',
        CREDENTIAL_ERROR_INVALID_SECRETS_FILE,
        secretsFile
      );
    }
    return decodeSecretChecked(stored);
  }
  if (hasExistingDatastore(dataDir)) {
    throw new CredentialError(
      'Existing datastore has no credential file; recovery is required',
      CREDENTIAL_ERROR_INVALID_SECRETS_FILE,
      secretsFile
    );
  }
  const surrealPassword = randomSecretBytes(DATABASE_PASSWORD_BYTES).toString('base64url');
  writeSecretFile(
    secretsFile,
    `${JSON.stringify({ surrealPassword: encodeSecret(surrealPassword) }, null, 2)}\n`
  );
  return surrealPassword;
}

/**
 * Resolves the SurrealDB credentials to start the database with.
 *
 * SurrealDB applies the initial root credentials only when no root user exists
 * yet, so a freshly generated password has no effect on a datastore created by
 * an older build. Every host therefore reports one of three states:
 *
 *   - `generated`         — fresh install, random password created.
 *   - `stored`            — password read back from `secrets.json`.
 *   - `legacy-unmigrated` — datastore exists, no secrets file. The install
 *                           predates per-install credentials and must be
 *                           migrated before it can start; no password is
 *                           returned, and `migrationRequired` is true.
 *
 * This function is deliberately offline: it reads files and nothing else. The
 * migration that a `legacy-unmigrated` result calls for lives in
 * `credential-migration.js`, which needs a live datastore.
 *
 * @param {string} dataDir
 * @returns {{ user: string, password: string | null, migrationRequired: boolean, source: string }}
 */
function resolveDatabaseCredentials(dataDir) {
  const secretsFile = path.join(dataDir, SECRETS_FILENAME);
  const hadSecrets = fs.existsSync(secretsFile);
  if (!hadSecrets && hasExistingDatastore(dataDir)) {
    return {
      user: DATABASE_USER,
      password: null,
      migrationRequired: true,
      source: CREDENTIAL_SOURCE_LEGACY_UNMIGRATED,
    };
  }
  const password = ensureDatabasePassword(dataDir);
  return {
    user: DATABASE_USER,
    password,
    migrationRequired: false,
    source: hadSecrets ? CREDENTIAL_SOURCE_STORED : CREDENTIAL_SOURCE_GENERATED,
  };
}

/**
 * Returns the persisted encryption key for `dataDir`, generating a random
 * 32-byte key on first use.
 *
 * The key is stored obfuscated so it never appears in plaintext on disk.
 * Legacy plaintext key files are still readable, but any stored key must have
 * the documented shape: decrypting every saved provider API key with a
 * truncated or non-hex value would fail long after startup reported success.
 *
 * @param {string} dataDir Directory holding the app's user data.
 * @returns {string}
 */
function ensureEncryptionKey(dataDir) {
  const keyFile = path.join(dataDir, KEY_FILENAME);
  const contents = readProtectedSecretFile(keyFile);
  if (contents !== null) {
    const existing = decodeSecretChecked(contents);
    if (existing.length !== ENCRYPTION_KEY_BYTES * 2 || !/^[0-9a-fA-F]+$/.test(existing)) {
      throw new CredentialError('Invalid encryption key', CREDENTIAL_ERROR_INVALID_SECRET_VALUE, keyFile);
    }
    return existing;
  }
  if (hasExistingDatastore(dataDir)) {
    throw new CredentialError(
      'Existing datastore has no encryption key; recovery is required',
      CREDENTIAL_ERROR_INVALID_SECRETS_FILE,
      keyFile
    );
  }
  const key = randomSecretBytes(ENCRYPTION_KEY_BYTES).toString('hex');
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
 * A missing password is an error, not a default. Substituting the legacy
 * `root` password here is what previously made the legacy case invisible.
 *
 * @param {{ user?: string, password?: string | null }} credentials
 * @returns {{ SURREAL_USER: string, SURREAL_PASSWORD: string, SURREAL_PASS: string }}
 */
function buildCredentialEnvironment(credentials) {
  const user = credentials && credentials.user ? credentials.user : DATABASE_USER;
  const password = credentials ? credentials.password : null;
  if (!isUsableSecretValue(password)) {
    throw new CredentialError(
      'No database password available; credential migration is required',
      CREDENTIAL_ERROR_INVALID_SECRET_VALUE
    );
  }
  return {
    SURREAL_USER: user,
    SURREAL_PASSWORD: password,
    SURREAL_PASS: password,
  };
}

/**
 * Builds operator-facing guidance for a credential failure.
 *
 * Each state has a distinct remedy, and the generic "review the service
 * lifecycle diagnostics" message would send users to logs that cannot contain
 * the fix. The messages are deliberately free of secret material. Non-credential
 * errors fall through to the generic launcher guidance.
 *
 * @param {unknown} error The thrown error, which may carry a `code`.
 * @returns {string}
 */
function credentialStartupMessage(error) {
  switch (error && error.code) {
    case CREDENTIAL_ERROR_INVALID_SECRETS_FILE:
      return (
        'The saved database credentials for this installation could not be read. ' +
        'They have been left untouched so the existing notebook data is not put out of reach. ' +
        'Restore the credentials file from a backup, or contact your administrator to run credential recovery.'
      );
    case CREDENTIAL_ERROR_INVALID_SECRET_VALUE:
      return (
        'The saved database credential for this installation is not a valid value. ' +
        'It has been left untouched so the existing notebook data is not put out of reach. ' +
        'Contact your administrator to run credential recovery.'
      );
    case CREDENTIAL_ERROR_PERMISSIONS_TOO_OPEN:
      return (
        'The saved database credentials are readable by other users on this computer. ' +
        'The file has been left untouched. Restrict its permissions to your own account, or contact your administrator.'
      );
    case CREDENTIAL_ERROR_DATASTORE_UNREADABLE:
      return (
        'The notebook database could not be inspected. Check that no other process is using it, then try again.'
      );
    default:
      return 'SERVICE_STARTUP_FAILED: Review the service lifecycle diagnostics.';
  }
}

module.exports = {
  ensureEncryptionKey,
  ensureDatabasePassword,
  resolveDatabaseCredentials,
  hasExistingDatastore,
  restrictToCurrentUser,
  checkRestrictedToCurrentUser,
  isRestrictedAclListing,
  isRestrictedPosixMode,
  buildCredentialEnvironment,
  deriveObfuscationKey,
  deriveObfuscationKeyFrom,
  xorObfuscate,
  encodeSecret,
  decodeSecret,
  decodeSecretChecked,
  isStrictBase64,
  isUsableSecretValue,
  writeSecretFile,
  readProtectedSecretFile,
  readEncryptionKeyFile,
  writeEncryptionKeyFile,
  stripUserDomain,
  currentUsername,
  currentHostname,
  CredentialError,
  KEY_FILENAME,
  SECRETS_FILENAME,
  DATABASE_USER,
  DATABASE_DIRNAME,
  DATABASE_FILENAME,
  OBFUSCATION_PREFIX,
  OBFUSCATION_SALT,
  ENCRYPTION_KEY_BYTES,
  DATABASE_PASSWORD_BYTES,
  CREDENTIAL_SOURCE_LEGACY_UNMIGRATED,
  CREDENTIAL_SOURCE_STORED,
  CREDENTIAL_SOURCE_GENERATED,
  CREDENTIAL_SOURCE_MIGRATED,
  CREDENTIAL_ERROR_INVALID_SECRETS_FILE,
  CREDENTIAL_ERROR_INVALID_SECRET_VALUE,
  CREDENTIAL_ERROR_PERMISSIONS_TOO_OPEN,
  CREDENTIAL_ERROR_DATASTORE_UNREADABLE,
  CREDENTIAL_ERROR_MIGRATION_REJECTED,
  credentialStartupMessage,
};
