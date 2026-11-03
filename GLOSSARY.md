# GLOSSARY

Domain vocabulary for the Office of Equity Open Notebook desktop app. Terms here
name the concepts reviewers, ADRs, and future architecture work should use.

## The app

**Office of Equity Open Notebook** — a self-contained Windows desktop app
wrapping the upstream [Open Notebook](https://github.com/lfnovo/open-notebook)
stack in an Electron shell, with zero system-dependency requirements.

## Runtime pieces

**Problem Report** — the structured list of failures a stage produces, rendered
to console or dialog by `scripts/lib/problem-report.js`.

**Runtime** — the self-contained folder `resources/runtime/` assembled by
`prepare-runtime.js` from a pristine upstream clone: bundled Python 3.12, the
backend, the frontend, SurrealDB, Node.js, and the tiktoken cache.

**Upstream** — the `lfnovo/open-notebook` repository, always referenced as a
pristine clone, never a fork (see ADR-0001).

**Frontend** — the upstream Next.js app, built into a standalone server and
served on port 8502. This repo modifies it only via build-time patches.

**Backend** — the upstream FastAPI app (plus `open_notebook`, `commands`,
`prompts`), copied into the runtime with the `DATA_FOLDER` patch applied.

**Services** — the four child processes started by `start-services.js`:
SurrealDB (8000), API (5055), worker, frontend (8502).

## Branding

**Branded surfaces** — the four places the Office of Equity mark appears:
the exe/installer icon, the window/taskbar icon, the sidebar mark, and the
favicon. The first two come from `assets/icon.ico`; the last two are build-time
patches over the upstream frontend (see ADR-0001).

**App icon** — `assets/icon.ico`, generated from `assets/icon.png` by
`build-icons.js`. One file covers exe, desktop shortcut, and installer.

**In-GUI mark** — `assets/cu-logo.png`, served at `/cu-logo.png` by the
frontend's `public/` directory and referenced from the patched sidebar
component. Deliberately separate from the app icon so it can be tuned
independently.

## Build pipeline

**Prepare runtime** — `npm run prepare:runtime` → `scripts/prepare-runtime.js`.
Steps: frontend | python | surreal | node | tiktoken | backend | all.

**Verify runtime** — `scripts/verify-runtime.js`. Sanity-checks an assembled
frontend runtime (server.js placement, real node_modules, consistent
`.next/BUILD_ID` vs `.next/static`, no missing prerendered assets, and that
branding actually reached the build).

**Package app** — `npm run package:app` → `scripts/package.js`. Manual Windows
packaging (Electron dist + app code + bundled runtime) without electron-builder
(see ADR-0002).

**Build installer** — `npm run installer` → `scripts/build-installer.js`. NSIS
installer with three optional components (app, Python runtime, Node runtime).

**Verify installer** — `scripts/verify-installer.js`. Reads the NSIS length
header to detect truncated installers, optionally compares size/SHA-256 to a
published GitHub release asset.
