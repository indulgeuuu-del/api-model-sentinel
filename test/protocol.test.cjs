'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { makeProbe } = require('../src/probes.cjs');
const {
  endpoint,
  requestBody,
  fingerprint,
  normalizeProfile,
  publicProfile,
} = require('../src/profile.cjs');
const { classify, decode, usageOf, runProbe, readBody } = require('../src/protocol.cjs');
const { profile, responses, chat } = require('./helpers.cjs');
const probe = makeProbe();
test('endpoint preserves explicit paths and prevents unsafe URL forms', () => {
  for (const [base, protocol, expected] of [
    ['https://a.test', 'responses', 'https://a.test/v1/responses'],
    ['https://a.test/responses', 'responses', 'https://a.test/responses'],
    ['https://a.test/v1/', 'chat', 'https://a.test/v1/chat/completions'],
    ['https://a.test/proxy/chat/completions', 'responses', 'https://a.test/proxy/responses'],
    ['http://127.0.0.1:9000/v1', 'chat', 'http://127.0.0.1:9000/v1/chat/completions'],
  ])
    assert.equal(endpoint(base, protocol), expected);
  for (const bad of [
    'ftp://x',
    'http://remote.test',
    'https://user:pass@a.test',
    'https://a.test?key=secret',
    'https://a.test/#secret',
  ])
    assert.throws(() => endpoint(bad, 'responses'));
});
test('default request uses 16 tokens, no reasoning, no tools, no stored output', () => {
  const p = profile(),
    body = requestBody(p, probe);
  assert.equal(body.max_output_tokens, 16);
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.equal(body.input, probe.prompt);
  assert.equal(body.tools, undefined);
  assert.equal(body.temperature, undefined);
  assert.equal(requestBody(profile({ reasoningEffort: 'default' }), probe).reasoning, undefined);
});
test('Chat parameter selection can be explicitly overridden without retries', () => {
  assert.equal(
    requestBody(profile({ protocol: 'chat', model: 'gpt-5.1' }), probe).max_completion_tokens,
    16,
  );
  assert.equal(requestBody(profile({ protocol: 'chat', model: 'other' }), probe).max_tokens, 16);
  assert.equal(
    requestBody(profile({ protocol: 'chat', model: 'gpt-5', chatTokenField: 'max_tokens' }), probe)
      .max_tokens,
    16,
  );
});
test('credentials stay private and credential/tag/parameter changes separate statistics', () => {
  const p = profile({ apiKey: 'test-secret' });
  assert.equal(publicProfile(p).apiKey, undefined);
  assert.equal(publicProfile(p).credentialId, undefined);
  assert.equal(normalizeProfile({ ...p, apiKey: '' }, p).apiKey, p.apiKey);
  assert.equal(fingerprint(normalizeProfile({ ...p, apiKey: '' }, p)), fingerprint(p));
  assert.notEqual(
    fingerprint(normalizeProfile({ ...p, apiKey: 'other-secret' }, p)),
    fingerprint(p),
  );
  assert.notEqual(fingerprint({ ...p, contextTag: 'a' }), fingerprint(p));
  assert.equal(normalizeProfile({ ...p, clearApiKey: true }, p).apiKey, '');
});
for (const [protocol, wrap] of [
  ['responses', responses],
  ['chat', chat],
]) {
  test(`${protocol}: correct and incorrect completed answers are scored`, () => {
    assert.equal(classify(wrap('21'), protocol, probe).status, 'pass');
    assert.equal(classify(wrap('20'), protocol, probe).status, 'fail');
    assert.equal(classify(wrap('21'), protocol, probe).responseComplete, true);
    assert.equal(classify(wrap(''), protocol, probe).category, 'empty_answer');
  });
  test(`${protocol}: budget metadata never vetoes a correct answer; incomplete wrong answers do not fail`, () => {
    const wrapPartial = (text) =>
      protocol === 'responses' ? responses(text, { status: 'incomplete' }) : chat(text, 'length');
    assert.equal(classify(wrapPartial('21'), protocol, probe).status, 'pass');
    assert.equal(classify(wrapPartial('20'), protocol, probe).status, 'inconclusive');
  });
}
test('pending, reasoning, refusals and protocol mismatches cannot trigger wrong-answer protection', () => {
  assert.equal(
    classify({ status: 'in_progress', output: [] }, 'responses', probe).category,
    'pending',
  );
  assert.equal(
    classify(
      {
        status: 'completed',
        output: [{ type: 'reasoning', summary: [{ type: 'text', text: '20' }] }],
      },
      'responses',
      probe,
    ).category,
    'empty_answer',
  );
  assert.equal(
    classify(
      { output: [{ type: 'message', content: [{ type: 'output_text', text: '20' }] }] },
      'responses',
      probe,
    ).status,
    'inconclusive',
  );
  assert.equal(classify({ error: { message: 'unavailable' } }, 'responses', probe).status, 'error');
  assert.equal(classify(responses(), 'chat', probe).category, 'protocol_mismatch');
  assert.equal(classify(chat(), 'responses', probe).category, 'protocol_mismatch');
  assert.equal(
    classify(
      { choices: [{ message: { content: '21', refusal: 'no' }, finish_reason: 'stop' }] },
      'chat',
      probe,
    ).status,
    'inconclusive',
  );
});
test('SSE requires a terminal event and reconstructs Chat text and usage', () => {
  const line = (data) => 'data: ' + JSON.stringify(data) + '\r\n\r\n';
  const body =
    line({ choices: [{ delta: { role: 'assistant', content: '2' } }] }) +
    line({ choices: [{ delta: { content: '1' }, finish_reason: 'stop' }] }) +
    line({ choices: [], usage: { completion_tokens: 2 } }) +
    'data: [DONE]\r\n\r\n';
  assert.equal(classify(decode(body, 'text/event-stream'), 'chat', probe).status, 'pass');
  assert.equal(usageOf(decode(body)).output, 2);
  assert.equal(
    classify(
      decode(line({ type: 'response.completed', response: responses() })),
      'responses',
      probe,
    ).status,
    'pass',
  );
  assert.throws(() => decode(line({ choices: [{ delta: { content: '21' } }] })), /最终/);
  assert.throws(() => decode('data: nope\n\n'), /SSE/);
  assert.throws(() => decode('[1,2]'));
  assert.deepEqual(decode('data: {"type":"error","message":"bad"}\n\n').error.type, 'error');
});
test('usage handles both APIs, partial data and invalid numbers', () => {
  assert.deepEqual(
    usageOf({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 7,
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    }),
    { input: 10, output: 7, total: 17, reasoning: 5, cached: null },
  );
  assert.equal(usageOf({ usage: { output_tokens: -1, input_tokens: '5' } }), null);
});
test('a real loopback provider receives exactly one request; warnings do not change the result', async (t) => {
  let requests = 0,
    received;
  const server = http.createServer(async (req, res) => {
    requests++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      url: req.url,
      auth: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks)),
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('x-request-id', 'fake-request-1');
    res.end(
      JSON.stringify(
        responses('21', {
          usage: {
            input_tokens: 200,
            output_tokens: 99,
            output_tokens_details: { reasoning_tokens: 80 },
          },
        }),
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const p = profile({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: 'example-test-only-key',
  });
  const result = await runProbe(p, probe);
  assert.equal(requests, 1);
  assert.equal(received.url, '/v1/responses');
  assert.equal(received.auth, 'Bearer example-test-only-key');
  assert.equal(received.body.max_output_tokens, 16);
  assert.equal(result.status, 'pass');
  assert.equal(result.warnings.length, 2);
  assert.equal(result.providerRequestId, 'fake-request-1');
});
test('HTTP failures, malformed responses, secrets and deadlines are handled without retry', async () => {
  const p = profile({ apiKey: 'example-private-value' });
  let calls = 0;
  const error = await runProbe(p, probe, {
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: p.apiKey } }), { status: 503 });
    },
  });
  assert.equal(calls, 1);
  assert.equal(error.status, 'error');
  assert.ok(error.diagnostic.hint);
  assert.ok(!JSON.stringify(error).includes(p.apiKey));
  assert.equal(
    (
      await runProbe(p, probe, {
        fetchImpl: async () => new Response('<html>upstream failed</html>'),
      })
    ).category,
    'invalid_response',
  );
  const waits = async (_url, { signal }) =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }),
    );
  assert.equal((await runProbe(p, probe, { timeoutMs: 10, fetchImpl: waits })).status, 'timeout');
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (
      await runProbe(p, probe, {
        signal: controller.signal,
        fetchImpl: () => {
          throw Error('should not call');
        },
      })
    ).status,
    'cancelled',
  );
});
test('body reader enforces byte limit', async () => {
  await assert.rejects(readBody(new Response('123456'), 5), /上限/);
});
test('provider echoes that contradict requested limits warn without vetoing a correct answer', async () => {
  const result = await runProbe(profile(), probe, {
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          responses('21', {
            reasoning: { effort: 'medium' },
            max_output_tokens: 1000,
            usage: { input_tokens: 2, output_tokens: 2 },
          }),
        ),
      ),
  });
  assert.equal(result.status, 'pass');
  assert.equal(result.diagnostic.reasoningEffort, 'medium');
  assert.equal(result.diagnostic.outputBudget, 1000);
  assert.ok(result.warnings.some((w) => w.includes('none') && w.includes('medium')));
  assert.ok(result.warnings.some((w) => w.includes('16') && w.includes('1000')));
});
