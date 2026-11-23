'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { parse } = require('../bin/sentinel.cjs');
const { Vault } = require('../src/storage.cjs');
const cli = path.resolve(__dirname, '../bin/sentinel.cjs');
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function until(predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error('Timed out waiting for service state');
}
test('CLI arguments reject missing paths and invalid ports', () => {
  assert.equal(parse(['--demo']).port, 17656);
  assert.equal(parse(['status']).command, 'status');
  for (const args of [
    ['--port', '0'],
    ['--port', 'no'],
    ['--data-dir'],
    ['--data-dir', '--open'],
    ['--unknown'],
  ])
    assert.throws(() => parse(args));
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Node.js 22.14/);
  const bad = spawnSync(process.execPath, [cli, '--data-dir'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.ok(!bad.stderr.includes('at parse'));
});
test(
  'supervisor recovers a crashed in-flight worker without replaying its request',
  { timeout: 25000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-recovery-')),
      port = await unusedPort();
    const supervisor = spawn(
      process.execPath,
      [cli, 'supervise', '--demo', '--port', String(port), '--data-dir', dir],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    supervisor.stdout.resume();
    supervisor.stderr.resume();
    const metaFile = path.join(dir, 'instance.json');
    let vault;
    t.after(async () => {
      if (supervisor.exitCode === null) {
        try {
          const state = vault?.load();
          if (state)
            await fetch(`http://127.0.0.1:${port}/api/system/shutdown`, {
              method: 'POST',
              headers: {
                Authorization: 'Bearer ' + state.token,
                'Content-Type': 'application/json',
              },
              body: '{}',
              signal: AbortSignal.timeout(3000),
            });
        } catch {}
        await until(() => supervisor.exitCode !== null, 5000).catch(() => supervisor.kill());
      }
      fs.rmSync(dir, { recursive: true });
    });
    const meta = await until(
      () => fs.existsSync(metaFile) && JSON.parse(fs.readFileSync(metaFile)),
    );
    vault = new Vault(dir);
    const saved = vault.load(),
      p = saved.profiles[0],
      base = `http://127.0.0.1:${port}`;
    const start = await fetch(base + `/api/profiles/${p.id}/start`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + saved.token, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(start.status, 200);
    assert.ok(vault.load().runtimes[p.id].running);
    // Only terminate the worker whose PID was read from this test's new data dir.
    process.kill(meta.pid, 'SIGKILL');
    await until(
      () => fs.existsSync(metaFile) && JSON.parse(fs.readFileSync(metaFile)).pid !== meta.pid,
    );
    const restored = vault.load();
    assert.equal(restored.runtimes[p.id].enabled, true);
    assert.equal(restored.runtimes[p.id].running, null);
    assert.equal(restored.records[0].category, 'interrupted');
    assert.ok(restored.runtimes[p.id].nextRunAt > Date.now() + 50000);
    const exited = once(supervisor, 'exit');
    const response = await fetch(base + '/api/system/shutdown', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + saved.token, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 200);
    await exited;
    assert.equal(supervisor.exitCode, 0);
    assert.ok(!fs.existsSync(path.join(dir, 'supervisor.lock')));
  },
);
test(
  'Windows launcher starts hidden supervision and reuses the existing service',
  { skip: process.platform !== 'win32', timeout: 45000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel launcher-')),
      port = await unusedPort(),
      script = path.resolve(__dirname, '../scripts/start.ps1');
    t.after(async () => {
      spawnSync(process.execPath, [cli, 'stop', '--demo', '--data-dir', dir], {
        encoding: 'utf8',
        timeout: 5000,
      });
      await until(() => !fs.existsSync(path.join(dir, 'supervisor.lock')), 5000);
      fs.rmSync(dir, { recursive: true });
    });
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Demo',
      '-NoOpen',
      '-DataDir',
      dir,
      '-Port',
      String(port),
    ];
    const start = spawnSync('powershell.exe', args, {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    assert.equal(start.status, 0, start.stderr);
    assert.match(start.stdout, /Background service ready/);
    const second = spawnSync('powershell.exe', args, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already running/);
  },
);
test(
  'a real CLI service starts, rejects duplicates, reports status, and shuts down cleanly',
  { timeout: 20000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-cli-'));
    const reserve = net.createServer();
    await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
    const port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    const child = spawn(
      process.execPath,
      [cli, 'serve', '--demo', '--no-url', '--port', String(port), '--data-dir', dir],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let logs = '';
    child.stdout.on('data', (data) => {
      logs += data;
    });
    child.stderr.on('data', (data) => {
      logs += data;
    });
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill();
        await once(child, 'exit');
      }
      fs.rmSync(dir, { recursive: true });
    });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('service never became ready: ' + logs)), 10000);
      child.stdout.on('data', () => {
        if (logs.includes('local service') || logs.includes('DEMO')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(Error('early service exit ' + code + ': ' + logs));
      });
    });
    await ready;
    const common = ['--demo', '--data-dir', dir];
    const duplicate = spawnSync(process.execPath, [cli, 'serve', ...common], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /已有服务/);
    const status = spawnSync(process.execPath, [cli, 'status', ...common], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).profiles.length, 4);
    const state = new Vault(dir).load();
    assert.ok(!logs.includes(state.token));
    assert.ok(!status.stdout.includes(state.token));
    const exited = once(child, 'exit');
    const stop = spawnSync(process.execPath, [cli, 'stop', ...common], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(stop.status, 0, stop.stderr);
    await exited;
    assert.equal(child.exitCode, 0);
    assert.ok(!fs.existsSync(path.join(dir, 'instance.lock')));
    assert.ok(!fs.existsSync(path.join(dir, 'instance.json')));
  },
);
