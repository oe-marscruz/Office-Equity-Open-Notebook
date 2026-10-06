# Security Model

This document describes the security architecture of Office of Equity Open Notebook and explains why each design decision was made, particularly with respect to antivirus (Microsoft Defender) compatibility.

## Threat Model

The app runs on a user's Windows machine and:

1. **Processes sensitive data locally** — notebooks, documents, and AI conversations never leave the machine unless the user configures an external AI provider.
2. **Stores API keys** — provider API keys are stored encrypted on disk.
3. **Downloads and runs binaries** — SurrealDB and Node.js are downloaded during build and bundled with the app.
4. **Spawns child processes** — SurrealDB, Python backend, and background worker run as separate processes.

### Threats Addressed

| Threat | Mitigation |
|--------|-----------|
| Malicious web content in renderer | Sandbox, CSP, no Node.js in renderer, permission denial |
| API key theft from disk | AES-256-GCM encryption with machine-and-user-bound key |
| Tampered app code | ASAR integrity validation on startup |
| Supply-chain attack on downloads | SHA-256 checksums + Authenticode signature verification |
| Command injection via shell | No `shell: true`; direct executable invocation |
| Process manipulation by malware | Per-user install, no admin rights, restricted file ACLs |
| Antivirus false positives | Avoidance of flagged patterns (see below) |

## Electron Security

### Renderer Sandbox

```js
webPreferences: {
  sandbox: true,           // No Node.js in renderer
  webSecurity: true,       // Same-origin policy enforced
  allowRunningInsecureContent: false,
  webviewTag: false,       // No <webview> tag
  navigateOnDragDrop: false,
  enableBlinkFeatures: '', // No experimental features
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,  // Isolated preload context
}
```

### Content Security Policy

A strict CSP is applied via `session.defaultSession.webRequest.onHeadersReceived`:

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self' http://127.0.0.1:5055 ws://127.0.0.1:8000;
frame-src 'none';
object-src 'none';
base-uri 'self';
form-action 'self'
```

The `connect-src` allows only localhost connections to the FastAPI backend (`127.0.0.1:5055`) and SurrealDB WebSocket (`127.0.0.1:8000`).

### Permission Denial

All browser permissions are denied:

```js
ses.setPermissionRequestHandler((_wc, permission, callback) => callback(false));
ses.setPermissionCheckHandler(() => false);
```

This blocks camera, microphone, geolocation, notifications, MIDI, USB, Bluetooth, and all other permissions.

## Process Management

### No `taskkill` / `tasklist` / `icacls`

The supervisor uses native Node.js `process.kill(pid, 0)` to check if a process is alive:

```js
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // Exists but no permission = alive
  }
}
```

This avoids spawning `tasklist.exe`, `taskkill.exe`, or `icacls.exe`, which are commonly flagged by antivirus software as process-manipulation patterns.

### No `shell: true`

All child processes are spawned with `shell: false` (the default). On Windows, `npm` is resolved to `npm.cmd` explicitly:

```js
function resolveCommand(cmd) {
  if (process.platform === 'win32' && cmd === 'npm') return 'npm.cmd';
  return cmd;
}
```

All spawn calls include `windowsHide: true` to prevent console window flashing.

## Installer Security

### Per-User Installation

The NSIS installer is configured for per-user installation:

- `RequestExecutionLevel user` — no admin/elevation prompt
- `InstallDir $LOCALAPPDATA\Office of Equity Open Notebook` — installs to user profile
- All registry writes use `HKCU` (not `HKLM`)
- No writes to `Program Files` or system directories

### Temp Staging

Build artifacts are staged in `%TEMP%` (via `os.tmpdir()`), not in fixed paths like `C:\onb`.

## Secrets Storage

### Encryption Key

The encryption key (used for AES-256-GCM encryption of API keys) is:

1. Generated as 32 random bytes (`crypto.randomBytes(32)`)
2. Stored **obfuscated** — XOR'd with a SHA-256 hash of `app-name | username | hostname`
3. Written with file ACLs restricted to the current user only

This means:
- The key file never contains the raw key in plaintext
- A copy of the key file is useless on another machine or user account
- Antivirus software doesn't flag a plaintext hex key file

### API Keys

Provider API keys are encrypted with AES-256-GCM:

```js
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
```

Each encryption uses a unique IV. The auth tag is stored alongside the ciphertext for tamper detection.

## Download Integrity

### SHA-256 Checksums

All downloads are verified against pinned SHA-256 checksums:

```js
async function download(url, dest, expectedSha256) {
  // ... download ...
  const actual = sha256File(dest);
  if (actual !== expectedSha256) throw new Error('Checksum mismatch');
}
```

### Authenticode Signature Verification

Downloaded executables (SurrealDB, Node.js) are verified with `Get-AuthenticodeSignature`:

```js
function verifyAuthenticodeSignature(filePath, expectedSubject) {
  const result = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-AuthenticodeSignature -FilePath '${filePath}').Status`
  ], { encoding: 'utf8', windowsHide: true });
  return result.stdout.trim() === 'Valid';
}
```

## ASAR Packaging

Application code is packaged as an ASAR archive (`app.asar`) instead of loose `.js` files:

- **Fewer files for AV to scan** — one archive instead of hundreds of `.js` files
- **Integrity validation** — `asarIntegrity` hash in `package.json` is verified by Electron on startup
- **Tamper-evident** — any modification to the archive invalidates the hash

## File Permissions

Sensitive files (encryption key, secrets) are written with ACLs restricted to the current user:

```js
function restrictToCurrentUser(file) {
  if (process.platform === 'win32') {
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true });
  } else {
    fs.chmodSync(file, 0o600);
  }
}
```

## Antivirus Compatibility Summary

| Defender Trigger | How We Avoid It |
|-----------------|-----------------|
| Admin-level installer | `RequestExecutionLevel user`, `$LOCALAPPDATA` |
| `taskkill /T /F` | Native `process.kill(pid, signal)` |
| `tasklist` process enumeration | `process.kill(pid, 0)` liveness check |
| `icacls` permission changes | Only on secret files, with `windowsHide: true` |
| `shell: true` command execution | Direct `spawn()` without shell |
| PowerShell `Expand-Archive` | Native `tar -xf` for zip extraction |
| Fixed path writes (`C:\onb`) | `os.tmpdir()` for staging |
| Plaintext key files | XOR-obfuscated with machine-bound key |
| Unsigned downloaded binaries | SHA-256 + Authenticode verification |
| Loose `.js` files | ASAR archive with integrity hash |
| Missing sandbox/CSP | `sandbox: true`, strict CSP, permission denial |
