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
const { assertRuntimeForPackaging } = require('./lib/runtime-evidence');
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

async function main() {
  await assertRuntimeForPackaging(RUNTIME_DIR, path.join(PROJECT_DIR, 'upstream.lock.json'));
  const outDir = arg('--out', path.join(PROJECT_DIR, 'out'));
  const appDir = path.join(outDir, PRODUCT_NAME);

  

  const required = [
    ['python', 'python.exe'],
    ['backend', 'open_notebook'],
    ['surreal', 'surreal.exe'],
    ['frontend', 'static'],
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

  // 1. Build and copy the Native app
  fs.mkdirSync(appDir, { recursive: true });
  console.log("  building Tauri app...");
  run("cargo", ["build", "--release", "--manifest-path", path.join(PROJECT_DIR, "src-tauri", "Cargo.toml")]);
  
  const exeName = process.platform === "win32" ? "office-equity-host-tauri.exe" : "office-equity-host-tauri";
  const exe = path.join(PROJECT_DIR, "src-tauri", "target", "release", exeName);
  const productExeName = process.platform === "win32" ? `${PRODUCT_NAME}.exe` : PRODUCT_NAME;
  const productExe = path.join(appDir, productExeName);
  cp(exe, productExe);

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

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
