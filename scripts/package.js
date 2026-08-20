'use strict';

/**
 * package.js — manual Windows packaging.
 *
 * Assembles a self-contained unpacked app directory without electron-builder,
 * which on non-admin Windows fails to extract its code-signing cache (7-Zip
 * cannot create the macOS symlinks without admin/Developer Mode).
 *
 * The output is a runnable `Office of Equity Open Notebook.exe` with the app code and the
 * bundled runtime in `resources/`.
 *
 * Usage:
 *   node scripts/package.js [--out <dir>]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_DIR = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(PROJECT_DIR, 'resources', 'runtime');
const ELECTRON_DIST = path.join(PROJECT_DIR, 'node_modules', 'electron', 'dist');
const PRODUCT_NAME = 'Office of Equity Open Notebook';
const VERSION = '1.14.0';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function cp(src, dest, opts = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true, ...opts });
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}`);
  }
  return res;
}

function main() {
  const outDir = arg('--out', path.join(PROJECT_DIR, 'out'));
  const appDir = path.join(outDir, PRODUCT_NAME);

  if (!fs.existsSync(ELECTRON_DIST)) {
    console.error(`Electron dist not found at ${ELECTRON_DIST}. Run \`npm install\` first.`);
    process.exit(1);
  }

  const required = [
    ['python', 'python.exe'],
    ['backend', 'open_notebook'],
    ['surreal', 'surreal.exe'],
    ['node', 'node.exe'],
    ['frontend', 'server.js'],
  ];
  const missing = required
    .map(([dir, file]) => path.join(RUNTIME_DIR, dir, file))
    .filter((p) => !fs.existsSync(p));
  if (missing.length > 0) {
    console.error('Runtime not prepared or incomplete. Run `npm run prepare:runtime` first.\nMissing:');
    missing.forEach((m) => console.error(`  ${m}`));
    process.exit(1);
  }

  console.log(`Packaging app into ${appDir}`);
  rmrf(appDir);

  // 1. Copy the Electron runtime
  console.log('  copying Electron runtime...');
  cp(ELECTRON_DIST, appDir);

  // 2. Rename the executable
  const exe = path.join(appDir, 'electron.exe');
  const productExe = path.join(appDir, `${PRODUCT_NAME}.exe`);
  fs.renameSync(exe, productExe);

  // 3. Replace the default app with our app code (loose files, no asar)
  const appRes = path.join(appDir, 'resources', 'app');
  rmrf(path.join(appDir, 'resources', 'default_app.asar'));
  rmrf(appRes);
  fs.mkdirSync(appRes, { recursive: true });
  for (const item of ['main.js', 'preload.js', 'package.json']) {
    cp(path.join(PROJECT_DIR, item), path.join(appRes, item));
  }
  cp(path.join(PROJECT_DIR, 'scripts'), path.join(appRes, 'scripts'));

  // 4. Copy the bundled runtime into resources/runtime
  console.log('  copying bundled runtime (this is large)...');
  cp(RUNTIME_DIR, path.join(appDir, 'resources', 'runtime'));

  // 5. Set icon and version metadata on the exe using rcedit.
  const iconSrc = path.join(PROJECT_DIR, '..', 'open-notebook', 'frontend', 'src', 'app', 'favicon.ico');
  const rcedit = path.join(PROJECT_DIR, 'resources', '.cache', 'rcedit', 'rcedit.exe');
  if (fs.existsSync(productExe) && fs.existsSync(rcedit)) {
    console.log('  setting exe icon and metadata...');
    run(rcedit, [
      productExe,
      '--set-icon', iconSrc,
      '--set-version-string', 'FileDescription', PRODUCT_NAME,
      '--set-version-string', 'ProductName', PRODUCT_NAME,
      '--set-version-string', 'CompanyName', `${PRODUCT_NAME} Desktop`,
      '--set-version-string', 'OriginalFilename', `${PRODUCT_NAME}.exe`,
      '--set-version-string', 'InternalName', PRODUCT_NAME,
      '--set-file-version', VERSION,
      '--set-product-version', VERSION,
    ]);
  } else {
    console.warn('  rcedit or icon not found; exe will use default Electron metadata.');
  }

  console.log(`\n✅ Packaged app: ${productExe}`);
  console.log(`Run it directly, or build the installer with \`npm run installer\`.`);
}

main();
