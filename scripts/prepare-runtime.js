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

const PROJECT_DIR = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(PROJECT_DIR, 'resources', 'runtime');
const CACHE_DIR = path.join(PROJECT_DIR, 'resources', '.cache');
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

function run(cmd, args, opts = {}) {
  // npm is a .cmd shim on Windows and needs a shell; everything else (uv,
  // python, tar, node) is a real exe and must NOT go through a shell, or
  // arguments like `-r <path>` get mangled.
  const shell = opts.shell === true || cmd === 'npm';
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell,
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}`);
  }
  return res;
}

function readFlag(args, name, def) {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = args.indexOf(name);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  return def;
}

function runCapture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}`);
  }
  return (res.stdout || '').trim();
}

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

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function findFile(dir, name) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

function cp(src, dest, opts = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // dereference: true follows symlinks (uv-managed Pythons are symlinked),
  // which avoids EPERM on Windows when trying to recreate a symlink.
  fs.cpSync(src, dest, { recursive: true, dereference: true, ...opts });
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function buildFrontend(repo) {
  const src = path.join(repo, 'frontend');
  const buildDir = path.join(CACHE_DIR, 'frontend-build');

  // Copy the frontend source into a temp build directory so we don't mutate
  // the upstream clone (especially package-lock.json).
  log('frontend', 'Copying frontend source to temp build directory');
  rmrf(buildDir);
  cp(src, buildDir, {
    filter: (s) => {
      const base = path.basename(s);
      return base !== 'node_modules' && base !== '.next';
    },
  });

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
    env: { ...process.env, INTERNAL_API_URL: 'http://127.0.0.1:5055' },
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
  log('frontend', 'Assembled frontend runtime');
}

function buildPython(repo) {
  log('python', 'Installing standalone CPython 3.12 via uv');
  run('uv', ['python', 'install', '3.12'], { timeout: 600000 });

  const pythonPath = runCapture('uv', ['python', 'find', '3.12']);
  const pythonSrcDir = path.dirname(pythonPath);

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
  const ccoreVersion = runCapture(
    path.join(dest, 'python', 'python.exe'),
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

  log('python', 'Python runtime ready');
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
    // Git Bash's tar is GNU tar and misreads Windows drive paths, so use
    // PowerShell's Expand-Archive for a robust cross-shell extraction.
    const ps = [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${extractDir}' -Force`,
    ];
    run('powershell', ps, { timeout: 300000 });
  }

  const destDir = path.join(RUNTIME_DIR, 'node');
  fs.mkdirSync(destDir, { recursive: true });
  // The Node zip ships a top-level folder, so node.exe may sit one level deep.
  const nodeExe = findFile(extractDir, 'node.exe');
  if (!nodeExe) throw new Error('node.exe not found after extraction');
  cp(nodeExe, path.join(destDir, 'node.exe'));
  log('node', 'Node.js runtime ready');
}

function buildTiktoken() {
  log('tiktoken', 'Pre-downloading tiktoken encoding for offline use');
  const cacheDir = path.join(RUNTIME_DIR, 'tiktoken-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const pythonExe = path.join(RUNTIME_DIR, 'python', 'python.exe');
  run(
    pythonExe,
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
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const repo = readFlag(args, '--repo', DEFAULT_REPO);
  const step = readFlag(args, '--step', 'all');

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
