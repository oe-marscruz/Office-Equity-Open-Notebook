'use strict';

const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { getLogTail } = require('./problem-report');

const IS_WINDOWS = process.platform === 'win32';

/**
 * Pids of services we believe are still running. If the host process dies
 * without a clean shutdown (Electron quit, a crash, Ctrl-C in a terminal),
 * the exit hook below force-kills whatever is left so the ports and the
 * SurrealDB file lock are released for the next launch.
 */
const livePids = new Set();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', reapLivePids);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    process.on(signal, () => {
      reapLivePids();
      process.exit(0);
    });
  }
}

function reapLivePids() {
  for (const pid of [...livePids]) {
    killProcessTree(pid, { force: true });
    livePids.delete(pid);
  }
}

// How long a portless critical service must stay alive to count as "up".
const LIVENESS_SETTLE_MS = 2000;
// How often we poll for process exit / port release.
const EXIT_POLL_MS = 100;
// How long a POSIX service gets to exit after SIGTERM before we force it.
const GRACEFUL_TIMEOUT_MS = 3000;
// How long we wait for a killed process to actually disappear.
const FORCE_TIMEOUT_MS = 3000;

/**
 * Returns whether `pid` is still running. Used to confirm that a shutdown
 * actually finished rather than assuming it did.
 */
function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    if (IS_WINDOWS) {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return new RegExp(`"${pid}"`).test(out);
    }
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Terminates a service and every process it spawned.
 *
 * `child.kill()` only signals the direct child. Our services are launched
 * through wrappers that create grandchildren (uvicorn -> python, the Next.js
 * server -> worker threads), and on Windows those grandchildren survive an
 * Electron exit — leaving ports bound and the SurrealDB file locked, which is
 * what makes the next launch fail with "port already in use".
 *
 * Windows uses `taskkill /PID <pid> /T /F`, which is PID-scoped and walks the
 * tree; it is invoked while the root is still alive, because once the root is
 * gone the tree can no longer be discovered. It never matches by image name.
 */
function killProcessTree(pid, { force = true } = {}) {
  if (!pid) return false;
  if (IS_WINDOWS) {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    const res = spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    return res.status === 0;
  }
  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    try {
      process.kill(pid, signal);
      return true;
    } catch (_) {
      return false;
    }
  }
}

/** Resolves true once `child` has exited, or false if `timeoutMs` elapses first. */
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(value);
    }
    function onExit() {
      finish(true);
    }
    const timer = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), timeoutMs);
    child.once('exit', onExit);
  });
}

/**
 * Confirms a portless critical service survived startup. Services without a
 * readiness port (the background worker) otherwise report success the instant
 * the process is spawned, so a worker that dies immediately leaves the app
 * looking healthy while no document is ever processed.
 */
async function waitForLiveness(service, child, getErrorContext, settleMs) {
  const label = service.label || service.name;
  const start = Date.now();
  while (Date.now() - start < settleMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw createReadinessError(
        `${label} exited with code ${child.exitCode} (signal: ${child.signalCode || 'none'}) immediately after starting, before it was ready to process work.`,
        getErrorContext
      );
    }
    await sleep(EXIT_POLL_MS);
  }
  return true;
}

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const onDone = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => onDone(true));
    socket.once('timeout', () => onDone(false));
    socket.once('error', () => onDone(false));
    socket.connect(port, host);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createReadinessError(summary, getErrorContext) {
  const context = getErrorContext ? getErrorContext() : '';
  const error = new Error(context ? `${summary}\n\n${context}` : summary);
  if (context) {
    error.summary = summary;
    error.logTail = context;
  }
  return error;
}

async function waitForPort(port, timeoutMs = 60000, label = String(port), childProcess = null, getErrorContext = null) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (childProcess && childProcess.exitCode !== null) {
      const exitMsg = `${label} process exited prematurely with code ${childProcess.exitCode} (signal: ${childProcess.signalCode || 'none'}) before port ${port} became ready.`;
      throw createReadinessError(exitMsg, getErrorContext);
    }
    if (await isPortOpen(port)) return true;
    await sleep(500);
  }
  if (childProcess && childProcess.exitCode !== null) {
    const exitMsg = `${label} process exited with code ${childProcess.exitCode} before port ${port} became ready.`;
    throw createReadinessError(exitMsg, getErrorContext);
  }
  const timeoutMsg = `Timed out waiting for ${label} on port ${port} after ${Math.round(timeoutMs / 1000)}s.`;
  throw createReadinessError(timeoutMsg, getErrorContext);
}

