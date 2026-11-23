'use strict';
// Experimental compatibility adapter. Derived from the original local project.
// Only local Codex Desktop threads, no process termination or CLI sessions.
const net = require('node:net'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class FramedPipe {
  constructor(pipe) {
    this.pipe = pipe;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
  }
  async connect() {
    await new Promise((resolve, reject) => {
      const socket = (this.socket = net.connect(this.pipe));
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Codex 本地连接超时'));
      }, 3000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
        this.fail(e);
      });
      socket.on('close', () => this.fail(new Error('Codex 本地连接已关闭')));
      socket.on('data', (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32LE(0);
          if (!length || length > 32 * 1024 * 1024) {
            this.close();
            return;
          }
          if (this.buffer.length < length + 4) return;
          let message;
          try {
            message = JSON.parse(this.buffer.subarray(4, length + 4));
          } catch {
            this.close();
            return;
          }
          this.buffer = this.buffer.subarray(length + 4);
          if (message.type === 'client-discovery-request') {
            this.send({
              type: 'client-discovery-response',
              requestId: message.requestId,
              response: { canHandle: false },
            });
          } else {
            const key = message.requestId ?? message.id,
              p = this.pending.get(key);
            if (p) {
              clearTimeout(p.timer);
              this.pending.delete(key);
              p.resolve(message);
            }
          }
        }
      });
    });
    return this;
  }
  fail(error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  send(message) {
    const data = Buffer.from(JSON.stringify(message)),
      head = Buffer.alloc(4);
    head.writeUInt32LE(data.length);
    this.socket.write(Buffer.concat([head, data]));
  }
  request(message, timeout = 20000) {
    const id = message.requestId ?? message.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex 本地请求超时'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(message);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  close() {
    this.fail(new Error('本地连接结束'));
    this.socket?.destroy();
  }
}

function parseTool(result) {
  if (result.error) throw new Error(result.error.message || 'Codex 工具请求失败');
  const r = result.result;
  if (r?.success === false || r?.isError) throw new Error('Codex 未能读取会话状态');
  for (const item of r?.contentItems || r?.content || []) {
    if (typeof item.text === 'string') {
      try {
        return JSON.parse(item.text);
      } catch {
        /* not a structured response */
      }
    }
  }
  throw new Error('Codex 状态格式不兼容，请更新本地连接组件');
}

