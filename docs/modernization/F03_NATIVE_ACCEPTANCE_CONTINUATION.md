# F03 native acceptance continuation — 2026-11-10

Continuation of [the diagnostics handoff](../compliance/ferpa/SERVICE_DIAGNOSTICS_HANDOFF.md).
Branch: `codex/f03-native-acceptance`. Starting commit: `3e4caf6`.
The user requested a save point before application launch or installation.

## Saved source changes

- `src-tauri/src/runtime_paths.rs` validates an optional absolute `OEON_DATA_DIR` override. Empty and relative overrides fail closed; the default application directory is preserved when absent.
- Native startup supplies `DATA_FOLDER=<selected-directory>/data`, `TIKTOKEN_CACHE_DIR=<runtime>/tiktoken-cache`, and `PYTHONUTF8=1` to both API and worker. Previously backend-owned uploads and SQLite could be written relative to the bundled backend directory.
- Native diagnostics integration tests include the production path resolver and three new cases (default, explicit absolute directory, invalid overrides).
- `scripts/package-native.js --runtime <directory>` selects an isolated runtime for packaging; the existing default remains available.

## Verified results

- `npm.cmd run build:types`: PASS after each edited source file.
- `node scripts/orchestrator/verifier.js`: PASS, 30/30 suites.
- Full offline Cargo test run: PASS, 49 tests (33 application tests, 1 contract harness, 3 proxy/static tests, 6 diagnostics/path tests, 6 static-route tests).
- Actual pinned frontend static build: PASS, 200 files / 6.6 MiB; Next.js build output reported 16.3.8. Upstream revision matched `a0f6f3081ae06328f0a451b3a3ef2959ca25721d`.
- Backend assembly and tiktoken offline cache: PASS in the isolated output.
- Actual release native package: PASS. Cargo release compilation completed in 10m47s, followed by runtime copying. The linker warned about multiple non-default manifests; graphical/runtime impact remains unverified. rcedit was unavailable, so executable metadata was not rewritten.

Generated artifacts are ignored local files under `resources/.cache/f03-acceptance/`:

- `runtime/`: assembled core runtime, with real frontend and pinned backend.
- `package/Office of Equity Open Notebook/Office of Equity Open Notebook.exe`: unpacked release executable.
- Executable SHA-256: `14108451FFEBAAC5845C3F5ECE782F45CE579ADA5392887996B1DA3C80396BD4`.
- `inventory.js`: retained full-runtime hashing and Python import/version inventory script. It was interrupted at the requested save point; no completed inventory result is claimed. Rerun with `node resources/.cache/f03-acceptance/inventory.js`.

Python and SurrealDB were copied from the existing AndroidStudioProjects checkout's `resources/.cache/f05-stage/runtime/`; no source-code or acceptance claims were transferred from that checkout. This runtime contains 184 Python distribution metadata directories. Docling was absent, so the assembled and packaged runtime manifests were corrected to `variant: core`. SurrealDB's SHA-256 independently matched the assembler's pinned checksum:
`DD9B6FA15EDACBDE96D490DD5727B49B5CF40DF80F29074C7DC17ACB974F509F`.
Python dependencies have not been freshly resolved against a reviewed immutable lock in this continuation. The manifest's `wrapperCommit` is the pre-edit baseline, not evidence that the package was built from a clean committed tree. The release executable was compiled with the saved working-tree source changes.

The existing `resources/runtime/` and `upstream.lock.json` were not modified. Test-generated changes to tracked `.artifacts/` files were restored to the initially clean baseline before saving.

## Reproducible native toolchain workaround

The rustup-shim Cargo invocation stalled. Direct Cargo revealed that GNU windres failed on the space in `Codex Projects`. A short-path junction points at the existing target cache:

`C:/Users/cruzmars/.cache/oeon-f03-target` -> this checkout's `src-tauri/target`.

Use the explicit installed compiler and Cargo, with the short target directory:

```powershell
$env:PATH = 'C:\Users\cruzmars\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin;' + $env:PATH
$env:RUSTC = 'C:\Users\cruzmars\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin\rustc.exe'
& 'C:\Users\cruzmars\.rustup\toolchains\stable-x86_64-pc-windows-gnu\bin\cargo.exe' test --offline --manifest-path src-tauri/Cargo.toml --target-dir 'C:\Users\cruzmars\.cache\oeon-f03-target'
```

For packaging with that existing junction:

```powershell
$env:CARGO_TARGET_DIR = 'C:\Users\cruzmars\.cache\oeon-f03-target'
$env:CARGO_NET_OFFLINE = 'true'
node scripts/package-native.js --runtime resources/.cache/f03-acceptance/runtime --out resources/.cache/f03-acceptance/package
```

## Next acceptance work — still open

1. Complete the runtime inventory and confirm dependency provenance/imports. Keep the core variant explicit; full/Docling behavior is untested.
2. Launch the saved release executable with `OEON_DATA_DIR` set to a new absolute test directory. Check that ports 8000, 5055, and 8502 are unused first. No application was launched in this continuation; no personal application data was accessed.
3. Exercise synthetic notebook workflows, API and worker failures, nonzero exits, restart, and missing/unwritable diagnostics destinations through the packaged application. Inspect both host lifecycle diagnostics and backend/dependency-owned file sinks; verify backend data stays outside bundled resources.
4. Build/install the real Windows installer and repeat acceptance in the installed application. The saved package is an unpacked release, not installer acceptance.
5. Record application/runtime hashes, exact actions, inspected sinks, canaries, and results. Keep OS crash sinks, exports, cloud diagnostics, and untested UI behavior explicitly unverified.

F03, F05, and institutional production acceptance remain open. No Azure deployment or GitHub publication occurred.
