# FERPA and cloud security source inventory

Reviewed on 2026-11-02 against baseline commit `1c552ad0b0bd71a2da96f7f1f92900b4e7b69d12` in this Windows checkout. The first implementation is on `codex/ferpa-security-foundation`. This is a source review and an inventory of missing evidence. It does not establish FERPA compliance or deployment readiness.

## Scope and provenance

The application in this checkout is a desktop launcher and native host. `package.json` starts Rust/Tauri by default and retains Electron entrypoints. The Python API, application authorization, database schema, and frontend are assembled from upstream by `scripts/prepare-runtime.js`; they are not application source owned by this checkout.

Before verification, `resources/runtime/` was absent. The upstream-lock test generates a dummy backend and manifest; those synthetic test outputs are not evidence of an assembled or approved runtime. No desktop application, real backend, Azure resource, or student record was exercised for this inventory.

`upstream.lock.json` names `lfnovo/open-notebook` and was originally pinned to an all-zero commit against a mutable `main` tag. Upstream `70e0ae4` has since pinned it to the real revision `a0f6f3081ae06328f0a451b3a3ef2959ca25721d`, and CI verifies the checkout matches that revision. The upstream revision is therefore resolved; upstream-owned backend behavior and compatibility are still unverified by this review. The completed modernization statements in `.agent/CURRENT_TASK.md` and the architecture guide are historical claims; current security conclusions require owning-source and runtime evidence. Existing local edits to `AGENTS.md` and the supplied compliance materials were preserved.

## Runtime and data boundaries

| Component or boundary | Owning source | What source establishes | Missing evidence |
| --- | --- | --- | --- |
| Primary desktop host | `src-tauri/src/main.rs`, `runner.rs` | Starts local database, API, worker, static server and proxy | Successful native build, installed-app execution, authenticated backend behavior |
| Retained JavaScript launcher | `main.js`, `scripts/start-services.js` | Builds child environment; launches local services; stores files beneath user data directory | Actual runtime smoke test, secret-store and migration verification |
| Database | `scripts/start-services.js`, `src-tauri/src/runner.rs` | SurrealDB is configured on loopback with fixed `root/root` credentials | Nondefault credentials, least privilege, existing-database credential migration, storage encryption |
| Local API and worker | `scripts/start-services.js`, `src-tauri/src/runner.rs` | Python service startup commands and loopback API configuration | Pinned backend source, object authorization, session enforcement, consent and disclosure rules |
| API proxy and static server | `src-tauri/src/server.rs`, `proxy.rs`, `static_server.rs` | Native listener binds loopback; proxy forwards requests | Host/Origin and request authorization guards; enforced streamed-body bounds; runtime traversal and streaming tests |
| Browser boundary | `src-tauri/src/security.rs`, `src-tauri/tauri.conf.json`, `main.js` | Navigation rules exist; Tauri CSP is null | Active CSP, exact-origin checks in all hosts, external-link and malicious-navigation runtime tests |
| Service diagnostics | `scripts/service-diagnostics.js`, `src-tauri/src/service_diagnostics.rs` | Child stdout/stderr were written to logs and console without invoking the sample redactor; F03 now discards them at the OS boundary and writes `<service>.lifecycle.jsonl` with generated timestamps, fixed identifiers and numeric exit status only | Data minimization at every sink; synthetic record and credential leak tests |
| Local encryption key | `main.js:26` | A generated key is stored in `encryption-key.txt` | OS-protected key storage, rotation, migration and recovery; data encryption coverage is unknown |
| Model providers and other egress | Backend assembled by `scripts/prepare-runtime.js` | Provider calls are outside the available backend source | Actual destinations, approved vendors, default-deny policy, consent/exception decisions, request and retry tests |
| Cloud infrastructure | No Azure deployment or IaC identified in source review | This checkout does not establish a cloud deployment | Approved hosting model, tenant and region; identity, networking, key, storage and logging configuration |

Loopback binding reduces exposure but does not establish authentication, authorization, or protection from other local processes. A field-encryption key does not prove that databases, uploads, logs and backups are encrypted.

## Existing verification and assurance limits

