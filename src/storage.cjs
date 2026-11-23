'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { AppError, clone } = require('./util.cjs');
function atomicWrite(file, bytes, { backup = false } = {}) {
  const temp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  let descriptor;
  try {
    descriptor = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (backup && fs.existsSync(file)) {
      const previous = file + '.previous.tmp';
      fs.copyFileSync(file, previous);
      fs.chmodSync(previous, 0o600);
      fs.renameSync(previous, file + '.previous');
    }
    fs.renameSync(temp, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function dpapi(bytes, decrypt = false) {
  const code =
    'Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd());$r=[Security.Cryptography.ProtectedData]::' +
    (decrypt ? 'Unprotect' : 'Protect') +
    '($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($r))';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
    input: bytes.toString('base64'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0 || r.error)
    throw new AppError('Windows 用户加密不可用；没有退回明文存储', 500, 'vault_error');
  return Buffer.from(r.stdout.trim(), 'base64');
}
class Vault {
  constructor(dir, { platform = process.platform } = {}) {
    this.dir = path.resolve(dir);
    this.platform = platform;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.dir).isSymbolicLink())
      throw Error('Data directory cannot be a symbolic link');
    if (platform !== 'win32') fs.chmodSync(this.dir, 0o700);
    this.file = path.join(this.dir, 'state.enc');
    this.keyFile = path.join(this.dir, platform === 'win32' ? 'master.dpapi' : 'master.key');
    if (fs.existsSync(this.file) && !fs.existsSync(this.keyFile))
      throw Error('Encryption key is missing; preserve state.enc and restore its key');
    if (fs.existsSync(this.keyFile))
      this.key =
        platform === 'win32'
          ? dpapi(fs.readFileSync(this.keyFile), true)
          : fs.readFileSync(this.keyFile);
    else {
      this.key = crypto.randomBytes(32);
      atomicWrite(this.keyFile, platform === 'win32' ? dpapi(this.key) : this.key);
    }
    if (this.key.length !== 32) throw Error('Invalid encryption key');
    if (platform !== 'win32') fs.chmodSync(this.keyFile, 0o600);
  }
  seal(value) {
    const iv = crypto.randomBytes(12),
      cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.from(
      JSON.stringify({
        version: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      }),
    );
  }
  load() {
    if (!fs.existsSync(this.file)) return null;
    try {
      const envelope = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (envelope.version !== 1) throw Error('Unsupported envelope');
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(envelope.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(envelope.data, 'base64')),
          decipher.final(),
        ]).toString('utf8'),
      );
    } catch {
      throw new AppError(
        '加密状态损坏或无法解密；原数据保留，请先备份并查看故障排查文档',
        500,
        'state_corrupt',
      );
    }
  }
  save(value) {
    atomicWrite(this.file, this.seal(value), { backup: true });
  }
}
function acquireLock(dir, name = 'instance.lock') {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name),
    nonce = crypto.randomUUID();
  if (fs.existsSync(file)) {
    let previous;
    try {
      previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw Error('Invalid instance lock; inspect it before removal');
    }
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1)
      throw Error('Invalid lock process ID');
    let alive = true;
    try {
      process.kill(previous.pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') alive = false;
      else throw e;
    }
    if (alive)
      throw new AppError(
        '此数据目录已有服务运行，请打开原服务或选择另一个目录',
        409,
        'already_running',
      );
    fs.unlinkSync(file);
  }
  const fd = fs.openSync(file, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
  fs.closeSync(fd);
  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.nonce === nonce) fs.unlinkSync(file);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  };
}
class MemoryStore {
  constructor(initial = null) {
    this.value = clone(initial);
  }
  load() {
    return clone(this.value);
  }
  save(state) {
    this.value = clone(state);
  }
}
module.exports = { Vault, MemoryStore, atomicWrite, acquireLock, dpapi };
