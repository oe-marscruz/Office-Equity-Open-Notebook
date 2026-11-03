'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVICES = new Set(['surrealdb', 'api', 'worker']);

function spawnServiceProcess(service, command, args, { cwd, env, logsDir }) {
  if (!SERVICES.has(service)) throw new Error('SERVICE_DIAGNOSTIC_INVALID_SERVICE');
  let fd;
  try {
    fd = fs.openSync(path.join(logsDir, `${service}.lifecycle.jsonl`), 'a', 0o600);
  } catch (_) {
    throw new Error('SERVICE_DIAGNOSTIC_OPEN_FAILED');
  }
  function record(event, exitCode = null) {
    const line = JSON.stringify({
      timestamp_ms: Date.now(), service, event,
      exit_code: Number.isInteger(exitCode) ? exitCode : null,
    });
    try {
      fs.writeSync(fd, `${line}\n`);
    } catch (_) {
      console.error('SERVICE_DIAGNOSTIC_WRITE_FAILED');
    }
    console.log(line);
  }
  function closeLog() {
    try { fs.closeSync(fd); } catch (_) { console.error('SERVICE_DIAGNOSTIC_CLOSE_FAILED'); }
  }
  let child;
  try {
    // Arbitrary record text cannot be made safe by matching known secret formats.
    child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch (_) {
    record('spawn_failed');
    closeLog();
    throw new Error('SERVICE_SPAWN_FAILED');
  }
  child.once('spawn', () => record('started'));
  child.on('error', () => record(child.pid ? 'process_error' : 'spawn_failed'));
  child.once('exit', code => record('exited', code));
  child.once('close', closeLog);
  return child;
}

module.exports = { spawnServiceProcess };
