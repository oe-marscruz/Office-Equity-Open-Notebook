'use strict';

/**
 * build-installer.js — builds a Windows NSIS installer for the packaged app.
 *
 * Why not electron-builder? On non-admin Windows, electron-builder fails to
 * extract its code-signing cache because 7-Zip cannot create the macOS
 * symlinks without admin/Developer Mode. This script uses the NSIS toolchain
 * directly instead.
 *
 * It copies the packaged app to a short root to stay under the Windows
 * MAX_PATH (260-char) limit, then runs makensis.
 *
 * Usage:
 *   node scripts/build-installer.js [--makensis <path>]
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { verifyFrontend } = require('./verify-runtime');
const { verifyInstaller } = require('./verify-installer');
const { arg, run } = require('./lib/cli');
const { PROJECT_DIR, CACHE_DIR, APP_DIR, DIST_DIR, PRODUCT_NAME, VERSION } = require('./lib/paths');
const { createProblemReport, consoleRenderer } = require('./lib/problem-report');

const INSTALLER_NAME = `${PRODUCT_NAME}-${VERSION}-Setup.exe`;

/**
 * robocopy uses exit codes 0–7 for success (with various informational flags).
 * Only 8 and above are actual errors.
 */
function runRobocopy(args) {
  const res = spawnSync('robocopy', args, { stdio: 'inherit' });
  const status = res.status == null ? 999 : res.status;
  if (status > 7) {
    throw new Error(`robocopy failed with exit code ${status}`);
  }
}

function reportFailure(code, message) {
  const report = createProblemReport();
  report.add(code, message);
  report.render(consoleRenderer, { style: 'plain' });
  process.exitCode = report.exitCode();
}

