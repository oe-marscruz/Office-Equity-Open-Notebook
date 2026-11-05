'use strict';

// Shared storage format for the CLI/Electron hosts and the native implementations.
// Obfuscation preserves compatibility; it does not replace an OS secret store.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { isUtf8 } = require('node:buffer');
const { execFileSync } = require('child_process');

const KEY_FILENAME = 'encryption-key.txt';
const SECRETS_FILENAME = 'secrets.json';
const LEGACY_DATABASE_PASSWORD = 'root';
const DATABASE_USER = 'root';
const DATABASE_DIRNAME = 'surrealdb';
const DATABASE_FILENAME = 'mydatabase.db';
const OBFUSCATION_PREFIX = 'obf:';
const OBFUSCATION_SALT = 'Office-Equity-Open-Notebook';
const ENCRYPTION_KEY_BYTES = 32;
const DATABASE_PASSWORD_BYTES = 24;

class CredentialError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function fail(code) { throw new CredentialError(code); }
function stripUserDomain(name) {
  const raw = typeof name === 'string' ? name.trim() : '';
  const cut = Math.max(raw.lastIndexOf('\\'), raw.lastIndexOf('/'));
  return cut >= 0 ? raw.slice(cut + 1).trim() : raw;
}
function currentUsername() {
  const name = stripUserDomain(process.env.USERNAME) || stripUserDomain(process.env.USER);
  if (name) return name;
  try { return stripUserDomain(os.userInfo().username); } catch (_) { return ''; }
}
function currentHostname() {
  return (process.env.COMPUTERNAME || process.env.HOSTNAME || os.hostname()).trim();
}
function deriveObfuscationKeyFrom(username, hostname) {
  return crypto.createHash('sha256').update([OBFUSCATION_SALT, username || '', hostname || ''].join('|'), 'utf8').digest();
}
function deriveObfuscationKey() {
  const username = currentUsername(), hostname = currentHostname();
  if (!username || !hostname) fail('CREDENTIAL_STORE_UNAVAILABLE');
  return deriveObfuscationKeyFrom(username, hostname);
}
function xorObfuscate(data, key) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
  return out;
}
function validSecret(value) {
  return typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}
function encodeSecret(secret) {
  if (!validSecret(secret)) fail('CREDENTIALS_INVALID');
  return OBFUSCATION_PREFIX + xorObfuscate(secret, deriveObfuscationKey()).toString('base64');
}
function decodeSecret(stored) {
  if (typeof stored !== 'string') fail('CREDENTIAL_RECOVERY_REQUIRED');
  const raw = stored.trim();
  let secret = raw;
  if (raw.startsWith(OBFUSCATION_PREFIX)) {
    const payload = raw.slice(OBFUSCATION_PREFIX.length);
    const bytes = Buffer.from(payload, 'base64');
    if (!payload || bytes.toString('base64') !== payload) fail('CREDENTIAL_RECOVERY_REQUIRED');
    const decoded = xorObfuscate(bytes, deriveObfuscationKey());
    if (!isUtf8(decoded)) fail('CREDENTIAL_RECOVERY_REQUIRED');
    secret = decoded.toString('utf8');
  }
  if (!validSecret(secret)) fail('CREDENTIAL_RECOVERY_REQUIRED');
  return secret;
}

// Keep the script fixed. File paths travel as an environment value, never shell code.
const ACL_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$p = $env:OE_CREDENTIAL_ACL_FILE',
  '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
  '$acl = [System.Security.AccessControl.FileSecurity]::new()',
  '$acl.SetOwner($sid)',
  '$acl.SetAccessRuleProtection($true, $false)',
  '$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)',
  '$acl.AddAccessRule($rule)',
  '[System.IO.File]::SetAccessControl($p, $acl)',
  '$actual = [System.IO.File]::GetAccessControl($p)',
  '$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))',
  'if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].IsInherited -or $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { exit 1 }',
].join('; ');

function restrictToCurrentUser(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return false;
    if (process.platform !== 'win32') {
      fs.chmodSync(file, 0o600);
      const actual = fs.statSync(file);
      return (actual.mode & 0o777) === 0o600 && actual.uid === process.getuid();
    }
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT], {
      stdio: 'ignore', windowsHide: true, timeout: 15000,
      env: { ...process.env, OE_CREDENTIAL_ACL_FILE: file },
    });
    return true;
  } catch (_) { return false; }
}

