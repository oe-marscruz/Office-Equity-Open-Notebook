# F03 native diagnostics acceptance - 2026-11-10

Continuation of [the original diagnostics handoff](../compliance/ferpa/SERVICE_DIAGNOSTICS_HANDOFF.md).
Branch: `codex/f03-native-acceptance`. Saved data-isolation commit: `7b91dd1`.
Packaging/startup fixes and regression tests: `3de2fbd`.

## Current result

The real unpacked release and the actual installed Windows application both passed synthetic notebook creation, restart persistence, forced API/worker failure, and blocked-diagnostic-path checks. The installer completed with exit code 0; the installed executable and all 23,876 runtime files matched the tested package. The isolated test installation was subsequently removed. Existing 1.14.1 installation metadata and original shortcuts were restored, and its executable hash was unchanged. This closes the specific installed-application checks exercised here; it does not close every F03 diagnostic boundary.

F03 remains open for the untested acceptance boundaries listed below. No GitHub publication or Azure deployment occurred.

## Corrections proved through application runs

1. The initial package exited with `0xC0000135`. PE import inspection identified `WebView2Loader.dll`, emitted in the Rust release directory but omitted by the packager. A new packaging regression test reproduced the missing file before the fix. The packager now includes the loader when emitted; the test also supports builds that link it statically.
2. After adding the DLL, the application exited before API readiness. The native window used an embedded URL although its navigation policy allows the local HTTP origin. Startup also created the window before its services were ready. Startup now waits for service initialization, then opens `http://127.0.0.1:8502/`. The corrected release completed the real application tests.
3. Native data isolation from the previous save point remains in place: absolute `OEON_DATA_DIR`, backend `DATA_FOLDER`, bundled token-cache path, and UTF-8 Python mode. API and worker data did not appear under the packaged backend resources.
4. The installer builder accepts `--app` and `--out` so acceptance artifacts do not replace the default package. Windows CI now includes the window-origin tests; that workflow change has not been executed on GitHub here.

## Observed verification

| Check | Result |
| --- | --- |
| `npm.cmd run build:types` after each authored file edit | PASS |
| `node scripts/orchestrator/verifier.js` | PASS, 31/31 suites |
| Full offline Cargo tests through short target path | PASS, 50 tests |
| Release native build | PASS |
| Runtime Python imports/version inventory | PASS, Python 3.12.14, 184 distributions |
| Real static frontend | PASS, 200 files; build reported Next.js 16.3.8 |
| Packaged runtime vs recorded inventory | PASS, 23,876 files, zero missing/changed/extra files |
| Packaged startup + frontend HTTP | PASS |
| Synthetic notebook create + application restart persistence | PASS |
| Forced worker/API process exits | PASS, each recorded numeric exit code 1 |
| Host 502 after API termination with query/token canaries | PASS, fixed `UPSTREAM_CONNECTION_FAILED`, no query disclosure |
| API and worker diagnostic destinations blocked by directories at JSONL file paths | PASS, fixed startup-failure message observed and affected service not spawned |
| Inspected host lifecycle files and parent output | PASS, expected schema, no synthetic record/token/path canaries |
| Actual NSIS installer compilation | PASS |
| Actual installed application smoke/failure checks | PASS, repeated through the installed executable |
| Installed runtime hash comparison | PASS, 23,876 files, no missing/changed/extra files |
| Test uninstall and prior-installation restoration | PASS; registry preflight limitation described below |

The blocked-path cases test a directory where a diagnostic file should be. They do not establish behavior under every Windows ACL-denial condition. The frontend test exercised its actual HTTP assets and API workflow; visual interaction in the native WebView was not inspected.

The full native run covered 34 application tests, 1 contract harness, 3 proxy/static tests, 6 service-diagnostics/path tests, and 6 static-route tests. The repository packaging regression executes the real packager with controlled build dependencies; the subsequent real executable launches separately establish runtime evidence.

## Artifacts and provenance

All generated artifacts below are ignored local files under `resources/.cache/f03-acceptance/` and are not included in Git commits:

- `runtime/`: assembled core runtime.
- `runtime-inventory.json`: versions and SHA-256 for 23,876 files, totaling 691,889,095 bytes.
- `package/Office of Equity Open Notebook/`: tested unpacked release.
- `package-runtime-verification.json`: comparison against that complete inventory.
- `application-smoke-result.json`: successful create/restart/canary checks.
- `application-failures-result.json`: strengthened failure checks requiring the fixed startup-failure message for each blocked destination.
- `application-smoke-missing-loader.json` and `application-smoke-before-startup-fix.json`: initial reproduced failures.
- `verifier-latest.txt`: complete final repository-verifier output.
- `installer/Office of Equity Open Notebook-1.14.0-Setup.exe`: actual Windows installer, 251,608,281 bytes.
- `install-attempt.json`: successful installation, exact isolated target, executable hash, and shortcut backups.
- `installed-application-smoke-result.json` and `installed-application-failures-result.json`: successful tests of the actual installed executable.
- `installed-runtime-verification.json`: complete installed payload hash comparison.
- `uninstall-result.json`: successful cleanup and previous-installation restoration checks.
- `data-sink-inspection.json`: 139 synthetic-data files inventoried, including 25 host diagnostic files and 11 datastore .log files. Host diagnostics had no canaries. Datastore .log files are product storage and are not characterized as sanitized diagnostics.

SHA-256:

