'use strict';
const { spawn } = require('node:child_process');
class PowerKeeper {
  constructor({ platform = process.platform } = {}) {
    this.platform = platform;
    this.child = null;
    this.desired = false;
    this.state = 'inactive';
    this.failure = null;
  }
  set(enabled) {
    this.desired = enabled;
    if (this.platform !== 'win32') {
      this.state = enabled ? 'unsupported' : 'inactive';
      return;
    }
    if (!enabled) {
      this.child?.stdin.end();
      this.child = null;
      this.state = 'inactive';
      return;
    }
    if (this.child || this.state === 'error') return;
    const code =
      'Add-Type -TypeDefinition \'using System.Runtime.InteropServices; public static class SentinelPower { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }\';try { $r=[SentinelPower]::SetThreadExecutionState([uint32]2147483649);if($r -eq 0){exit 1};[Console]::Out.WriteLine("READY");[Console]::In.ReadLine() | Out-Null } finally { [SentinelPower]::SetThreadExecutionState([uint32]2147483648) | Out-Null }';
    this.state = 'starting';
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(code, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child = child;
    child.stdout.once('data', (chunk) => {
      if (chunk.toString().includes('READY') && this.child === child) this.state = 'active';
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', () => {
      if (this.child === child) {
        this.child = null;
        this.state = 'error';
        this.failure = '无法启动空闲睡眠保护';
      }
    });
    child.once('exit', () => {
      if (this.child === child) {
        this.child = null;
        this.state = this.desired ? 'error' : 'inactive';
        if (this.desired) this.failure = '空闲睡眠保护进程已退出';
      }
    });
  }
  snapshot() {
    return { desired: this.desired, state: this.state, message: this.failure };
  }
  close() {
    this.set(false);
  }
}
module.exports = { PowerKeeper };
