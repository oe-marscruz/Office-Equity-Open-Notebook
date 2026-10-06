'use strict';

/**
 * prepare-runtime.js
 *
 * Assembles a self-contained runtime folder (`resources/runtime/`) from a
 * clone of the upstream `lfnovo/open-notebook` repository. The runtime bundles
 * everything the desktop app needs to run offline:
 *
 *   runtime/
 *     python/        standalone CPython 3.12 with all backend dependencies
 *     backend/       the Open Notebook Python code (api, open_notebook, ...)
 *     frontend/      the built Next.js standalone server + static assets
 *     surreal/       the SurrealDB Windows binary
 *     node/          a portable Node.js runtime for the frontend server
 *     tiktoken-cache pre-downloaded tiktoken encoding (offline support)
 *
 * Usage:
 *   node scripts/prepare-runtime.js [--repo <path>] [--step <name>]
 *
 * Steps: frontend | python | surreal | node | tiktoken | backend | all
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { verifyFrontend } = require('./verify-runtime');
const { applyBranding } = require('./apply-branding');
const { arg, run, runCapture } = require('./lib/cli');
const { resolveInterpreter } = require('./lib/resolve-runtimes');
const { rmrf, cp, findFile } = require('./lib/fsx');
const { PROJECT_DIR, RUNTIME_DIR, CACHE_DIR, API_URL } = require('./lib/paths');

const DEFAULT_REPO = path.join(PROJECT_DIR, '..', 'open-notebook');

const SURREAL_VERSION = '2.6.5';
const NODE_VERSION = '22.23.2';

// SHA-256 checksums for downloaded binaries. Update these when bumping versions.
const CHECKSUMS = {
  surreal: 'DD9B6FA15EDACBDE96D490DD5727B49B5CF40DF80F29074C7DC17ACB974F509F',
  node: '1177B4137BA5ADAA56354AE40F1080C7450E8AE09CECB47DA459D1C52AC99F97',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(step, msg) {
  console.log(`\n=== [${step}] ${msg} ===\n`);
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()));
  });
}

/**
 * Verifies the Authenticode digital signature of a Windows executable.
 *
 * SHA-256 checksums prove the file matches what we downloaded, but they do
 * not prove the file is from the expected publisher. Authenticode signature
 * verification confirms the binary was signed by the vendor (SurrealDB,
 * Node.js) and has not been tampered with.
 *
 * Uses PowerShell's Get-AuthenticodeSignature (a read-only query, not a
 * script execution) to check the signature status. Returns true if the
 * signature is valid, false otherwise.
 *
 * Security note: this is a verification step, not an execution step. We are
 * checking a signature, not running the binary.
 */
function verifyAuthenticodeSignature(filePath, expectedPublisher) {
  if (process.platform !== 'win32') return true; // N/A on non-Windows
  try {
    const psScript = [
      `(Get-AuthenticodeSignature -FilePath '${filePath.replace(/'/g, "''")}').Status`,
    ];
    const result = runCapture('powershell', ['-NoProfile', '-Command', psScript.join(' ')], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.trim() !== 'Valid') {
      return false;
    }
    if (expectedPublisher) {
      const sigInfo = runCapture('powershell', [
        '-NoProfile',
        '-Command',
        `(Get-AuthenticodeSignature -FilePath '${filePath.replace(/'/g, "''")}').SignerCertificate.Subject`,
      ], { encoding: 'utf8', windowsHide: true });
      return sigInfo.includes(expectedPublisher);
    }
    return true;
  } catch (_) {
    return false;
  }
}

