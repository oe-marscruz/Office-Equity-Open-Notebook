# Modernization State

## Current Packet
`Security hardening re-port` (Completed — per-install credential store across all five hosts)

## FERPA Hardening Queue
The modernization initiative (L0.1–L8.5) is closed. The separate FERPA hardening queue (F01–F18) is tracked in `docs/compliance/ferpa/IMPLEMENTATION_STATUS.md` and is **not** complete.

- `F01`: Source inventory and task mapping. (Completed)
- `F02`: Prevent unsupported security assurance. (Completed — fixture-scoped, compliance claims rejected)
- `F03`: Service diagnostics minimization. (Implemented and component-tested; installed-application acceptance open)
- `F04`: Per-install database credentials and legacy migration. (Implemented and contract-tested — least privilege, at-rest encryption, key rotation and end-to-end runtime verification open)
- `F05`: Assembled upstream backend. (Revision pinned and CI-verified; assembly never performed — `resources/runtime/` absent)
- `F06`–`F18`: Open. F06, F09, F10, F14 and F18 are hard-blocked on F05.

Remaining planning allowance is roughly 40–80 engineer-days at ~10–15% complete by effort, excluding approvals and external assessment. Highest-leverage next task is F05's assembled backend; second is packaged-application acceptance for F03.

## Completed Packets
- `L0.1`: Pin upstream revision and build provenance. (Completed)
- `L0.2`: Capture untouched baseline build and metrics. (Completed)
- `L0.3a`: Add strict TypeScript tooling and boundary interfaces. (Completed)
- `L0.3b`: Port pure wrapper modules to TypeScript. (Completed)
- `L0.3c`: Port process-management wrapper modules to TypeScript. (Completed)
- `L0.4`: Build the language-neutral replacement harness. (Completed)
- `L0.5`: Create the permanent performance harness. (Completed)
- `L0.6`: Implement safe interactive port-conflict recovery. (Completed)
- `L1.1`: Produce dependency and packaged-size inventory. (Completed)
- `L1.2`: Build and validate a no-Docling core runtime. (Completed)
- `L1.5`: Benchmark Python worker concurrency settings. (Completed)
- `L2.1`: Freeze the native-host contract. (Completed)
- `L2.2`: Build the minimal Rust/Tauri host candidate. (Completed)
- `L2.3`: Build the minimal Go/Wails host candidate. (Completed)
- `L2.4`: Build the minimal C#/WinUI/WebView2 host candidate. (Completed)
- `L2.5`: Score native-host candidates and select one. (Completed)
- `L3.1`: Inventory every Next.js server responsibility. (Completed)
- `L3.2`: Freeze API proxy, upload, and SSE compatibility fixtures. (Completed)
- `L3.3`: Build a parallel static/client frontend proof of concept. (Completed)
- `L3.4`: Prepare the bounded handoff into Section 19. (Completed)
- `X19`: Move frontend serving and API proxying into native host. (Completed)
- `X20`: Remove bundled Node.js. (Completed)
- `L4.1`: Productionize the selected native host against current services. (Completed)
- `L4.2`: Replaced ad hoc PID-tree cleanup with OS-owned process containment. (Completed)
- `L4.3`: Replaced overly weak readiness assumptions with service-specific checks. (Completed)
- `L4.4`: Native host is now the default desktop shell. (Completed)
- `L4.5`: Run native-host chaos and security review. (Completed)
- `L5.1`: Modularize runtime packaging into auditable components. (Completed)
- `L5.2`: Run installer variant experiments and select preferred variant. (Completed)
- `L5.3`: Validated clean-machine installation and upgrade paths. (Completed)
- `L6`: Re-profile the simplified application and generate bottleneck scorecards. (Completed)
- `L7.1`: Optimize one proven Python CPU hotspot with Cython. (Skipped/Aborted)
- `L7.2`: Optimize one proven Python leaf with a Rust extension. (Skipped/Aborted)
- `L7.3`: Integrate a C/C++ leaf only when an established native library warrants it. (Skipped/Aborted)
- `L7.4`: Build a discrete Go or C# helper only if the boundary is simpler than host integration. (Skipped/Aborted)
- `L7.5`: Study Python worker migration options without implementing a rewrite. (Completed)
- `L7.6`: Study FastAPI backend routes and native migration options without implementing a rewrite. (Completed)
- `L8.1`: Security audit of loopback networking, proxy target pinning, path traversal, and WebView navigation policy isolation. (Completed)
- `L8.2`: Audit secrets, paths, diagnostics, dependencies, and licenses. (Completed)
- `L8.3`: Run golden extraction, RAG, and API contract regression. (Completed)
- `L8.4`: Finalize CI lanes, release gates, rollback, and canary controls. (Completed)
- `L8.5`: Refresh architecture, operations docs, and final benchmark scorecard. (Completed — Prompt 45 / Initiative Complete)

## Current Status
- Modernization initiative successfully completed across all 31 workstreams (L0.1 - L8.5).
- Architecture and operations documentation compiled at `docs/modernization/ARCHITECTURE_OPERATIONS.md`.
- Final empirical benchmark scorecard saved at `.artifacts/reports/l8_5/final_scorecard_and_operations.json`.
- All 29 automated mechanical test suites passing successfully via `node scripts/orchestrator/verifier.js`.

> The suite count and "initiative complete" claim above describe the modernization scope only. Re-verified on 2026-11-09 on the credential re-port branch: `npm run build:types` PASS and `node scripts/orchestrator/verifier.js` PASS with **30/30** suites (the credential re-port added two). These green checks cover contract and synthetic-fixture suites, not an installed application, an assembled backend, or any Azure tenant.


## Security Hardening Re-port
- The fixed SurrealDB `root`/`root` credential was replaced with a per-install random password, stored obfuscated and ACL-restricted to the current OS user.
- The on-disk secret store is implemented identically by the Node/Electron, TypeScript contract, Rust/Tauri, Go/Wails and C#/WinUI hosts, pinned by the shared fixture `tests/contracts/credentials-cases.json`.
- Credentials travel to SurrealDB and the Python backend through the child process environment, so they never appear in a command line or a process listing.
- Datastores created by older builds keep their original password, because SurrealDB applies initial root credentials only to a new datastore.
- Handoff: `docs/compliance/ferpa/CREDENTIAL_STORE_HANDOFF.md`. Inventory rows updated in `docs/compliance/ferpa/CODEBASE_SECURITY_INVENTORY.md`.
- Known limits: no .NET SDK (C# source-only), empty Go module cache (Go verified in an isolated stdlib module), and no assembled runtime (contract-level verification only).
