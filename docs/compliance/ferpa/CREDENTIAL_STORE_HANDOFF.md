# Credential Store Re-port Handoff — Per-Install Database Credentials

## Executive Summary

The application shipped with a fixed SurrealDB credential of `root`/`root`. On a loopback-bound service that is not a defense: any other process or account on the machine can reach the local port and read the whole notebook database. This change replaces the fixed password with a per-install random one, stored obfuscated and restricted to the current OS user, and implements the same on-disk format in all five hosts so a user data directory can be moved between them.

The work is a re-port of a security hardening that was dropped from an earlier branch. It touches the Electron launcher, the Rust/Tauri host, the Go/Wails host, the C#/WinUI host and the typed contract layer, plus a shared parity fixture and mechanical test suites.

---

## 1. Security model and its limits

| Property | Behavior |
| --- | --- |
| Fresh install | Root password is 24 random bytes, base64url-encoded, never shown to the user |
| Storage | `secrets.json` holds the password XOR-obfuscated, prefixed `obf:`, with base64 encoding |
| Obfuscation key | `SHA-256("Office-Equity-Open-Notebook\|<username>\|<hostname>")`, domain qualifier stripped |
| Key file | `encryption-key.txt` holds the provider-API-key encryption key, obfuscated the same way |
| Access control | Both files are ACL-restricted to the current OS user via `icacls` on Windows |
| Transport | Credentials reach SurrealDB and the Python backend through the child process environment, never a command line |
| Legacy install | Datastores created by older builds keep their original `root` password |

This is deliberately **not** equivalent to a hardware-backed key store. It raises the bar against casual reads by other processes and avoids the plaintext-secret-file pattern that endpoint-protection software flags. It does not defend against an attacker who already runs as the current OS user.

### Why legacy installs keep `root`

SurrealDB creates the root user from the initial credentials only when the datastore is new. Starting an existing datastore with different values changes nothing. A newly generated password would therefore have had no effect on an upgraded install and would have locked the backend out of its own data. Fresh installs get a random password; existing datastores keep their password until an operator rotates it. Rotation of a legacy password remains an open operator task.

---

## 2. Implementation map

| Host | Canonical module | Call site |
| --- | --- | --- |
| Node / Electron | `scripts/lib/credentials.js` | `main.js`, `scripts/run-services.js`, `scripts/start-services.js` |
| TypeScript contract | `src/contracts/credentials.ts` (facade over the Node module) | `src/contracts/service-table.ts` |
| Rust / Tauri | `src-tauri/src/credentials.rs` | `src-tauri/src/runner.rs` |
| Go / Wails | `src-wails/credentials.go` | `src-wails/runner.go` |
| C# / WinUI | `src-winui/Credentials.cs` | `src-winui/ServiceManager.cs` |

`scripts/lib/credentials.js` is the source of truth. It has to stay plain CommonJS under `scripts/` because `scripts/package.js` copies `scripts/` — but not `dist/` — into the packaged Electron app's `resources/app` directory. `src/contracts/credentials.ts` is therefore a typed facade over the same module rather than a second implementation.

### On-disk format

Byte-for-byte identical across all five hosts:

```
encryption-key.txt   obf:<base64>
secrets.json         {"surrealPassword": "obf:<base64>"}
```

`secrets.json` uses two-space indentation and a trailing newline. The obfuscated bytes are `utf8(secret)` XORed with the derived key, cycling over the key length. The transform is symmetric, so the same operation encodes and decodes. A stored value without the `obf:` prefix is returned unchanged, which keeps legacy plaintext files readable.

### Environment variables

| Variable | Consumer | Value |
| --- | --- | --- |
| `SURREAL_USER` | SurrealDB CLI, upstream backend | The fixed `root` username |
| `SURREAL_PASSWORD` | Upstream backend | The password |
| `SURREAL_PASS` | SurrealDB CLI, upstream backend fallback | The password |