The mandatory commands are `npm run build:types` and `node scripts/orchestrator/verifier.js`. The verifier discovers `scripts/tests/test-*.js` and runs them serially. Several modernization suites operate on contracts or synthetic reports rather than a running native host and backend. Passing them alone cannot establish production security or measured application performance.

The L8.2 audit originally returned fixed successful secret traces, fabricated dependency/license conclusions and a mock CVE, then reported `fullyCompliant: true`. This first implementation removes the invented inventory/scan results, marks production traces unverified, keeps the diagnostic finding open, and records only executed synthetic redaction checks. Its schema now requires fixture provenance and rejects a production-compliance verdict. Other historical modernization audit/report claims still need independent assessment.

The verifier also exposed two pre-existing test defects: an absent benchmark baseline and a readiness test that used literal port zero. Upstream `fbc0ff3` added the benchmark baseline file and made the performance comparison test compile the contract natively instead of shelling out to `npx`; the comparison still measures the local machine rather than a controlled environment, so its numbers are not portable evidence. The readiness test used literal port zero, which is false on Windows: port `0` connects to a real listener and returns a status. This branch repairs the readiness test to use its own loopback server and check successful, unavailable and refused connections.

The dependency lockfile had described an older package manifest and omitted the current TypeScript build dependencies. It was refreshed, and `npm ci --ignore-scripts --no-audit --no-fund` installed build dependencies. This did not execute an advisory scan, approve licenses, download an Electron application binary, or demonstrate a packaged application.

## F03 follow-up on 2026-11-03

The baseline observations above describe the original source. On `codex/ferpa-service-diagnostics`, the JavaScript and Rust launchers now discard child stdout/stderr at the OS boundary and write separate `<service>.lifecycle.jsonl` files containing only generated timestamps, fixed service/event identifiers and numeric exit status. Startup/shutdown error messages no longer forward arbitrary errors or missing-file paths to the reviewed launcher console/dialog sinks. Existing raw logs remain unchanged and must not be treated as sanitized.

`node scripts/tests/test-service-diagnostics.js` runs real children through both production process boundaries and exercises JavaScript CLI/Electron startup/shutdown error paths. The Rust module is compiled directly and tested with real processes. Those tests do not establish that the full Tauri application builds, that the Electron desktop was launched, or that backend-owned files and exports are safe.

The native baseline `cargo check --offline --manifest-path src-tauri/Cargo.toml` had failed before this work: Tauri context generation lacked build-script output, the navigation policy used an unsupported `Window.on_navigation` method, and the old Tokio child-handle call was invalid. Upstream `70e0ae4` has since repaired all three, so the native check passes on the ported branch and F03 uses the tested standard-library child handle. Installed-app acceptance is still open. See [SERVICE_DIAGNOSTICS_HANDOFF.md](SERVICE_DIAGNOSTICS_HANDOFF.md).

The selected target scope is now all three configurations: fully local desktop, desktop with approved cloud AI and an Azure-hosted backend. Their mode-specific controls and tenant evidence remain open in the implementation queue.

## Source guidance and interpretation

The supplied Word guides were read as local requirement inputs, including their control tables. The testing checklist has 21 test IDs across authentication, cryptography, logging, rights/consent and lifecycle domains. Their implementation and evidence are tracked in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

The portable SSD manifest describes a separate research project and historical media transfer. Its statements about omitted raw records do not substantiate the contents or security of this application. The supplied guides and compliance index are reference materials, not test results or certificates for this checkout.

Some local guide language presents chosen technical controls and example retention periods as general legal requirements. Treat these as proposed project acceptance criteria requiring institutional confirmation. FERPA recordkeeping has exceptions; the governing requirements and retention rules must be checked for the particular disclosure and records. See the [Department of Education regulations](https://studentprivacy.ed.gov/ferpa) and [cloud computing guidance](https://studentprivacy.ed.gov/sites/default/files/resource_document/file/FAQ_Cloud_Computing_0.pdf).

Microsoft states that FERPA does not require or recognize certifications. Azure services do not establish the institution's compliance by themselves; the customer retains responsibility for data, identities, configuration and access. See [Microsoft FERPA guidance](https://learn.microsoft.com/en-us/compliance/regulatory/offering-ferpa) and [Azure shared responsibility](https://learn.microsoft.com/en-us/azure/security/fundamentals/shared-responsibility).
