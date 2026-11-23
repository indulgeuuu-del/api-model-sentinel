'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarize, wilson } = require('../src/stats.cjs');
const { csv, redact, scrub } = require('../src/util.cjs');
test('quality, complete response availability and known usage use distinct denominators', () => {
  const rows = [
    { status: 'pass', responseComplete: true, durationMs: 100, usage: { total: 12 } },
    { status: 'fail', responseComplete: true, durationMs: 900, usage: { total: 18 } },
    { status: 'inconclusive', responseComplete: false, durationMs: 10 },
    { status: 'timeout' },
    { status: 'cancelled' },
  ];
  const s = summarize(rows);
  assert.equal(s.passRate, 0.5);
  assert.equal(s.availability, 0.5);
  assert.equal(s.knownTokens, 30);
  assert.equal(s.unknownUsage, 3);
  assert.equal(s.p95Ms, 900);
  assert.equal(summarize([]).passRate, null);
  assert.equal(summarize([{ status: 'cancelled' }]).availability, null);
});
test('Wilson interval conveys small-sample uncertainty; trend needs both windows', () => {
  assert.equal(wilson(0, 0), null);
  assert.ok(wilson(1, 1).low < 0.3);
  assert.ok(wilson(100, 100).low > 0.96);
  assert.equal(summarize(Array.from({ length: 29 }, () => ({ status: 'pass' }))).trendReady, false);
  const s = summarize(Array.from({ length: 40 }, (_, i) => ({ status: i < 20 ? 'fail' : 'pass' })));
  assert.equal(s.trendReady, true);
  assert.equal(s.recentRate, 0);
  assert.equal(s.baselineRate, 1);
});
test('CSV cells cannot execute spreadsheet formulas and quoting is reversible', () => {
  const text = csv([['=SUM(1,2)', '+1', '-1', '@cmd', 'safe,"quoted"', 'line\nbreak']]);
  assert.ok(text.includes('"\'=SUM(1,2)"'));
  assert.ok(text.includes('"\'+1"'));
  assert.ok(text.includes('safe,""quoted""'));
  assert.ok(text.includes('line\nbreak'));
});
test('secret scrubbing covers exact values, credential fields, bearer values and URL credentials', () => {
  const result = scrub(
    { answer: 'example-private', diagnostic: { api_key: 'any', encrypted_content: 'cipher' } },
    ['example-private'],
  );
  assert.ok(!JSON.stringify(result).includes('example-private'));
  assert.ok(!JSON.stringify(result).includes('cipher'));
  assert.equal(redact('Bearer fixture-token'), 'Bearer [REDACTED]');
  assert.equal(redact('https://a:b@host/path'), 'https://[REDACTED]@host/path');
});
