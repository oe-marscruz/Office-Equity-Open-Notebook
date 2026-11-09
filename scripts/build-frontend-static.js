'use strict';

/**
 * build-frontend-static.js
 *
 * Builds the pinned upstream Open Notebook Next.js UI into Node-free static
 * assets and copies them to `runtime/frontend/static`, where the native Tauri
 * host serves them and proxies `/api/*` to the bundled FastAPI backend.
 *
 * This replaces the L3.3 static-client POC stubs. The result is the real
 * application: same pages, same components, same i18n bundle, no Node process
 * at runtime (X20) and no server-side rendering.
 *
 * Usage:
 *   node scripts/build-frontend-static.js [--repo <path>] [--output <dir>] [--force-install]
 *
 * Flags:
 *   --repo <path>      Upstream checkout (default: ../open-notebook)
 *   --output <dir>     Destination for the static assets
 *                      (default: resources/runtime/frontend/static)
 *   --force-install    Reinstall frontend dependencies even if they look current
 *   --skip-verify      Skip the pinned-commit check (local experiments only)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const {
  FrontendPatchError,
  inspectStaticExport,
  patchFrontendForStaticExport,
} = require('./lib/frontend-static-export');

const PROJECT_DIR = path.join(__dirname, '..');
const LOCK_FILE = path.join(PROJECT_DIR, 'upstream.lock.json');
const BUILD_ROOT = path.join(PROJECT_DIR, '.artifacts', 'frontend-build');

/** Bump when the shape of `build-manifest.json` changes. */
const MANIFEST_SCHEMA_VERSION = 2;

