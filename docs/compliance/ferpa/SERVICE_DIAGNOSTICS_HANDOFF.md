# F03 service diagnostics handoff

Recorded 2026-11-03 on `codex/ferpa-service-diagnostics`, based on foundation commit `fe943cf`, and ported onto upstream `913c418`. This change implements and component-tests launcher log minimization for checklist TC-CRYP-03. Installed-application and backend-owned diagnostic verification remain open.

## Porting note

The original branch was built on `1c552ad`. Upstream has since moved forward and includes `70e0ae4` ("fix(ci): pin upstream source and repair native host so the Windows installer builds"), which already resolved the Tauri build-script, navigation-policy and child-handle compile failures that the original branch recorded as outstanding blockers. The work was therefore re-based onto upstream rather than merged, and the native design was re-evaluated against the now-compiling upstream host:

- `src-tauri/src/main.rs` keeps upstream's `security::build_secured_window` window-creation flow and adds only the fixed diagnostic messages.
- `src-tauri/src/runner.rs` uses the standard-library child handle that `service_diagnostics.rs` wraps, so the upstream `Option`-guarded Tokio handle is not needed.
- The `.gitignore` hunk from the original branch was dropped; upstream already ignores `src-tauri/target/`.

## Resulting behavior

The JavaScript launcher delegates service creation to `scripts/service-diagnostics.js`. The native launcher delegates to `src-tauri/src/service_diagnostics.rs`. Both discard child stdin/stdout/stderr at the OS boundary and create separate `<service>.lifecycle.jsonl` diagnostic files. The only serialized fields are:

| Field | Allowed content |
| --- | --- |
| `timestamp_ms` | Generated epoch timestamp in milliseconds |
| `service` | Fixed `surrealdb`, `api`, or `worker` identifier |
| `event` | Fixed lifecycle event such as `started`, `exited`, `spawn_failed`, `process_error`, or `wait_failed` |
| `exit_code` | Numeric process exit code or null |

No command arguments, environment values, child output, arbitrary error messages, file paths or record bodies enter these lifecycle records. Detected file I/O failures use fixed codes: JavaScript open/write/close and Rust open/write. A diagnostic-file open failure prevents that child from starting. These files are operational diagnostics; protected disclosure/audit logging is separate work in F10.

JavaScript CLI and Electron startup/shutdown handlers use fixed failure messages, including errors before service startup. Native startup dialogs no longer dump paths or arbitrary service errors. A native server failure emits a fixed code. Old service `.log` files are not read, rewritten, copied or deleted by this change; they may contain previously captured sensitive content.

The native watcher polls child status asynchronously. It does not block Tokio runtime shutdown waiting for a long-lived child, and it records each observed exit only once. Existing process containment and service shutdown mechanisms remain separate from the diagnostic content boundary.

## Verification scope

`node scripts/tests/test-service-diagnostics.js` passed with real child processes emitting synthetic record content, credentials, large output and exceptions. It checks new diagnostic files and parent console output, nonzero exits, failed executable paths, diagnostic open failures, a JavaScript post-open write failure, CLI errors, and executed Electron handler code with controlled application dependencies. It also verifies that a legacy log remains untouched.

The same suite compiles `src-tauri/tests/service_diagnostics.rs` directly with `rustc`, includes the actual production Rust module, and executes three native tests with real Node children. These cover output/exception suppression, safe spawn errors and an open failure that prevents spawning. Repeated status polling does not duplicate exit records. A Rust compiler is required; native coverage must not be silently skipped.

Required repository checks:

```text
npm run build:types
node scripts/orchestrator/verifier.js
```

Additional native build check:

```text
cargo check --offline --manifest-path src-tauri/Cargo.toml
```

The native check now passes. Upstream `70e0ae4` had already added `src-tauri/build.rs`, replaced the unsupported navigation API with `security::build_secured_window`, and fixed the invalid Tokio child-handle call, so the original branch's "native build limitation" no longer applies. `cargo check --offline --manifest-path src-tauri/Cargo.toml` succeeds on this branch, and `cargo test --offline --manifest-path src-tauri/Cargo.toml --test service_diagnostics` passes all three native tests.

The native check requires the pinned upstream checkout at `../open-notebook` (relative to `src-tauri/`), because `tauri.conf.json` points `bundle.icon` at the upstream favicon and `tauri-build` fails without it. CI provides that checkout in the `build-installer` job. A local run without it fails in the build script, not in this change.

Component tests are not a packaged-application test. The actual installed application still has to be exercised before native acceptance can close.

## Outstanding evidence and deployment scope

The upstream backend is now pinned to `a0f6f3081ae06328f0a451b3a3ef2959ca25721d` by upstream `70e0ae4`, and CI assembles it through `scripts/prepare-runtime.js`. Backend code can still write its own files independently of redirected stdout/stderr; crash dumps and exports also need owning-source and runtime checks. No launcher log-export implementation was found in the reviewed code, and none was added. This change does not prove that all application or cloud diagnostics satisfy TC-CRYP-03.

The user selected three target configurations: entirely local desktop, desktop with approved cloud AI providers, and an Azure-hosted backend. The diagnostics boundary is shared groundwork. Mode selection, egress restrictions, backend identity/authorization, remote TLS/networking, managed cloud keys, infrastructure deployment and tenant evidence are tracked separately. No Azure resources were provisioned by this task.

## Observed verification results

On the ported branch, in this checkout:

```text
npm run build:types                                   PASS
node scripts/orchestrator/verifier.js                PASS (28/28 suites)
node scripts/tests/test-service-diagnostics.js        PASS
cargo check --offline --manifest-path src-tauri/Cargo.toml   PASS
cargo test --offline --manifest-path src-tauri/Cargo.toml --test service_diagnostics   PASS (3/3)
```

One pre-existing upstream defect was repaired in the same change: `scripts/tests/test-readiness.js` asserted that a request to literal port `0` fails, which is false on Windows (port `0` connects to a real listener and returns a status). The test now uses its own loopback server and checks successful, unavailable and refused connections. This was not caused by the diagnostics work; the verifier failed on this test at upstream `913c418` before it was changed.