function main() {
  if (!fs.existsSync(path.join(APP_DIR, `${PRODUCT_NAME}.exe`))) {
    reportFailure('PACKAGED_APP_MISSING', `Packaged app not found at ${APP_DIR}. Run \`npm run package:app\` first.`);
    return;
  }

  const makensis =
    arg('--makensis', null) ||
    path.join(CACHE_DIR, 'nsis', 'nsis-3.09', 'makensis.exe');
  if (!fs.existsSync(makensis)) {
    reportFailure(
      'MAKENSIS_MISSING',
      `makensis not found at ${makensis}. Download the NSIS 3.x zip to resources/.cache/nsis/.`
    );
    return;
  }

  // Use a unique short-root staging directory per run under the system temp
  // directory. This avoids MAX_PATH, guarantees we never clobber user data,
  // and avoids writing to a fixed root path (C:\onb) which antivirus software
  // flags as suspicious behavior.
  const shortRoot = path.join(require('os').tmpdir(), `onb-build-${process.pid}-${Date.now()}`);
  const shortAppRequired = path.join(shortRoot, 'OpenNotebook-required');
  const shortAppPython = path.join(shortRoot, 'OpenNotebook-python');
  const shortAppNode = path.join(shortRoot, 'OpenNotebook-node');
  const scriptPath = path.join(shortRoot, 'installer.nsi');
  const installerPath = path.join(DIST_DIR, INSTALLER_NAME);
  const partialPath = `${installerPath}.partial`;

  try {
    // Stage three component directories:
    //  - required: everything except the bundled Python and Node runtimes
    //  - python:   resources/runtime/python
    //  - node:     resources/runtime/node
    // Using robocopy /XD avoids fragile cross-directory moves on Windows.
    console.log(`Staging installer components in ${shortRoot}...`);
    try {
      fs.mkdirSync(shortRoot, { recursive: true });
    } catch (err) {
      throw new Error(
        `Cannot create staging directory ${shortRoot}: ${err.message}. ` +
          'The installer build stages files in the system temp directory to stay under MAX_PATH.'
      );
    }

    // Exclude the two runtimes by FULL path. A bare `/XD python node` matches
    // directories with those names at any depth, which silently drops unrelated
    // files such as node_modules/next/dist/server/api-utils/node/*.
    const runtimeDir = path.join(APP_DIR, 'resources', 'runtime');
    const pythonSrc = path.join(runtimeDir, 'python');
    const nodeSrc = path.join(runtimeDir, 'node');
    runRobocopy([APP_DIR, shortAppRequired, '/E', '/MT:16', '/XD', pythonSrc, nodeSrc, '/NFL', '/NDL', '/NJH', '/NJS']);
    runRobocopy([pythonSrc, path.join(shortAppPython, 'python'), '/E', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS']);
    runRobocopy([nodeSrc, path.join(shortAppNode, 'node'), '/E', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS']);

    // Fail the build if staging lost or mangled anything the frontend needs.
    const stagedFrontend = path.join(shortAppRequired, 'resources', 'runtime', 'frontend');
    const problems = verifyFrontend(stagedFrontend);
    if (problems.length > 0) {
      throw new Error(`Staged frontend is broken:\n  - ${problems.map((p) => p.message).join('\n  - ')}`);
    }

    // Write the NSIS script with optional components for Python and Node.
    // makensis writes a .partial file first so a killed/timed-out build cannot
    // leave a truncated Setup.exe in dist/.
    fs.mkdirSync(DIST_DIR, { recursive: true });
    fs.rmSync(partialPath, { force: true });
    // NSIS accepts forward slashes in paths, which avoids backslash escaping.
    const nsisInstallerPath = partialPath.replace(/\\/g, '/').replace(/"/g, '$\\"');
    const iconPath = path.join(PROJECT_DIR, 'assets', 'icon.ico');
    const iconDefines = fs.existsSync(iconPath)
      ? `!define MUI_ICON "${iconPath.replace(/\\/g, '/')}"\n!define MUI_UNICON "${iconPath.replace(/\\/g, '/')}"`
      : '';
    // Per-user installation: no admin rights required, installs to
    // %LOCALAPPDATA% instead of Program Files. This avoids the UAC prompt
    // that triggers antivirus scrutiny and SmartScreen warnings.
    // Registry writes go to HKCU (current user) instead of HKLM (machine-wide).
    const script = `
!include "MUI2.nsh"
Name "${PRODUCT_NAME}"
OutFile "${nsisInstallerPath}"
InstallDir "$LOCALAPPDATA\\${PRODUCT_NAME}"
InstallDirRegKey HKCU "Software\\${PRODUCT_NAME}" "InstallDir"
RequestExecutionLevel user
Unicode true
CRCCheck on
!define MUI_ABORTWARNING
${iconDefines}
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "${PRODUCT_NAME} (required)" SecApp
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "OpenNotebook-required\\*"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  WriteRegStr HKCU "Software\\${PRODUCT_NAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}" "Publisher" "${PRODUCT_NAME} Desktop"
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}" "UninstallString" '"$INSTDIR\\Uninstall.exe"'
  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}" "NoModify" 1
  WriteRegDWORD HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}" "NoRepair" 1
  CreateDirectory "$SMPROGRAMS\\${PRODUCT_NAME}"
  CreateShortcut "$SMPROGRAMS\\${PRODUCT_NAME}\\${PRODUCT_NAME}.lnk" "$INSTDIR\\${PRODUCT_NAME}.exe"
  CreateShortcut "$DESKTOP\\${PRODUCT_NAME}.lnk" "$INSTDIR\\${PRODUCT_NAME}.exe"
SectionEnd

Section "Python 3.12 runtime" SecPython
  SetOutPath "$INSTDIR\\resources\\runtime"
  File /r "OpenNotebook-python\\*"
SectionEnd

Section "Node.js runtime" SecNode
  SetOutPath "$INSTDIR\\resources\\runtime"
  File /r "OpenNotebook-node\\*"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\\Uninstall.exe"
  RMDir /r "$INSTDIR"
  Delete "$SMPROGRAMS\\${PRODUCT_NAME}\\${PRODUCT_NAME}.lnk"
  RMDir "$SMPROGRAMS\\${PRODUCT_NAME}"
  Delete "$DESKTOP\\${PRODUCT_NAME}.lnk"
  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}"
  DeleteRegKey HKCU "Software\\${PRODUCT_NAME}"
SectionEnd
`;

    fs.writeFileSync(scriptPath, script, 'utf8');

    console.log('Building installer with NSIS (this compresses ~800 MB, please wait)...');
    run(makensis, [scriptPath], { cwd: shortRoot, timeout: 2400000 });

    const installerProblems = verifyInstaller(partialPath);
    if (installerProblems.length > 0) {
      throw new Error(`Installer failed integrity check:\n  - ${installerProblems.join('\n  - ')}`);
    }

    fs.rmSync(installerPath, { force: true });
    fs.renameSync(partialPath, installerPath);

    console.log(`\n✅ Installer created: ${installerPath}`);
  } finally {
    fs.rmSync(partialPath, { force: true });
    // Always clean up the staging directory, even on failure.
    try {
      fs.rmSync(shortRoot, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Could not remove staging directory ${shortRoot}: ${err.message}`);
    }
  }
}

main();
