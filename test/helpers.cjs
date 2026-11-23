'use strict';
const { normalizeProfile } = require('../src/profile.cjs');
const { MemoryStore } = require('../src/storage.cjs');
const { Engine } = require('../src/engine.cjs');
const profile = (extra = {}) =>
  normalizeProfile({
    name: 'test',
    model: 'test-model',
    baseUrl: 'https://api.example.test/v1',
    ...extra,
  });
function record(p, probe, status = 'pass', extra = {}) {
  return {
    profileId: p.id,
    startedAt: Date.now(),
    timestamp: Date.now(),
    durationMs: 12,
    answer: String(status === 'pass' ? probe.expected : 22),
    reason: 'test',
    status,
    category: status === 'fail' ? 'wrong_answer' : status === 'pass' ? 'correct' : status,
    usage: { input: 10, output: 2, total: 12 },
    responseComplete: ['pass', 'fail'].includes(status),
    probe,
    warnings: [],
    ...extra,
  };
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const engine = (extra = {}) =>
  new Engine({
    store: new MemoryStore(),
    autoPoll: false,
    runner: async (p, probe) => record(p, probe),
    ...extra,
  });
const responses = (text = '21', extra = {}) => ({
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    },
  ],
  ...extra,
});
const chat = (text = '21', finish = 'stop', extra = {}) => ({
  choices: [{ message: { role: 'assistant', content: text }, finish_reason: finish }],
  ...extra,
});
module.exports = { profile, record, deferred, engine, responses, chat };
