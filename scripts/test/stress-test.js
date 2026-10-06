'use strict';

/**
 * test-api.js — integration/stress harness for the bundled Open Notebook API.
 *
 * Exercises the primary user workflows (creating notes, listing notebooks, both
 * search paths) under moderate concurrency and reports latency percentiles and
 * an error rate per endpoint.
 *
 * Requires a running stack. Start one with:
 *   node scripts/run-services.js
 * then run this in another shell:
 *   npm run test:integration
 *
 * Uses the built-in `fetch` rather than a third-party HTTP client so the
 * harness has no dependencies beyond Node itself.
 */

const { PORTS } = require('../lib/paths');

const API_URL = `http://127.0.0.1:${PORTS.api}`;
const CONCURRENCY = 10;
const REQUESTS_PER_ENDPOINT = 200;
const REQUEST_TIMEOUT_MS = 5000;

// Latency above this is treated as a degraded (but non-fatal) result.
const P95_BUDGET_MS = 2000;
const ERROR_RATE_BUDGET = 0.05;

async function request(endpoint, signal) {
  const url = new URL(`${API_URL}${endpoint.path}`);
  if (endpoint.params) {
    for (const [key, value] of Object.entries(endpoint.params)) {
      url.searchParams.set(key, value);
    }
  }
  const response = await fetch(url, {
    method: (endpoint.method || 'get').toUpperCase(),
    headers: endpoint.body ? { 'Content-Type': 'application/json' } : undefined,
    body: endpoint.body ? JSON.stringify(endpoint.body) : undefined,
    signal,
  });
  // Drain the body so the socket is released back to the pool.
  await response.arrayBuffer();
  return response.status;
}

/** Runs `tasks` with a bounded number of in-flight requests. */
async function runPool(tasks, limit) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

async function checkApiReachable() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    await fetch(`${API_URL}/health`, { signal: controller.signal });
    return true;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function runStressTest() {
  console.log(`Stress testing ${API_URL}...`);

  if (!(await checkApiReachable())) {
    console.error(`\nSKIPPED: no API is listening on ${API_URL}.`);
    console.error('Start the stack first with: node scripts/run-services.js');
    process.exitCode = 2;
    return;
  }

  const endpoints = [
    { name: 'Create Note', method: 'post', path: '/notes', body: { title: 'Stress Test', content: 'Testing concurrency...' } },
    { name: 'Get Notebooks', method: 'get', path: '/notebooks' },
    { name: 'Vector Search', method: 'get', path: '/search/vector', params: { query: 'performance' } },
    { name: 'Full-Text Search', method: 'get', path: '/search/text', params: { query: 'concurrency' } },
  ];

  let worstP95 = 0;
  let worstErrorRate = 0;

  for (const endpoint of endpoints) {
    console.log(`\nTesting ${endpoint.name}...`);
    const latencies = [];
    let errors = 0;
    const errorSamples = [];

    const tasks = Array.from({ length: REQUESTS_PER_ENDPOINT }, () => async () => {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        await request(endpoint, controller.signal);
        latencies.push(Date.now() - started);
      } catch (error) {
        errors += 1;
        if (errorSamples.length < 3) errorSamples.push(error.message);
      } finally {
        clearTimeout(timer);
      }
    });

    await runPool(tasks, CONCURRENCY);

    const sorted = latencies.slice().sort((a, b) => a - b);
    const p50 = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);
    const p99 = percentile(sorted, 0.99);
    const errorRate = errors / REQUESTS_PER_ENDPOINT;

    console.log(`- p50: ${p50 === null ? 'n/a' : `${p50}ms`}`);
    console.log(`- p95: ${p95 === null ? 'n/a' : `${p95}ms`}`);
    console.log(`- p99: ${p99 === null ? 'n/a' : `${p99}ms`}`);
    console.log(`- Errors: ${errors}/${REQUESTS_PER_ENDPOINT}`);
    if (errorSamples.length > 0) {
      console.log(`- Sample errors: ${errorSamples.join('; ')}`);
    }

    if (p95 !== null) worstP95 = Math.max(worstP95, p95);
    worstErrorRate = Math.max(worstErrorRate, errorRate);
  }

  console.log('\n--- Summary ---');
  console.log(`Worst p95: ${worstP95}ms (budget ${P95_BUDGET_MS}ms)`);
  console.log(`Worst error rate: ${(worstErrorRate * 100).toFixed(1)}% (budget ${(ERROR_RATE_BUDGET * 100).toFixed(0)}%)`);

  if (worstErrorRate > ERROR_RATE_BUDGET) {
    console.error(`FAIL: error rate exceeds the ${(ERROR_RATE_BUDGET * 100).toFixed(0)}% budget.`);
    process.exitCode = 1;
  } else if (worstP95 > P95_BUDGET_MS) {
    console.error(`FAIL: p95 latency exceeds the ${P95_BUDGET_MS}ms budget.`);
    process.exitCode = 1;
  } else {
    console.log('PASS: within latency and error-rate budgets.');
  }
}

runStressTest().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
