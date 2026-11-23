'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Engine, HISTORY_LIMIT } = require('../src/engine.cjs');
const { MemoryStore } = require('../src/storage.cjs');
const { profile, record, deferred, engine } = require('./helpers.cjs');
const add = (e, extra = {}) => e.saveProfile(profile(extra));
function guard() {
  return {
    checks: 0,
    stops: 0,
    async check() {
      this.checks++;
      return { supported: true };
    },
    async stop() {
      this.stops++;
      return { ok: true, stopped: 2 };
    },
  };
}

for (const status of ['pass', 'timeout', 'error', 'inconclusive', 'cancelled'])
  test(`automatic ${status} continues the original interval and never stops Codex`, async (t) => {
    let now = 100000;
    const g = guard(),
      e = engine({
        now: () => now,
        guard: g,
        runner: async (p, probe) => record(p, probe, status),
      });
    t.after(() => e.close());
    const p = add(e, { guard: true, intervalMin: 3 });
    await e.start(p.id);
    await e.run(p.id, 'automatic');
    assert.equal(e.state.runtimes[p.id].enabled, true);
    assert.equal(e.state.runtimes[p.id].nextRunAt, now + 180000);
    assert.equal(g.stops, 0);
    assert.equal(e.records().length, 1);
  });
test('only a completed automatic wrong answer pauses and invokes explicitly enabled protection', async (t) => {
  const g = guard(),
    e = engine({ guard: g, runner: async (p, probe) => record(p, probe, 'fail') });
  t.after(() => e.close());
  const p = add(e, { guard: true });
  await e.start(p.id);
  await e.run(p.id, 'automatic');
  assert.equal(g.checks, 1);
  assert.equal(g.stops, 1);
  assert.equal(e.state.runtimes[p.id].enabled, false);
  assert.equal(e.state.incidents[0].phase, 'complete');
  assert.match(e.records()[0].guardAction, /2/);
});
test('manual and comparison results never invoke protection', async (t) => {
  const g = guard(),
    e = engine({ guard: g, runner: async (p, probe) => record(p, probe, 'fail') });
  t.after(() => e.close());
  const a = add(e, { guard: true }),
    b = add(e, { guard: true });
  await e.run(a.id);
  const batch = e.compare([a.id, b.id]);
  await Promise.all([...e.jobs.values()].map((j) => j.promise));
  const rows = e.records().filter((r) => r.batchId === batch.batchId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].probe, rows[1].probe);
  assert.equal(g.stops, 0);
  assert.equal(e.state.incidents.length, 0);
});
test('wrong answer with protection off still pauses monitoring', async (t) => {
  const g = guard(),
    e = engine({ guard: g, runner: async (p, probe) => record(p, probe, 'fail') });
  t.after(() => e.close());
  const p = add(e);
  await e.start(p.id);
  await e.run(p.id, 'automatic');
  assert.equal(e.state.runtimes[p.id].enabled, false);
  assert.equal(g.stops, 0);
  assert.equal(e.state.incidents[0].phase, 'recorded');
});
test('cancellation makes a late wrong answer harmless even when runner ignores abort', async (t) => {
  const wait = deferred(),
    g = guard(),
    e = engine({
      guard: g,
      runner: async (p, probe) => {
        await wait.promise;
        return record(p, probe, 'fail');
      },
    });
  t.after(() => e.close());
  const p = add(e, { guard: true });
  await e.start(p.id);
  const run = e.run(p.id, 'automatic');
  e.stop(p.id);
  wait.resolve();
  await run;
  assert.equal(g.stops, 0);
  assert.equal(e.records()[0].status, 'cancelled');
  assert.equal(e.state.runtimes[p.id].nextRunAt, null);
});
test('closing the service suppresses late protection but preserves schedule for restart', async () => {
  const wait = deferred(),
    g = guard(),
    store = new MemoryStore(),
    e = engine({
      store,
      guard: g,
      runner: async (p, probe) => {
        await wait.promise;
        return record(p, probe, 'fail');
      },
    });
  const p = add(e, { guard: true });
  await e.start(p.id);
  e.run(p.id, 'automatic');
  const closed = e.close();
  wait.resolve();
  await closed;
  assert.equal(g.stops, 0);
  assert.equal(store.load().runtimes[p.id].enabled, true);
  assert.equal(store.load().records[0].status, 'cancelled');
});
test('stop during asynchronous readiness cancels start without enabling a monitor', async (t) => {
  const wait = deferred(),
    e = engine({ guard: { check: () => wait.promise } });
  t.after(() => e.close());
  const p = add(e, { guard: true });
  const starting = e.start(p.id);
  e.stop(p.id);
  wait.resolve();
  await assert.rejects(starting, /取消/);
  assert.equal(e.state.runtimes[p.id].enabled, false);
});
test('incompatible guard fails explicitly before starting the monitor', async (t) => {
  const e = engine({
    guard: {
      check: async () => {
        throw Error('incompatible');
      },
    },
  });
  t.after(() => e.close());
  const p = add(e, { guard: true });
  await assert.rejects(e.start(p.id), /incompatible/);
  assert.equal(e.state.runtimes[p.id].enabled, false);
});
test('unconfirmed protection is visible and never silently retried', async (t) => {
  let attempts = 0;
  const e = engine({
    guard: {
      check: async () => {},
      stop: async () => {
        attempts++;
        throw Error('lost connection');
      },
    },
    runner: async (p, probe) => record(p, probe, 'fail'),
  });
  t.after(() => e.close());
  const p = add(e, { guard: true });
  await e.start(p.id);
  await e.run(p.id, 'automatic');
  await e.poll();
  assert.equal(attempts, 1);
  assert.equal(e.state.incidents[0].phase, 'unknown');
  assert.equal(e.state.runtimes[p.id].enabled, false);
});
test('concurrency is bounded; repeated polling does not duplicate in-flight requests', async (t) => {
  const wait = deferred();
  let calls = 0;
  const e = engine({
    runner: async (p, probe) => {
      calls++;
      await wait.promise;
      return record(p, probe);
    },
  });
  t.after(() => e.close());
  const ps = [add(e), add(e), add(e)];
  for (const p of ps) await e.start(p.id);
  await e.poll();
  await e.poll();
  assert.equal(e.jobs.size, 2);
  assert.equal(calls, 2);
  assert.throws(() => e.run(ps[0].id), /已有|暂停/);
  wait.resolve();
  await Promise.all([...e.jobs.values()].map((j) => j.promise));
  await e.poll();
  await Promise.all([...e.jobs.values()].map((j) => j.promise));
  assert.equal(calls, 3);
});
test('elapsed wall time triggers one request without catching up missed intervals', async (t) => {
  let now = 1000,
    calls = 0;
  const e = engine({
    now: () => now,
    runner: async (p, probe) => {
      calls++;
      return record(p, probe);
    },
  });
  t.after(() => e.close());
  const p = add(e);
  await e.start(p.id);
  now += 8 * 3600000;
  await e.poll();
  await Promise.all([...e.jobs.values()].map((j) => j.promise));
  await e.poll();
  assert.equal(calls, 1);
  assert.equal(e.state.runtimes[p.id].nextRunAt, now + 30 * 60000);
});
test('crash recovery records an unknown outcome and waits a full interval without replay', async (t) => {
  const store = new MemoryStore(),
    e = engine({ store });
  const p = add(e);
  await e.start(p.id);
  const state = store.load();
  state.runtimes[p.id].running = { source: 'automatic', probe: { id: 'old' } };
  state.incidents = [{ phase: 'executing' }];
  store.save(state);
  await e.close();
  const restored = engine({ store, now: () => 5000 });
  t.after(() => restored.close());
  assert.equal(restored.state.runtimes[p.id].nextRunAt, 5000 + 1800000);
  assert.equal(restored.records()[0].category, 'interrupted');
  assert.equal(restored.snapshot().profiles[0].stats.total, 1);
  assert.equal(restored.snapshot().profiles[0].stats.unknownUsage, 1);
  assert.equal(restored.state.incidents[0].phase, 'unknown');
});
test('persistence failure prevents provider calls and exposes a fatal status', async (t) => {
  const store = new MemoryStore();
  let calls = 0;
  const e = engine({
    store,
    runner: async () => {
      calls++;
    },
  });
  t.after(() => e.close());
  const p = add(e);
  store.save = () => {
    throw Error('disk full');
  };
  assert.throws(() => e.run(p.id), /保存失败/);
  assert.equal(calls, 0);
  assert.equal(e.jobs.size, 0);
  assert.ok(e.snapshot().fatal);
  await e.poll();
  assert.equal(calls, 0);
});
test('active profiles cannot be edited or deleted; import is atomic and disabled', async (t) => {
  const e = engine();
  t.after(() => e.close());
  const p = add(e);
  await e.start(p.id);
  assert.throws(() => e.saveProfile(profile(), p.id), /停止/);
  assert.throws(() => e.removeProfile(p.id), /停止/);
  assert.throws(() => e.importConfig({ profiles: [profile(), { model: '' }] }));
  assert.equal(e.state.profiles.length, 1);
  e.stop(p.id);
  const imported = e.importConfig({ profile: { ...profile(), guard: true, temperature: '' } });
  assert.equal(imported[0].guard, false);
  assert.equal(e.state.runtimes[imported[0].id].enabled, false);
  assert.ok(!JSON.stringify(e.exportConfig()).includes('apiKey'));
  assert.ok(!JSON.stringify(e.exportConfig()).includes('credentialId'));
  e.removeProfile(p.id);
  assert.equal(e.state.profiles.length, 1);
});
test('comparison preflight does not send a partial batch while readiness is pending', async (t) => {
  const wait = deferred(),
    e = engine({ guard: { check: () => wait.promise } });
  t.after(() => e.close());
  const a = add(e),
    b = add(e, { guard: true });
  const pending = e.start(b.id);
  assert.throws(() => e.compare([a.id, b.id]), /暂停/);
  assert.equal(e.jobs.size, 0);
  e.stop(b.id);
  wait.resolve();
  await assert.rejects(pending);
});
test('rotating comparison results do not contaminate fixed-original statistics', async (t) => {
  const e = engine();
  t.after(() => e.close());
  const a = add(e),
    b = add(e);
  e.compare([a.id, b.id]);
  await Promise.all([...e.jobs.values()].map((j) => j.promise));
  assert.equal(e.records().length, 2);
  for (const p of e.snapshot().profiles) assert.equal(p.stats.scored, 0);
  // Older releases tagged comparison records with the fixed-pack fingerprint.
  const { fingerprint } = require('../src/profile.cjs');
  for (const r of e.state.records) r.configurationId = fingerprint(e.profile(r.profileId));
  for (const p of e.snapshot().profiles) assert.equal(p.stats.scored, 0);
  await e.run(a.id);
  assert.equal(e.snapshot().profiles.find((p) => p.id === a.id).stats.scored, 1);
});
test('statistics are partitioned on settings, group tag and key changes; history remains bounded', async (t) => {
  const e = engine();
  t.after(() => e.close());
  const p = add(e);
  await e.run(p.id);
  assert.equal(e.snapshot().profiles[0].stats.scored, 1);
  e.saveProfile({ ...p, contextTag: 'new-group' }, p.id);
  assert.equal(e.snapshot().profiles[0].stats.scored, 0);
  assert.equal(e.records().length, 1);
  e.state.records = Array.from({ length: HISTORY_LIMIT }, (_, i) => ({
    id: String(i),
    profileId: p.id,
  }));
  await e.run(p.id);
  assert.equal(e.records().length, HISTORY_LIMIT);
});
test('provider/internal exceptions are recorded once and do not disable monitoring', async (t) => {
  const e = engine({
    runner: async () => {
      throw Error('unexpected failure');
    },
  });
  t.after(() => e.close());
  const p = add(e);
  await e.start(p.id);
  await assert.rejects(e.run(p.id, 'automatic'));
  assert.equal(e.records()[0].category, 'internal_error');
  assert.equal(e.snapshot().profiles[0].stats.total, 1);
  assert.equal(e.snapshot().profiles[0].stats.availability, 0);
  assert.equal(e.state.runtimes[p.id].enabled, true);
});
test('invalid stored state is rejected without overwriting it', () => {
  const state = { schemaVersion: 99 };
  const store = new MemoryStore(state);
  assert.throws(() => new Engine({ store, autoPoll: false }), /invalid state/);
  assert.deepEqual(store.load(), state);
});