function download(url, dest, expectedSha256) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const request = lib.get(url, { timeout: 300000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(res.headers.location, dest, expectedSha256).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Download failed (${res.statusCode}): ${url}`));
        return;
      }
      const file = fs.createWriteStream(tmp);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    });
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error(`Download timed out: ${url}`));
    });
  }).then(async () => {
    if (expectedSha256) {
      const actual = await sha256File(tmp);
      if (actual !== expectedSha256.toUpperCase()) {
        fs.unlinkSync(tmp);
        throw new Error(`Checksum mismatch for ${path.basename(dest)}: expected ${expectedSha256}, got ${actual}`);
      }
    }
    fs.renameSync(tmp, dest);
  });
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function buildFrontend(repo) {
  const src = path.join(repo, 'frontend');
  // Build OUTSIDE this project tree. This repo has its own package-lock.json;
  // if the build dir sits underneath it (e.g. resources/.cache), Next.js infers
  // the project root as the workspace root and nests the standalone output under
  // resources/.cache/frontend-build/, so server.js is no longer at the top.
  // A space-free temp path also keeps the toolchain happy on Windows.
  const buildDir = path.join(os.tmpdir(), 'onb-frontend-build');

  // Copy the frontend source into a temp build directory so we don't mutate
  // the upstream clone (especially package-lock.json).
  log('frontend', `Copying frontend source to temp build directory (${buildDir})`);
  rmrf(buildDir);
  cp(src, buildDir, {
    filter: (s) => {
      const base = path.basename(s);
      return base !== 'node_modules' && base !== '.next';
    },
  });

  // Rebrand before the build so the sidebar mark and favicon are compiled into
  // the standalone output. Doing it here (rather than by forking upstream)
  // mirrors how the backend step patches config.py: the clone stays pristine
  // and the change is reproducible from this repo alone.
  log('frontend', 'Applying Office of Equity branding');
  applyBranding(buildDir);

  // The upstream lockfile pins ~108 tarball URLs to the npmmirror.com CDN
  // (a mirror of registry.npmjs.org). Newer npm refuses to fetch packages of
  // type "remote" from hosts other than the configured registry, so normalize
  // those URLs back to registry.npmjs.org before installing.
  const lockFile = path.join(buildDir, 'package-lock.json');
  const lock = fs.readFileSync(lockFile, 'utf8');
  if (lock.includes('registry.npmmirror.com')) {
    log('frontend', 'Normalizing npmmirror.com URLs in package-lock.json');
    fs.writeFileSync(lockFile, lock.split('https://registry.npmmirror.com/').join('https://registry.npmjs.org/'), 'utf8');
  }

  log('frontend', 'Installing frontend dependencies (npm ci)');
  run('npm', ['ci'], { cwd: buildDir, timeout: 1200000 });

  log('frontend', 'Building Next.js standalone output');
  run('npm', ['run', 'build'], {
    cwd: buildDir,
    env: { ...process.env, INTERNAL_API_URL: API_URL },
    timeout: 1200000,
  });

  const standalone = path.join(buildDir, '.next', 'standalone');
  const dest = path.join(RUNTIME_DIR, 'frontend');
  rmrf(dest);
  cp(standalone, dest);
  cp(path.join(buildDir, '.next', 'static'), path.join(dest, '.next', 'static'));
  cp(path.join(buildDir, 'public'), path.join(dest, 'public'));
  cp(path.join(buildDir, 'start-server.js'), path.join(dest, 'start-server.js'));

  // Clean up the temp build dir to save disk space.
  rmrf(buildDir);

  const problems = verifyFrontend(dest);
  if (problems.length > 0) {
    throw new Error(`Assembled frontend runtime is broken:\n  - ${problems.map((p) => p.message).join('\n  - ')}`);
  }
  log('frontend', 'Assembled and verified frontend runtime');
}

function buildPython(repo) {
  log('python', 'Installing standalone CPython 3.12 via uv');
  run('uv', ['python', 'install', '3.12'], { timeout: 600000 });

  const resolvedPython = resolveInterpreter('python', { runtimePath: RUNTIME_DIR, prefer: 'uv' });
  if (!resolvedPython || resolvedPython.source !== 'uv') {
    throw new Error('Could not find the uv-managed Python 3.12 interpreter.');
  }
  const pythonSrcDir = path.dirname(resolvedPython.path);

  log('python', `Copying standalone Python from ${pythonSrcDir}`);
  const dest = path.join(RUNTIME_DIR, 'python');
  rmrf(dest);
  cp(pythonSrcDir, dest);

  // Build requirements.txt from pyproject.toml [project].dependencies
  const deps = parseDependencies(repo);

  // uv on Windows mishandles file arguments whose paths contain spaces (it
  // splits on the space), which breaks in directories like this one. Do the
  // install in a space-free temp directory, then copy the result into place.
  const buildDir = path.join(os.tmpdir(), 'onb-uvbuild');
  rmrf(buildDir);
  fs.mkdirSync(buildDir, { recursive: true });
  const reqFile = path.join(buildDir, 'requirements.txt');
  fs.writeFileSync(reqFile, deps.join('\n') + '\n', 'utf8');

  // The repo pins a pillow override in [tool.uv] override-dependencies to
  // dodge a moviepy/podcast-creator transitive cap. That only works through
  // uv's --override mechanism, not as a plain requirement, so feed it as an
  // override file here.
  const overrideFile = path.join(buildDir, 'overrides.txt');
  fs.writeFileSync(overrideFile, 'pillow>=12.2.0\n', 'utf8');

  log('python', `Installing ${deps.length} dependencies into standalone Python`);
  run(
    'uv',
    ['pip', 'install', '--target', 'site-packages', '-r', 'requirements.txt', '--override', 'overrides.txt'],
    { cwd: buildDir, timeout: 1800000 }
  );

  // Install the opt-in Docling extraction engine (content-core[docling]).
  // This mirrors the Docker entrypoint's on-demand install
  // (scripts/docker-entrypoint.sh) but pre-installs it into the bundled
  // runtime so the desktop app works fully offline. Pin the extra to the
  // installed content-core version so its transitive deps stay compatible
  // with the locked base install.
  // `cp()` copies the *contents* of the uv-managed interpreter directory.
  const resolvedCcorePython = resolveInterpreter('python', { runtimePath: RUNTIME_DIR });
  const ccorePython = resolvedCcorePython && resolvedCcorePython.source === 'bundled' ? resolvedCcorePython.path : null;
  if (!ccorePython) {
    throw new Error(`Could not find the bundled Python interpreter under ${dest} (looked for python.exe).`);
  }
  const ccoreVersion = runCapture(
    ccorePython,
    ['-c', "import importlib.metadata as m; print(m.version('content-core'))"],
    { env: { ...process.env, PYTHONPATH: path.join(buildDir, 'site-packages') } }
  );
  log('python', `Installing Docling engine (content-core[docling]==${ccoreVersion})`);
  run(
    'uv',
    ['pip', 'install', '--target', 'site-packages', `content-core[docling]==${ccoreVersion}`, '--override', 'overrides.txt'],
    { cwd: buildDir, timeout: 1800000 }
  );

  log('python', 'Copying installed packages into runtime Python');
  cp(path.join(buildDir, 'site-packages'), path.join(dest, 'Lib', 'site-packages'));
  rmrf(buildDir);

  compileBytecode(ccorePython, path.join(path.dirname(ccorePython), 'Lib'));
  log('python', 'Python runtime ready');
}

function compileBytecode(pythonExe, targetDir) {
  if (!fs.existsSync(pythonExe) || !fs.existsSync(targetDir)) return;
  try {
    log('bytecode', `Pre-compiling Python bytecode (.pyc) in ${path.basename(targetDir)}`);
    run(pythonExe, ['-m', 'compileall', '-q', '-j', '0', targetDir], { timeout: 600000 });
  } catch (err) {
    console.warn(`Warning: bytecode compilation encountered an issue in ${targetDir}: ${err.message}`);
  }
}

function parseDependencies(repo) {
  // Use Python's built-in tomllib (Python 3.11+) to read pyproject.toml
  // robustly instead of regex-parsing TOML.
  const pyprojectPath = path.join(repo, 'pyproject.toml');
  const res = spawnSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [
      '-c',
      'import tomllib, json, sys; ' +
        'data = tomllib.load(open(sys.argv[1], "rb")); ' +
        'print(json.dumps(data["project"]["dependencies"]))',
      pyprojectPath,
    ],
    { encoding: 'utf8', shell: false }
  );
  if (res.status !== 0) {
    throw new Error(`Failed to parse pyproject.toml: ${res.stderr}`);
  }
  return JSON.parse(res.stdout.trim());
}

async function buildSurreal() {
  log('surreal', `Downloading SurrealDB v${SURREAL_VERSION} for Windows`);
  const url = `https://download.surrealdb.com/v${SURREAL_VERSION}/surreal-v${SURREAL_VERSION}.windows-amd64.exe`;
  const destDir = path.join(RUNTIME_DIR, 'surreal');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, 'surreal.exe');
  if (!fs.existsSync(dest)) {
    await download(url, dest, CHECKSUMS.surreal);
    // Verify the Authenticode signature to confirm the binary is from
    // SurrealDB and has not been tampered with. This is critical because
    // antivirus software flags unsigned executables, and a tampered binary
    // would be a supply-chain attack.
    log('surreal', 'Verifying Authenticode signature...');
    if (!verifyAuthenticodeSignature(dest, 'SurrealDB')) {
      fs.unlinkSync(dest);
      throw new Error(
        `SurrealDB binary at ${dest} failed Authenticode signature verification. ` +
        'The download may be corrupted or tampered with. Delete the file and retry.'
      );
    }
    log('surreal', 'Signature verified');
  }
  log('surreal', `Saved SurrealDB binary to ${dest}`);
}