| Artifact | SHA-256 |
| --- | --- |
| Tested release executable | `73D353831C4980A3A91256CF0E4AA7F06D2B88C92CAA6D435B59AF33EAD11CC4` |
| WebView2Loader.dll | `38F04671D2BD3FD580AEAE4CFBE6FEDBB79970D754869FC2907759846030CD44` |
| Windows installer | `8DD256C2E9AD3F7D1F05F2374478E68133FF30A100415A136607D439AD8A9E61` |
| SurrealDB 2.6.5 | `DD9B6FA15EDACBDE96D490DD5727B49B5CF40DF80F29074C7DC17ACB974F509F` |

Backend and frontend were rebuilt from upstream `a0f6f3081ae06328f0a451b3a3ef2959ca25721d`. Python and SurrealDB came from the existing AndroidStudioProjects checkout's `resources/.cache/f05-stage/runtime/`. Their actual copied contents were inventoried and compared with the packaged payload; no prior acceptance claims were transferred from that checkout. Python dependencies were not freshly resolved against a reviewed immutable lock in this continuation. Docling is absent and the runtime is explicitly `core`.

Runtime manifests retain their original assembly baseline `3e4caf6`; that field is not evidence of a clean-tree build of the subsequently corrected native host. The source changes were saved as `3de2fbd` after the native build and tests. The installer labels itself 1.14.0, while Tauri configuration declares 1.0.0; retain the hashes above as the precise artifact identity. The existing resource-manifest/linker warning and unavailable rcedit remain recorded build limitations.

The original `resources/runtime/` and `upstream.lock.json` were not replaced. Application tests used new synthetic-only directories under the ignored acceptance folder and stopped their own processes. Generated changes to tracked `.artifacts/` files were restored before the source commit.

## Commands and toolchain

The rustup Cargo shim stalled in this environment. Direct GNU Cargo initially exposed a windres failure on spaces in `Codex Projects`. A short-path junction reuses the existing build cache:

`C:/Users/cruzmars/.cache/oeon-f03-target` -> this checkout's `src-tauri/target`.

```powershell
$env:PATH = 'C:\Users\cruzmars\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin;' + $env:PATH
$env:RUSTC = 'C:\Users\cruzmars\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin\rustc.exe'
& 'C:\Users\cruzmars\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin\cargo.exe' test --offline --manifest-path src-tauri/Cargo.toml --target-dir 'C:\Users\cruzmars\.cache\oeon-f03-target'
$env:CARGO_TARGET_DIR = 'C:\Users\cruzmars\.cache\oeon-f03-target'
$env:CARGO_NET_OFFLINE = 'true'
node scripts/package-native.js --runtime resources/.cache/f03-acceptance/runtime --out resources/.cache/f03-acceptance/package
node resources/.cache/f03-acceptance/application-smoke.js
node resources/.cache/f03-acceptance/application-failures.js
node resources/.cache/f03-acceptance/verify-package-runtime.js
node scripts/build-installer-native.js --app 'resources/.cache/f03-acceptance/package/Office of Equity Open Notebook' --out resources/.cache/f03-acceptance/installer --makensis 'C:\Program Files (x86)\NSIS\makensis.exe'
```

## Remaining boundary

Installed workflow, failure checks, payload verification, and test cleanup are complete for the cases above. OS-managed crash reporting, true ACL-denial cases, every backend error response/export, full/Docling runtime, cloud diagnostics, clean-machine deployment, and institutional acceptance are not verified by these results. Dependency provenance still needs the F05 reproducibility review. The synthetic notebook and diagnostic tests establish only the specific behaviors exercised above.

## Installation, registry preflight limitation, and cleanup

The first installation preflight found existing Desktop and Start Menu shortcuts and stopped before installing. Both shortcuts were backed up with SHA-256 checks. The second attempt installed into `C:/Users/cruzmars/.cache/oeon-f03-installed-4a073c68f99645d38735b309831e9087`, then restored the pre-existing shortcuts.

The initial registry check missed the 32-bit registry view. A prior 1.14.1 Electron installation existed at `C:/Program Files/Office of Equity Open Notebook`; the test installer temporarily replaced its 32-bit uninstall registration. This is a limitation of this acceptance run's preflight, not evidence of safe side-by-side installer behavior. Future runs must check both registry views or use a disposable Windows VM before installing.

Before test cleanup, the unchanged prior install-location key was exported. The original application's package metadata, executable version, and shipped installer source established the correct 1.14.1 registration fields. Remaining registration fields were preserved through export. The test uninstaller ran only from the validated isolated target, and the prior install-location key and uninstall metadata were restored. No exact pre-test snapshot of the 32-bit uninstall key existed; restoration used verified installed metadata and preserved fields rather than claiming a byte-for-byte registry rollback.

Observed cleanup results in `uninstall-result.json`:

- Uninstaller exit code 0; test payload removed. A subsequent check confirmed the entire isolated target directory was absent.
- Both original shortcuts matched their pre-test hashes.
- Prior install-location key and uninstall registration point to the existing 1.14.1 installation again.
- Existing 1.14.1 executable SHA-256 before and after cleanup: `8F131845F64A3742C808261C710DAB4217842E1E72BF4B434276569F0C36E09C`.

Installed test helpers and `uninstall-test.ps1` remain in the ignored evidence folder. They were executed successfully for this test. The cleanup helper validates the target prefix, matching uninstall registration, prior installed metadata, and preserved executable hash. It is specific to this recorded test and should not be reused blindly for another installation.
