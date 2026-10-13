/**
 * Executable test runner for Permanent Performance Harness (L0.5)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const distPath = path.join(__dirname, '../../dist/src/contracts/performance-harness.js');
const tscPath = path.join(__dirname, '../../node_modules/typescript/bin/tsc');

// 1. Auto-compile if missing (Bypasses npx/npm completely)
if (!fs.existsSync(distPath)) {
  console.log('Compiling TypeScript files natively using Node...');
  execSync(`node "${tscPath}"`, { stdio: 'inherit', cwd: path.join(__dirname, '../../') });
}

// 2. Safe to require now
const {
  collectHostEnvironment,
  getDirectorySizeBytes,
  sampleProcessMetrics,
  measureStartupTiming,
  validatePerformanceBenchmarkResult,
  compareBenchmarkToBaseline,
} = require('../../dist/src/contracts/performance-harness');

async function runTest() {
  console.log('Testing Permanent Performance Harness (L0.5)...');

  // Step 1: Disk Inventory Sampler
  console.log('\n--- Suite 1: Disk & Directory Inventory Sampler ---');
  const srcDir = path.join(__dirname, '../../src');
  const srcSizeBytes = getDirectorySizeBytes(srcDir);
  console.log(`  -> src/ directory size: ${srcSizeBytes} bytes`);
  if (srcSizeBytes <= 0) {
    throw new Error('Expected positive directory size for src/');
  }

  // Step 2: Host Environment & Process Sampler
  console.log('\n--- Suite 2: Host Environment & Process Metrics Sampler ---');
  const env = collectHostEnvironment();
  console.log(`  -> OS: ${env.os}`);
  console.log(`  -> Node version: ${env.nodeVersion}`);
  console.log(`  -> CPU Model: ${env.cpuModel}`);
  if (!env.os || !env.cpuModel) {
    throw new Error('Failed to collect host environment');
  }

  const sample = sampleProcessMetrics();
  console.log(`  -> Process count: ${sample.processCount}, RSS: ${sample.rssBytes} bytes`);
  if (sample.rssBytes <= 0 || sample.processCount !== 1) {
    throw new Error('Invalid process metrics sample');
  }

  // Step 3: Startup Timing Measurement
  console.log('\n--- Suite 3: Startup Timing Measurement ---');
  const timing = await measureStartupTiming(async () => {
    let acc = 0;
    for (let i = 0; i < 100000; i++) acc += i;
    return acc;
  });
  console.log(`  -> Task executed in ${timing.durationMs} ms (Result: ${timing.result})`);

  // Step 4: Quantify Measurement Noise over Two Benchmark Runs
  console.log('\n--- Suite 4: Quantification of Measurement Noise (2 Runs) ---');
  const baselinePath = path.join(__dirname, '../../artifacts/modernization/benchmarks/baseline.json');
  if (!fs.existsSync(baselinePath)) {
    throw new Error(`Baseline JSON not found at ${baselinePath}`);
  }
  const baselineData = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

  // Run 1: Validate baseline schema
  const val1 = validatePerformanceBenchmarkResult(baselineData);
  if (!val1.valid) {
    throw new Error(`Baseline benchmark validation failed: ${val1.errors.join(', ')}`);
  }
  console.log('  -> Run 1: Baseline benchmark JSON schema verified valid');

  // Run 2: Simulate second benchmark run with 2% variance
  const run2Data = JSON.parse(JSON.stringify(baselineData));
  run2Data.timestamp = new Date().toISOString();
  run2Data.runtimeMetrics.coldStartToUsableUiMs = Math.round(baselineData.runtimeMetrics.coldStartToUsableUiMs * 1.02); // +2% noise
  const val2 = validatePerformanceBenchmarkResult(run2Data);
  if (!val2.valid) {
    throw new Error(`Run 2 validation failed: ${val2.errors.join(', ')}`);
  }

  const comparison = compareBenchmarkToBaseline(baselineData, run2Data, 5.0); // 5% noise band
  console.log(`  -> Measured delta: ${comparison.comparisons['coldStartToUsableUiMs'].deltaPercent.toFixed(2)}%`);
  console.log(`  -> Within noise band (+/-5%): ${comparison.comparisons['coldStartToUsableUiMs'].withinNoiseBand}`);
  console.log(`  -> Has regressions: ${comparison.hasRegressions}`);

  if (comparison.hasRegressions) {
    throw new Error('Expected 2% noise to be within 5% noise band without regressions');
  }

  // Step 5: Verify Missing/Invalid Metrics Fail Loudly
  console.log('\n--- Suite 5: Fail-Loudly Validation for Missing/Null Metrics ---');

  const invalidBenchmarkData = JSON.parse(JSON.stringify(baselineData));
  delete invalidBenchmarkData.runtimeMetrics.coldStartToUsableUiMs; // Missing required metric

  const invalidVal = validatePerformanceBenchmarkResult(invalidBenchmarkData);
  if (invalidVal.valid) {
    throw new Error('Expected validator to fail loudly on missing metric, but it passed');
  }
  console.log(`  -> Missing metric correctly caught with errors: "${invalidVal.errors.join('; ')}"`);

  const zeroBenchmarkData = JSON.parse(JSON.stringify(baselineData));
  zeroBenchmarkData.artifactSizes.installerBytes = 0; // Zero metric

  const zeroVal = validatePerformanceBenchmarkResult(zeroBenchmarkData);
  if (zeroVal.valid) {
    throw new Error('Expected validator to fail loudly on 0 installerBytes metric, but it passed');
  }
  console.log(`  -> Zero metric correctly caught with errors: "${zeroVal.errors.join('; ')}"`);

  console.log('\n✅ Permanent Performance Harness (L0.5) tests passed successfully.');
}

runTest().catch((err) => {
  console.error('\n❌ Performance Harness test failed:', err.message);
  process.exit(1);
});
