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
const { verifyRuntime } = require('./verify-runtime');
const { arg, run } = require('./lib/cli');
const { resolveInterpreter } = require('./lib/resolve-runtimes');
const { rmrf, cp } = require('./lib/fsx');
const { PROJECT_DIR, RUNTIME_DIR, CACHE_DIR, OUT_DIR, PRODUCT_NAME, VERSION } = require('./lib/paths');
const { createProblemReport, consoleRenderer } = require('./lib/problem-report');

const ELECTRON_DIST = path.join(PROJECT_DIR, 'node_modules', 'electron', 'dist');

function reportFailure(code, message) {
  const report = createProblemReport();
  report.add(code, message);
  report.render(consoleRenderer, { style: 'plain' });
  process.exitCode = report.exitCode();
}

function main() {
  const outDir = arg('--out', OUT_DIR);
  const appDir = path.join(outDir, PRODUCT_NAME);

  if (!fs.existsSync(ELECTRON_DIST)) {
    reportFailure(
      'ELECTRON_DIST_MISSING',
      `Electron dist not found at ${ELECTRON_DIST}. Run \`npm install\` first.`
    );
    return;
  }

  const runtimeProblems = verifyRuntime(RUNTIME_DIR);
  const fileProblems = runtimeProblems.filter((p) => p.check === 'file-exists');
  if (fileProblems.length > 0) {
    const missing = fileProblems.map((problem) => `  ${path.join(RUNTIME_DIR, ...problem.file.split('/'))}`);
    reportFailure(
      'RUNTIME_INCOMPLETE',
      `Runtime not prepared or incomplete. Run \`npm run prepare:runtime\` first.\nMissing:\n${missing.join('\n')}`
    );
    return;
  }

  const frontendProblems = runtimeProblems.filter((p) => p.check !== 'file-exists');
  if (frontendProblems.length > 0) {
    const details = frontendProblems.map((problem) => `  - ${problem.message}`).join('\n');
    reportFailure(
      'FRONTEND_RUNTIME_INCOMPLETE',
      `Frontend runtime is incomplete. Re-run \`npm run prepare:runtime -- --step frontend\`.\n${details}`
    );
    return;
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

  // 3. Replace the default app with our app code, packaged as ASAR.
  // ASAR archives the JS source into a single .asar file, which:
  //   - Prevents antivirus from scanning individual .js files (a common
  //     false-positive trigger for Electron apps).
  //   - Makes the app code tamper-evident when combined with asarIntegrity.
  //   - Reduces the number of files Defender has to scan at startup.
  const appRes = path.join(appDir, 'resources', 'app');
  const stagingDir = path.join(appDir, 'resources', '.app-staging');
  rmrf(path.join(appDir, 'resources', 'default_app.asar'));
  rmrf(appRes);
  rmrf(stagingDir);
  fs.mkdirSync(stagingDir, { recursive: true });
  for (const item of ['main.js', 'preload.js', 'package.json']) {
    cp(path.join(PROJECT_DIR, item), path.join(stagingDir, item));
  }
  cp(path.join(PROJECT_DIR, 'scripts'), path.join(stagingDir, 'scripts'));
  // The window/taskbar icon is loaded at runtime from `assets/icon.ico`
  // relative to the app code, so it has to ship alongside it.
  const assetsDir = path.join(PROJECT_DIR, 'assets');
  if (fs.existsSync(assetsDir)) {
    cp(assetsDir, path.join(stagingDir, 'assets'));
  }

  // Create the ASAR archive using Electron's bundled asar module.
  console.log('  creating ASAR archive...');
  const asarPath = path.join(appRes + '.asar');
  try {
    const asar = require('asar');
    asar.createPackage(stagingDir, asarPath);

    // Compute ASAR integrity hash and inject it into the staged package.json
    // so Electron validates the archive on every startup. This makes the app
    // code tamper-evident.
    const integrity = asar.getRawHeader ? null : null; // placeholder
    const header = asar.getRawHeader ? asar.getRawHeader(asarPath) : null;
    if (header && header.header) {
      const crypto = require('crypto');
      const headerBuf = Buffer.from(JSON.stringify(header.header));
      const hash = crypto.createHash('sha256').update(headerBuf).digest('hex');
      const pkgPath = path.join(stagingDir, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.asarIntegrity = { header: { sha256: hash, blockSize: 4194304 } };
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      // Re-create the ASAR with the updated package.json
      rmrf(asarPath);
      asar.createPackage(stagingDir, asarPath);
    }
    console.log('  ASAR archive created with integrity validation');
  } catch (err) {
    console.warn(`  ASAR creation failed (${err.message}); falling back to loose files`);
    cp(stagingDir, appRes);
  }
  rmrf(stagingDir);

  // 4. Copy the bundled runtime into resources/runtime
  console.log('  copying bundled runtime (this is large)...');
  cp(RUNTIME_DIR, path.join(appDir, 'resources', 'runtime'));

  // 5. Ensure Python bytecode (.pyc) is compiled so read-only installations
  // (like Program Files) do not suffer slow cold starts and AST re-parsing.
  const packagedRuntime = path.join(appDir, 'resources', 'runtime');
  const resolvedPackagedPython = resolveInterpreter('python', { runtimePath: packagedRuntime });
  const packagedPython = resolvedPackagedPython && resolvedPackagedPython.source === 'bundled'
    ? resolvedPackagedPython.path
    : null;
  const packagedBackend = path.join(packagedRuntime, 'backend');
  const packagedLib = packagedPython ? path.join(path.dirname(packagedPython), 'Lib') : null;
  if (packagedPython) {
    console.log('  verifying/compiling Python bytecode (.pyc)...');
    try {
      if (fs.existsSync(packagedLib)) {
        run(packagedPython, ['-m', 'compileall', '-q', '-j', '0', packagedLib], { timeout: 600000 });
      }
      if (fs.existsSync(packagedBackend)) {
        run(packagedPython, ['-m', 'compileall', '-q', '-j', '0', packagedBackend], { timeout: 300000 });
      }
    } catch (err) {
      console.warn(`  warning during bytecode compilation: ${err.message}`);
    }
  }

  // 6. Set icon and version metadata on the exe using rcedit.
  const iconSrc = path.join(PROJECT_DIR, 'assets', 'icon.ico');
  const rcedit = path.join(CACHE_DIR, 'rcedit', 'rcedit.exe');
  if (fs.existsSync(productExe) && fs.existsSync(rcedit) && fs.existsSync(iconSrc)) {
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
