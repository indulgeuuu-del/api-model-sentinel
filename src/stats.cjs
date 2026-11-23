'use strict';
function wilson(passes, total) {
  if (!total) return null;
  const z = 1.96,
    p = passes / total,
    d = 1 + (z * z) / total,
    c = (p + (z * z) / (2 * total)) / d,
    h = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / d;
  return { low: Math.max(0, c - h), high: Math.min(1, c + h) };
}
function summarize(records) {
  const scored = records.filter((r) => ['pass', 'fail'].includes(r.status)),
    passes = scored.filter((r) => r.status === 'pass').length;
  const completed = records.filter((r) => r.responseComplete === true);
  const attempted = records.filter((r) => r.status !== 'cancelled');
  const latency = completed.map((r) => r.durationMs).sort((a, b) => a - b);
  const known = records.filter((r) => r.usage?.total != null);
  const recent = scored.slice(0, 20),
    baseline = scored.slice(20, 100);
  const rate = (rows) =>
    rows.length ? rows.filter((r) => r.status === 'pass').length / rows.length : null;
  return {
    total: records.length,
    scored: scored.length,
    passes,
    failures: scored.length - passes,
    passRate: rate(scored),
    passInterval: wilson(passes, scored.length),
    availability: attempted.length ? completed.length / attempted.length : null,
    p50Ms: latency.length ? latency[Math.floor((latency.length - 1) * 0.5)] : null,
    p95Ms: latency.length ? latency[Math.ceil(latency.length * 0.95) - 1] : null,
    knownTokens: known.reduce((sum, r) => sum + r.usage.total, 0),
    unknownUsage: records.length - known.length,
    recentRate: rate(recent),
    baselineRate: baseline.length >= 10 ? rate(baseline) : null,
    trendReady: recent.length >= 10 && baseline.length >= 10,
    modelReported: [...new Set(records.map((r) => r.modelReported).filter(Boolean))],
  };
}
module.exports = { wilson, summarize };
