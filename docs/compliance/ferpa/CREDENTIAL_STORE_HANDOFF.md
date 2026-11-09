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
| Legacy install | Datastores created by older builds are reported as `legacy-unmigrated`: no password is available and no file is written. Migration is a separate, explicit step (§7) |

This is deliberately **not** equivalent to a hardware-backed key store. It raises the bar against casual reads by other processes and avoids the plaintext-secret-file pattern that endpoint-protection software flags. It does not defend against an attacker who already runs as the current OS user.

### Why legacy installs no longer resolve to `root`

SurrealDB creates the root user from the initial credentials only when the datastore is new. Starting an existing datastore with different values changes nothing, so a newly generated password would have had no effect on an upgraded install and would have locked the backend out of its own data.

Earlier builds handled that by refusing to migrate and instead quietly reusing the historical `root` password. That made the credential store unable to distinguish "this installation legitimately uses the development default" from "this installation is an upgrade that was never migrated", and it left every upgraded install running on a password published in this repository. Both outcomes are unacceptable for a store holding student records.

The current behaviour is to **fail closed and say so**. Resolution returns one of three explicit sources:

| Source | Meaning |
| --- | --- |
| `generated` | No datastore and no secrets file: a random password was created, stored, and is in use |
| `stored` | A valid secrets file exists and is used as-is; nothing is written |
| `legacy-unmigrated` | A datastore exists with no secrets file. The password is unknown and is **not** guessed |

`legacy-unmigrated` carries no password at all (`password: null` in every host). Callers must handle it explicitly — the launchers stop with "Credential migration is required for this installation" rather than starting the backend on a default credential.

Damaged secrets files are never repaired or rewritten either, for the same reason: a corrupt file may be the only remaining copy of a password the datastore still accepts. Resolution raises `invalid-secrets-file` and leaves the bytes on disk untouched.

The four error codes every host can raise are `invalid-secrets-file`, `invalid-secret-value`, `permissions-too-open`, and `datastore-unreadable`.

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

The encoding is identical across all five hosts:

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

`tests/contracts/credentials-cases.json` pins the shared behaviour for all five hosts. It holds four derivation vectors, one obfuscation vector, the legacy-plaintext case, the domain-qualified and stripped account names, the salt and prefix constants, the four error codes, ten `aclSamples` (Windows `icacls` listings and POSIX modes) and ten `states` covering every outcome, source, and file-write decision. Every host's test suite reads that fixture directly, so the implementations are checked against one oracle rather than against each other.

Each `states` entry asserts five things at once: the resolved `source`, the `legacy` flag, whether a password is available, whether `secrets.json` is created or rewritten, and the error code on rejection. The write expectations are what pin the fail-closed behaviour:

| State | Outcome | Writes `secrets.json` |
| --- | --- | --- |
| `fresh-install` | `generated` | yes — creates it |
| `stored-secret` | `stored` | no — never rewritten |
| `legacy-unmigrated` | `legacy-unmigrated` | no — no file created |
| `corrupt-secrets-file` | `invalid-secrets-file` | no — corrupt bytes preserved |
| `missing-password-field` | `invalid-secrets-file` | no |
| `undecodable-secret` | `invalid-secret-value` | no |
| `empty-secret` | `invalid-secret-value` | no |
| `control-char-secret` | `invalid-secret-value` | no |
| `open-permissions` | `permissions-too-open` | no |
| `datastore-unreadable` | `datastore-unreadable` | no |

Three parity traps are worth recording:

