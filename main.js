'use strict';

/**
 * Open Notebook Desktop — Electron main process.
 *
 * Bundles and launches the full Open Notebook stack (SurrealDB, FastAPI
 * backend, background worker, Next.js frontend) and presents it in a native
 * desktop window.
 */

const { app, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServices } = require('./scripts/start-services');
const { ensureEncryptionKey } = require('./scripts/lib/encryption-key');
const { PRODUCT_NAME, FRONTEND_URL, RUNTIME_DIR } = require('./scripts/lib/paths');
const { REQUIRED_RUNTIME_FILES } = require('./scripts/lib/runtime-manifest');
const { createProblemReport } = require('./scripts/lib/problem-report');

const FRONTEND_ORIGIN = new URL(FRONTEND_URL).origin;

/**
 * True only for the app's own frontend origin. A prefix check would also match
 * look-alike hosts such as `http://127.0.0.1:8502.evil.example`, which could
 * hand a navigation to an attacker-controlled page.
 */
function isFrontendUrl(url) {
  try {
    return new URL(url).origin === FRONTEND_ORIGIN;
  } catch (_) {
    return false;
  }
}

function resolveIconPath() {
  // In development this is the repo root; when packaged, `assets/` is copied
  // next to the app code in `resources/app`, so the same relative path works.
  const icon = path.join(__dirname, 'assets', 'icon.ico');
  return fs.existsSync(icon) ? icon : undefined;
}

function resolveRuntimePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'runtime');
  }
  return RUNTIME_DIR;
}

let services = null;
let mainWindow = null;
let shutdownPromise = null;
let quitConfirmed = false;

// Upper bound on shutdown so a stuck service can never hang the app's exit.
const SHUTDOWN_TIMEOUT_MS = 15000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => {
        console.error(`Service shutdown did not finish within ${ms}ms; releasing the app anyway.`);
        resolve({ survivors: [] });
      }, ms);
    }),
  ]);
}

/**
 * Stops the service stack exactly once. Every exit path awaits this same
 * promise, so a window close and an app quit can no longer race each other
 * into quitting while services are still running.
 */
function stopServices() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (!services) return { survivors: [] };
    try {
      const result = await services.stop();
      if (result && result.survivors && result.survivors.length > 0) {
        console.error(
          `WARNING: ${result.survivors.length} service process(es) could not be stopped: ` +
          result.survivors.map((entry) => `${entry.name} (pid ${entry.pid})`).join(', ')
        );
      }
      return result || { survivors: [] };
    } catch (err) {
      console.error('Error stopping services:', err);
      return { survivors: [] };
    }
  })();
  return shutdownPromise;
}

/** Runs the shutdown once, then lets the app exit for real. */
function shutdownAndQuit() {
  if (quitConfirmed) return;
  withTimeout(stopServices(), SHUTDOWN_TIMEOUT_MS).finally(() => {
    quitConfirmed = true;
    app.quit();
  });
}

function dialogRenderer(title) {
  return (problems) => {
    const first = problems[0];
    const detail = first.detail || first.logTail || first.stack || '';
    const context = first.detail && first.logTail ? `${first.detail}\n\n${first.logTail}` : detail;
    const message = context ? `${first.message}\n\n${context}` : first.message;
    dialog.showErrorBox(title, message);
  };
}

function showErrorAndExit(title, report) {
  // Use a synchronous message box so the app waits for the user to click OK
  // before exiting. dialog.showErrorBox is also synchronous on Windows.
  report.render(dialogRenderer(title));
  // A partially-started stack must be reaped before we exit, otherwise the
  // very first failure leaves ports bound and the next launch fails too.
  withTimeout(stopServices(), SHUTDOWN_TIMEOUT_MS).finally(() => {
    app.exit(report.exitCode());
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: PRODUCT_NAME,
    icon: resolveIconPath(),
    backgroundColor: '#0b0b0f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(FRONTEND_URL);

  // Open external links in the system browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isFrontendUrl(url)) {
      event.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        shell.openExternal(url);
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  const runtimePath = resolveRuntimePath();
  const dataDir = app.getPath('userData');
  const encryptionKey = ensureEncryptionKey(dataDir);

  const required = REQUIRED_RUNTIME_FILES.map((file) => path.join(runtimePath, ...file.split('/')));
  const missing = required.filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    const report = createProblemReport();
    report.add(
      'RUNTIME_INCOMPLETE',
      'The bundled runtime is incomplete. Please re-run `npm run prepare:runtime` and rebuild the app.',
      { detail: `Missing:\n${missing.join('\n')}` }
    );
    showErrorAndExit(`${PRODUCT_NAME} — runtime not found`, report);
    return;
  }

  try {
    services = await startServices({
      runtimePath,
      dataDir,
      encryptionKey,
      waitReady: true,
    });
  } catch (err) {
    const report = createProblemReport();
    report.add('SERVICE_START_FAILED', err.summary || String(err && err.message), {
      detail: err.detail,
      logTail: err.logTail,
      stack: err.stack,
    });
    showErrorAndExit(`${PRODUCT_NAME} — failed to start`, report);
    return;
  }

  createWindow();
});

app.on('window-all-closed', () => {
  // Route closing the window through the same guarded path as quitting; the
  // service stack must be fully reaped before the process goes away.
  shutdownAndQuit();
});

app.on('before-quit', (event) => {
  if (quitConfirmed) return;
  event.preventDefault();
  shutdownAndQuit();
});
