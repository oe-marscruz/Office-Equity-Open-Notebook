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
const crypto = require('crypto');
const { startServices } = require('./scripts/start-services');

const FRONTEND_URL = 'http://127.0.0.1:8502';

function resolveRuntimePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'runtime');
  }
  return path.join(__dirname, 'resources', 'runtime');
}

function ensureEncryptionKey(dataDir) {
  const keyFile = path.join(dataDir, 'encryption-key.txt');
  if (fs.existsSync(keyFile)) {
    return fs.readFileSync(keyFile, 'utf8').trim();
  }
  const key = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyFile, key, 'utf8');
  return key;
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
      console.error('Error stopping services:', err);
    }
  }
}

function showErrorAndExit(title, message) {
  // Use a synchronous message box so the app waits for the user to click OK
  // before exiting. dialog.showErrorBox is also synchronous on Windows.
  dialog.showErrorBox(title, message);
  app.exit(1);
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
  const encryptionKey = ensureEncryptionKey(dataDir);

  const required = [
    path.join(runtimePath, 'surreal', 'surreal.exe'),
    path.join(runtimePath, 'backend', 'open_notebook'),
    path.join(runtimePath, 'frontend', 'server.js'),
  ];
  const missing = required.filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    showErrorAndExit(
      'Office of Equity Open Notebook — runtime not found',
      'The bundled runtime is incomplete. Please re-run `npm run prepare:runtime` and rebuild the app.\n\nMissing:\n' +
        missing.join('\n')
    );
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
    showErrorAndExit('Office of Equity Open Notebook — failed to start', String(err && err.message));
    return;
  }

  createWindow();
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
