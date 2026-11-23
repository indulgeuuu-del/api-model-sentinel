#!/usr/bin/env node
'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { spawn } = require('node:child_process');
const { Vault, acquireLock, atomicWrite, dpapi } = require('../src/storage.cjs');
const { Engine } = require('../src/engine.cjs');
const { createServer } = require('../src/server.cjs');
const { CodexGuard } = require('../src/guard.cjs');
const { PowerKeeper } = require('../src/power.cjs');
const { demoRunner, seedDemo } = require('../src/demo.cjs');
function parse(argv) {
  const options = {
    command: argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'serve',
    port: 17655,
    open: false,
    demo: false,
    dir: null,
    noUrl: false,
  };
  while (argv.length) {
    const arg = argv.shift();
    if (arg === '--port') {
      options.port = Number(argv.shift());
      if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
        throw Error('Port must be 1–65535');
    } else if (arg === '--data-dir') {
      const value = argv.shift();
      if (!value || value.startsWith('--')) throw Error('--data-dir requires a directory');
      options.dir = path.resolve(value);
    } else if (arg === '--open') options.open = true;
    else if (arg === '--demo') options.demo = true;
    else if (arg === '--no-url') options.noUrl = true;
    else if (arg === '--help' || arg === '-h') options.command = 'help';
    else throw Error('Unknown argument: ' + arg);
  }
  options.dir =
    options.dir ||
    path.join(
      process.platform === 'win32'
        ? process.env.LOCALAPPDATA || os.homedir()
        : path.join(os.homedir(), '.local', 'share'),
      'ApiModelSentinel' + (options.demo ? '-demo' : ''),
    );
  if (options.demo && options.port === 17655) options.port = 17656;
  return options;
}
function openBrowser(url) {
  const commands =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(commands[0], commands[1], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () =>
    console.error('Browser could not be opened. Run the status command for the local address.'),
  );
  child.unref();
}
async function serve(options) {
  const unlock = acquireLock(options.dir);
  let app,
    engine,
    power,
    closing = false;
  try {
    const store = new Vault(options.dir);
    engine = new Engine({
      store,
      guard: new CodexGuard({ demo: options.demo }),
      ...(options.demo ? { runner: demoRunner() } : {}),
    });
    if (options.demo) seedDemo(engine);
    power = options.demo ? null : new PowerKeeper();
    const close = async () => {
      if (closing) return;
      closing = true;
      await engine.close();
      await app.close();
      unlock();
      const file = path.join(options.dir, 'instance.json');
      if (fs.existsSync(file)) fs.unlinkSync(file);
      process.exitCode = 0;
    };
    app = createServer({
      engine,
      guard: engine.guard,
      power,
      demo: options.demo,
      onShutdown: () => void close(),
    });
    const address = await app.listen(options.port);
    atomicWrite(
      path.join(options.dir, 'instance.json'),
      Buffer.from(
        JSON.stringify({
          port: address.port,
          pid: process.pid,
          demo: options.demo,
          startedAt: Date.now(),
        }),
      ),
    );
    const url = `http://127.0.0.1:${address.port}/#token=${engine.state.token}`;
    console.log(
      `API Model Sentinel 1.0.0 · ${options.demo ? 'DEMO (no provider calls)' : 'local service'} · http://127.0.0.1:${address.port}/`,
    );
    if (!options.noUrl) console.log('Private panel URL (keep local): ' + url);
    if (options.open) openBrowser(url);
    engine.on('operationError', (message) => console.error(message));
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
  } catch (e) {
    power?.close();
    if (engine) await engine.close();
    if (app) await app.close();
    unlock();
    throw e;
  }
}
async function command(options) {
  if (options.command === 'help') {
    console.log(
      'Usage: node bin/sentinel.cjs [serve|supervise|status|open|stop|migrate] [--open] [--demo] [--port 17655] [--data-dir PATH]\nRuntime: Node.js 22.14+; no runtime dependencies.\nFor migration: migrate --data-dir DEST (reads legacy Windows background data, imports paused).',
    );
    return;
  }
  if (options.command === 'serve') return serve(options);
  if (options.command === 'supervise') {
    const release = acquireLock(options.dir, 'supervisor.lock');
    let child,
      retryTimer,
      stopping = false,
      failures = 0;
    const start = () => {
      const args = [
        __filename,
        'serve',
        '--data-dir',
        options.dir,
        '--port',
        String(options.port),
        '--no-url',
        ...(options.demo ? ['--demo'] : []),
        ...(options.open && failures === 0 ? ['--open'] : []),
      ];
      child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
      child.once('exit', (code) => {
        if (stopping || code === 0) {
          release();
          return;
        }
        failures++;
        if (failures > 6) {
          console.error(
            'Service repeatedly failed; supervisor stopped. Check diagnostics before restarting.',
          );
          release();
          process.exitCode = 1;
          return;
        }
        retryTimer = setTimeout(start, Math.min(30000, 1000 * 2 ** (failures - 1)));
      });
      child.once('error', (e) => {
        stopping = true;
        console.error('Could not start service: ' + e.message);
        release();
        process.exitCode = 1;
      });
    };
    const stop = () => {
      stopping = true;
      clearTimeout(retryTimer);
      child?.kill('SIGTERM');
      if (!child || child.exitCode !== null) release();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    start();
    return;
  }
  if (options.command === 'migrate') {
    if (process.platform !== 'win32')
      throw Error('Legacy DPAPI import is only available on Windows');
    const source = path.join(process.env.LOCALAPPDATA, 'CodexModelHealthGuard', 'scheduler.dpapi');
    const legacy = JSON.parse(dpapi(fs.readFileSync(source), true).toString('utf8'));
    const release = acquireLock(options.dir);
    let engine;
    try {
      engine = new Engine({ store: new Vault(options.dir), autoPoll: false });
      const profiles = engine.importConfig(legacy);
      console.log(
        `Imported ${profiles.length} profile(s), all paused and Codex protection disabled. Source unchanged.`,
      );
    } finally {
      if (engine) await engine.close();
      release();
    }
    return;
  }
  if (!['status', 'open', 'stop'].includes(options.command))
    throw Error('Unknown command. Use --help');
  const metaFile = path.join(options.dir, 'instance.json');
  if (!fs.existsSync(metaFile))
    throw Error('Service is not running. Use Start.cmd or the serve command first.');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')),
    state = new Vault(options.dir).load();
  if (!Number.isInteger(meta?.port) || meta.port < 1 || meta.port > 65535 || !state?.token)
    throw Error('No running service found');
  const base = `http://127.0.0.1:${meta.port}`;
  const response = await fetch(
    base + (options.command === 'stop' ? '/api/system/shutdown' : '/api/status'),
    {
      method: options.command === 'stop' ? 'POST' : 'GET',
      headers: {
        Authorization: 'Bearer ' + state.token,
        ...(options.command === 'stop' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.command === 'stop' ? '{}' : undefined,
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) throw Error('Local service refused request: ' + response.status);
  const result = await response.json();
  if (options.command === 'open') openBrowser(`${base}/#token=${state.token}`);
  else if (options.command === 'stop') console.log('All monitors and the service stopped.');
  else
    console.log(
      JSON.stringify(
        {
          url: base,
          profiles: result.profiles.map((p) => ({
            name: p.name,
            enabled: p.runtime.enabled,
            nextRunAt: p.runtime.nextRunAt,
            stats: p.stats,
          })),
          power: result.power,
          fatal: result.fatal,
        },
        null,
        2,
      ),
    );
}
if (require.main === module) {
  Promise.resolve()
    .then(() => command(parse(process.argv.slice(2))))
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
}
module.exports = { parse, serve, command };
