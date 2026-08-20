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
const os = require('os');

const PROJECT_DIR = path.join(__dirname, '..');
const APP_DIR = path.join(PROJECT_DIR, 'out', 'Open Notebook');
const DIST_DIR = path.join(PROJECT_DIR, 'dist');
const VERSION = '1.14.0';
const PRODUCT_NAME = 'Open Notebook';
const INSTALLER_NAME = `${PRODUCT_NAME}-${VERSION}-Setup.exe`;

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}`);
  }
  return res;
}

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

function main() {
  if (!fs.existsSync(path.join(APP_DIR, `${PRODUCT_NAME}.exe`))) {
    console.error(`Packaged app not found at ${APP_DIR}. Run \`npm run package:app\` first.`);
    process.exit(1);
  }

  const makensis =
    arg('--makensis', null) ||
    path.join(PROJECT_DIR, 'resources', '.cache', 'nsis', 'nsis-3.09', 'makensis.exe');
  if (!fs.existsSync(makensis)) {
    console.error(`makensis not found at ${makensis}. Download the NSIS 3.x zip to resources/.cache/nsis/.`);
    process.exit(1);
  }

  // Use a unique short-root staging directory per run. This avoids MAX_PATH
  // and guarantees we never clobber user data in a fixed path like C:\onb.
  const shortRoot = path.join('C:\\onb', `build-${process.pid}-${Date.now()}`);
  const shortAppRequired = path.join(shortRoot, 'OpenNotebook-required');
  const shortAppPython = path.join(shortRoot, 'OpenNotebook-python');
  const shortAppNode = path.join(shortRoot, 'OpenNotebook-node');
  const scriptPath = path.join(shortRoot, 'installer.nsi');

  try {
    // Stage three component directories:
    //  - required: everything except the bundled Python and Node runtimes
    //  - python:   resources/runtime/python
    //  - node:     resources/runtime/node
    // Using robocopy /XD avoids fragile cross-directory moves on Windows.
    console.log(`Staging installer components in ${shortRoot}...`);
    fs.mkdirSync(shortRoot, { recursive: true });

    runRobocopy([APP_DIR, shortAppRequired, '/E', '/MT:16', '/XD', 'python', 'node', '/NFL', '/NDL', '/NJH', '/NJS']);
    runRobocopy([path.join(APP_DIR, 'resources', 'runtime', 'python'), path.join(shortAppPython, 'python'), '/E', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS']);
    runRobocopy([path.join(APP_DIR, 'resources', 'runtime', 'node'), path.join(shortAppNode, 'node'), '/E', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS']);

    // Write the NSIS script with optional components for Python and Node.
    const installerPath = path.join(DIST_DIR, INSTALLER_NAME);
    fs.mkdirSync(DIST_DIR, { recursive: true });
    const nsisInstallerPath = installerPath.replace(/\\/g, '\\\\').replace(/"/g, '$\\"');
    const script = `
!include "MUI2.nsh"
Name "${PRODUCT_NAME}"
OutFile "${nsisInstallerPath}"
InstallDir "$PROGRAMFILES64\\${PRODUCT_NAME}"
InstallDirRegKey HKLM "Software\\${PRODUCT_NAME}" "InstallDir"
RequestExecutionLevel admin
Unicode true
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Open Notebook (required)" SecApp
  SetOutPath "$INSTDIR"
  File /r "OpenNotebook-required\\*"
  WriteUninstaller "$INSTDIR\\Uninstall.exe"
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}" "Publisher" "${PRODUCT_NAME} Desktop"
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}" "UninstallString" '"$INSTDIR\\Uninstall.exe"'
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}" "NoModify" 1
  WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}" "NoRepair" 1
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
  DeleteRegKey HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${PRODUCT_NAME}"
  DeleteRegKey HKLM "Software\\${PRODUCT_NAME}"
SectionEnd
`;

    fs.writeFileSync(scriptPath, script, 'utf8');

    console.log('Building installer with NSIS (this compresses ~800 MB, please wait)...');
    run(makensis, [scriptPath], { cwd: shortRoot, timeout: 2400000 });

    console.log(`\n✅ Installer created: ${installerPath}`);
  } finally {
    // Always clean up the staging directory, even on failure.
    try {
      fs.rmSync(shortRoot, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Could not remove staging directory ${shortRoot}: ${err.message}`);
    }
  }
}

main();
