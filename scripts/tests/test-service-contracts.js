'use strict';

const fs = require('fs');
const path = require('path');

const FIXTURE_PATH = path.join(__dirname, '..', '..', 'tests', 'contracts', 'service-table-cases.json');
const COMPILED_CONTRACT_PATH = path.join(__dirname, '..', '..', 'dist', 'src', 'contracts', 'service-table.js');

function run() {
  console.log('Testing Service Table Contracts...');

  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(`Fixture file missing: ${FIXTURE_PATH}`);
  }

  if (!fs.existsSync(COMPILED_CONTRACT_PATH)) {
    throw new Error(`Compiled contract module missing at ${COMPILED_CONTRACT_PATH}. Run 'npm run build:types' or 'npx tsc' first.`);
  }

  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const { validateServiceTable, validateServiceDefinition, DEFAULT_PORTS, createBackendEnvironment } = require(COMPILED_CONTRACT_PATH);

  // Test 1: Verify default ports match required baseline contract
  console.log('Test 1: DEFAULT_PORTS structure');
  if (DEFAULT_PORTS.surreal !== 8000 || DEFAULT_PORTS.api !== 5055 || DEFAULT_PORTS.frontend !== 8502) {
    throw new Error(`DEFAULT_PORTS mismatch: ${JSON.stringify(DEFAULT_PORTS)}`);
  }
  console.log('  -> Passed');

  // Test 2: Verify valid tables from fixture
  console.log('Test 2: Valid tables from fixture');
  for (const validTable of fixture.validTables) {
    const validated = validateServiceTable(validTable);
    if (validated.services.length !== 3) {
      throw new Error(`Expected 3 services, got ${validated.services.length}`);
    }
  }
  console.log('  -> Passed');

  // Test 3: Verify invalid service definitions fail with expected error
  console.log('Test 3: Invalid service definitions handling');
  for (const item of fixture.invalidDefinitions) {
    let threw = false;
    try {
      validateServiceDefinition(item.input);
    } catch (err) {
      threw = true;
      if (!err.message.includes(item.expectedError)) {
        throw new Error(`Expected error containing "${item.expectedError}", got "${err.message}"`);
      }
    }
    if (!threw) {
      throw new Error(`Expected error for input: ${JSON.stringify(item.input)}`);
    }
  }
  console.log('  -> Passed');

  // Test 4: Verify BackendEnvironment generator
  console.log('Test 4: createBackendEnvironment contract');
  const env = createBackendEnvironment({
    credentials: { user: 'root', password: 'synthetic-test-password' },
    backendPath: '/test/backend',
    dataFolder: '/test/data',
    encryptionKey: 'test-key-123',
    credentials: { user: 'root', password: 'synthetic-contract-password' },
    tiktokenCache: '/test/cache',
    apiPort: 5055,
  });

  const requiredKeys = [
    'PYTHONPATH', 'PYTHONUNBUFFERED', 'PYTHONUTF8', 'DATA_FOLDER',
    'SURREAL_URL', 'SURREAL_USER', 'SURREAL_PASSWORD', 'SURREAL_NAMESPACE',
    'SURREAL_DATABASE', 'OPEN_NOTEBOOK_ENCRYPTION_KEY', 'OPEN_NOTEBOOK_ENABLE_DOCLING',
    'TIKTOKEN_CACHE_DIR', 'API_HOST', 'API_PORT',
  ];

  for (const k of requiredKeys) {
    if (typeof env[k] !== 'string') {
      throw new Error(`Missing or non-string key in BackendEnvironment: ${k}`);
    }
  }
  if (env.OPEN_NOTEBOOK_ENCRYPTION_KEY !== 'test-key-123') {
    throw new Error('Encryption key not properly propagated');
  }
  console.log('  -> Passed');

  console.log('All Service Table Contract tests passed successfully.');
}

run();
