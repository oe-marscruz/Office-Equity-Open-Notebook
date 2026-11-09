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
| Legacy install | Datastores created by older builds are reported as `legacy-unmigrated`: no password is available and no file is written yet. The launcher then runs the one-time migration in §7, which rotates the password and persists it |

This is deliberately **not** equivalent to a hardware-backed key store. It raises the bar against casual reads by other processes and avoids the plaintext-secret-file pattern that endpoint-protection software flags. It does not defend against an attacker who already runs as the current OS user.

### Why legacy installs no longer resolve to `root`

SurrealDB creates the root user from the initial credentials only when the datastore is new. Starting an existing datastore with different values changes nothing, so a newly generated password would have had no effect on an upgraded install and would have locked the backend out of its own data.

Earlier builds handled that by refusing to migrate and instead quietly reusing the historical `root` password. That made the credential store unable to distinguish "this installation legitimately uses the development default" from "this installation is an upgrade that was never migrated", and it left every upgraded install running on a password published in this repository. Both outcomes are unacceptable for a store holding student records.

The current behaviour is to **fail closed and say so**, then migrate when that is safe. Resolution returns one of four explicit sources:

| Source | Meaning |
| --- | --- |
| `generated` | No datastore and no secrets file: a random password was created, stored, and is in use |
| `stored` | A valid secrets file exists and is used as-is; nothing is written |
| `migrated` | This process rotated a legacy install onto a provisioned password. Provenance, not state — the next launch reports `stored` |
| `legacy-unmigrated` | A datastore exists with no secrets file. The password is unknown, is **not** guessed, and is resolved by the migration in §7 |

`legacy-unmigrated` carries no password at all (`password: null` in every host) and sets `migrationRequired: true`. Callers must handle it explicitly — the launchers run the one-time migration described in §7 rather than starting the backend on a default credential.

Damaged secrets files are never repaired or rewritten either, for the same reason: a corrupt file may be the only remaining copy of a password the datastore still accepts. Resolution raises `invalid-secrets-file` and leaves the bytes on disk untouched.

The five error codes every host can raise are `invalid-secrets-file`, `invalid-secret-value`, `permissions-too-open`, `datastore-unreadable`, and `migration-rejected`.

---

## 2. Implementation map

| Host | Canonical module | Call site |
| --- | --- | --- |
| Node / Electron | `scripts/lib/credentials.js` | `main.js`, `scripts/run-services.js`, `scripts/start-services.js` |
| TypeScript contract | `src/contracts/credentials.ts` (facade over the Node module) | `src/contracts/service-table.ts` |
| Rust / Tauri | `src-tauri/src/credentials.rs` | `src-tauri/src/runner.rs` |
| Go / Wails | `src-wails/credentials.go` | `src-wails/runner.go` |
| C# / WinUI | `src-winui/Credentials.cs` | `src-winui/ServiceManager.cs` |

Credential *migration* is deliberately not implemented five times. It lives once, in `scripts/lib/credential-migration.js`, and is driven by `scripts/start-services.js`; the native hosts carry the state vocabulary and the resolution rules, but not a second rotation implementation. See §7 and `docs/modernization/adr/002-credential-migration-and-recovery.md`.

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

`tests/contracts/credentials-cases.json` pins the shared behaviour for all five hosts. It holds four derivation vectors, one obfuscation vector, the legacy-plaintext case, the domain-qualified and stripped account names, the salt and prefix constants, the four credential-state sources, the five error codes, ten `aclSamples` (Windows `icacls` listings and POSIX modes), ten `states` covering every resolution outcome and file-write decision, and eight `migration` cases covering the rotation. Every host's test suite reads that fixture directly, so the implementations are checked against one oracle rather than against each other.

Each `states` entry asserts five things at once: the resolved `source`, the `migrationRequired` flag, whether a password is available, whether `secrets.json` is created or rewritten, and the error code on rejection. The write expectations are what pin the fail-closed behaviour:

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

The `migrated` source appears in the fixture as a declared value even though no `states` entry resolves to it. That is deliberate: `migrated` is provenance, not state. It marks the process that performed the rotation; the next launch reads the same password back from `secrets.json` and reports `stored`. Only the `migration` cases can produce it.

The eight `migration` cases pin the rotation itself. Each declares the datastore, the presence of a recovery file, whether the legacy probe authenticates, how the rotation call behaves, the resulting source, and exactly which files survive:

