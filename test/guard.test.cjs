'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CodexGuard } = require('../src/guard.cjs');
const { stopSnapshot, FramedPipe } = require('../src/desktop-ipc.cjs');
const { deferred } = require('./helpers.cjs');
test('unsupported platform is explicit; demo never opens desktop connections', async () => {
  await assert.rejects(new CodexGuard({ platform: 'linux' }).check(), /仅支持Windows/);
  const demo = new CodexGuard({
    demo: true,
    factory: () => {
      throw Error('must not connect');
    },
  });
  assert.equal((await demo.stop()).demo, true);
  assert.equal((await demo.check()).demo, true);
});
test('snapshot interruption records partial failures without stopping newly observed threads', async () => {
  const stopped = [],
    original = [{ id: 'a' }, { id: 'b' }];
  let reads = 0;
  const result = await stopSnapshot({
    snapshot: async () => (reads++ === 0 ? original : [{ id: 'new' }]),
    stop: async (t) => {
      stopped.push(t.id);
      if (t.id === 'b') throw Error('failed');
    },
  });
  assert.deepEqual(stopped.sort(), ['a', 'b']);
  assert.equal(result.ok, false);
  assert.equal(result.stopped, 1);
  assert.equal(result.remainingActive, 1);
});
test('no active desktop threads is a successful no-op', async () => {
  assert.deepEqual(
    await stopSnapshot({
      snapshot: async () => [],
      stop: async () => {
        throw Error('unexpected');
      },
    }),
    { ok: true, detected: 0, stopped: 0, results: [], remainingActive: 0 },
  );
});
test('concurrent incidents share one stop operation and always close the adapter', async () => {
  const wait = deferred();
  let opens = 0,
    closes = 0,
    reads = 0;
  const guard = new CodexGuard({
    platform: 'win32',
    factory: () => ({
      open: async () => {
        opens++;
        await wait.promise;
      },
      close: () => closes++,
      snapshot: async () => (reads++ === 0 ? [{ id: 'a' }] : []),
      stop: async () => {},
    }),
  });
  const a = guard.stop(),
    b = guard.stop();
  wait.resolve();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual(ra, rb);
  assert.equal(opens, 1);
  assert.equal(closes, 1);
});
test('failed readiness closes even a partially opened adapter', async () => {
  let closed = false;
  const guard = new CodexGuard({
    platform: 'win32',
    factory: () => ({
      open: async () => {
        throw Error('incompatible');
      },
      close: () => {
        closed = true;
      },
    }),
  });
  await assert.rejects(guard.check(), /不可用/);
  assert.ok(closed);
});
test('framed protocol handles fragmented messages and rejects pending calls on closure', async (t) => {
  const net = require('node:net'),
    path = require('node:path'),
    os = require('node:os'),
    crypto = require('node:crypto');
  const addr =
    process.platform === 'win32'
      ? '\\\\.\\pipe\\sentinel-test-' + crypto.randomUUID()
      : path.join(os.tmpdir(), 'sentinel-' + crypto.randomUUID() + '.sock');
  const server = net.createServer((socket) =>
    socket.once('data', (data) => {
      const request = JSON.parse(data.subarray(4)),
        bytes = Buffer.from(JSON.stringify({ id: request.id, result: 'ok' })),
        header = Buffer.alloc(4);
      header.writeUInt32LE(bytes.length);
      socket.write(header.subarray(0, 2));
      socket.write(Buffer.concat([header.subarray(2), bytes]));
    }),
  );
  await new Promise((resolve) => server.listen(addr, resolve));
  const pipe = await new FramedPipe(addr).connect();
  t.after(() => {
    pipe.close();
    server.close();
  });
  assert.equal((await pipe.request({ id: 'one', method: 'read' })).result, 'ok');
  const pending = pipe.request({ id: 'two' });
  pipe.close();
  await assert.rejects(pending, /结束/);
});
