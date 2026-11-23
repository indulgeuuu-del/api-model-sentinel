'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../src/server.cjs');
const { engine, profile, record } = require('./helpers.cjs');
async function fixture(t, extra = {}) {
  const e = engine(extra),
    guard = { check: async () => ({ supported: true, demo: true }) },
    app = createServer({ engine: e, guard });
  const address = await app.listen(0),
    base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await e.close();
    await app.close();
  });
  const request = (route, body, method = body ? 'POST' : 'GET', headers = {}) =>
    fetch(base + route, {
      method,
      headers: {
        Authorization: 'Bearer ' + e.state.token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { e, app, base, request };
}
test('health/assets have security headers, API requires a connection code', async (t) => {
  const { base, request } = await fixture(t);
  const health = await fetch(base + '/health');
  assert.equal((await health.json()).service, 'api-model-sentinel');
  const asset = await fetch(base + '/');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.ok((await asset.text()).includes('API 模型哨兵'));
  assert.equal((await fetch(base + '/api/status')).status, 401);
  assert.equal(
    (await request('/api/status', null, 'GET', { Origin: 'https://hostile.example' })).status,
    403,
  );
  assert.equal(
    (await request('/api/status', null, 'GET', { 'sec-fetch-site': 'cross-site' })).status,
    403,
  );
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get(base + '/health', { headers: { Host: 'rebind.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(hostStatus, 403);
});
test('configuration CRUD, manual runs and exports never expose provider credentials', async (t) => {
  const { request, e } = await fixture(t);
  const secret = 'fixture-private-credential';
  const created = await request(
    '/api/profiles',
    profile({ apiKey: secret, name: '=HYPERLINK("fake")' }),
  );
  assert.equal(created.status, 201);
  const p = (await created.json()).profile;
  assert.equal(p.apiKey, undefined);
  assert.equal(p.hasApiKey, true);
  const run = await request(`/api/profiles/${p.id}/run`, {});
  assert.equal(run.status, 202);
  await Promise.all([...e.jobs.values()].map((j) => j.promise));
  const history = await request('/api/history');
  assert.ok(!(await history.text()).includes(secret));
  const status = await request('/api/status');
  assert.ok(!(await status.text()).includes(secret));
  const config = await (await request('/api/export/config')).json();
  assert.equal(config.profiles[0].apiKey, undefined);
  assert.equal(config.profiles[0].credentialId, undefined);
  const csv = await (await request('/api/export/history?format=csv')).text();
  assert.ok(csv.startsWith('"time"') || csv.startsWith('\uFEFF"time"'));
  assert.match(csv, /correct/);
  assert.equal(
    (await request('/api/profiles/' + p.id, { ...p, name: 'renamed' }, 'PUT')).status,
    200,
  );
  assert.equal((await request('/api/profiles/' + p.id, {}, 'DELETE')).status, 200);
  assert.equal((await (await request('/api/status')).json()).profiles.length, 0);
});
test('HTTP run requests preserve the paused/automatic boundary and stop-all works', async (t) => {
  const { request, e } = await fixture(t);
  const p = e.saveProfile(profile());
  assert.equal((await request(`/api/profiles/${p.id}/start`, {})).status, 200);
  assert.equal((await request(`/api/profiles/${p.id}/run`, {})).status, 409);
  assert.equal((await request('/api/stop-all', {})).status, 200);
  assert.equal(e.state.runtimes[p.id].enabled, false);
  assert.equal((await request('/api/guard/check', {})).status, 200);
  assert.equal((await request('/api/missing')).status, 404);
});
test('JSON body validation has explicit media, parse and byte limits', async (t) => {
  const { base, e } = await fixture(t);
  const headers = { Authorization: 'Bearer ' + e.state.token };
  assert.equal(
    (await fetch(base + '/api/profiles', { method: 'POST', headers, body: '{}' })).status,
    415,
  );
  headers['Content-Type'] = 'application/json';
  for (const body of ['{', '[]', 'null'])
    assert.equal(
      (await fetch(base + '/api/profiles', { method: 'POST', headers, body })).status,
      400,
    );
  assert.equal(
    (
      await fetch(base + '/api/profiles', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'a'.repeat(512 * 1024) }),
      })
    ).status,
    413,
  );
});
test('SSE subscriptions report changes without containing the connection code or key', async (t) => {
  const { request, e } = await fixture(t),
    response = await request('/api/events'),
    reader = response.body.getReader();
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: change/);
  assert.ok(!first.includes(e.state.token));
  e.saveProfile(profile());
  const next = new TextDecoder().decode((await reader.read()).value);
  assert.match(next, /event: change/);
  await reader.cancel();
});
test('probe preview and config import are deterministic, validated and side-effect free until saved', async (t) => {
  const { request } = await fixture(t);
  const route = '/api/probes/preview?pack=rotating&sequence=3&seed=42';
  assert.deepEqual(await (await request(route)).json(), await (await request(route)).json());
  assert.equal((await request('/api/probes/preview?seed=-1')).status, 400);
  assert.equal(
    (await request('/api/import', { profiles: [{ ...profile(), guard: true }] })).status,
    201,
  );
  const state = await (await request('/api/status')).json();
  assert.equal(state.profiles[0].runtime.enabled, false);
  assert.equal(state.profiles[0].guard, false);
});
test('provider HTML and script-like text is returned as data and credentials are scrubbed', async (t) => {
  const secret = 'fixture-secret-value';
  const { request, e } = await fixture(t, {
    runner: async (p, probe) =>
      record(p, probe, 'error', {
        answer: '<img src=x onerror=alert(1)> ' + secret,
        diagnostic: { authorization: secret, encrypted_content: secret },
      }),
  });
  const p = e.saveProfile(profile({ apiKey: secret }));
  await e.run(p.id);
  const response = await request('/api/history'),
    text = await response.text();
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.ok(!text.includes(secret));
  assert.ok(text.includes('[REDACTED]'));
});
