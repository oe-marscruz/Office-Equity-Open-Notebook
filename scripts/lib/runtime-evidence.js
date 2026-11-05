'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STEPS = ['frontend', 'python', 'surreal', 'tiktoken', 'backend'];
const REQUIRED_FILES = [
  'backend/api/main.py',
  'backend/open_notebook/config.py',
  'python/python.exe',
  'surreal/surreal.exe',
  'frontend/static/index.html',
];

async function inventoryRuntime(runtimeDir) {
  const files = [];
  async function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(runtimeDir, full).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) throw new Error('Runtime inventory rejects symbolic links: ' + rel);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && rel !== 'manifest.json') {
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(full)) hash.update(chunk);
        files.push({ path: rel, sizeBytes: fs.statSync(full).size, sha256: hash.digest('hex') });
      } else if (!entry.isFile()) throw new Error('Unsupported runtime entry: ' + rel);
    }
  }
  await walk(runtimeDir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function assemblyProblems(manifest, expectedCommit) {
  const errors = [];
  if (manifest.schemaVersion !== 2 || manifest.evidenceKind !== 'runtime-assembly-inventory') {
    errors.push('Missing runtime assembly inventory; prepare the runtime again.');
  }
  if (!/^[0-9a-f]{40}$/.test(expectedCommit || '') || /^0+$/.test(expectedCommit || '') ||
      manifest.upstreamCommit !== expectedCommit || manifest.upstreamPinMatched !== true) {
    errors.push('Runtime upstream revision does not match the approved pin.');
  }
  if (manifest.upstreamWorkingTreeClean !== true) errors.push('Upstream source was not verified clean.');
  if (manifest.preparationStep !== 'all' || !Array.isArray(manifest.completedSteps) ||
      !STEPS.every((step) => manifest.completedSteps.includes(step))) {
    errors.push('Runtime preparation is partial; all components must be prepared together.');
  }
  if (manifest.frontendKind !== 'application') errors.push('Frontend is a proof of concept; functional application assembly remains open.');
  if (manifest.allowlistPassed !== true) errors.push('Runtime allowlist validation did not pass.');
  if (!manifest.toolchains || !/^3\.12\.\d+$/.test(manifest.toolchains.python || '') ||
      !/^2\.6\.5(?:\+[^\s]+)?$/.test(manifest.toolchains.surreal || '')) {
    errors.push('Resolved Python/SurrealDB runtime versions are missing or unsupported.');
  }
  if (!Array.isArray(manifest.pythonPackages) || manifest.pythonPackages.length === 0 ||
      manifest.pythonPackages.some((item) => !item || typeof item.name !== 'string' || !item.name ||
        typeof item.version !== 'string' || !item.version)) {
    errors.push('Resolved Python package inventory is missing or malformed.');
  }
  if (manifest.targetPlatform !== 'win32' || manifest.targetArchitecture !== 'x64') {
    errors.push('Only the Windows x64 runtime is supported by this assembler.');
  }
  if (!['full', 'core'].includes(manifest.variant)) errors.push('Unsupported runtime variant.');
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length === 0 || files.some((file) => !file || typeof file.path !== 'string' ||
      file.path.includes('\\') || file.path.startsWith('/') || file.path.split('/').some((s) => !s || s === '.' || s === '..') ||
      !/^[0-9a-f]{64}$/.test(file.sha256 || '') || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0) ||
      new Set(files.map((file) => file && file.path)).size !== files.length) {
    errors.push('Runtime file inventory is missing or malformed.');
  }
  for (const required of REQUIRED_FILES) {
    if (!files.some((file) => file && file.path === required && file.sizeBytes > 0)) {
      errors.push('Missing runtime file: ' + required);
    }
  }
  return errors;
}

async function writePreparationManifest(runtimeDir, metadata, validateAllowlist) {
  const files = await inventoryRuntime(runtimeDir);
  const allowlist = validateAllowlist(files.map((file) => file.path));
  if (!allowlist || allowlist.valid !== true) throw new Error('Runtime allowlist validation failed.');
  const manifest = {
    ...metadata,
    schemaVersion: 2,
    evidenceKind: 'runtime-assembly-inventory',
    buildTimestamp: new Date().toISOString(),
    files,
    allowlistPassed: true,
  };
  manifest.assemblyProblems = assemblyProblems(manifest, metadata.expectedUpstreamCommit);
  manifest.assemblyComplete = manifest.assemblyProblems.length === 0;
  // The expected pin comes from the checkout's lock, not from the runtime manifest.
  delete manifest.expectedUpstreamCommit;
  fs.writeFileSync(path.join(runtimeDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

async function assertRuntimeForPackaging(runtimeDir, lockFile) {
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'manifest.json'), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid runtime manifest.');
  const problems = assemblyProblems(manifest, lock && lock.commit);
  if (manifest.assemblyComplete !== true) problems.push('Runtime is not marked as assembled.');
  if (problems.length) throw new Error('Runtime packaging blocked:\n' + problems.join('\n'));
  const actual = await inventoryRuntime(runtimeDir);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new Error('Runtime packaging blocked: files changed after inventory generation.');
  }
  // Recheck using the owning contract rather than trusting the manifest's boolean.
  const { validateRuntimeAllowlist } = require('../../dist/src/contracts/modular-packaging');
  if (validateRuntimeAllowlist(actual.map((file) => file.path)).valid !== true) {
    throw new Error('Runtime packaging blocked: file allowlist validation failed.');
  }
  const frontendManifest = path.join(runtimeDir, 'frontend/static/build-manifest.json');
  if (fs.existsSync(frontendManifest) &&
      JSON.parse(fs.readFileSync(frontendManifest, 'utf8')).buildTarget === 'parallel-static-client-poc') {
    throw new Error('Runtime packaging blocked: proof-of-concept frontend detected.');
  }
  return manifest;
}

module.exports = { STEPS, inventoryRuntime, writePreparationManifest, assertRuntimeForPackaging };
