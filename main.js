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
const {
  ensureEncryptionKey,
  credentialStartupMessage,
  resolveDatabaseCredentials,
} = require('./scripts/lib/credentials');

const FRONTEND_URL = 'http://127.0.0.1:8502';

function resolveRuntimePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'runtime');
  }
  return path.join(__dirname, 'resources', 'runtime');
}

let services = null;
let mainWindow = null;
let shuttingDown = false;

async function stopServices() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (services) {
    try {
      await services.stop();
    } catch (err) {
      console.error('SERVICE_SHUTDOWN_FAILED');
    }
  }
}

function showErrorAndExit(title, message) {
  // Use a synchronous message box so the app waits for the user to click OK
  // before exiting. dialog.showErrorBox is also synchronous on Windows.
  dialog.showErrorBox(title, message);
  app.exit(1);
}

/**
 * Operator-facing guidance for a credential failure is built by the shared
 * credential module (`credentialStartupMessage`), so every host renders the
 * same remedy for the same state. The messages are deliberately free of
 * secret material.
 */

/**
 * Resolves the credentials the app needs to start, or reports and exits.
 *
 * The legacy-unmigrated state is called out separately: such an install has a
 * database but no per-install credential, so it must not fall back to the old
 * fixed password.
 */
function resolveCredentialsOrExit(dataDir) {
  try {
    const credentials = resolveDatabaseCredentials(dataDir);
    if (credentials.source === 'legacy-unmigrated' || !credentials.password) {
      showErrorAndExit(
        'Office of Equity Open Notebook — database credentials need migration',
        'This installation was created by an older version and does not have a saved database credential yet. ' +
          'It has been left unchanged so no notebook data is lost. ' +
          'Contact your administrator to run credential recovery before starting the app again.'
      );
      return null;
    }
    return credentials;
  } catch (err) {
    showErrorAndExit(
      'Office of Equity Open Notebook — database credentials unavailable',
      credentialStartupMessage(err)
    );
    return null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Office of Equity Open Notebook',
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
    if (!url.startsWith(FRONTEND_URL)) {
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

  const required = [
    path.join(runtimePath, 'surreal', 'surreal.exe'),
    path.join(runtimePath, 'backend', 'open_notebook'),
    path.join(runtimePath, 'frontend', 'static'),
  ];
  const missing = required.filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    showErrorAndExit(
      'Office of Equity Open Notebook — runtime not found',
      'The bundled runtime is incomplete. Please re-run `npm run prepare:runtime` and rebuild the app.'
    );
    return;
  }

  const credentials = resolveCredentialsOrExit(dataDir);
  if (!credentials) return;

  let encryptionKey;
  try {
    encryptionKey = ensureEncryptionKey(dataDir);
  } catch (err) {
    showErrorAndExit(
      'Office of Equity Open Notebook — encryption key unavailable',
      credentialStartupMessage(err)
    );
    return;
  }

  try {
    services = await startServices({
      runtimePath,
      dataDir,
      encryptionKey,
      credentials,
      waitReady: true,
    });
  } catch (err) {
    showErrorAndExit('Office of Equity Open Notebook — failed to start', credentialStartupMessage(err));
    return;
  }

  createWindow();
}).catch((error) => {
  showErrorAndExit('Office of Equity Open Notebook - failed to start', credentialStartupMessage(error));
});

app.on('window-all-closed', async () => {
  await stopServices();
  app.quit();
});

app.on('before-quit', (event) => {
  if (!shuttingDown) {
    event.preventDefault();
    stopServices().finally(() => {
      app.quit();
    });
  }
});
