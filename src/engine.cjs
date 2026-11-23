'use strict';
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { AppError, id, clone, scrub, redact } = require('./util.cjs');
const { normalizeProfile, publicProfile, fingerprint } = require('./profile.cjs');
const { makeProbe } = require('./probes.cjs');
const { runProbe } = require('./protocol.cjs');
const { summarize } = require('./stats.cjs');
const HISTORY_LIMIT = 1000,
  PROFILE_LIMIT = 20;
const effectivePack = (profile, source) => (source === 'comparison' ? 'rotating' : profile.pack);
const recordFingerprint = (profile, source) =>
  fingerprint({ ...profile, pack: effectivePack(profile, source) });
const freshRuntime = () => ({
  enabled: false,
  nextRunAt: null,
  running: null,
  sequence: 0,
  lastReason: '尚未开启自动检测',
});
class Engine extends EventEmitter {
  constructor({
    store,
    runner = runProbe,
    guard = null,
    now = Date.now,
    maxConcurrent = 2,
    autoPoll = true,
  } = {}) {
    super();
    this.store = store;
    this.runner = runner;
    this.guard = guard;
    this.now = now;
    this.maxConcurrent = maxConcurrent;
    this.jobs = new Map();
    this.starting = new Set();
    this.fatal = null;
    this.closing = false;
    const saved = store.load();
    this.state = saved || {
      schemaVersion: 1,
      revision: 0,
      profiles: [],
      runtimes: {},
      records: [],
      incidents: [],
      token: crypto.randomBytes(32).toString('hex'),
    };
    this.validateState();
    let recovered = false;
    for (const profile of this.state.profiles) {
      const runtime = this.state.runtimes[profile.id];
      if (runtime.running) {
        this.state.records.unshift({
          id: id(),
          profileId: profile.id,
          status: 'inconclusive',
          category: 'interrupted',
          source: runtime.running.source,
          configurationId: recordFingerprint(profile, runtime.running.source),
          probePack: effectivePack(profile, runtime.running.source),
          model: profile.model,
          protocol: profile.protocol,
          responseComplete: false,
          timestamp: now(),
          durationMs: 0,
          answer: '',
          reason: '服务在请求期间中断，结果未知；未重发原请求',
          usage: null,
          warnings: [],
          probe: runtime.running.probe,
        });
        runtime.running = null;
        if (runtime.enabled) runtime.nextRunAt = now() + profile.intervalMin * 60000;
        runtime.lastReason = '中断后恢复，等待完整间隔';
        recovered = true;
      }
    }
    for (const incident of this.state.incidents)
      if (incident.phase === 'executing') {
        incident.phase = 'unknown';
        incident.message = '服务在保护操作期间中断；没有自动重试';
        recovered = true;
      }
    this.state.records = this.state.records.slice(0, HISTORY_LIMIT);
    if (!saved || recovered) this.commit();
    if (autoPoll) {
      this.poller = setInterval(
        () =>
          void this.poll().catch((e) =>
            this.emit('operationError', redact(e.message, this.secrets())),
          ),
        1000,
      );
      this.poller.unref();
    }
  }
  validateState() {
    const s = this.state;
    if (
      s.schemaVersion !== 1 ||
      !Array.isArray(s.profiles) ||
      s.profiles.length > PROFILE_LIMIT ||
      !Array.isArray(s.records) ||
      !Array.isArray(s.incidents) ||
      !s.runtimes ||
      typeof s.runtimes !== 'object' ||
      !/^[a-f0-9]{64}$/.test(s.token)
    )
      throw Error('Unsupported or invalid state; keep a backup before migration');
    const ids = new Set();
    for (const p of s.profiles) {
      if (
        typeof p.id !== 'string' ||
        !p.id ||
        ids.has(p.id) ||
        !s.runtimes[p.id] ||
        typeof s.runtimes[p.id].enabled !== 'boolean'
      )
        throw Error('Invalid profile state');
      Object.assign(p, normalizeProfile(p, p));
      ids.add(p.id);
      const r = s.runtimes[p.id];
      if (r.enabled && r.nextRunAt !== null && (!Number.isFinite(r.nextRunAt) || r.nextRunAt < 0))
        throw Error('Invalid schedule');
    }
  }
  secrets() {
    return [this.state.token, ...this.state.profiles.map((p) => p.apiKey)].filter(Boolean);
  }
  commit() {
    this.state.revision++;
    try {
      this.store.save(this.state);
    } catch (e) {
      this.fatal = '状态保存失败，所有检测已暂停：' + redact(e.message, this.secrets());
      for (const r of Object.values(this.state.runtimes)) {
        r.enabled = false;
        r.nextRunAt = null;
        r.lastReason = this.fatal;
      }
      this.emit('change');
      throw new AppError(this.fatal, 503, 'storage_failed');
    }
    this.emit('change');
  }
  ensureWritable() {
    if (this.closing) throw new AppError('服务正在停止', 503);
    if (this.fatal) throw new AppError(this.fatal, 503, 'storage_failed');
  }
  profile(profileId) {
    const p = this.state.profiles.find((p) => p.id === profileId);
    if (!p) throw new AppError('配置不存在', 404, 'not_found');
    return p;
  }
  snapshot() {
    const profiles = this.state.profiles.map((p) => {
      const records = this.state.records.filter(
        (r) =>
          r.profileId === p.id &&
          r.configurationId === fingerprint(p) &&
          (p.pack !== 'original' || r.source !== 'comparison'),
      );
      return {
        ...publicProfile(p),
        configurationId: fingerprint(p),
        runtime: clone(this.state.runtimes[p.id]),
        stats: summarize(records),
        familyStats: Object.fromEntries(
          [...new Set(records.map((r) => r.probe?.family).filter(Boolean))].map((f) => [
            f,
            summarize(records.filter((r) => r.probe?.family === f)),
          ]),
        ),
      };
    });
    return scrub(
      {
        version: 1,
        revision: this.state.revision,
        serverTime: this.now(),
        profiles,
        incidents: this.state.incidents.slice(0, 100),
        fatal: this.fatal,
        activeRequests: this.jobs.size,
        maxConcurrent: this.maxConcurrent,
        historyLimit: HISTORY_LIMIT,
      },
      this.secrets(),
    );
  }
  records(profileId = null) {
    if (profileId) this.profile(profileId);
    return scrub(
      this.state.records.filter((r) => !profileId || r.profileId === profileId),
      this.secrets(),
    );
  }
  saveProfile(input, profileId = null) {
    this.ensureWritable();
    const previous = profileId ? this.profile(profileId) : null;
    if (
      previous &&
      (this.state.runtimes[profileId].enabled ||
        this.jobs.has(profileId) ||
        this.starting.has(profileId))
    )
      throw new AppError('先停止检测，再修改配置', 409);
    if (!previous && this.state.profiles.length >= PROFILE_LIMIT)
      throw new AppError('最多保存20个配置', 409);
    const profile = normalizeProfile(input, previous);
    const before = clone(this.state);
    if (previous)
      this.state.profiles = this.state.profiles.map((p) => (p.id === profileId ? profile : p));
    else {
      this.state.profiles.push(profile);
      this.state.runtimes[profile.id] = freshRuntime();
    }
    try {
      this.commit();
    } catch (e) {
      this.state = before;
      for (const r of Object.values(this.state.runtimes)) {
        r.enabled = false;
        r.nextRunAt = null;
      }
      throw e;
    }
    return publicProfile(profile);
  }
  removeProfile(profileId) {
    this.ensureWritable();
    this.profile(profileId);
    if (
      this.jobs.has(profileId) ||
      this.state.runtimes[profileId].enabled ||
      this.starting.has(profileId)
    )
      throw new AppError('先停止检测再删除配置', 409);
    this.state.profiles = this.state.profiles.filter((p) => p.id !== profileId);
    delete this.state.runtimes[profileId];
    this.state.records = this.state.records.filter((r) => r.profileId !== profileId);
    this.state.incidents = this.state.incidents.filter((r) => r.profileId !== profileId);
    this.commit();
  }
  async start(profileId) {
    this.ensureWritable();
    const profile = this.profile(profileId),
      r = this.state.runtimes[profileId];
    if (r.enabled) return;
    if (this.jobs.has(profileId) || this.starting.has(profileId))
      throw new AppError('配置正在执行操作，请稍后', 409);
    const marker = { cancelled: false };
    this.starting.add(profileId);
    this.startMarkers ??= new Map();
    this.startMarkers.set(profileId, marker);
    try {
      if (profile.guard) {
        if (!this.guard) throw new AppError('本机保护适配器不可用', 409);
        await this.guard.check();
      }
      this.ensureWritable();
      if (marker.cancelled) throw new AppError('启动已取消', 409);
      r.enabled = true;
      r.nextRunAt = this.now();
      r.lastReason = '后台自动检测已开启';
      this.commit();
    } finally {
      this.starting.delete(profileId);
      this.startMarkers.delete(profileId);
    }
  }
  stop(profileId) {
    this.ensureWritable();
    this.profile(profileId);
    const marker = this.startMarkers?.get(profileId);
    if (marker) marker.cancelled = true;
    const r = this.state.runtimes[profileId];
    r.enabled = false;
    r.nextRunAt = null;
    r.lastReason = '已手动停止';
    this.jobs.get(profileId)?.controller.abort();
    this.commit();
  }
  stopAll() {
    for (const p of this.state.profiles) {
      const marker = this.startMarkers?.get(p.id);
      if (marker) marker.cancelled = true;
      const r = this.state.runtimes[p.id];
      r.enabled = false;
      r.nextRunAt = null;
      r.lastReason = '已停止所有检测';
      this.jobs.get(p.id)?.controller.abort();
    }
    this.commit();
  }
  async poll() {
    if (this.fatal || this.closing) return;
    const due = this.state.profiles
      .filter((p) => {
        const r = this.state.runtimes[p.id];
        return r.enabled && !this.jobs.has(p.id) && r.nextRunAt <= this.now();
      })
      .sort((a, b) => this.state.runtimes[a.id].nextRunAt - this.state.runtimes[b.id].nextRunAt);
    for (const p of due) {
      if (this.jobs.size >= this.maxConcurrent) break;
      this.run(p.id, 'automatic').catch((e) =>
        this.emit('operationError', redact(e.message, this.secrets())),
      );
    }
  }
  run(profileId, source = 'manual', probeOverride = null, batchId = null) {
    this.ensureWritable();
    const profile = this.profile(profileId),
      runtime = this.state.runtimes[profileId];
    if (!['manual', 'automatic', 'comparison'].includes(source)) throw new AppError('请求来源无效');
    if (this.jobs.has(profileId) || this.starting.has(profileId))
      throw new AppError('此配置已有请求执行中', 409, 'busy');
    if (source !== 'automatic' && runtime.enabled)
      throw new AppError('先暂停自动检测，再手动执行', 409, 'busy');
    if (source === 'automatic' && !runtime.enabled) throw new AppError('自动检测尚未开启', 409);
    if (this.jobs.size >= this.maxConcurrent)
      throw new AppError('已有两个请求执行中，请稍后', 409, 'busy');
    const probe = probeOverride || makeProbe(profile.pack, runtime.sequence),
      controller = new AbortController(),
      runId = id();
    const job = { controller, runId, promise: null, batchId };
    this.jobs.set(profileId, job);
    runtime.running = {
      id: runId,
      source,
      startedAt: this.now(),
      scheduledAt: runtime.nextRunAt,
      probe,
    };
    runtime.nextRunAt = null;
    try {
      this.commit();
    } catch (e) {
      this.jobs.delete(profileId);
      runtime.running = null;
      throw e;
    }
    job.promise = this.execute(profile, runtime, job, source, probe);
    return job.promise;
  }
  async execute(profile, runtime, job, source, probe) {
    let record;
    try {
      record = await this.runner(profile, probe, { signal: job.controller.signal });
      // A provider may finish after cancellation. Never act on that late answer.
      if (job.controller.signal.aborted || this.closing) {
        record = {
          ...record,
          status: 'cancelled',
          category: 'cancelled',
          reason: '已取消本地等待；远端请求可能仍产生费用',
        };
      }
      record = scrub(
        {
          ...record,
          id: job.runId,
          profileId: profile.id,
          source,
          batchId: job.batchId,
          configurationId: recordFingerprint(profile, source),
          probePack: effectivePack(profile, source),
          scheduledAt: runtime.running?.scheduledAt ?? null,
          schedulingDelayMs:
            runtime.running?.scheduledAt == null
              ? null
              : Math.max(0, (record.startedAt || this.now()) - runtime.running.scheduledAt),
        },
        this.secrets(),
      );
      this.state.records.unshift(record);
      this.state.records = this.state.records.slice(0, HISTORY_LIMIT);
      runtime.sequence++;
      runtime.lastReason = record.reason;
      if (
        source === 'automatic' &&
        runtime.enabled &&
        record.status === 'fail' &&
        record.category === 'wrong_answer'
      ) {
        runtime.enabled = false;
        runtime.nextRunAt = null;
        runtime.lastReason = '完整错误答案，已暂停检测';
        const incident = {
          id: id(),
          profileId: profile.id,
          recordId: record.id,
          timestamp: this.now(),
          phase: profile.guard ? 'executing' : 'recorded',
          message: profile.guard ? '正在请求停止本机活动会话' : '已暂停检测；未启用本机停止保护',
        };
        this.state.incidents.unshift(incident);
        this.state.incidents = this.state.incidents.slice(0, 100);
        try {
          this.commit();
        } catch {
          /* An already verified wrong answer still executes its authorized protection. */
        }
        if (profile.guard) {
          try {
            const action = await this.guard.stop();
            incident.phase = action.ok ? 'complete' : 'partial';
            incident.action = scrub(action, this.secrets());
            incident.message = action.ok
              ? `已确认停止 ${action.stopped} 个本机会话`
              : '部分停止未确认，请检查Codex';
          } catch (e) {
            incident.phase = 'unknown';
            incident.message = '停止未确认：' + redact(e.message, this.secrets());
          }
        }
        record.guardAction = incident.message;
      }
      return record;
    } catch (e) {
      if (!record) {
        runtime.lastReason = '本次执行异常：' + redact(e.message, this.secrets());
        this.state.records.unshift({
          id: job.runId,
          profileId: profile.id,
          source,
          timestamp: this.now(),
          durationMs: 0,
          status: 'error',
          category: 'internal_error',
          configurationId: recordFingerprint(profile, source),
          probePack: effectivePack(profile, source),
          model: profile.model,
          protocol: profile.protocol,
          responseComplete: false,
          reason: runtime.lastReason,
          answer: '',
          usage: null,
          probe,
          warnings: [],
        });
        this.state.records = this.state.records.slice(0, HISTORY_LIMIT);
      }
      throw e;
    } finally {
      runtime.running = null;
      this.jobs.delete(profile.id);
      runtime.nextRunAt =
        runtime.enabled && !this.fatal ? this.now() + profile.intervalMin * 60000 : null;
      try {
        this.commit();
      } catch {
        /* commit exposes a persistent fatal banner and disables all schedules */
      }
    }
  }
  compare(profileIds) {
    this.ensureWritable();
    if (
      !Array.isArray(profileIds) ||
      profileIds.length < 2 ||
      profileIds.length > this.maxConcurrent ||
      new Set(profileIds).size !== profileIds.length
    )
      throw new AppError('选择两个不同配置进行同题比较');
    for (const profileId of profileIds) {
      this.profile(profileId);
      if (
        this.jobs.has(profileId) ||
        this.starting.has(profileId) ||
        this.state.runtimes[profileId].enabled
      )
        throw new AppError('先暂停所选配置的检测', 409);
    }
    if (this.jobs.size + profileIds.length > this.maxConcurrent)
      throw new AppError('请求并发已满', 409);
    const probe = makeProbe('rotating', 0),
      batchId = id();
    const promises = profileIds.map((profileId) =>
      this.run(profileId, 'comparison', probe, batchId),
    );
    for (const promise of promises)
      promise.catch((e) => this.emit('operationError', redact(e.message, this.secrets())));
    return { batchId, profileIds, probe };
  }
  exportConfig() {
    return {
      schemaVersion: 1,
      profiles: this.state.profiles.map((p) => {
        const { id: profileId, hasApiKey, ...rest } = publicProfile(p);
        return rest;
      }),
    };
  }
  importConfig(input) {
    this.ensureWritable();
    const list = Array.isArray(input?.profiles)
      ? input.profiles
      : input?.profile
        ? [input.profile]
        : null;
    if (!list || list.length < 1 || list.length + this.state.profiles.length > PROFILE_LIMIT)
      throw new AppError('导入需要1至20个配置，且合计不超过20个');
    const profiles = list.map((p) =>
      normalizeProfile({
        ...p,
        temperature: p.temperature === '' ? null : p.temperature,
        guard: false,
        keepAwake: p.keepAwake ?? true,
      }),
    );
    for (const p of profiles) {
      this.state.profiles.push(p);
      this.state.runtimes[p.id] = freshRuntime();
    }
    this.commit();
    return profiles.map(publicProfile);
  }
  async close() {
    this.closing = true;
    clearInterval(this.poller);
    for (const marker of this.startMarkers?.values() || []) marker.cancelled = true;
    const jobs = [...this.jobs.values()];
    for (const job of jobs) job.controller.abort();
    await Promise.allSettled(jobs.map((job) => job.promise));
    this.removeAllListeners();
  }
}
module.exports = { Engine, HISTORY_LIMIT, PROFILE_LIMIT, freshRuntime };