// Dependencies are injected only by fixture tests; launchers use the default store.
function createCredentialStore(options = {}) {
  const io = options.fs || fs;
  const randomBytes = options.randomBytes || ((size) => crypto.randomBytes(size));
  const restrict = options.restrict || restrictToCurrentUser;

  function entry(file) {
    try {
      const st = io.lstatSync(file);
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) fail('CREDENTIAL_RECOVERY_REQUIRED');
      return st;
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      if (error instanceof CredentialError) throw error;
      fail('CREDENTIAL_STORE_UNAVAILABLE');
    }
  }
  function hasExistingDatastore(dataDir) {
    // Even an empty or partially initialized store cannot safely be assumed fresh.
    return entry(path.join(dataDir, DATABASE_DIRNAME, DATABASE_FILENAME)) !== null;
  }
  function readSecretFile(file) {
    const st = entry(file);
    if (!st) return null;
    if (!st.isFile()) fail('CREDENTIAL_RECOVERY_REQUIRED');
    if (!restrict(file)) fail('CREDENTIAL_STORE_UNAVAILABLE');
    try {
      const bytes = io.readFileSync(file);
      if (!isUtf8(bytes)) fail('CREDENTIAL_RECOVERY_REQUIRED');
      return bytes.toString('utf8');
    } catch (error) {
      if (error instanceof CredentialError) throw error;
      fail('CREDENTIAL_STORE_UNAVAILABLE');
    }
  }
  function writeSecretFile(file, contents) {
    let fd;
    try {
      fd = io.openSync(file, 'wx', 0o600);
      // No secret bytes are written until protection succeeds.
      if (!restrict(file)) fail('CREDENTIAL_STORE_UNAVAILABLE');
      io.writeFileSync(fd, contents, 'utf8');
      io.fsyncSync(fd);
      io.closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) { try { io.closeSync(fd); } catch (_) {} }
      // Preserve a failed reservation for recovery rather than overwriting it later.
      if (error instanceof CredentialError) throw error;
      fail(error && error.code === 'EEXIST' ? 'CREDENTIAL_RECOVERY_REQUIRED' : 'CREDENTIAL_STORE_UNAVAILABLE');
    }
  }
  function randomSecret(size, encoding) {
    try {
      const bytes = randomBytes(size);
      if (!Buffer.isBuffer(bytes) || bytes.length !== size) fail('CREDENTIAL_RANDOMNESS_UNAVAILABLE');
      return bytes.toString(encoding);
    } catch (_) { fail('CREDENTIAL_RANDOMNESS_UNAVAILABLE'); }
  }
  function makeDirectory(dir) {
    try { io.mkdirSync(dir, { recursive: true }); } catch (_) { fail('CREDENTIAL_STORE_UNAVAILABLE'); }
  }
  function ensureDatabasePassword(dataDir) {
    const file = path.join(dataDir, SECRETS_FILENAME);
    const stored = readSecretFile(file);
    if (stored !== null) {
      let parsed;
      try { parsed = JSON.parse(stored); } catch (_) { fail('CREDENTIAL_RECOVERY_REQUIRED'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('CREDENTIAL_RECOVERY_REQUIRED');
      return decodeSecret(parsed.surrealPassword);
    }
    if (hasExistingDatastore(dataDir)) fail('CREDENTIAL_RECOVERY_REQUIRED');
    const password = randomSecret(DATABASE_PASSWORD_BYTES, 'base64url');
    makeDirectory(dataDir);
    writeSecretFile(file, JSON.stringify({ surrealPassword: encodeSecret(password) }, null, 2) + '\n');
    return password;
  }
  function resolveDatabaseCredentials(dataDir) {
    const hadSecrets = entry(path.join(dataDir, SECRETS_FILENAME)) !== null;
    const password = ensureDatabasePassword(dataDir);
    return { user: DATABASE_USER, password, legacy: false, source: hadSecrets ? 'stored' : 'generated' };
  }
  function writeEncryptionKeyFile(file, key) { writeSecretFile(file, encodeSecret(key)); }
  function readEncryptionKeyFile(file) {
    const stored = readSecretFile(file);
    if (stored === null) fail('CREDENTIAL_RECOVERY_REQUIRED');
    return decodeSecret(stored);
  }
  function ensureEncryptionKey(dataDir) {
    const file = path.join(dataDir, KEY_FILENAME);
    const stored = readSecretFile(file);
    if (stored !== null) return decodeSecret(stored);
    if (hasExistingDatastore(dataDir)) fail('CREDENTIAL_RECOVERY_REQUIRED');
    const key = randomSecret(ENCRYPTION_KEY_BYTES, 'hex');
    makeDirectory(dataDir);
    writeEncryptionKeyFile(file, key);
    return key;
  }
  return { ensureDatabasePassword, resolveDatabaseCredentials, ensureEncryptionKey,
    hasExistingDatastore, writeSecretFile, writeEncryptionKeyFile, readEncryptionKeyFile };
}

function credentialStartupMessage(error) {
  switch (error && error.code) {
    case 'CREDENTIAL_RECOVERY_REQUIRED':
      return "CREDENTIAL_RECOVERY_REQUIRED: Restore this installation's original credential files from a trusted backup, or contact your administrator. Notebook data has been preserved.";
    case 'CREDENTIAL_STORE_UNAVAILABLE':
      return 'CREDENTIAL_STORE_UNAVAILABLE: The app could not protect, read or save its credentials. Check access to the app data folder or contact your administrator.';
    case 'CREDENTIAL_RANDOMNESS_UNAVAILABLE':
      return 'CREDENTIAL_RANDOMNESS_UNAVAILABLE: Secure credential generation failed. Restart the app or contact your administrator.';
    case 'CREDENTIALS_INVALID':
      return 'CREDENTIALS_INVALID: Valid database credentials are required before services can start.';
    default:
      return 'SERVICE_STARTUP_FAILED: Review the service lifecycle diagnostics.';
  }
}

function buildCredentialEnvironment(credentials) {
  if (!credentials || !validSecret(credentials.user) || !validSecret(credentials.password)) fail('CREDENTIALS_INVALID');
  return { SURREAL_USER: credentials.user, SURREAL_PASSWORD: credentials.password, SURREAL_PASS: credentials.password };
}

module.exports = {
  ...createCredentialStore(), createCredentialStore, CredentialError, restrictToCurrentUser,
  buildCredentialEnvironment, credentialStartupMessage, deriveObfuscationKey, deriveObfuscationKeyFrom,
  xorObfuscate, encodeSecret, decodeSecret, stripUserDomain, currentUsername, currentHostname,
  KEY_FILENAME, SECRETS_FILENAME, LEGACY_DATABASE_PASSWORD, DATABASE_USER, DATABASE_DIRNAME,
  DATABASE_FILENAME, OBFUSCATION_PREFIX, OBFUSCATION_SALT, ENCRYPTION_KEY_BYTES, DATABASE_PASSWORD_BYTES,
};