class DesktopAdapter {
  constructor(home = path.join(os.homedir(), '.codex')) {
    this.home = home;
  }
  async open() {
    const names = fs.readdirSync('\\\\.\\pipe\\');
    const pipes = names.filter((n) => /^codex-app-tools-[a-f0-9-]+$/i.test(n));
    if (pipes.length !== 1)
      throw new Error(
        pipes.length
          ? '检测到多个 Codex 工具服务，无法确定完整会话范围'
          : 'Codex 未打开或桌面工具服务不可用',
      );
    if (!names.includes('codex-ipc'))
      throw new Error('当前Codex Desktop未提供兼容的本机停止接口；监测可用，停止保护不可开启');
    this.native = await new FramedPipe('\\\\.\\pipe\\' + pipes[0]).connect();
    this.ipc = await new FramedPipe('\\\\.\\pipe\\codex-ipc').connect();
    const init = await this.ipc.request({
      type: 'request',
      requestId: crypto.randomUUID(),
      method: 'initialize',
      version: 0,
      params: { clientType: 'model-health-guard' },
    });
    if (init.resultType !== 'success') throw new Error('Codex 桌面连接初始化失败');
    this.clientId = init.result.clientId;
    const ids = this.lockIds();
    this.caller = ids[0] || null;
    return this;
  }
  lockIds() {
    // Loaded local threads hold writer locks. Include them even if absent from Recents.
    let names;
    try {
      names = fs.readdirSync(path.join(this.home, 'thread-writer-locks'));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    return names
      .filter((n) => n.endsWith('.lock') && UUID.test(n.slice(0, -5)))
      .map((n) => n.slice(0, -5));
  }
  async tool(tool, args) {
    return parseTool(
      await this.native.request({
        jsonrpc: '2.0',
        id: crypto.randomUUID(),
        method: 'tools/call',
        params: {
          tool,
          namespace: 'codex_app',
          arguments: args,
          callerSource: 'codex',
          hostId: 'local',
          threadId: this.caller,
          callId: crypto.randomUUID(),
          turnId: 'local-model-health-guard',
        },
      }),
    );
  }
  async snapshot() {
    this.caller = this.lockIds()[0];
    if (!this.caller) return []; // No writer lock means no loaded local Codex turn.
    const result = await this.tool('list_threads', { limit: 50 });
    if (
      result.schemaVersion !== 4 ||
      !Array.isArray(result.threads) ||
      !Array.isArray(result.pinnedThreads)
    )
      throw new Error('Codex 会话目录格式不兼容');
    if ((result.unavailableHosts || []).some((h) => h === 'local' || h?.hostId === 'local'))
      throw new Error('本机会话目录不可用');
    const records = new Map();
    for (const t of [...result.pinnedThreads, ...result.threads]) {
      if (t.kind === 'codex' && t.hostId === 'local' && UUID.test(t.id))
        records.set(t.id, { id: t.id, title: t.title || t.id, status: t.status });
    }
    const missing = this.lockIds().filter((id) => !records.has(id));
    for (const id of missing) {
      const r = await this.tool('read_thread', {
        threadId: id,
        hostId: 'local',
        turnLimit: 1,
        includeOutputs: false,
        maxOutputCharsPerItem: 0,
      });
      if (!r.thread || r.thread.hostId !== 'local') throw new Error('无法核实一个已加载的本机会话');
      records.set(id, {
        id,
        title: r.thread.title || id,
        status: typeof r.thread.status === 'string' ? r.thread.status : r.thread.status?.type,
      });
    }
    for (const r of records.values())
      if (!['active', 'idle', 'notLoaded', 'systemError'].includes(r.status))
        throw new Error('未知的 Codex 会话状态，未执行停止');
    return [...records.values()].filter((t) => t.status === 'active');
  }
  async discover(thread) {
    const r = await this.ipc.request({
      type: 'request',
      requestId: crypto.randomUUID(),
      sourceClientId: this.clientId,
      method: 'thread-owner-discovery',
      version: 1,
      params: { hostId: 'local', conversationId: thread.id },
    });
    if (r.resultType !== 'success') throw new Error('无法连接会话的桌面控制窗口：' + thread.title);
  }
  async stop(thread) {
    // user-stop matches the UI stop button: pause active goal, cancel the turn and descendants.
    const r = await this.ipc.request(
      {
        type: 'request',
        requestId: crypto.randomUUID(),
        sourceClientId: this.clientId,
        method: 'thread-follower-interrupt-turn',
        version: 5,
        hostId: 'local',
        timeoutMs: 20000,
        params: { conversationId: thread.id, mode: 'user-stop' },
      },
      22000,
    );
    if (r.resultType !== 'success' || r.result?.ok !== true)
      throw new Error(r.error || 'Codex 未确认停止');
    if (r.result.goalPauseError)
      throw new Error('回合停止，但目标暂停失败：' + r.result.goalPauseError);
    return r.result;
  }
  close() {
    this.native?.close();
    this.ipc?.close();
  }
}

async function stopSnapshot(adapter) {
  const targets = await adapter.snapshot(),
    results = [];
  // Only target these thread IDs. Desktop user-stop acts on their current turn.
  await Promise.all(
    targets.map(async (t) => {
      try {
        await adapter.stop(t);
        results.push({ id: t.id, title: t.title, requested: true });
      } catch (e) {
        results.push({
          id: t.id,
          title: t.title,
          requested: false,
          error: String(e.message).slice(0, 300),
        });
      }
    }),
  );
  let active = await adapter.snapshot();
  for (let i = 0; i < 5 && active.some((t) => targets.some((x) => x.id === t.id)); i++) {
    await delay(400);
    active = await adapter.snapshot();
  }
  const ids = new Set(active.map((t) => t.id));
  for (const r of results) r.stopped = r.requested && !ids.has(r.id);
  return {
    ok: results.every((r) => r.stopped),
    detected: targets.length,
    stopped: results.filter((r) => r.stopped).length,
    results,
    remainingActive: active.length,
  };
}

module.exports = { FramedPipe, DesktopAdapter, stopSnapshot };
