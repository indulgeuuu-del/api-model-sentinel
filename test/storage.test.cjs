'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { Vault, atomicWrite, acquireLock, dpapi } = require('../src/storage.cjs');
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return dir;
}
test('vault encrypts data and round-trips with an authenticated previous backup', (t) => {
  const dir = temp(t),
    vault = new Vault(dir, { platform: 'linux' });
  const secret = 'fixture-not-an-api-key';
  vault.save({ secret, version: 1 });
  vault.save({ secret, version: 2 });
  assert.deepEqual(new Vault(dir, { platform: 'linux' }).load(), { secret, version: 2 });
  assert.ok(!fs.readFileSync(vault.file, 'utf8').includes(secret));
  assert.ok(fs.existsSync(vault.file + '.previous'));
  assert.equal(
    fs.readdirSync(dir).some((n) => n.endsWith('.tmp')),
    false,
  );
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(vault.keyFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  }
});
test('corruption and missing keys fail closed without overwriting evidence', (t) => {
  const dir = temp(t),
    v = new Vault(dir, { platform: 'linux' });
  v.save({ marker: 'original' });
  const envelope = JSON.parse(fs.readFileSync(v.file));
  envelope.tag = Buffer.alloc(16).toString('base64');
  fs.writeFileSync(v.file, JSON.stringify(envelope));
  assert.throws(() => v.load(), /损坏/);
  const bytes = fs.readFileSync(v.file);
  fs.unlinkSync(v.keyFile);
  assert.throws(() => new Vault(dir, { platform: 'linux' }), /key is missing/);
  assert.deepEqual(fs.readFileSync(v.file), bytes);
});
test('atomic writes preserve previous data and leave no partial files', (t) => {
  const dir = temp(t),
    file = path.join(dir, 'test');
  atomicWrite(file, Buffer.from('first'));
  atomicWrite(file, Buffer.from('second'), { backup: true });
  assert.equal(fs.readFileSync(file, 'utf8'), 'second');
  assert.equal(fs.readFileSync(file + '.previous', 'utf8'), 'first');
});
test('same data directory cannot run twice and unlocking only removes its own lock', (t) => {
  const dir = temp(t),
    unlock = acquireLock(dir);
  assert.throws(() => acquireLock(dir), /已有服务/);
  unlock();
  const next = acquireLock(dir);
  unlock();
  assert.ok(fs.existsSync(path.join(dir, 'instance.lock')));
  next();
});
test('invalid instance lock is retained for manual diagnosis', (t) => {
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'instance.lock'), 'not-json');
  assert.throws(() => acquireLock(dir), /Invalid/);
  assert.ok(fs.existsSync(path.join(dir, 'instance.lock')));
});
test(
  'Windows DPAPI uses the current user and encrypted master key',
  { skip: process.platform !== 'win32' },
  (t) => {
    const dir = temp(t),
      v = new Vault(dir);
    v.save({ value: 'test' });
    assert.deepEqual(new Vault(dir).load(), { value: 'test' });
    assert.equal(dpapi(dpapi(Buffer.from('roundtrip')), true).toString(), 'roundtrip');
    assert.notEqual(fs.readFileSync(v.keyFile).length, 32);
  },
);
