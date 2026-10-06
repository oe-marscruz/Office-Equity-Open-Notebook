'use strict';

/**
 * test-chaos.js — verifies how the app behaves when the database disappears
 * underneath it.
 *
 * The failure this exercises is the realistic one: SurrealDB dies or is killed
 * mid-session. The questions that matter for the Office of Equity are:
 *   1. Does the API fail fast and report an error, or hang and appear frozen?
 *   2. Does the app recover on its own, or does it require a restart?
 *
 * Requires a running stack:
 *   node scripts/run-services.js
 * then:
 *   npm run test:integration
 *
 * NOTE: the supervisor deliberately does NOT restart services. A crashed
 * critical service is surfaced as a problem report and the app must be
 * relaunched, so this harness asserts that behaviour rather than assuming a
 * restart that does not exist.
 */

const { execFileSync } = require('child_process');
const { PORTS } = require('../lib/paths');
const { killProcessTree, isProcessAlive, sleep } = require('../lib/supervisor');

const API_URL = `http://127.0.0.1:${PORTS.api}`;
const HEALTH_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 8000;
const RECOVERY_POLL_MS = 2000;
const RECOVERY_ATTEMPTS = 15;

/**
 * Finds the pid listening on `port` without matching by image name, so we can
 * never accidentally kill an unrelated `surreal.exe` the user is running.
 */
function findListeningPid(port) {
  const output = process.platform === 'win32'
    ? execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true })
    : execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });

  if (process.platform !== 'win32') {
    const first = output.trim().split(/\s+/)[0];
    return first ? Number(first) : null;
  }

  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0] !== 'TCP') continue;
    if (!columns[1].endsWith(`:${port}`)) continue;
    const state = columns[3];
    if (state !== 'LISTENING') continue;
    const pid = Number(columns[4]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    await response.arrayBuffer();
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function isApiHealthy() {
  const result = await fetchWithTimeout(`${API_URL}/health`, HEALTH_TIMEOUT_MS);
  return result.ok;
}

async function runChaosTest() {
  console.log('Chaos test: simulating a mid-session database failure...');

  if (!(await isApiHealthy())) {
    console.error(`\nSKIPPED: no healthy API on ${API_URL}.`);
    console.error('Start the stack first with: node scripts/run-services.js');
    process.exitCode = 2;
    return;
  }
  console.log('Backend is healthy.');

  const pid = findListeningPid(PORTS.surreal);
  if (!pid) {
    console.error(`\nSKIPPED: could not identify the process listening on port ${PORTS.surreal}.`);
    process.exitCode = 2;
    return;
  }
  console.log(`Killing the database (pid ${pid}) only — no other process is touched...`);
  killProcessTree(pid, { force: true });
  await sleep(1000);
  console.log(`Database process alive after kill: ${isProcessAlive(pid)}`);

  console.log('\nRequesting a primary workflow during the outage...');
  const started = Date.now();
  const result = await fetchWithTimeout(`${API_URL}/notebooks`, REQUEST_TIMEOUT_MS);
  const elapsed = Date.now() - started;

  if (result.ok) {
    console.error(`FAIL: /notebooks returned ${result.status} with the database down; a stale success would mislead staff into thinking data was saved.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Expected failure: ${result.error} (responded in ${elapsed}ms)`);

  if (elapsed >= REQUEST_TIMEOUT_MS) {
    console.error(`FAIL: the API hung for the full ${REQUEST_TIMEOUT_MS}ms instead of failing fast. Users would see a frozen window.`);
    process.exitCode = 1;
    return;
  }
  console.log(`No hang: the API failed in ${elapsed}ms rather than blocking the UI.`);

  console.log('\nChecking whether the stack self-heals...');
  let recovered = false;
  for (let attempt = 0; attempt < RECOVERY_ATTEMPTS; attempt++) {
    await sleep(RECOVERY_POLL_MS);
    if (await isApiHealthy()) {
      recovered = true;
      break;
    }
  }

  if (recovered) {
    console.log('The stack recovered on its own.');
  } else {
    console.log('The stack did NOT recover on its own, which matches the documented design:');
    console.log('a crashed critical service is reported to the user and the app must be relaunched.');
  }

  console.log('\nPASS: outage is detected, fails fast, and does not silently pretend to succeed.');
}

runChaosTest().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
