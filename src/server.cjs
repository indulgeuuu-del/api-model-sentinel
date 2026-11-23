'use strict';
const http = require('node:http'),
  fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { AppError, redact, scrub, csv, integer } = require('./util.cjs');
const { makeProbe, FAMILIES } = require('./probes.cjs');
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};
async function jsonBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
    throw new AppError('需要 application/json', 415);
  const parts = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 512 * 1024) {
      req.resume();
      throw new AppError('请求超过512 KiB', 413);
    }
    parts.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(parts).toString());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error();
    return parsed;
  } catch {
    throw new AppError('JSON 请求格式无效');
  }
}
function createServer({
  engine,
  guard,
  power = null,
  demo = false,
  onShutdown = async () => {},
  publicDir = path.join(__dirname, '..', 'public'),
} = {}) {
  const sse = new Set();
  let closing = false;
  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port,
      host = `127.0.0.1:${port}`,
      origin = `http://${host}`;
    const headers = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    };
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(scrub(value, engine.secrets())));
    };
    try {
      if (req.headers.host !== host) throw new AppError('不允许的 Host', 403, 'forbidden_host');
      if (req.headers.origin && req.headers.origin !== origin)
        throw new AppError('不允许的网页来源', 403, 'forbidden_origin');
      if (req.headers['sec-fetch-site'] === 'cross-site')
        throw new AppError('拒绝跨站请求', 403, 'forbidden_origin');
      const url = new URL(req.url, origin),
        route = url.pathname;
      if (req.method === 'GET' && route === '/health')
        return json(200, { service: 'api-model-sentinel', version: '1.0.0', demo });
      if (req.method === 'GET' && assets[route]) {
        const [file, type] = assets[route];
        res.writeHead(200, { 'Content-Type': type });
        return res.end(fs.readFileSync(path.join(publicDir, file)));
      }
      const want = Buffer.from('Bearer ' + engine.state.token),
        got = Buffer.from(req.headers.authorization || '');
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want))
        throw new AppError('连接码缺失或已失效，请用启动器重新打开面板', 401, 'unauthorized');
      if (closing) throw new AppError('服务正在停止', 503);
      if (req.method === 'GET' && route === '/api/status')
        return json(200, {
          ...engine.snapshot(),
          demo,
          platform: process.platform,
          power: power?.snapshot() || { state: 'inactive' },
          families: FAMILIES,
          guardExperimental: true,
        });
      if (req.method === 'GET' && route === '/api/events') {
        if (sse.size >= 20) throw new AppError('订阅连接过多', 429);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
        res.write('event: change\ndata: {}\n\n');
        sse.add(res);
        res.once('close', () => sse.delete(res));
        return;
      }
      if (req.method === 'GET' && route === '/api/history')
        return json(200, { records: engine.records(url.searchParams.get('profileId') || null) });
      if (req.method === 'GET' && route === '/api/export/config')
        return json(200, engine.exportConfig());
      if (req.method === 'GET' && route === '/api/export/history') {
        const records = engine.records(url.searchParams.get('profileId') || null);
        if (url.searchParams.get('format') === 'csv') {
          const rows = [
            [
              'time',
              'profile',
              'source',
              'result',
              'category',
              'answer',
              'reason',
              'input_tokens',
              'output_tokens',
              'reasoning_tokens',
              'total_tokens',
              'duration_ms',
              'scheduling_delay_ms',
              'probe_version',
              'seed',
              'warnings',
              'guard',
            ],
            ...records.map((r) => [
              new Date(r.timestamp).toISOString(),
              r.profileId,
              r.source,
              r.status,
              r.category,
              r.answer,
              r.reason,
              r.usage?.input,
              r.usage?.output,
              r.usage?.reasoning,
              r.usage?.total,
              r.durationMs,
              r.schedulingDelayMs,
              r.probe?.version,
              r.probe?.seed,
              r.warnings?.join('; '),
              r.guardAction,
            ]),
          ];
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="sentinel-history.csv"',
          });
          return res.end(csv(rows));
        }
        return json(200, { version: 1, exportedAt: Date.now(), records });
      }
      if (req.method === 'GET' && route === '/api/probes/preview') {
        const pack = url.searchParams.get('pack') || 'original';
        if (!['original', 'rotating'].includes(pack)) throw new AppError('未知探针集');
        const sequence = Number(url.searchParams.get('sequence') || 0),
          seed = Number(url.searchParams.get('seed') || 0);
        integer(sequence, 0, 100000, '序号');
        integer(seed, 0, 4294967295, '种子');
        return json(200, makeProbe(pack, sequence, seed));
      }
      if (req.method === 'POST' && route === '/api/profiles') {
        const body = await jsonBody(req);
        return json(201, { profile: engine.saveProfile(body) });
      }
      const match = route.match(/^\/api\/profiles\/([a-f0-9-]{36})(?:\/(start|stop|run))?$/i);
      if (match) {
        const profileId = match[1],
          action = match[2];
        if (req.method === 'PUT' && !action)
          return json(200, { profile: engine.saveProfile(await jsonBody(req), profileId) });
        if (req.method === 'DELETE' && !action) {
          await jsonBody(req);
          engine.removeProfile(profileId);
          return json(200, { ok: true });
        }
        if (req.method === 'POST' && action) {
          await jsonBody(req);
          if (action === 'start') {
            await engine.start(profileId);
            void engine.poll().catch(() => {});
            return json(200, { ok: true });
          }
          if (action === 'stop') {
            engine.stop(profileId);
            return json(200, { ok: true });
          }
          const promise = engine.run(profileId);
          promise.catch((e) => engine.emit('operationError', redact(e.message, engine.secrets())));
          return json(202, { ok: true, runId: engine.state.runtimes[profileId].running?.id });
        }
      }
      if (req.method === 'POST' && route === '/api/stop-all') {
        await jsonBody(req);
        engine.stopAll();
        return json(200, { ok: true });
      }
      if (req.method === 'POST' && route === '/api/compare') {
        const body = await jsonBody(req);
        return json(202, engine.compare(body.profileIds));
      }
      if (req.method === 'POST' && route === '/api/import') {
        const body = await jsonBody(req);
        return json(201, { profiles: engine.importConfig(body) });
      }
      if (req.method === 'POST' && route === '/api/guard/check') {
        await jsonBody(req);
        return json(200, await guard.check());
      }
      if (req.method === 'POST' && route === '/api/system/shutdown') {
        await jsonBody(req);
        engine.stopAll();
        closing = true;
        json(200, { ok: true });
        setImmediate(() => onShutdown());
        return;
      }
      throw new AppError('接口不存在', 404, 'not_found');
    } catch (e) {
      json(e.status || 500, {
        error: redact(e.status ? e.message : '本地服务发生内部错误，请查看终端', engine.secrets()),
        code: e.code || 'internal_error',
      });
    }
  });
  const change = () => {
    if (power)
      power.set(
        engine.state.profiles.some((p) => p.keepAwake && engine.state.runtimes[p.id].enabled),
      );
    for (const res of sse) {
      if (res.writableLength > 65536) {
        res.destroy();
        sse.delete(res);
      } else res.write('event: change\ndata: {}\n\n');
    }
  };
  engine.on('change', change);
  change();
  const heartbeat = setInterval(() => {
    for (const res of sse) res.write(': heartbeat\n\n');
  }, 15000);
  heartbeat.unref();
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 40;
  server.on('close', () => {
    clearInterval(heartbeat);
    engine.off('change', change);
    power?.close();
  });
  return {
    server,
    listen: (port = 17655) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server.address()));
      }),
    close: () =>
      new Promise((resolve) => {
        closing = true;
        for (const res of sse) res.end();
        sse.clear();
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
module.exports = { createServer, jsonBody };
