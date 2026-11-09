'use strict';

/**
 * prepare-runtime.js
 *
 * Assembles a self-contained runtime folder (`resources/runtime/`) from a
 * clone of the upstream `lfnovo/open-notebook` repository. The runtime bundles
 * everything the desktop app needs to run offline:
 *
 *   runtime/
 *     python/        standalone CPython 3.12 with resolved backend packages
 *     backend/       pinned, tracked Open Notebook Python source
 *     frontend/      static frontend proof of concept (not an application)
 *     surreal/       checksum-verified SurrealDB Windows binary
 *     tiktoken-cache  pre-downloaded encoding
 *     manifest.json  file hashes, source provenance and assembly limitations
 *
 * Full assembly currently fails acceptance because the frontend is a POC.
 *
 * Usage:
 *   node scripts/prepare-runtime.js [--repo <path>] [--step <name>]
 *     [--runtime-dir <isolated-output>] [--output <path>] [--lock-file <test-lock>]
 *
 * Steps: frontend | python | surreal | tiktoken | backend | all
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const PROJECT_DIR = path.join(__dirname, '..');
const DEFAULT_RUNTIME_DIR = path.join(PROJECT_DIR, 'resources', 'runtime');
let RUNTIME_DIR = DEFAULT_RUNTIME_DIR;
const BUILD_DIRS = new Set();
const { STEPS, writePreparationManifest } = require('./lib/runtime-evidence');
const CACHE_DIR = path.join(PROJECT_DIR, 'resources', '.cache');
const DEFAULT_REPO = path.join(PROJECT_DIR, '..', 'open-notebook');

const SURREAL_VERSION = '2.6.5';

// SHA-256 checksums for downloaded binaries. Update these when bumping versions.
const CHECKSUMS = {
  surreal: 'DD9B6FA15EDACBDE96D490DD5727B49B5CF40DF80F29074C7DC17ACB974F509F',
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

function canonicalPath(input) {
  let parent = path.resolve(input);
  const suffix = [];
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error('Cannot resolve runtime output ancestry.');
    suffix.unshift(path.basename(parent));
    parent = next;
  }
  return path.join(fs.realpathSync(parent), ...suffix);
}

function containsPath(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function rmrf(p) {
  const target = canonicalPath(p);
  const relative = path.relative(RUNTIME_DIR, target);
  if (!BUILD_DIRS.has(target) && (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) {
    throw new Error('Refusing to remove a directory outside this runtime build.');
  }
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
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
  log('frontend', 'Assembling Node-free static frontend assets');
  const destStatic = path.join(RUNTIME_DIR, 'frontend', 'static');
  rmrf(path.join(RUNTIME_DIR, 'frontend'));
  fs.mkdirSync(destStatic, { recursive: true });

  const { buildStaticClientPoc } = require('./build-static-client');
  buildStaticClientPoc();

  const pocDir = path.join(PROJECT_DIR, '.artifacts', 'static-client-poc');
  if (fs.existsSync(pocDir)) {
    cp(pocDir, destStatic);
  }
  log('frontend', 'Assembled Node-free static frontend assets');
}

function buildPython(repo, options = {}) {
  const skipDocling = options.variant === 'core' || options.skipDocling;

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
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onb-uvbuild-'));
  BUILD_DIRS.add(canonicalPath(buildDir));
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

  if (!skipDocling) {
    // Install the opt-in Docling extraction engine (content-core[docling]).
    // This mirrors the Docker entrypoint's on-demand install
    // (scripts/docker-entrypoint.sh) but pre-installs it into the bundled
    // runtime so the desktop app works fully offline. Pin the extra to the
    // installed content-core version so its transitive deps stay compatible
    // with the locked base install.
    const ccoreVersion = runCapture(
      path.join(dest, 'python.exe'),
      ['-c', "import importlib.metadata as m; print(m.version('content-core'))"],
      { env: { ...process.env, PYTHONPATH: path.join(buildDir, 'site-packages') } }
    );
    log('python', `Installing Docling engine (content-core[docling]==${ccoreVersion})`);
    run(
      'uv',
      ['pip', 'install', '--target', 'site-packages', `content-core[docling]==${ccoreVersion}`, '--override', 'overrides.txt'],
      { cwd: buildDir, timeout: 1800000 }
    );
  } else {
    log('python', 'Skipping Docling engine installation for core minimal variant');
  }

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
  if (await sha256File(dest) !== CHECKSUMS.surreal) {
    throw new Error('Checksum mismatch for cached SurrealDB binary.');
  }
  log('surreal', `Saved SurrealDB binary to ${dest}`);
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
  // Copy only tracked source; ignored .env files and bytecode are not part of the pin.
  const tracked = runCapture('git', ['ls-files', '-z', '--', 'api', 'open_notebook', 'commands', 'prompts', 'LICENSE'], { cwd: repo });
  for (const rel of tracked.split('\0').filter(Boolean)) {
    const src = path.join(repo, rel);
    if (!fs.lstatSync(src).isFile()) throw new Error('Backend source contains a non-regular file.');
    cp(src, path.join(dest, rel));
  }

  // Patch config.py so the data folder can be redirected via DATA_FOLDER env.
  // The desktop app runs the backend from the (read-only) resources dir, so
  // user data must live in the app's user-data directory instead of ./data.
  // This mirrors the project's own recommended modification in
  // docs/1-INSTALLATION/windows-native.md.
  const configFile = path.join(dest, 'open_notebook', 'config.py');
  const config = fs.readFileSync(configFile, 'utf8');
  if (!config.includes('DATA_FOLDER = "./data"')) throw new Error('Failed to patch config.py (DATA_FOLDER line not found)');
  const patched = config.replace(
    'DATA_FOLDER = "./data"',
    (config.includes('import os') ? '' : 'import os\n') + 'DATA_FOLDER = os.environ.get("DATA_FOLDER", "./data")'
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
  const repoInput = path.resolve(readFlag(args, '--repo', DEFAULT_REPO));
  if (!fs.existsSync(path.join(repoInput, 'pyproject.toml'))) {
    throw new Error('Pinned upstream repository not found. Pass --repo with the approved local checkout.');
  }
  const repo = fs.realpathSync(repoInput);
  const step = readFlag(args, '--step', 'all');
  const overrideUpstreamCheck = args.includes('--override-upstream-check');
  const variant = readFlag(args, '--variant', args.includes('--no-docling') ? 'core' : 'full');
  const skipDocling = variant === 'core' || args.includes('--no-docling');
  // --runtime-dir is the canonical flag; --output is kept as an alias for
  // existing callers that predate the rename.
  const outputFlag = readFlag(args, '--runtime-dir', readFlag(args, '--output', DEFAULT_RUNTIME_DIR));
  RUNTIME_DIR = canonicalPath(outputFlag);
  const lockFilePath = path.resolve(readFlag(args, '--lock-file', path.join(PROJECT_DIR, 'upstream.lock.json')));
  if (!['all', ...STEPS].includes(step)) throw new Error('Unknown preparation step: ' + step);
  if (!['full', 'core'].includes(variant) || (variant === 'full' && skipDocling)) {
    throw new Error('Use --variant core for a runtime without Docling.');
  }
  // An alternate test lock must never generate an apparently approved default runtime.
  if (lockFilePath !== path.join(PROJECT_DIR, 'upstream.lock.json') && RUNTIME_DIR === canonicalPath(DEFAULT_RUNTIME_DIR)) {
    throw new Error('An alternate lock requires an isolated --runtime-dir (or --output).');
  }
  const project = fs.realpathSync(PROJECT_DIR);
  const resources = canonicalPath(path.join(project, 'resources'));
  if (containsPath(RUNTIME_DIR, project) || containsPath(RUNTIME_DIR, repo) ||
      containsPath(repo, RUNTIME_DIR) ||
      (containsPath(project, RUNTIME_DIR) && (RUNTIME_DIR === resources || !containsPath(resources, RUNTIME_DIR)))) {
    throw new Error('Runtime output overlaps protected project or upstream source.');
  }
  const { validateRuntimeAllowlist } = require(path.join(PROJECT_DIR, 'dist/src/contracts/modular-packaging'));
  const lockData = JSON.parse(fs.readFileSync(lockFilePath, 'utf8'));
  const upstreamCommit = runCapture('git', ['rev-parse', 'HEAD'], { cwd: repo });
  const upstreamPinMatched = /^[0-9a-f]{40}$/.test(lockData.commit || '') &&
    !/^0+$/.test(lockData.commit) && upstreamCommit === lockData.commit;
  const upstreamStatus = runCapture('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: repo });
  const upstreamWorkingTreeClean = upstreamStatus === '';
  if (!upstreamPinMatched || !upstreamWorkingTreeClean) {
    if (!overrideUpstreamCheck) throw new Error('Upstream commit mismatch or dirty source; runtime preparation refused.');
    console.warn('Upstream commit mismatch or dirty source overridden; output is ineligible for packaging.');
  } else {
    console.log('Verified upstream commit: ' + upstreamCommit);
  }

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // Invalidate a previous manifest before a step can change any artifact.
  const manifestPath = path.join(RUNTIME_DIR, 'manifest.json');
  if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);

  const steps = {
    frontend: () => buildFrontend(repo),
    python: () => buildPython(repo, { variant, skipDocling }),
    surreal: () => buildSurreal(),
    tiktoken: () => buildTiktoken(),
    backend: () => buildBackend(repo),
  };
  const completedSteps = [];
  for (const name of step === 'all' ? STEPS : [step]) {
    await steps[name]();
    completedSteps.push(name);
  }

  if (runCapture('git', ['rev-parse', 'HEAD'], { cwd: repo }) !== upstreamCommit ||
      runCapture('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: repo }) !==
        upstreamStatus) {
    throw new Error('Upstream source changed during runtime preparation.');
  }

  const toolchains = {};
  let pythonPackages = [];
  if (completedSteps.includes('python')) {
    const pythonExe = path.join(RUNTIME_DIR, 'python', 'python.exe');
    toolchains.python = runCapture(pythonExe, ['--version']).replace(/^Python /, '');
    pythonPackages = JSON.parse(runCapture(pythonExe, [
      '-I', '-c', 'import importlib.metadata as m,json; print(json.dumps(sorted([{"name":d.metadata["Name"],"version":d.version} for d in m.distributions()],key=lambda d:d["name"].lower())))',
    ]));
  }
  if (completedSteps.includes('surreal')) {
    const version = runCapture(path.join(RUNTIME_DIR, 'surreal/surreal.exe'), ['version']);
    toolchains.surreal = (version.match(/\b(2\.6\.5(?:\+[^\s]+)?)(?=\s|$)/) || [])[1] || version;
  }
  const manifest = await writePreparationManifest(RUNTIME_DIR, {
    wrapperCommit: runCapture('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_DIR }),
    upstreamCommit,
    expectedUpstreamCommit: lockData.commit,
    upstreamPinMatched,
    upstreamWorkingTreeClean,
    preparationStep: step,
    completedSteps,
    frontendKind: 'parallel-static-client-poc',
    targetPlatform: process.platform,
    targetArchitecture: os.arch(),
    variant,
    toolchains,
    pythonPackages,
  }, validateRuntimeAllowlist);

  if (step !== 'all') {
    console.log('Prepared component: ' + step + '. Partial inventory only; packaging remains blocked.');
  } else if (!manifest.assemblyComplete) {
    throw new Error('Runtime assembly remains incomplete:\n' + manifest.assemblyProblems.join('\n'));
  } else {
    console.log('Runtime assembly inventory verified. Installed-application acceptance remains separate.');
  }
}

main().catch((err) => {
  console.error('Preparation failed:', err && err.message);
  process.exitCode = 1;
});
