'use strict';
const { DesktopAdapter, stopSnapshot } = require('./desktop-ipc.cjs');
const { AppError } = require('./util.cjs');
class CodexGuard {
  constructor({
    factory = () => new DesktopAdapter(),
    platform = process.platform,
    demo = false,
  } = {}) {
    this.factory = factory;
    this.platform = platform;
    this.demo = demo;
    this.pending = null;
  }
  async withAdapter(fn) {
    if (this.platform !== 'win32')
      throw new AppError(
        '本机Codex停止保护仅支持Windows Desktop；监测功能可跨平台使用',
        409,
        'unsupported',
      );
    const adapter = this.factory();
    try {
      await adapter.open();
      return await fn(adapter);
    } finally {
      adapter.close();
    }
  }
  async check() {
    if (this.demo) return { experimental: true, supported: true, demo: true, activeCount: 2 };
    try {
      return await this.withAdapter(async (a) => {
        const active = await a.snapshot();
        await Promise.all(active.map((t) => a.discover(t)));
        return { experimental: true, supported: true, activeCount: active.length };
      });
    } catch (e) {
      throw new AppError('Codex保护不可用：' + e.message, 409, 'guard_unavailable');
    }
  }
  async stop() {
    if (this.demo) return { ok: true, detected: 2, stopped: 2, demo: true };
    if (this.pending) return this.pending;
    this.pending = this.withAdapter((a) => stopSnapshot(a));
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }
}
module.exports = { CodexGuard };