async function buildNode() {
  log('node', `Downloading Node.js v${NODE_VERSION} for Windows`);
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`;
  const zip = path.join(CACHE_DIR, `node-v${NODE_VERSION}-win-x64.zip`);
  if (!fs.existsSync(zip)) {
    await download(url, zip, CHECKSUMS.node);
  }

  const extractDir = path.join(CACHE_DIR, `node-v${NODE_VERSION}-win-x64`);
  if (!fs.existsSync(path.join(extractDir, 'node.exe'))) {
    rmrf(extractDir);
    fs.mkdirSync(extractDir, { recursive: true });
    // Windows 10+ ships bsdtar (tar.exe) which handles zip archives natively.
    // Using tar instead of PowerShell's Expand-Archive avoids spawning a
    // shell process, which antivirus software flags as a suspicious pattern.
    run('tar', ['-xf', zip, '-C', extractDir], { timeout: 300000 });
  }

  const destDir = path.join(RUNTIME_DIR, 'node');
  fs.mkdirSync(destDir, { recursive: true });
  // The Node zip ships a top-level folder, so node.exe may sit one level deep.
  const nodeExe = findFile(extractDir, 'node.exe');
  if (!nodeExe) throw new Error('node.exe not found after extraction');

  // Verify the Authenticode signature of node.exe before copying it into
  // the runtime. Node.js is signed by the Node.js Foundation.
  log('node', 'Verifying Authenticode signature...');
  if (!verifyAuthenticodeSignature(nodeExe, 'Node.js Foundation')) {
    throw new Error(
      `Node.js binary at ${nodeExe} failed Authenticode signature verification. ` +
      'The download may be corrupted or tampered with. Delete the cache and retry.'
    );
  }
  log('node', 'Signature verified');

  cp(nodeExe, path.join(destDir, 'node.exe'));
  log('node', 'Node.js runtime ready');
}

function buildTiktoken() {
  log('tiktoken', 'Pre-downloading tiktoken encoding for offline use');
  const cacheDir = path.join(RUNTIME_DIR, 'tiktoken-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const resolvedPython = resolveInterpreter('python', { runtimePath: RUNTIME_DIR });
  if (!resolvedPython || resolvedPython.source !== 'bundled') {
    throw new Error(`Could not find the bundled Python interpreter under ${RUNTIME_DIR}.`);
  }
  run(
    resolvedPython.path,
    ['-c', "import tiktoken; tiktoken.get_encoding('o200k_base')"],
    { env: { ...process.env, TIKTOKEN_CACHE_DIR: cacheDir }, timeout: 300000 }
  );
  log('tiktoken', 'Encoding cached');
}

function buildBackend(repo) {
  log('backend', 'Copying backend code');
  const dest = path.join(RUNTIME_DIR, 'backend');
  rmrf(dest);
  for (const item of ['api', 'open_notebook', 'commands', 'prompts', 'LICENSE']) {
    const src = path.join(repo, item);
    if (fs.existsSync(src)) cp(src, path.join(dest, item));
  }

  // Patch config.py so the data folder can be redirected via DATA_FOLDER env.
  // The desktop app runs the backend from the (read-only) resources dir, so
  // user data must live in the app's user-data directory instead of ./data.
  // This mirrors the project's own recommended modification in
  // docs/1-INSTALLATION/windows-native.md.
  const configFile = path.join(dest, 'open_notebook', 'config.py');
  const config = fs.readFileSync(configFile, 'utf8');
  const patched = config.replace(
    'DATA_FOLDER = "./data"',
    'DATA_FOLDER = os.environ.get("DATA_FOLDER", "./data")'
  );
  if (patched === config) {
    throw new Error('Failed to patch config.py (DATA_FOLDER line not found)');
  }
  fs.writeFileSync(configFile, patched, 'utf8');

  log('backend', 'Backend code copied');
  const resolvedPython = resolveInterpreter('python', { runtimePath: RUNTIME_DIR });
  if (resolvedPython && resolvedPython.source === 'bundled') {
    compileBytecode(resolvedPython.path, dest);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const repo = arg('--repo', DEFAULT_REPO, args);
  const step = arg('--step', 'all', args);

  if (!fs.existsSync(path.join(repo, 'pyproject.toml'))) {
    console.error(`Repository not found at ${repo}. Pass --repo=<path> or clone lfnovo/open-notebook.`);
    process.exit(1);
  }
  console.log(`Using repository: ${repo}`);
  console.log(`Runtime output:  ${RUNTIME_DIR}`);

  const steps = {
    frontend: () => buildFrontend(repo),
    python: () => buildPython(repo),
    surreal: () => buildSurreal(),
    node: () => buildNode(),
    tiktoken: () => buildTiktoken(),
    backend: () => buildBackend(repo),
  };

  if (step === 'all') {
    for (const key of Object.keys(steps)) {
      await steps[key]();
    }
  } else {
    if (!steps[step]) {
      console.error(`Unknown step: ${step}. Valid: ${Object.keys(steps).join(', ')}, all`);
      process.exit(1);
    }
    await steps[step]();
  }

  console.log('\n✅ Runtime prepared successfully.');
  console.log('You can now run the app with `npm start`, package it with `npm run package:app`, or build the installer with `npm run installer`.');
}

main().catch((err) => {
  console.error('\n❌ Preparation failed:', err && err.message);
  process.exit(1);
});

module.exports = { verifyAuthenticodeSignature, sha256File, download };
