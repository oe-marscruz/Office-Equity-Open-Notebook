# FERPA and cloud security source inventory

Reviewed on 2026-11-02 against baseline commit `1c552ad0b0bd71a2da96f7f1f92900b4e7b69d12` in this Windows checkout. The first implementation is on `codex/ferpa-security-foundation`. This is a source review and an inventory of missing evidence. It does not establish FERPA compliance or deployment readiness.

## Scope and provenance

The application in this checkout is a desktop launcher and native host. `package.json` starts Rust/Tauri by default and retains Electron entrypoints. The Python API, application authorization, database schema, and frontend are assembled from upstream by `scripts/prepare-runtime.js`; they are not application source owned by this checkout.

Before verification, `resources/runtime/` was absent. The upstream-lock test generates a dummy backend and manifest; those synthetic test outputs are not evidence of an assembled or approved runtime. No desktop application, real backend, Azure resource, or student record was exercised for this inventory.

`upstream.lock.json` names `lfnovo/open-notebook` but contains an all-zero commit and a mutable `main` tag. The actual upstream revision and compatibility remain unresolved. The completed modernization statements in `.agent/CURRENT_TASK.md` and the architecture guide are historical claims; current security conclusions require owning-source and runtime evidence. Existing local edits to `AGENTS.md` and the supplied compliance materials were preserved.

## Runtime and data boundaries

| Component or boundary | Owning source | What source establishes | Missing evidence |
| --- | --- | --- | --- |
| Primary desktop host | `src-tauri/src/main.rs`, `runner.rs` | Starts local database, API, worker, static server and proxy | Successful native build, installed-app execution, authenticated backend behavior |
| Retained JavaScript launcher | `main.js`, `scripts/start-services.js` | Builds child environment; launches local services; stores files beneath user data directory | Actual runtime smoke test, secret-store and migration verification |
| Database | `scripts/start-services.js`, `src-tauri/src/runner.rs` | SurrealDB is configured on loopback with fixed `root/root` credentials | Nondefault credentials, least privilege, existing-database credential migration, storage encryption |
| Local API and worker | `scripts/start-services.js`, `src-tauri/src/runner.rs` | Python service startup commands and loopback API configuration | Pinned backend source, object authorization, session enforcement, consent and disclosure rules |
| API proxy and static server | `src-tauri/src/server.rs`, `proxy.rs`, `static_server.rs` | Native listener binds loopback; proxy forwards requests | Host/Origin and request authorization guards; enforced streamed-body bounds; runtime traversal and streaming tests |
| Browser boundary | `src-tauri/src/security.rs`, `src-tauri/tauri.conf.json`, `main.js` | Navigation rules exist; Tauri CSP is null | Active CSP, exact-origin checks in all hosts, external-link and malicious-navigation runtime tests |
| Service diagnostics | `scripts/start-services.js:247`, `src-tauri/src/runner.rs:127` | Child stdout/stderr are written to logs and console without invoking the sample redactor | Data minimization at every sink; synthetic record and credential leak tests |
| Local encryption key | `main.js:26` | A generated key is stored in `encryption-key.txt` | OS-protected key storage, rotation, migration and recovery; data encryption coverage is unknown |
| Model providers and other egress | Backend assembled by `scripts/prepare-runtime.js` | Provider calls are outside the available backend source | Actual destinations, approved vendors, default-deny policy, consent/exception decisions, request and retry tests |
| Cloud infrastructure | No Azure deployment or IaC identified in source review | This checkout does not establish a cloud deployment | Approved hosting model, tenant and region; identity, networking, key, storage and logging configuration |

Loopback binding reduces exposure but does not establish authentication, authorization, or protection from other local processes. A field-encryption key does not prove that databases, uploads, logs and backups are encrypted.

## Existing verification and assurance limits

The mandatory commands are `npm run build:types` and `node scripts/orchestrator/verifier.js`. The verifier discovers `scripts/tests/test-*.js` and runs them serially. Several modernization suites operate on contracts or synthetic reports rather than a running native host and backend. Passing them alone cannot establish production security or measured application performance.

The L8.2 audit originally returned fixed successful secret traces, fabricated dependency/license conclusions and a mock CVE, then reported `fullyCompliant: true`. This first implementation removes the invented inventory/scan results, marks production traces unverified, keeps the diagnostic finding open, and records only executed synthetic redaction checks. Its schema now requires fixture provenance and rejects a production-compliance verdict. Other historical modernization audit/report claims still need independent assessment.

The verifier also exposed two pre-existing test defects: an absent benchmark baseline and a readiness test that used literal port zero. The performance comparison test now uses explicitly synthetic inputs; it does not manufacture a measured baseline. The readiness test uses its own loopback server and checks successful, unavailable and refused connections.

The dependency lockfile had described an older package manifest and omitted the current TypeScript build dependencies. It was refreshed, and `npm ci --ignore-scripts --no-audit --no-fund` installed build dependencies. This did not execute an advisory scan, approve licenses, download an Electron application binary, or demonstrate a packaged application.

## Source guidance and interpretation

The supplied Word guides were read as local requirement inputs, including their control tables. The testing checklist has 21 test IDs across authentication, cryptography, logging, rights/consent and lifecycle domains. Their implementation and evidence are tracked in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

The portable SSD manifest describes a separate research project and historical media transfer. Its statements about omitted raw records do not substantiate the contents or security of this application. The supplied guides and compliance index are reference materials, not test results or certificates for this checkout.

Some local guide language presents chosen technical controls and example retention periods as general legal requirements. Treat these as proposed project acceptance criteria requiring institutional confirmation. FERPA recordkeeping has exceptions; the governing requirements and retention rules must be checked for the particular disclosure and records. See the [Department of Education regulations](https://studentprivacy.ed.gov/ferpa) and [cloud computing guidance](https://studentprivacy.ed.gov/sites/default/files/resource_document/file/FAQ_Cloud_Computing_0.pdf).

Microsoft states that FERPA does not require or recognize certifications. Azure services do not establish the institution's compliance by themselves; the customer retains responsibility for data, identities, configuration and access. See [Microsoft FERPA guidance](https://learn.microsoft.com/en-us/compliance/regulatory/offering-ferpa) and [Azure shared responsibility](https://learn.microsoft.com/en-us/azure/security/fundamentals/shared-responsibility).
