'use strict';

/**
 * run-services.js — headless CLI to start/stop the bundled Open Notebook
 * services without launching the Electron window. Useful for testing and
 * debugging the runtime.
 *
 * Usage:
 *   node scripts/run-services.js --runtime <path> --data <dir> [--key <key>]
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { startServices } = require('./start-services');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

async function main() {
  const runtime = arg('--runtime', path.join(__dirname, '..', 'resources', 'runtime'));
  const data = arg('--data', path.join(__dirname, '..', 'resources', '.testdata'));
  const key =
    arg('--key', null) ||
    (() => {
      const kf = path.join(data, 'encryption-key.txt');
      if (fs.existsSync(kf)) return fs.readFileSync(kf, 'utf8').trim();
      const k = crypto.randomBytes(32).toString('hex');
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(kf, k);
      return k;
    })();

  console.log('Starting services...');
  const services = await startServices({ runtimePath: runtime, dataDir: data, encryptionKey: key, waitReady: true });
  console.log('All services are up.');
  console.log('  Frontend: http://127.0.0.1:8502');
  console.log('  API:      http://127.0.0.1:5055/docs');
  console.log('  Database: ws://127.0.0.1:8000');
  console.log('Press Ctrl+C to stop.');

  const stop = async () => {
    console.log('Stopping services...');
    await services.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('Failed to start services:', err && err.message);
  process.exit(1);
});