- **Domain-qualified account names.** Node's `os.userInfo().username` returns `cruzmars`, while Go's `os/user.Current().Username` returns `UNIVERSITY\cruzmars`. Every host strips the domain qualifier — the substring after the last `\` or `/` — so the derivation matches.
- **Environment-first resolution.** The order is fixed everywhere: `USERNAME`, then `USER`, then the OS account API; `COMPUTERNAME`, then `HOSTNAME`, then the OS host API. This guarantees identical derivation on the same machine regardless of which host resolves it.
- **Strict base64 and UTF-8.** `Buffer.from(x, 'base64')` never throws, and `toString('utf8')` silently substitutes U+FFFD. Decoding therefore has to validate: the alphabet must be `A-Za-z0-9+/=`, the length must be a multiple of four, a decode/re-encode round trip must return the input, and the UTF-8 re-encode must reproduce the original bytes. Without all four checks, `undecodable-secret` and `control-char-secret` would resolve successfully instead of raising `invalid-secret-value`. C# needs the round trip too, because `Convert.FromBase64String` tolerates non-canonical encodings, and needs `new UTF8Encoding(false, true)` for the UTF-8 check.
- **Windows path-shape hole.** When a *file* occupies the path where the `surrealdb` directory belongs, both `os.Stat(dir\mydatabase.db)` and `os.ReadDir(dir)` report "not found" on Windows-Go, so a broken installation looked like a fresh one. Node's `ENOTDIR` and Rust's `NotADirectory` are distinct and do not have this problem. Every host now guards the datastore check against a non-directory at that path (C# uses `File.Exists`).

---

## 4. Verification performed

| Check | Result |
| --- | --- |
| `npm run build:types` | PASSED, zero errors |
| `node scripts/orchestrator/verifier.js` | PASSED, 29/29 suites |
| `node scripts/tests/test-credentials.js` | PASSED, 15 groups |
| `cargo test` (src-tauri) | PASSED, 34 tests including the fixture harness and the ACL classification test |
| `go vet ./...` + `go test ./...` (src-wails) | PASSED, 13.4 s; `go vet` clean |
| `src-winui` compile + fixture replay | PASSED — see below |

`src-winui` has no .NET SDK in this checkout, so `dotnet build` cannot run. It was verified instead by compiling `Credentials.cs` and `NavigationPolicy.cs` with the Roslyn compiler from the `microsoft.net.compilers.toolset` 4.11.0 package against the `Microsoft.NETCore.App` 8.0.33 reference assemblies (`-nostdlib`, native DLLs excluded), then replaying `tests/contracts/credentials-cases.json` through the real `Credentials` class: 4 derivation vectors, the obfuscation and encode/decode vectors, the legacy-plaintext case, domain stripping, all 10 `aclSamples`, all 10 `states` including the write and preservation assertions, corrupt-file preservation, and environment rejection of a null password. All passed. This is a type-check plus behavioural replay, not a `dotnet build` of the full WinUI project.

The credential suite is auto-discovered by `scripts/orchestrator/verifier.js` and is also run explicitly in CI Lane 1.

---

## 5. Known constraints

These are environment limits of this checkout, not defects in the change.

- **No .NET SDK.** `dotnet --list-runtimes` shows 7.0.20 and 8.0.33, but no SDK and no `csc.exe` is installed, so `dotnet build src-winui` cannot run here. The Roslyn type-check plus fixture replay described in §4 is the substitute. The full WinUI project also needs a `Microsoft.WindowsAppSDK` restore, which the harness does not exercise.
- **Go module metadata was missing.** `src-wails` had no `go.sum` and no indirect requirements in `go.mod`, so the package could never build. Both were generated with `go mod tidy`. `//go:embed all:frontend/dist` also needs a non-empty directory, so `frontend/dist/.gitkeep` and a `frontend/.gitignore` that stops ignoring it were added.
- **Pre-existing `gofmt` drift.** Every file in `src-wails`, including untouched ones, is flagged by `gofmt -l`; the diff is a whole-file CRLF to LF replacement. This was left alone rather than mixed into a security change.
- **No assembled runtime.** `resources/runtime/` is absent, so there was no end-to-end launch against a real SurrealDB and Python backend. The credential behavior is verified at the contract level only.
- **Rust build prerequisite, now removed.** `src-tauri/tauri.conf.json` used to reference `../open-notebook/frontend/src/app/favicon.ico`, which resolves outside `src-tauri` and therefore outside the worktree. The icon now ships in-repo at `src-tauri/icons/icon.ico`, so no external checkout or directory junction is required to build or test the crate.

---

## 6. Follow-up work

| Item | Status |
| --- | --- |
| Operator-driven migration of a `legacy-unmigrated` datastore | Open — resolution now reports the condition instead of guessing; the one-time rotation is the next packet |
| Least privilege beyond the fixed `root` database account | Open |
| SurrealDB datastore storage encryption at rest | Open |
| Encryption-key rotation, migration and recovery | Open |
| Secret-store backup and restore behavior | Open |
| Hardware-backed key storage (Windows DPAPI, macOS Keychain, libsecret) | Open — would replace the obfuscation scheme with OS-native protection |
| Electron Browser boundary hardening (active CSP, exact-origin checks) | Separate packet; untouched here |

---

## 7. Migrating a `legacy-unmigrated` installation

A `legacy-unmigrated` state means the datastore exists but no secrets file does, so the current password is unknown to the application. Nothing in this change guesses it, and nothing writes a password that would only fail to take effect.

The migration must rotate the password **before** writing the secrets file:

1. Connect to the existing datastore using the operator-supplied current password (or the datastore owner grant).
2. Define a new root password and confirm it works.
3. Only then write `secrets.json` with the obfuscated value and ACL-restrict it.
4. Record a `.migrated` marker so a crash between steps 3 and 4 is detectable, and make the whole sequence idempotent.

Ordering matters: writing the secrets file first would leave an installation that is locked out of its own data with no fallback. Until that sequence exists, the launchers stop with an actionable message rather than proceeding on a default credential.
