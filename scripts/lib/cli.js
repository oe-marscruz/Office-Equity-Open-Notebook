'use strict';

/**
 * lib/cli.js — shared argv parsing and child-process runners for the
 * `scripts/` tooling.
 */

const { spawnSync } = require('child_process');

/**
 * Reads a CLI flag as `--name value` or `--name=value`.
 *
 * @param {string} name      Flag name, including the leading dashes.
 * @param {*} def            Value returned when the flag is absent.
 * @param {string[]} [argv]  Argument list; defaults to `process.argv`.
 */
function arg(name, def, argv = process.argv) {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return def;
}

/**
 * Runs a command with inherited stdio, throwing on a non-zero exit code.
 *
 * `npm` is a .cmd shim on Windows. We invoke it as `npm.cmd` directly
 * (without a shell) to avoid the `shell: true` pattern that antivirus
 * software flags. Everything else (uv, python, tar, node, rcedit, makensis)
 * is a real exe and must NOT go through a shell, or arguments like
 * `-r <path>` get mangled.
 *
 * All spawned processes use `windowsHide: true` to prevent console windows
 * from flashing on Windows.
 */
function commandFailed(res, cmd, args) {
  if (res.error) {
    return new Error(`Command failed (${res.error.code}): ${cmd} ${args.join(' ')}`);
  }
  if (res.status !== 0) {
    const why = res.signal ? `signal ${res.signal}` : res.status;
    return new Error(`Command failed (${why}): ${cmd} ${args.join(' ')}`);
  }
  return null;
}

function run(cmd, args, opts = {}) {
  // Resolve npm to npm.cmd on Windows to avoid shell: true.
  // Antivirus software flags shell execution as a common malware pattern.
  const isWindows = process.platform === 'win32';
  const resolvedCmd = isWindows && cmd === 'npm' ? 'npm.cmd' : cmd;
  const shell = opts.shell === true;
  const res = spawnSync(resolvedCmd, args, {
    stdio: 'inherit',
    shell,
    windowsHide: true,
    ...opts,
  });
  const err = commandFailed(res, resolvedCmd, args);
  if (err) throw err;
  return res;
}

/** Runs a command and returns its trimmed stdout, throwing on a non-zero exit code. */
function runCapture(cmd, args, opts = {}) {
  const isWindows = process.platform === 'win32';
  const resolvedCmd = isWindows && cmd === 'npm' ? 'npm.cmd' : cmd;
  const res = spawnSync(resolvedCmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    ...opts,
  });
  const err = commandFailed(res, resolvedCmd, args);
  if (err) throw err;
  return (res.stdout || '').trim();
}

module.exports = { arg, run, runCapture };
