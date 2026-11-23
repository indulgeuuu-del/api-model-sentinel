'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listModels, livePlan, runLive, main } = require('../scripts/live.cjs');
const { record } = require('./helpers.cjs');
const options = {
  baseUrl: 'https://provider.example.test/responses',
  model: 'gpt-6-sol',
  apiKey: 'live-fixture-only-secret',
};
test('live testing is opt-in and bounded without hidden retries or budget increases', async () => {
  let calls = 0;
  const result = await runLive({
    ...options,
    runner: async (p, probe) => {
      calls++;
      assert.equal(p.outputBudget, 16);
      assert.equal(p.reasoningEffort, 'none');
      return record(p, probe);
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.requestedCases, 1);
  assert.equal(result.passed, 1);
  assert.equal(livePlan({ mode: 'matrix', includeChat: true }).length, 7);
});
test('live acceptance stops at credential rejection and scrubs provider echoes', async () => {
  let calls = 0;
  const result = await runLive({
    ...options,
    mode: 'matrix',
    runner: async (p, probe) => {
      calls++;
      return record(p, probe, 'error', {
        reason: p.apiKey,
        diagnostic: { httpStatus: 401, error: { message: p.apiKey } },
      });
    },
  });
  assert.equal(calls, 1);
  assert.match(result.stoppedBecause, /Credential/);
  assert.ok(!JSON.stringify(result).includes(options.apiKey));
});
test('live acceptance stops at a reported total ceiling without changing answer grading', async () => {
  let calls = 0;
  const result = await runLive({
    ...options,
    mode: 'matrix',
    maxReportedTokens: 24,
    runner: async (p, probe) => {
      calls++;
      return record(p, probe);
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.passed, 2);
  assert.equal(result.knownTokens, 24);
  assert.match(result.stoppedBecause, /ceiling/);
});

test('unknown usage halts a paid batch while a final over-budget correct answer still passes', async () => {
  let calls = 0;
  const unknown = await runLive({
    ...options,
    mode: 'matrix',
    runner: async (p, probe) => {
      calls++;
      return record(p, probe, 'pass', { usage: null });
    },
  });
  assert.equal(calls, 1);
  assert.equal(unknown.passed, 1);
  assert.equal(unknown.unknownUsage, 1);
  assert.match(unknown.stoppedBecause, /unknown/);
  const complete = await runLive({
    ...options,
    maxReportedTokens: 1,
    runner: async (p, probe) => record(p, probe),
  });
  assert.equal(complete.passed, complete.requestedCases);
  assert.equal(complete.stoppedBecause, null);
  assert.equal(complete.knownTokens, 12);
});
test('model discovery preserves explicit root path, uses auth, and does not follow redirects', async () => {
  let received;
  const result = await listModels({
    ...options,
    fetchImpl: async (url, init) => {
      received = { url: String(url), init };
      return new Response(JSON.stringify({ data: [{ id: 'gpt-6-sol' }, null] }));
    },
  });
  assert.equal(received.url, 'https://provider.example.test/models');
  assert.equal(received.init.headers.Authorization, 'Bearer ' + options.apiKey);
  assert.equal(received.init.redirect, 'error');
  assert.deepEqual(result.models, ['gpt-6-sol']);
});

test('model discovery rejects an HTTP200 error page and scrubs authentication failures', async () => {
  const invalid = await listModels({
    ...options,
    fetchImpl: async () => new Response('<html>Gateway</html>'),
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'Invalid model list');
  const denied = await listModels({
    ...options,
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: options.apiKey } }), { status: 401 }),
  });
  assert.equal(denied.ok, false);
  assert.ok(!JSON.stringify(denied).includes(options.apiKey));
});
test('invalid or existing report destinations fail before any potentially billed request', async (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-live-')),
    report = path.join(dir, 'existing.local.json');
  fs.writeFileSync(report, '{}');
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Error('Unexpected network call');
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const args = ['--url', options.baseUrl, '--model', options.model, '--output'];
  await assert.rejects(main([...args, path.join(dir, 'not-private.json')]), /filename/);
  await assert.rejects(main([...args, report]), /already exists/);
  assert.equal(calls, 0);
  await assert.rejects(main([...args, path.join(dir, 'missing', 'report.local.json')]), /ENOENT/);
  await assert.rejects(
    main([...args, path.join(dir, 'unused.local.json'), '--chat']),
    /requires --matrix/,
  );
  await assert.rejects(
    main([...args, path.join(dir, 'unused.local.json'), '--effort', 'invalid']),
    /选项/,
  );
  assert.equal(calls, 0);
});

test('CLI reserves the destination and saves each billed response before sending another request', async (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path'),
    http = require('node:http');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-live-progress-')),
    file = path.join(dir, 'result.local.json');
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const savedKey = process.env.SENTINEL_API_KEY,
    savedExitCode = process.exitCode;
  process.env.SENTINEL_API_KEY = options.apiKey;
  t.after(() => {
    if (savedKey === undefined) delete process.env.SENTINEL_API_KEY;
    else process.env.SENTINEL_API_KEY = savedKey;
    process.exitCode = savedExitCode;
  });
  let calls = 0;
  const observed = [];
  const server = http.createServer((req, res) => {
    calls++;
    observed.push(JSON.parse(fs.readFileSync(file, 'utf8')));
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    if (calls === 1)
      res.end(
        JSON.stringify({
          status: 'completed',
          output_text: '21',
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      );
    else {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: options.apiKey } }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await main([
    '--url',
    'http://127.0.0.1:' + server.address().port + '/responses',
    '--model',
    options.model,
    '--matrix',
    '--output',
    file,
  ]);
  assert.equal(calls, 2);
  assert.equal(observed[0].status, 'running');
  assert.equal(observed[0].records.length, 0);
  assert.equal(observed[1].records.length, 1);
  assert.equal(observed[1].records[0].status, 'pass');
  const final = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(final.status, 'stopped');
  assert.equal(final.completedCases, 2);
  assert.equal(final.passed, 1);
  assert.match(final.stoppedBecause, /Credential/);
  assert.ok(!JSON.stringify(final).includes(options.apiKey));
  assert.equal(process.exitCode, 1);
});

test('a report replacement failure stops the paid batch and preserves the preceding complete report', async (t) => {
  const fs = require('node:fs'),
    os = require('node:os'),
    path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-live-storage-')),
    file = path.join(dir, 'result.local.json');
  const originalFetch = globalThis.fetch,
    originalRename = fs.renameSync;
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.renameSync = originalRename;
    fs.rmSync(dir, { recursive: true });
  });
  let requests = 0,
    replacements = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(
      JSON.stringify({
        status: 'completed',
        output_text: '21',
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    );
  };
  fs.renameSync = (source, target) => {
    if (target === file && ++replacements >= 3) throw Error('simulated report storage failure');
    return originalRename(source, target);
  };
  await assert.rejects(
    main(['--url', options.baseUrl, '--model', options.model, '--matrix', '--output', file]),
    /storage failure/,
  );
  assert.equal(requests, 2);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.records.length, 1);
  assert.equal(saved.records[0].status, 'pass');
  assert.deepEqual(fs.readdirSync(dir), ['result.local.json']);
});
