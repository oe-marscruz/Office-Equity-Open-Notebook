const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_DIR = path.join(__dirname, '..', '..');
const RUNTIME_SCRIPT = path.join(PROJECT_DIR, 'scripts', 'prepare-runtime.js');
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oen-upstream-lock-'));
const LOCK_FILE = path.join(TEMP_DIR, 'upstream.lock.json');
const RUNTIME_DIR = path.join(TEMP_DIR, 'runtime');

// We need a dummy repo to run prepare-runtime.js
const DUMMY_REPO = path.join(TEMP_DIR, 'repo');

function setupDummyRepo() {
  if (fs.existsSync(DUMMY_REPO)) fs.rmSync(DUMMY_REPO, { recursive: true, force: true });
  fs.mkdirSync(DUMMY_REPO, { recursive: true });

  // pyproject.toml is required by prepare-runtime.js
  fs.writeFileSync(path.join(DUMMY_REPO, 'pyproject.toml'), '[project]\ndependencies = []');

  // create dummy git repo
  spawnSync('git', ['init'], { cwd: DUMMY_REPO });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: DUMMY_REPO });
  spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: DUMMY_REPO });
  fs.mkdirSync(path.join(DUMMY_REPO, 'open_notebook'));
  fs.writeFileSync(path.join(DUMMY_REPO, 'open_notebook', 'config.py'), 'DATA_FOLDER = "./data"');
  spawnSync('git', ['add', '.'], { cwd: DUMMY_REPO });
  spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: DUMMY_REPO });

  const res = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: DUMMY_REPO, encoding: 'utf8' });
  return res.stdout.trim();
}

const dummyCommit = setupDummyRepo();

try {
  console.log('Test 1: Fail closed on mismatch');
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ commit: 'mismatched-sha' }));
  const res1 = spawnSync(process.execPath, [RUNTIME_SCRIPT, '--repo', DUMMY_REPO, '--step', 'backend', '--output', RUNTIME_DIR, '--lock-file', LOCK_FILE], { encoding: 'utf8' });
  const err1 = res1.stderr || '';
  if (res1.status === 0 || !err1.includes('Upstream commit mismatch')) {
    throw new Error('Expected prepare-runtime.js to fail on mismatch, but it did not. Output:\n' + err1 + (res1.stdout || ''));
  }
  console.log('  -> Passed');

  console.log('Test 2: Success with --override-upstream-check');
  const res2 = spawnSync(process.execPath, [RUNTIME_SCRIPT, '--repo', DUMMY_REPO, '--step', 'backend', '--output', RUNTIME_DIR, '--lock-file', LOCK_FILE, '--override-upstream-check'], { encoding: 'utf8' });
  const err2 = res2.stderr || '';
  if (res2.status !== 0 || !err2.includes('Upstream commit mismatch overridden')) {
    throw new Error('Expected prepare-runtime.js to succeed with override, but it failed. Output:\n' + err2 + '\n' + (res2.stdout || ''));
  }
  console.log('  -> Passed');

  console.log('Test 3: Success on match');
  fs.writeFileSync(LOCK_FILE, JSON.stringify({ commit: dummyCommit }));
  const res3 = spawnSync(process.execPath, [RUNTIME_SCRIPT, '--repo', DUMMY_REPO, '--step', 'backend', '--output', RUNTIME_DIR, '--lock-file', LOCK_FILE], { encoding: 'utf8' });
  const out3 = res3.stdout || '';
  if (res3.status !== 0 || !out3.includes('Verified upstream commit')) {
    throw new Error('Expected prepare-runtime.js to succeed on match, but it failed. Output:\n' + (res3.stderr || '') + '\n' + out3);
  }
  console.log('  -> Passed');

  console.log('Test 4: Manifest generated successfully');
  const manifestPath = path.join(RUNTIME_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('Manifest file was not generated.');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.upstreamCommit !== dummyCommit) {
    throw new Error(`Manifest has wrong upstreamCommit: expected ${dummyCommit}, got ${manifest.upstreamCommit}`);
  }
  console.log('  -> Passed');

} finally {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}

console.log('All tests passed.');
