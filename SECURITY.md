# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in Office of Equity Open Notebook, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities.
2. Email the maintainer directly with details of the vulnerability.
3. Include steps to reproduce, affected versions, and potential impact.
4. Allow reasonable time for a fix before public disclosure.

## Security Model

This is a **local-first desktop application**. All data processing happens on the user's machine. The app does not send data to external servers except when the user explicitly configures an AI provider API key.

### Key Security Properties

- **No admin rights required** — The installer is per-user (`%LOCALAPPDATA%`), writes only to `HKCU`, and never requests elevation.
- **Sandboxed renderer** — The Electron renderer process runs with `sandbox: true`, `webSecurity: true`, and no Node.js access.
- **Content Security Policy** — A strict CSP is applied to all responses, restricting scripts, connections, and frames.
- **No shell execution** — All child processes are spawned without `shell: true`, preventing command injection.
- **Process isolation** — Backend services (SurrealDB, FastAPI, worker) run as separate child processes, not in the Electron process.
- **Encrypted secrets** — API keys are encrypted at rest using AES-256-GCM with a machine-and-user-bound key.
- **Download integrity** — All downloaded binaries (SurrealDB, Node.js) are verified via SHA-256 checksums and Authenticode signatures.
- **ASAR packaging** — Application code is packaged as an ASAR archive with integrity validation, making tampering detectable.
- **Permission denial** — The app denies all browser permissions (camera, microphone, geolocation, notifications, etc.).

### Antivirus Compatibility

This app is designed to avoid common patterns that trigger false positives in Microsoft Defender and other antivirus software:

| Pattern Avoided | Why |
|----------------|-----|
| `RequestExecutionLevel admin` | Per-user install, no elevation prompt |
| `taskkill` / `tasklist` / `icacls` | Native Node.js `process.kill(pid, 0)` for process checks |
| `shell: true` in spawn | Direct executable invocation, no shell interpretation |
| PowerShell `Expand-Archive` | Native `tar -xf` for zip extraction |
| Fixed paths like `C:\onb` | Uses `%TEMP%` for staging, `%LOCALAPPDATA%` for install |
| Plaintext key files | Encryption keys are obfuscated with machine-bound derivation |
| Unsigned downloaded binaries | SHA-256 + Authenticode signature verification |
| Loose `.js` files in install | ASAR archive with integrity validation |

## Scope

This policy covers the desktop application code in this repository. The underlying [Open Notebook](https://github.com/lfnovo/open-notebook) project has its own security policy.
