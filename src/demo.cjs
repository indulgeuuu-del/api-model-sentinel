'use strict';
const { id } = require('./util.cjs');
function demoRunner() {
  return async (profile, probe, { signal } = {}) => {
    const startedAt = Date.now();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 120);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    const mode = profile.model;
    let status = mode === 'demo-wrong' ? 'fail' : mode === 'demo-timeout' ? 'timeout' : 'pass';
    if (signal?.aborted) status = 'cancelled';
    return {
      id: id(),
      profileId: profile.id,
      startedAt,
      timestamp: Date.now(),
      durationMs: Date.now() - startedAt,
      status,
      responseComplete: status === 'pass' || status === 'fail',
      category: status === 'pass' ? 'correct' : status === 'fail' ? 'wrong_answer' : status,
      answer:
        status === 'timeout' || status === 'cancelled'
          ? ''
          : probe.grading === 'json'
            ? JSON.stringify(status === 'fail' ? { values: [], sum: -1 } : probe.expected)
            : String(status === 'fail' ? probe.expected + 1 : probe.expected),
      reason:
        status === 'pass'
          ? '演示：答案正确'
          : status === 'fail'
            ? '演示：完整错误答案'
            : status === 'timeout'
              ? '演示：本次超时'
              : '已取消',
      probe,
      usage:
        status === 'timeout'
          ? null
          : {
              input: 200,
              output: mode === 'demo-overbudget' ? 160 : 8,
              total: mode === 'demo-overbudget' ? 360 : 208,
              reasoning: mode === 'demo-overbudget' ? 152 : 0,
              cached: 0,
            },
      warnings: mode === 'demo-overbudget' ? ['演示：超出请求预算；答案判定不受影响'] : [],
      model: mode,
      modelReported: mode,
      protocol: profile.protocol,
      settings: { outputBudget: profile.outputBudget, reasoningEffort: profile.reasoningEffort },
    };
  };
}
function seedDemo(engine) {
  if (engine.state.profiles.length) return;
  for (const [name, model] of [
    ['示例 · 正常模型', 'demo-pass'],
    ['示例 · 答错模型', 'demo-wrong'],
    ['示例 · 超时模型', 'demo-timeout'],
    ['示例 · 费用告警', 'demo-overbudget'],
  ])
    engine.saveProfile({
      name,
      model,
      baseUrl: 'https://demo.invalid',
      pack: 'original',
      intervalMin: 1,
      guard: false,
      keepAwake: false,
    });
}
module.exports = { demoRunner, seedDemo };
