# F05 runtime inventory and packaging handoff

Recorded 2026-11-04 on `codex/ferpa-runtime-evidence`, based on `897ba88`.

This change completes the runtime evidence and packaging boundary portion of F05. It does not complete F05, demonstrate an installed application, or establish production security.

## Result

`scripts/lib/runtime-evidence.js` records a sorted SHA-256/size inventory of runtime files, excluding the manifest itself. Preparation records the requested and completed steps, upstream revision and clean-source status, actual Python/SurrealDB versions and resolved Python package names/versions when those components are built. Partial and overridden output remains ineligible for packaging.

`scripts/prepare-runtime.js` now requires the compiled allowlist contract and treats validation failures as errors. It invalidates an old manifest before a component can change artifacts, copies only tracked backend source, checks cached SurrealDB binaries against the approved checksum, and rechecks upstream HEAD/status after component preparation. Output ancestry is canonicalized; source overlap and deletion outside the current runtime/unique temporary build directory are rejected.

`scripts/package-native.js`, `scripts/package.js` and both installer scripts validate runtime evidence before producing or replacing output. They reject legacy manifests, partial/overridden/unpinned inventories, unsupported versions, missing components, POC frontend metadata, changed/extra files, symbolic links and failed allowlist checks. Installer validation applies to the packaged runtime, not merely the source runtime.

The stronger boundary is separate from the historical TypeScript manifest parser so its existing callers retain their contract. File hashes detect drift relative to a locally generated inventory; this is not a signature, a dependency advisory scan, or proof of functional application behavior.

## Fixture isolation

`scripts/tests/test-upstream-lock.js` uses a unique temporary source repository, lock and runtime. It no longer changes the production lock or writes dummy backend artifacts into `resources/runtime`. It asserts that production files remain unchanged.

`--runtime-dir` selects an isolated output. `--lock-file` supports a test lock only with an isolated output; production packagers always compare against the checkout's real lock. A successful single-step command means only that the component step and inventory completed.

`scripts/tests/test-runtime-evidence.js` exercises synthetic acceptance and negative cases in temporary directories. It executes copies of the real packaging entrypoints against isolated invalid runtimes and verifies that existing output is preserved. Synthetic executables in this suite are never launched and are not application acceptance evidence.

## Verification observed

All checks below passed in this checkout on 2026-11-04:

- `npm run build:types` after every edited file.
- `node scripts/tests/test-upstream-lock.js`.
- `node scripts/tests/test-runtime-evidence.js`.
- `node scripts/orchestrator/verifier.js`: 30/30 suites, including its type build.
- `git diff --check`.

The suites include mismatch/override rejection, partial inventories, malformed evidence, changed/extra artifacts, POC detection, missing validation, ignored-source exclusion, source-junction overlap, corrupt cached binary rejection, failed-build manifest invalidation and all four packaging entrypoints.

## Remaining F05 work

The default upstream checkout at `../open-notebook` is absent locally. The existing local runtime was dummy output from the old test and is not an assembled backend. This change preserves it rather than presenting it as real evidence.

The frontend builder currently creates heading-only HTML through `buildStaticClientPoc`. Its provenance remains explicitly `parallel-static-client-poc`; full preparation cannot issue an assembled-runtime verdict. Consequently the installer release job will stop at runtime preparation until a functional frontend is implemented and verified. Do not weaken the gate to publish the POC.

Next implementation must provide the approved pinned source checkout, build a functional frontend compatible with the native host, resolve/pin Python dependencies, assemble actual components, and inspect source/data boundaries. Then collect real hashes/versions and run backend/installed-application smoke and negative tests. Python package name/version inventory is not an SBOM or a reproducible dependency lock.

F04 also remains open. The merged per-install credential work still needs fail-closed random generation and persistence, migration/recovery for initialized datastores, least privilege and protected key storage. Address that as a separate logical task.

Commit these explicit task files with the required trailer, announce branch/summary/observed checks, and stop for bridge review under AGENTS.md.
