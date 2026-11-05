'use strict';

const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { inventoryRuntime, assertRuntimeForPackaging } = require('../lib/runtime-evidence');

const ROOT = path.resolve(__dirname, '../..');
const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-upstream-lock-'));
const repo = path.join(suiteDir, 'source');
const runtime = path.join(suiteDir, 'runtime');
const lock = path.join(suiteDir, 'upstream.lock.json');

function git(args) {
  const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.error?.message);
  return res.stdout.trim();
}

function prepare(extra = [], output = runtime, step = 'backend') {
  return spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/prepare-runtime.js'), '--repo', repo,
    '--runtime-dir', output, '--lock-file', lock, '--step', step, ...extra,
  ], { encoding: 'utf8' });
}

async function defaultSnapshot() {
  const runtimeDir = path.join(ROOT, 'resources/runtime');
  const manifest = path.join(runtimeDir, 'manifest.json');
  return {
    lock: fs.readFileSync(path.join(ROOT, 'upstream.lock.json'), 'utf8'),
    files: fs.existsSync(runtimeDir) ? await inventoryRuntime(runtimeDir) : null,
    manifest: fs.existsSync(manifest) ? fs.readFileSync(manifest, 'utf8') : null,
  };
}

async function main() {
  const before = await defaultSnapshot();
  try {
    fs.mkdirSync(path.join(repo, 'open_notebook'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'pyproject.toml'), '[project]\ndependencies = []\n');
    fs.writeFileSync(path.join(repo, 'open_notebook/config.py'), 'DATA_FOLDER = "./data"\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.py\n');
    fs.writeFileSync(path.join(repo, 'open_notebook/ignored.py'), '# ignored local file');
    git(['init']);
    git(['add', '.']);
    git(['-c', 'user.email=test@example.invalid', '-c', 'user.name=Fixture', 'commit', '-m', 'synthetic fixture']);
    const commit = git(['rev-parse', 'HEAD']);

    fs.writeFileSync(lock, JSON.stringify({ commit: '0'.repeat(40) }));
    let result = prepare();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Upstream commit mismatch/);
    assert.equal(fs.existsSync(runtime), false, 'Rejected pin must not mutate output.');

    result = prepare(['--override-upstream-check']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /ineligible for packaging/);
    let manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'manifest.json'), 'utf8'));
    assert.equal(manifest.upstreamPinMatched, false);
    assert.equal(manifest.assemblyComplete, false);
    await assert.rejects(assertRuntimeForPackaging(runtime, lock), /packaging blocked/);

    fs.writeFileSync(lock, JSON.stringify({ commit }));
    result = prepare();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Verified upstream commit/);
    assert.match(result.stdout, /Partial inventory only/);
    manifest = JSON.parse(fs.readFileSync(path.join(runtime, 'manifest.json'), 'utf8'));
    assert.equal(manifest.upstreamCommit, commit);
    assert.equal(manifest.upstreamPinMatched, true);
    assert.equal(manifest.upstreamWorkingTreeClean, true);
    assert.deepEqual(manifest.completedSteps, ['backend']);
    assert.equal(manifest.assemblyComplete, false);
    assert.equal(manifest.files.length, 1);
    assert.match(manifest.files[0].sha256, /^[a-f0-9]{64}$/);
    assert.match(fs.readFileSync(path.join(runtime, 'backend/open_notebook/config.py'), 'utf8'), /^import os\n/);
    await assert.rejects(assertRuntimeForPackaging(runtime, lock), /partial/);

    assert.equal(fs.existsSync(path.join(runtime, 'backend/open_notebook/ignored.py')), false);
    const linked = path.join(suiteDir, 'linked-output');
    fs.symlinkSync(repo, linked, process.platform === 'win32' ? 'junction' : 'dir');
    result = prepare([], linked);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /overlaps protected/);
    fs.unlinkSync(linked);

    const manifestBeforeDirty = fs.readFileSync(path.join(runtime, 'manifest.json'), 'utf8');
    fs.appendFileSync(path.join(repo, 'open_notebook/config.py'), '# dirty\n');
    result = prepare();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dirty source/);
    assert.equal(fs.readFileSync(path.join(runtime, 'manifest.json'), 'utf8'), manifestBeforeDirty);

    result = prepare([], path.join(ROOT, 'resources/runtime'));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /alternate lock requires an isolated/);

    // A build failure after preflight invalidates the old manifest.
    fs.writeFileSync(path.join(repo, 'open_notebook/config.py'), '# incompatible upstream config\n');
    result = prepare(['--override-upstream-check']);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(runtime, 'manifest.json')), false);
    fs.mkdirSync(path.join(runtime, 'surreal'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'surreal/surreal.exe'), 'corrupt cached binary');
    result = prepare(['--override-upstream-check'], runtime, 'surreal');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Checksum mismatch for cached SurrealDB/);
    assert.equal(fs.existsSync(path.join(runtime, 'manifest.json')), false);
    assert.deepEqual(await defaultSnapshot(), before, 'Fixture tests must leave production lock/runtime unchanged.');
    console.log('Upstream pin, partial/override rejection, failed-build invalidation and fixture isolation passed.');
  } finally {
    const relative = path.relative(os.tmpdir(), suiteDir);
    assert.ok(relative.startsWith('oe-upstream-lock-') && !relative.includes(path.sep));
    fs.rmSync(suiteDir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
