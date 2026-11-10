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

## F03 continuation on 2026-11-10

Baseline: the local checkout was fast-forwarded from `a6c46fd` to fetched
GitHub `upstream/main` at `ce07b14` before creating
`codex/f03-native-acceptance`. No application data was used or changed.

### Native proxy diagnostic correction

The production native proxy previously embedded a reqwest error in its own
HTTP 502 JSON response. A connection failure includes the target URL, so
request paths and query values could escape through that diagnostic response.
It now returns only `{"error":"UPSTREAM_CONNECTION_FAILED"}` and retains status
502. Successful backend responses remain unchanged; this does not sanitize
errors generated by the backend itself.

Three tests in [proxy.rs](../../../src-tauri/src/proxy.rs) execute the production
proxy over ephemeral loopback HTTP listeners:

- Connection refusal with synthetic record/token values in the query.
- An upstream peer returning malformed HTTP.
- A successful backend response containing synthetic record content.

Before the correction, both failure cases reproduced disclosure of request data;
the success case passed. After the correction, all three passed. These are live
transport tests of the native module, not simulations of a proxy contract.
The Windows installer CI job now runs these tests and the existing native
service diagnostics integration tests before assembling the runtime. The new
CI steps have not been executed on GitHub as part of this local work.

### Owning-source review

The available upstream source was verified at
`a0f6f3081ae06328f0a451b3a3ef2959ca25721d`. A source search of the shipped
`api/`, `open_notebook/` and `commands/` modules found Loguru calls, including
exceptions and tracebacks, but no application-owned `logger.add`,
`logger.configure`, Python file handlers or explicit faulthandler setup.
Their default stderr output is discarded by the launcher process boundary.

The source download endpoint in `api/routers/sources.py` returns original
uploaded content; podcast audio streaming in `api/routers/podcasts.py` returns
audio files. These are product data, not sanitized diagnostic exports. No
diagnostic export endpoint was identified in these reviewed modules.
This inspection does not cover resolved third-party dependencies, OS-managed
crash reporting, every application response, or live file writes.

### Observed local verification

- `npm run build:types`: PASS after each source/document edit.
- `node scripts/orchestrator/verifier.js`: PASS, 30/30 suites, including the
  existing real-process JavaScript/Rust diagnostic tests.
- Direct `rustc --test src-tauri/src/proxy.rs` compilation using the cached
  dependency rlibs and Windows import libraries: PASS; 3/3 live HTTP tests.
- Full `cargo test --offline --manifest-path src-tauri/Cargo.toml --test service_diagnostics`:
  did not complete; it produced no output or compiler process and was stopped.
  No full-Cargo/native application build success is claimed by this work.
- `node scripts/package-native.js --out .artifacts/f03-packaging-check`:
  FAIL at preflight, before packaging. Missing
  `resources/runtime/python/python.exe`,
  `resources/runtime/surreal/surreal.exe`, and
  `resources/runtime/frontend/static`.

The existing local runtime manifest names upstream `0978800c...`, not the
locked revision. Its presence therefore does not establish an assembled pinned
runtime. The runtime and lock file were left unchanged.

### Remaining acceptance gate

F03 remains open for installed-application and backend/dependency-owned sinks.
Its next acceptance run requires the F05 assembled runtime:

1. Assemble the real pinned UI, backend, Python dependencies and SurrealDB;
   record versions/hashes and build/install the actual Windows application.
2. Use a new isolated test data directory and synthetic record/credential/path
   canaries. Exercise API and worker failures, nonzero exits, restart, and
   missing/unwritable diagnostic destinations through the application.
3. Inspect lifecycle files, parent output/dialogs, backend/dependency-created
   files, crash outputs and any diagnostic export. Confirm fixed host-generated
   diagnostics contain no canaries, while intentional product data remains
   available through its normal authorized workflow.
4. Record the actual installed application version, runtime hashes, actions,
   inspected sinks and results. Keep any untested sink explicitly unverified.

These results advance the native diagnostic boundary. They do not close F03,
F05, cloud diagnostics, or institutional production acceptance.