async function supervise(table, options = {}) {
  const {
    waitReady = true,
    timeouts = {},
    onCriticalExit,
    env = process.env,
    logsDir = process.cwd(),
  } = options;
  const children = [];
  const processes = [];
  const logStreams = new Map();
  const recentLogs = new Map();
  let stopping = false;
  let stopPromise = null;

  function appendRecentLog(name, line) {
    if (!recentLogs.has(name)) recentLogs.set(name, []);
    const buffer = recentLogs.get(name);
    buffer.push(line);
    if (buffer.length > 25) buffer.shift();
  }

  function getServiceLogTail(name, maxLines = 15) {
    const file = path.join(logsDir, `${name}.log`);
    return getLogTail(file, recentLogs.get(name) || [], maxLines);
  }

  function getLogStream(name) {
    if (!logStreams.has(name)) {
      const stream = fs.createWriteStream(path.join(logsDir, `${name}.log`), { flags: 'a' });
      logStreams.set(name, stream);
    }
    return logStreams.get(name);
  }

  function logLine(name, stream, data) {
    const line = String(data).trimEnd();
    if (!line) return;
    const formatted = `${new Date().toISOString()} [${name}:${stream}] ${line}\n`;
    appendRecentLog(name, formatted.trimEnd());
    getLogStream(name).write(formatted);
    if (stream === 'err') console.error(formatted.trimEnd());
    else console.log(formatted.trimEnd());
  }

  function reportCriticalExit(service, code, signal) {
    const details = {
      name: service.name,
      code,
      signal,
      logFile: path.join(logsDir, `${service.name}.log`),
    };
    if (onCriticalExit) {
      try {
        onCriticalExit(details);
      } catch (error) {
        console.error(`[${service.name}] critical-exit handler failed: ${error.message}`);
      }
    } else {
      console.error(`CRITICAL: ${service.name} exited unexpectedly. Check ${details.logFile}`);
    }
  }

  function spawnService(service) {
    const child = spawn(service.cmd, service.args, {
      cwd: service.cwd || process.cwd(),
      env: service.env || env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // A new process group lets us signal the whole tree on POSIX.
      detached: !IS_WINDOWS,
    });
    // Record the pid immediately: killProcessTree must run while the root is
    // still alive, and the pid stays valid after the root itself has exited.
    processes.push({ child, pid: child.pid, service });
    if (child.pid) livePids.add(child.pid);
    child.on('exit', () => {
      if (child.pid) livePids.delete(child.pid);
      // The root exiting does not prove the tree is gone; the reaper clears
      // the rest during shutdown.
    });
    child.stdout.on('data', (data) => logLine(service.name, 'out', data));
    child.stderr.on('data', (data) => logLine(service.name, 'err', data));
    child.on('error', (error) => console.error(`[${service.name}] spawn error: ${error.message}`));
    child.on('exit', (code, signal) => {
      logLine(service.name, 'out', `[${service.name}] exited (code=${code}, signal=${signal})`);
      // Any exit we did not initiate means the service is gone: the app's
      // primary workflows (ingestion, search, chat) all run through these
      // processes, so surface it even when the exit code is 0 (a worker that
      // quits cleanly is just as broken as one that crashes).
      if (service.critical && !stopping) {
        reportCriticalExit(service, code, signal);
      }
    });
    children.push(child);
    return child;
  }

  /**
   * Stops every service and everything it spawned, then verifies the result.
   * Idempotent: concurrent and repeated calls share one in-flight shutdown.
   */
  function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      stopping = true;
      const survivors = [];

      // Ask politely first so services can flush state and release file locks.
      for (const entry of [...processes].reverse()) {
        if (!entry.pid) continue;
        const exited = await waitForExit(entry.child, 0);
        if (exited) continue;
        if (IS_WINDOWS) continue;
        try {
          entry.child.kill('SIGTERM');
        } catch (_) {
          // Fall through to the forced tree kill below.
        }
      }

      if (!IS_WINDOWS) {
        await Promise.all(
          processes.map((entry) => waitForExit(entry.child, GRACEFUL_TIMEOUT_MS))
        );
      }

      // Force the whole tree. On Windows taskkill /T is the only reliable way
      // to reach grandchildren; elsewhere signal the group.
      for (const entry of processes) {
        if (!entry.pid) continue;
        const exited = entry.child.exitCode !== null || entry.child.signalCode !== null;
        if (exited && !isProcessAlive(entry.pid)) continue;
        killProcessTree(entry.pid, { force: true });
      }

      const deadline = Date.now() + FORCE_TIMEOUT_MS;
      let pending = processes.filter((entry) => entry.pid);
      while (pending.length && Date.now() < deadline) {
        pending = pending.filter((entry) => {
          const exited = entry.child.exitCode !== null || entry.child.signalCode !== null;
          if (exited && !isProcessAlive(entry.pid)) return false;
          killProcessTree(entry.pid, { force: true });
          return true;
        });
        if (pending.length) await sleep(EXIT_POLL_MS);
      }

      for (const stream of logStreams.values()) {
        try {
          stream.end();
        } catch (_) {
          // Best-effort stream cleanup.
        }
      }

      // Never claim success we did not observe: leftover processes hold ports
      // and the SurrealDB file lock, which breaks the next launch.
      for (const entry of pending) {
        const name = entry.service.name;
        console.error(`WARNING: ${name} (pid ${entry.pid}) survived shutdown and may still hold its port.`);
        survivors.push({ name, pid: entry.pid });
      }
      if (survivors.length) {
        stopPromise = null;
        stopping = false;
      }
      return { survivors };
    })();
    return stopPromise;
  }

  const ports = {};
  try {
    for (const service of table) {
      const child = spawnService(service);
      if (service.readyPort !== null && service.readyPort !== undefined) {
        ports[service.portKey || service.name] = service.readyPort;
        if (service.readiness !== 'optional' || waitReady !== false) {
          const timeoutMs = Object.prototype.hasOwnProperty.call(timeouts, service.timeoutKey)
            ? timeouts[service.timeoutKey]
            : service.timeoutMs;
          await waitForPort(
            service.readyPort,
            timeoutMs,
            service.label || service.name,
            child,
            () => getServiceLogTail(service.name)
          );
        }
      } else if (service.critical) {
        // No readiness port to poll, so confirm the process is still alive
        // rather than assuming a successful spawn means a working service.
        await waitForLiveness(
          service,
          child,
          () => getServiceLogTail(service.name),
          service.settleMs || LIVENESS_SETTLE_MS
        );
      }
    }
    return { children, processes, ports, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

module.exports = {
  supervise,
  isPortOpen,
  sleep,
  waitForPort,
  isProcessAlive,
  killProcessTree,
  waitForExit,
  waitForLiveness,
};