function arg(name, fallback) {
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function run(cmd, args, options = {}) {
  // npm/npx are .cmd shims on Windows and require a shell.
  const shell = options.shell === true || cmd === 'npm' || cmd === 'npx';
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell, ...options });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status ?? 'signal'}): ${cmd} ${args.join(' ')}`);
  }
  return res;
}

function runCapture(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', shell: false, ...options });
  if (res.status !== 0) {
    throw new Error(`Command failed (${res.status ?? 'signal'}): ${cmd} ${args.join(' ')}`);
  }
  return (res.stdout || '').trim();
}

function readLockCommit() {
  if (!fs.existsSync(LOCK_FILE)) return null;
  const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  return lock.commit || null;
}

function verifyUpstreamCommit(repo, { skipVerify }) {
  const expected = readLockCommit();
  let actual = 'unknown';
  try {
    actual = runCapture('git', ['rev-parse', 'HEAD'], { cwd: repo });
  } catch (err) {
    if (skipVerify) {
      console.warn(`Warning: cannot read upstream commit (${err.message}); continuing (--skip-verify).`);
      return { expected, actual, verified: false };
    }
    throw new Error(`Cannot read upstream commit at ${repo}: ${err.message}`);
  }

  if (expected && actual !== expected) {
    if (skipVerify) {
      console.warn(`Warning: upstream commit ${actual} != locked ${expected}; continuing (--skip-verify).`);
      return { expected, actual, verified: false };
    }
    throw new Error(
      `Upstream commit mismatch: expected ${expected} (upstream.lock.json), got ${actual}.\n` +
        'Check out the locked commit or pass --skip-verify for a local experiment.',
    );
  }
  return { expected, actual, verified: Boolean(expected) };
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * Clears the build workspace while preserving installed dependencies; wiping
 * `node_modules` would invalidate the reuse check on every run.
 */
function cleanBuildDir(buildDir) {
  fs.mkdirSync(buildDir, { recursive: true });
  const preserved = new Set(['node_modules', '.deps-lock-hash']);
  for (const entry of fs.readdirSync(buildDir)) {
    if (preserved.has(entry)) continue;
    rmrf(path.join(buildDir, entry));
  }
}

/**
 * Copies the upstream frontend sources into the build workspace, excluding
 * generated and dependency directories.
 */
function syncSources(upstreamFrontend, buildDir) {
  const excluded = new Set(['node_modules', '.next', '.git', 'out']);
  const copyTree = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name);
      if (entry.isDirectory()) copyTree(source, target);
      else if (entry.isFile()) fs.copyFileSync(source, target);
    }
  };
  copyTree(upstreamFrontend, buildDir);
}

function dependenciesAreCurrent(buildDir, lockHash) {
  const marker = path.join(buildDir, '.deps-lock-hash');
  const installed = path.join(buildDir, 'node_modules', 'next');
  if (!fs.existsSync(installed) || !fs.existsSync(marker)) return false;
  return fs.readFileSync(marker, 'utf8').trim() === lockHash;
}

function installDependencies(buildDir) {
  const lockfile = path.join(buildDir, 'package-lock.json');
  const lockHash = fs.existsSync(lockfile) ? hashFile(lockfile) : 'no-lockfile';

  if (!flag('--force-install') && dependenciesAreCurrent(buildDir, lockHash)) {
    console.log('Frontend dependencies already installed for this lockfile; reusing.');
    return;
  }

  console.log('Installing upstream frontend dependencies (this can take a few minutes)...');
  const args = ['install', '--no-audit', '--no-fund'];
  if (fs.existsSync(lockfile)) args.push('--prefer-offline');
  run('npm', args, { cwd: buildDir, timeout: 30 * 60 * 1000 });
  fs.writeFileSync(path.join(buildDir, '.deps-lock-hash'), `${lockHash}\n`);
}

function buildStaticExport(buildDir) {
  const outDir = path.join(buildDir, 'out');
  rmrf(outDir);
  // `next build` with output:"export" writes the export to `out/`.
  run('npx', ['next', 'build'], { cwd: buildDir, timeout: 60 * 60 * 1000 });
  return outDir;
}

/**
 * Produces the honest provenance manifest shipped alongside the assets. It is
 * written *after* a real application build succeeds, never as a substitute for
 * one.
 */
function writeBuildManifest(destination, details) {
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    frontendKind: 'application',
    buildTarget: 'next-static-export',
    isProofOfConcept: false,
    provenance: {
      upstreamRepository: 'lfnovo/open-notebook',
      upstreamCommit: details.upstreamCommit,
      lockedCommit: details.expectedCommit,
      upstreamCommitVerified: details.upstreamCommitVerified,
      frontendSourceDir: 'frontend',
    },
    runtimeModel: {
      bundlesNodeRuntime: false,
      requiresNodeAtRuntime: false,
      serverRendering: false,
      apiRouting: 'native-host-proxy',
      apiBasePath: '/api',
      runtimeConfigAsset: '/config',
    },
    transformations: details.transformations,
    export: {
      fileCount: details.fileCount,
      totalBytes: details.totalBytes,
      hasIndexHtml: details.hasIndexHtml,
      dynamicRouteShells: details.dynamicShells,
    },
    nextVersion: details.nextVersion,
    buildTimestamp: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(destination, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function main() {
  const repo = path.resolve(arg('--repo', path.join(PROJECT_DIR, '..', 'open-notebook')));
  const destination = path.resolve(
    arg('--output', path.join(PROJECT_DIR, 'resources', 'runtime', 'frontend', 'static')),
  );
  const skipVerify = flag('--skip-verify');

  const upstreamFrontend = path.join(repo, 'frontend');
  if (!fs.existsSync(path.join(upstreamFrontend, 'package.json'))) {
    throw new Error(
      `Upstream frontend not found at ${upstreamFrontend}.\n` +
        'Clone lfnovo/open-notebook at the commit in upstream.lock.json and pass --repo=<path>.',
    );
  }

  console.log('=== [frontend] Building the Open Notebook UI as a Node-free static export ===');
  console.log(`Upstream:  ${repo}`);

  const lock = verifyUpstreamCommit(repo, { skipVerify });
  console.log(`Commit:    ${lock.actual}${lock.verified ? ' (matches upstream.lock.json)' : ''}`);

  const buildDir = path.join(BUILD_ROOT, 'app');
  cleanBuildDir(buildDir);

  console.log(`Workspace: ${buildDir}`);
  syncSources(upstreamFrontend, buildDir);
  installDependencies(buildDir);

  const transformations = patchFrontendForStaticExport({ upstreamFrontend, buildDir });
  for (const transformation of transformations) console.log(`  · ${transformation}`);

  console.log('Running next build (static export)...');
  const outDir = buildStaticExport(buildDir);
  const exportInfo = inspectStaticExport(outDir);
  console.log(
    `Export:    ${exportInfo.fileCount} files, ${(exportInfo.totalBytes / (1024 * 1024)).toFixed(1)} MiB`,
  );

  rmrf(destination);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(outDir, destination, { recursive: true });
  console.log(`Copied static assets to ${destination}`);

  const frontendPackage = JSON.parse(fs.readFileSync(path.join(buildDir, 'package.json'), 'utf8'));
  const nextVersion =
    (frontendPackage.dependencies && frontendPackage.dependencies.next) ||
    (frontendPackage.devDependencies && frontendPackage.devDependencies.next) ||
    'unknown';

  const manifest = writeBuildManifest(destination, {
    upstreamCommit: lock.actual,
    expectedCommit: lock.expected,
    upstreamCommitVerified: lock.verified,
    transformations,
    fileCount: exportInfo.fileCount,
    totalBytes: exportInfo.totalBytes,
    hasIndexHtml: exportInfo.hasIndexHtml,
    dynamicShells: exportInfo.dynamicShells,
    nextVersion,
  });

  console.log(
    `Manifest:  frontendKind=${manifest.frontendKind}, buildTarget=${manifest.buildTarget}, ` +
      `isProofOfConcept=${manifest.isProofOfConcept}`,
  );
  console.log('=== [frontend] Static application build complete ===');
  return manifest;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    if (err instanceof FrontendPatchError) {
      console.error(`\n❌ Frontend patch failed: ${err.message}`);
    } else {
      console.error(`\n❌ Frontend build failed: ${err && err.message}`);
    }
    process.exit(1);
  }
}

module.exports = { main, writeBuildManifest, MANIFEST_SCHEMA_VERSION };
