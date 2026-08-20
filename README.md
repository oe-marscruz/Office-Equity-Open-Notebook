# Office of Equity Open Notebook — Desktop (Windows)

A job-specific Windows desktop app for the **Office of Equity**, built as a fork
of [Open Notebook Desktop](https://github.com/lfnovo/open-notebook). It bundles
the full Open Notebook stack — the Next.js frontend, the FastAPI backend, the
background worker, and SurrealDB — into a single installable Electron
application.

Everything runs locally on your machine. You still need an AI provider (an API
key for OpenAI/Anthropic/etc., or a local model server such as Ollama or
LM Studio) for the AI features to do anything useful.

> This is the working project for job-specific modifications. It is a fork of
> the upstream `open-notebook-desktop` wrapper; upstream sources are MIT
> licensed.

## What's inside

| Component | Role |
| --------- | ---- |
| Electron shell | Native desktop window + process lifecycle |
| Next.js frontend (port 8502) | The Open Notebook UI |
| FastAPI backend (port 5055) | REST API, LangGraph workflows, AI orchestration |
| SurrealDB (port 8000) | Graph + vector database (semantic search) |
| Background worker | Long-running jobs (source processing, podcasts) |
| Bundled Python 3.12 + Node.js | Self-contained runtimes — no system installs needed |
| Docling engine | Bundled document engine + OCR + image sources (pre-installed) |

## Requirements

- Windows 10/11 (x64)
- ~3–4 GB free disk space (the bundled runtime is large; Docling adds the ML/OCR stack)
- An AI provider: an API key, or a local model server (Ollama / LM Studio)

## Building from source

You need `git`, `node` (18+), and `uv` on the build machine. The runtime is
assembled from a clone of the upstream repository.

```bash
# 1. Clone the upstream repo (used as the source for the runtime)
git clone https://github.com/lfnovo/open-notebook.git ../open-notebook

# 2. Install the desktop app's own dependencies
cd office-of-equity-open-notebook
npm install
# If the Electron binary was not downloaded (postinstall blocked), run:
node node_modules/electron/install.js

# 3. Assemble the self-contained runtime (builds the frontend, installs the
#    Python dependencies, downloads SurrealDB + Node). Downloads are verified
#    against pinned SHA-256 checksums. Takes a while, needs network access,
#    and ~2 GB free disk.
npm run prepare:runtime

# 4a. Run the app in dev mode (no installer)
npm start

# 4b. Build the unpacked app folder (out/Open Notebook)
npm run package:app

# 4c. Build the Windows installer (needs NSIS 3.x in resources/.cache/nsis)
npm run installer
```

The installer is written to `dist/` as `Open Notebook-<version>-Setup.exe`.

> **Note on packaging:** this project uses a manual packaging script plus the
> NSIS toolchain instead of `electron-builder`, because on non-admin Windows
> electron-builder cannot extract its code-signing cache (7-Zip fails to create
> the macOS symlinks without admin/Developer Mode). The manual flow produces an
> identical result.
>
> To build the installer, download:
> - **NSIS 3.x** → extract to `resources/.cache/nsis/` (script looks for
>   `resources/.cache/nsis/nsis-3.09/makensis.exe`)
> - **rcedit-x64.exe** → place at `resources/.cache/rcedit/rcedit.exe` (used
>   to set the app icon and file metadata on `Open Notebook.exe`)

## Running

Launch the app (or the installed shortcut). The Electron window opens once the
bundled services are ready. On first launch the app:

- Creates a user-data folder at `%APPDATA%/Office of Equity Open Notebook/` for
  the database, uploads, settings, and logs.
- Generates a random encryption key (stored in that folder) used to secure your
  API keys at rest.
- Starts SurrealDB, the API, the worker, and the frontend, then opens the UI.

Service processes run hidden (no console windows), and their logs are written
to `%APPDATA%/Office of Equity Open Notebook/logs/` (`surrealdb.log`,
`api.log`, `worker.log`, `frontend.log`).

### Optional Python / Node.js runtimes

The installer has three components on the **Custom Install** page:

- **Open Notebook (required)** — the app, SurrealDB, and the built frontend.
- **Python 3.12 runtime** — bundled CPython + backend dependencies.
- **Node.js runtime** — bundled Node.js for the frontend server.

If you uncheck **Python 3.12 runtime**, the app will look for `python.exe` on
your PATH and requires Python 3.11 or 3.12. If you uncheck **Node.js runtime**,
the app will look for `node.exe` on your PATH and requires Node.js v18+.

Closing the window shuts the services down.

## Configuration

Set AI provider API keys from inside the app: **Settings → API Keys**. You can
also add a local model server (Ollama / LM Studio) there.

For advanced/optional environment variables (e.g. `OLLAMA_API_BASE`), see the
upstream `.env.example` and docs. The desktop app sets the database connection
(`SURREAL_URL=ws://127.0.0.1:8000/rpc`, user `root`/`root`) automatically.

**Docling** (the `docling` document engine, OCR toggle, and image sources) is
pre-installed into the bundled Python runtime and enabled by default — unlike
the Docker image, which installs it on demand via
`OPEN_NOTEBOOK_ENABLE_DOCLING=true`.

## Troubleshooting

- **Ports in use** — the app uses 8000 (DB), 5055 (API), 8502 (frontend). If
  any are in use, the app shows an error naming the blocked port before starting
  anything.
- **"Runtime not found"** — the app was installed without a prepared runtime.
  Re-run `npm run prepare:runtime` and rebuild.
- **No AI responses** — add an API key in Settings, or point the app at a local
  model server.
- **Podcast audio** — audio generation may need `ffmpeg` on `PATH` for some
  providers.

## License

This wrapper is MIT licensed. It bundles [lfnovo/open-notebook](https://github.com/lfnovo/open-notebook)
(MIT), [SurrealDB](https://github.com/surrealdb/surrealdb) (Business Source
License 1.1 for the core binary), and Node.js (MIT). See the upstream
`LICENSE` file in `resources/runtime/backend/LICENSE`.
