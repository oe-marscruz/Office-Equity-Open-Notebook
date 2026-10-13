const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const distDir = path.join(__dirname, '../dist');
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true, force: true });
}

// Bypass npx by invoking the local tsc binary using node directly
const tscPath = path.join(__dirname, '../node_modules/typescript/bin/tsc');
execSync(`node "${tscPath}"`, { stdio: 'inherit', cwd: path.join(__dirname, '../') });