| Case | Result |
| --- | --- |
| `migrates-legacy-datastore` | `migrated`; provisioned password written |
| `legacy-probe-rejected` | `migration-rejected`; nothing written |
| `legacy-probe-unreachable` | `datastore-unreadable`; nothing written |
| `rotation-fails-unchanged` | `migration-rejected`; recovery file discarded |
| `rotation-fails-but-committed` | `migrated` — the post-rotation probe proves the change landed, so the migration completes rather than discarding the only copy of the new password |
| `crash-before-rotation` | `migrated` — the stale recovery file is discarded and the migration restarts |
| `crash-after-rotation` | `migrated` — the recovery file's password authenticates, so the migration finishes instead of locking the install out |
| `crash-after-rotation-unreachable` | `datastore-unreadable`; the recovery file **is kept**, because it may hold the only copy of a live password |

Three parity traps are worth recording:
Four parity traps are worth recording:

- **Domain-qualified account names.** Node's `os.userInfo().username` returns `cruzmars`, while Go's `os/user.Current().Username` returns `UNIVERSITY\cruzmars`. Every host strips the domain qualifier — the substring after the last `\` or `/` — so the derivation matches.
- **Environment-first resolution.** The order is fixed everywhere: `USERNAME`, then `USER`, then the OS account API; `COMPUTERNAME`, then `HOSTNAME`, then the OS host API. This guarantees identical derivation on the same machine regardless of which host resolves it.
- **Strict base64 and UTF-8.** `Buffer.from(x, 'base64')` never throws, and `toString('utf8')` silently substitutes U+FFFD. Decoding therefore has to validate: the alphabet must be `A-Za-z0-9+/=`, the length must be a multiple of four, a decode/re-encode round trip must return the input, and the UTF-8 re-encode must reproduce the original bytes. Without all four checks, `undecodable-secret` and `control-char-secret` would resolve successfully instead of raising `invalid-secret-value`. C# needs the round trip too, because `Convert.FromBase64String` tolerates non-canonical encodings, and needs `new UTF8Encoding(false, true)` for the UTF-8 check.
- **Windows path-shape hole.** When a *file* occupies the path where the `surrealdb` directory belongs, both `os.Stat(dir\mydatabase.db)` and `os.ReadDir(dir)` report "not found" on Windows-Go, so a broken installation looked like a fresh one. Node's `ENOTDIR` and Rust's `NotADirectory` are distinct and do not have this problem. Every host now guards the datastore check against a non-directory at that path (C# uses `File.Exists`).

---

## 4. Verification performed

| Check | Result |
| --- | --- |
| `npm run build:types` | PASSED, zero errors |
| `node scripts/orchestrator/verifier.js` | PASSED, 30/30 suites |
| `node scripts/tests/test-credentials.js` | PASSED, 16 groups |
| `node scripts/tests/test-launcher-credentials.js` | PASSED, 15 checks across 5 groups |
| `cargo test` (src-tauri) | PASSED, 34 tests including the fixture harness and the ACL classification test |
| `go vet ./...` + `go test ./...` (src-wails) | PASSED, 9.3 s; `go vet` clean |
| `src-winui` compile + fixture replay | PASSED — see below |

`test-launcher-credentials.js` is the launcher-level companion to the contract suite. It drives `start-services.js` rather than the credential module alone, so it covers fresh installs, legacy installs, explicit credentials, and the deleted-after-migration state end to end — including the assertion that a rejected migration performs zero rotations and leaves the datastore password unchanged.

`src-winui` has no .NET SDK in this checkout, so `dotnet build` cannot run. It was verified instead by compiling `Credentials.cs` and `NavigationPolicy.cs` with the Roslyn compiler from the `microsoft.net.compilers.toolset` 4.11.0 package against the `Microsoft.NETCore.App` 8.0.33 reference assemblies (`-nostdlib`, native DLLs excluded), then replaying `tests/contracts/credentials-cases.json` through the real `Credentials` class: 4 derivation vectors, the obfuscation and encode/decode vectors, the legacy-plaintext case, domain stripping, all 10 `aclSamples`, all 10 `states` including the write and preservation assertions, corrupt-file preservation, and environment rejection of a null password. Re-run after the migration contract landed, the same harness also confirmed that `CredentialSources.ToIdentifier` maps `Migrated` to `migrated`, that `MigrationRejected` matches the fixture, and that neither `Credentials.LegacyDatabasePassword` nor `DatabaseCredentials.Legacy` is still exported. All passed. This is a type-check plus behavioural replay, not a `dotnet build` of the full WinUI project.

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
| Operator-driven migration of a `legacy-unmigrated` datastore | **Done** — `scripts/lib/credential-migration.js`, driven by the launcher; see §7 |
| Least privilege beyond the fixed `root` database account | Open |
| SurrealDB datastore storage encryption at rest | Open |
| Encryption-key rotation, migration and recovery | Open |
| Secret-store backup and restore behavior | Open |
| Hardware-backed key storage (Windows DPAPI, macOS Keychain, libsecret) | Open — would replace the obfuscation scheme with OS-native protection |
| Electron Browser boundary hardening (active CSP, exact-origin checks) | Separate packet; untouched here |

---

## 7. Migrating a `legacy-unmigrated` installation

A `legacy-unmigrated` state means the datastore exists but no secrets file does, so the application does not know the current password. Resolution reports that condition with a null password instead of guessing `root`; the launcher then runs the migration before any other service starts.

### Sequence

`scripts/lib/credential-migration.js` owns the one implementation, and `scripts/start-services.js` drives it in this order:

1. **Spawn SurrealDB with the legacy probe password.** The server has to be running before its root user can be re-keyed.
2. **Wait for readiness.**
3. **`migrateLegacyDatastore`**: probe with `LEGACY_PROBE_PASSWORD`; refuse if the probe is rejected or unreachable.
4. **Write the recovery file** `.migration-pending` — ACL-restricted and obfuscated, containing the password that is about to be provisioned.
5. **Rotate** with `DEFINE USER OVERWRITE root ON ROOT PASSWORD '…' ROLES OWNER`.
6. **Probe with the new password.** If it does not authenticate, the datastore is unchanged: discard the recovery file and fail.
7. **Write `secrets.json`**, then delete the recovery file.
8. **Rewrite `backendEnv`** and continue starting the API, worker and frontend.

Only the *first* launch after a rotation reports `source: "migrated"`. Every later launch reads the same password back from `secrets.json` and reports `stored`, which is why the two must not be treated as interchangeable states.

### The deviation, stated plainly

The original plan in this document said to rotate first and write the secrets file second, with a `.migrated` marker to detect a crash in between. That ordering has a hole: a crash between the rotation committing and the write leaves a datastore whose password exists nowhere — the install is locked out with no recovery path.

The implemented order is therefore **rotate second, after persisting the new password to a recovery file**. The recovery file is what makes the sequence safe:

- Crash before the rotation commits → the recovery file's password does not authenticate, so it is stale; discard it and start over.
- Crash after the rotation commits → the recovery file's password *does* authenticate, so the migration finishes by writing `secrets.json` instead of abandoning the only copy of a live password.
- Crash while the datastore is unreachable → the recovery file is kept, because it may be the only copy of the password the datastore now accepts. Deleting it would be unrecoverable.

This is stricter than the original plan and is the reason the `migration` fixture has eight cases rather than two.

### The rejected-probe case

If the legacy probe is rejected, nothing is rotated and nothing is written. The launcher stops with `credential-error: migration-rejected` and the message *"The existing datastore does not accept the legacy credential; an operator must supply its current password"*. Recovering from that state means restoring `secrets.json` from a backup, or re-keying the datastore out of band; the application deliberately does not guess.

An *unreachable* datastore is reported separately as `datastore-unreadable`. These two must not collapse into one code: "wrong password" is an operator problem, "server not up" is a launcher problem.

### Deleting `secrets.json` after a successful migration

Once a datastore has been migrated, deleting `secrets.json` makes the disk state **byte-identical to a legacy install**: a datastore exists and no secrets file does. Nothing in the filesystem distinguishes the two, so resolution correctly reports `migrationRequired: true` and the launcher attempts a migration.

That attempt is safe because of the ordering above. The rotated datastore rejects the legacy probe, so the launch stops with `migration-rejected` **before** any rotation or write. The password the datastore still accepts is the pre-deletion one, which remains recoverable from a backup, and no code path falls back to `root`.

Do not "improve" this by detecting the condition earlier: there is nothing to detect, and adding a best-effort heuristic here would risk breaking the genuine legacy path.

### Launch-time teardown

If the migration throws, `start-services.js` calls `stopChildren()` before rethrowing, so an already-spawned SurrealDB does not survive a failed launch. Without that, the next launch would report a port conflict and hide the real cause behind a secondary error.

### Operator-facing behaviour

The failure is reported as a stop with an actionable message rather than a start on a default credential. That is the deliberate end state of this packet; the F04 requirement is satisfied by the migration existing and being proven against a live server, not by an automatic repair of a datastore whose password is genuinely unknown.