The upstream backend reads `os.getenv("SURREAL_PASSWORD") or os.getenv("SURREAL_PASS") or "root"`, so all three carry the same value. The `--user` and `--pass` command-line flags were removed from the SurrealDB launch arguments in every host, because a command line is visible in the process listing.

---

## 3. Cross-host parity

`tests/contracts/credentials-cases.json` pins the shared behaviour: four derivation vectors, one obfuscation vector, the legacy-plaintext case, the domain-qualified and stripped account names, and the salt and prefix constants. The Rust and Go test suites read that fixture directly, so all five implementations are checked against the same vectors rather than against each other.

Two parity traps are worth recording:

- **Domain-qualified account names.** Node's `os.userInfo().username` returns `cruzmars`, while Go's `os/user.Current().Username` returns `UNIVERSITY\cruzmars`. Every host strips the domain qualifier — the substring after the last `\` or `/` — so the derivation matches.
- **Environment-first resolution.** The order is fixed everywhere: `USERNAME`, then `USER`, then the OS account API; `COMPUTERNAME`, then `HOSTNAME`, then the OS host API. This guarantees identical derivation on the same machine regardless of which host resolves it.

---

## 4. Verification performed

| Check | Result |
| --- | --- |
| `npm run build:types` | PASSED, zero errors |
| `node scripts/orchestrator/verifier.js` | PASSED, 29/29 suites (up from 28) |
| `node scripts/tests/test-credentials.js` | PASSED, 12 groups |
| `cargo test --offline` (src-tauri) | PASSED, 30 tests including 12 credential tests |
| `go test ./...` (isolated stdlib module) | PASSED, 12 parity tests |
| `node scripts/tests/test-service-diagnostics.js` | PASSED, updated for the new launcher require |

The credential suite is auto-discovered by `scripts/orchestrator/verifier.js` and is also run explicitly in CI Lane 1.

---

## 5. Known constraints

These are environment limits of this checkout, not defects in the change.

- **No .NET SDK.** `dotnet --info` reports "No SDKs were found", so `src-winui/Credentials.cs` and the `ServiceManager.cs` wiring are source-only and cannot be compile-verified here. They use only `System`, `System.IO`, `System.Security.Cryptography` and `System.Text`, and follow the same algorithm as the verified hosts.
- **Empty Go module cache.** `src-wails` depends on `wails/v2` and has no `go.sum`, so the full package cannot compile offline. `go vet ./...` there fails on pre-existing missing `go.sum` entries and on `main.go:13: pattern all:frontend/dist: no matching files found`. The Go mirror is stdlib-only and was verified in an isolated temporary module.
- **Pre-existing `gofmt` drift.** Every file in `src-wails`, including untouched ones, is flagged by `gofmt -l`; the diff is a whole-file CRLF to LF replacement. This was left alone rather than mixed into a security change.
- **No assembled runtime.** `resources/runtime/` is absent, so there was no end-to-end launch against a real SurrealDB and Python backend. The credential behavior is verified at the contract level only.
- **Rust build prerequisite.** `src-tauri/tauri.conf.json` references `../open-notebook/frontend/src/app/favicon.ico`, which resolves outside this worktree. A local directory junction satisfied the build. CI's `build-installer` job creates the same path by checking out `lfnovo/open-notebook` at `a0f6f3081ae06328f0a451b3a3ef2959ca25721d`.

---

## 6. Follow-up work

| Item | Status |
| --- | --- |
| Operator-driven rotation of a legacy `root` password | Open |
| Least privilege beyond the fixed `root` database account | Open |
| SurrealDB datastore storage encryption at rest | Open |
| Encryption-key rotation, migration and recovery | Open |
| Secret-store backup and restore behavior | Open |
| Hardware-backed key storage (Windows DPAPI, macOS Keychain, libsecret) | Open — would replace the obfuscation scheme with OS-native protection |
| Electron Browser boundary hardening (active CSP, exact-origin checks) | Separate packet; untouched here |
