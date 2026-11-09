'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { writePreparationManifest, assertRuntimeForPackaging } = require('../lib/runtime-evidence');
const { validateRuntimeAllowlist } = require('../../dist/src/contracts/modular-packaging');

const ROOT = path.resolve(__dirname, '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-runtime-evidence-'));
const runtime = path.join(dir, 'runtime');
const lockFile = path.join(dir, 'lock.json');
const commit = 'a'.repeat(40);

async function main() {
  try {
    fs.mkdirSync(runtime);
    fs.writeFileSync(lockFile, JSON.stringify({ commit }));
    const fixture = {
      'backend/api/main.py': '# synthetic API fixture\n',
      'backend/open_notebook/config.py': '# synthetic config fixture\n',
      'python/python.exe': 'synthetic Python executable',
      'surreal/surreal.exe': 'synthetic SurrealDB executable',
      'frontend/static/index.html': '<p>synthetic application artifact</p>',
    };
    for (const [name, content] of Object.entries(fixture)) {
      const file = path.join(runtime, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    const metadata = {
      upstreamCommit: commit, expectedUpstreamCommit: commit,
      upstreamPinMatched: true, upstreamWorkingTreeClean: true,
      preparationStep: 'all', completedSteps: ['frontend', 'python', 'surreal', 'tiktoken', 'backend'],
      frontendKind: 'application', targetPlatform: 'win32', targetArchitecture: 'x64', variant: 'core',
      toolchains: { python: '3.12.10', surreal: '2.6.5+test' },
      pythonPackages: [{ name: 'synthetic-package', version: '1.0' }],
    };
    const manifestPath = path.join(runtime, 'manifest.json');
    const good = await writePreparationManifest(runtime, metadata, validateRuntimeAllowlist);
    assert.equal(good.assemblyComplete, true);
    await assertRuntimeForPackaging(runtime, lockFile);

    for (const [field, value, pattern] of [
      ['preparationStep', 'backend', /partial/],
      ['completedSteps', ['backend'], /partial/],
      ['upstreamPinMatched', false, /approved pin/],
      ['upstreamWorkingTreeClean', false, /clean/],
      ['upstreamCommit', 'b'.repeat(40), /approved pin/],
      ['frontendKind', 'parallel-static-client-poc', /proof of concept/],
      ['allowlistPassed', false, /allowlist/],
      ['toolchains', { python: '3.12', surreal: '2.6.5' }, /versions/],
      ['pythonPackages', [], /package inventory/],
      ['files', [{ path: '../outside', sizeBytes: 1, sha256: '0'.repeat(64) }], /malformed/],
      ['schemaVersion', 1, /assembly inventory/],
      ['assemblyComplete', false, /not marked/],
      ['targetArchitecture', 'arm64', /Windows x64/],
    ]) {
      fs.writeFileSync(manifestPath, JSON.stringify({ ...good, [field]: value }));
      await assert.rejects(assertRuntimeForPackaging(runtime, lockFile), pattern, field);
    }
    for (const malformed of [null, [], {}, { upstreamCommit: commit }]) {
      fs.writeFileSync(manifestPath, JSON.stringify(malformed));
      await assert.rejects(assertRuntimeForPackaging(runtime, lockFile));
    }
    fs.writeFileSync(manifestPath, JSON.stringify(good));
    fs.appendFileSync(path.join(runtime, 'backend/api/main.py'), '# tamper\n');
    await assert.rejects(assertRuntimeForPackaging(runtime, lockFile), /files changed/);
    fs.writeFileSync(path.join(runtime, 'backend/api/main.py'), fixture['backend/api/main.py']);

    const extra = path.join(runtime, 'backend/unrecorded.py');
    fs.writeFileSync(extra, '# extra');
    await assert.rejects(assertRuntimeForPackaging(runtime, lockFile), /files changed/);
    fs.unlinkSync(extra);

    const poc = path.join(runtime, 'frontend/static/build-manifest.json');
    fs.writeFileSync(poc, JSON.stringify({ buildTarget: 'parallel-static-client-poc' }));
    await writePreparationManifest(runtime, metadata, validateRuntimeAllowlist);
    await assert.rejects(assertRuntimeForPackaging(runtime, lockFile), /proof-of-concept/);
    fs.unlinkSync(poc);

    fs.writeFileSync(path.join(runtime, 'unexpected.exe'), 'unapproved file');
    await assert.rejects(writePreparationManifest(runtime, metadata, validateRuntimeAllowlist), /allowlist/);
    fs.unlinkSync(path.join(runtime, 'unexpected.exe'));
    await assert.rejects(writePreparationManifest(runtime, metadata, () => { throw new Error('validation unavailable'); }), /validation unavailable/);

    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    const link = path.join(runtime, 'backend/link');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(writePreparationManifest(runtime, metadata, validateRuntimeAllowlist), /symbolic links/);
    fs.unlinkSync(link);

    // Execute copies of the real entrypoints in an isolated tree, never the user's runtime.
    const isolatedRoot = path.join(dir, 'entrypoints');
    fs.mkdirSync(path.join(isolatedRoot, 'scripts/lib'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts/lib/runtime-evidence.js'), path.join(isolatedRoot, 'scripts/lib/runtime-evidence.js'));
    fs.writeFileSync(path.join(isolatedRoot, 'upstream.lock.json'), JSON.stringify({ commit }));
    const packagedRoot = path.join(isolatedRoot, 'out/Office of Equity Open Notebook');
    for (const base of [isolatedRoot, packagedRoot]) {
      fs.mkdirSync(path.join(base, 'resources/runtime'), { recursive: true });
      fs.writeFileSync(path.join(base, 'resources/runtime/manifest.json'), '{}');
    }
    const sentinel = path.join(packagedRoot, 'preserve.txt');
    fs.writeFileSync(sentinel, 'untouched');
    for (const script of ['package-native.js', 'package.js', 'build-installer-native.js', 'build-installer.js']) {
      const target = path.join(isolatedRoot, 'scripts', script);
      fs.copyFileSync(path.join(ROOT, 'scripts', script), target);
      const res = spawnSync(process.execPath, [target], { encoding: 'utf8' });
      assert.notEqual(res.status, 0, script + ' must reject incomplete runtime.');
      assert.match(res.stderr, /Runtime packaging blocked/, script);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
    }
    console.log('Synthetic inventory acceptance and negative packaging checks passed; no application security acceptance claimed.');
  } finally {
    const relative = path.relative(os.tmpdir(), dir);
    assert.ok(relative.startsWith('oe-runtime-evidence-') && !relative.includes(path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
