'use strict';
// Opt-in live verification. Never called by CI, install, or the scheduler.
const fs = require('node:fs');
const { atomicWrite } = require('../src/storage.cjs');
const { normalizeProfile, endpoint } = require('../src/profile.cjs');
const { makeProbe } = require('../src/probes.cjs');
const { runProbe, readBody, usageOf } = require('../src/protocol.cjs');
const { scrub, redact, integer } = require('../src/util.cjs');

async function listModels({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = 20000 }) {
  const url = new URL(endpoint(baseUrl, 'responses'));
  url.pathname = url.pathname.replace(/\/responses$/, '/models');
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await readBody(response);
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    data = null;
  }
  return scrub(
    {
      httpStatus: response.status,
      ok: response.ok && Array.isArray(data?.data),
      models: Array.isArray(data?.data)
        ? data.data.map((m) => m?.id).filter((id) => typeof id === 'string')
        : [],
      reason: !response.ok
        ? redact(String(data?.error?.message || 'HTTP ' + response.status).slice(0, 500), [apiKey])
        : !Array.isArray(data?.data)
          ? 'Invalid model list'
          : null,
    },
    [apiKey],
  );
}

function livePlan({
  mode = 'smoke',
  includeChat = false,
  outputBudget = 16,
  reasoningEffort = 'none',
} = {}) {
  if (!['smoke', 'matrix'].includes(mode)) throw Error('mode must be smoke or matrix');
  if (includeChat && mode !== 'matrix') throw Error('--chat requires --matrix');
  integer(outputBudget, 16, 32768, '输出预算');
  const plan = [
    {
      name: 'responses-original',
      protocol: 'responses',
      probe: makeProbe('original'),
      outputBudget,
      reasoningEffort,
    },
  ];
  if (mode === 'matrix') {
    for (let i = 0; i < 5; i++)
      plan.push({
        name: 'responses-' + makeProbe('rotating', i, 20261123).family,
        protocol: 'responses',
        probe: makeProbe('rotating', i, 20261123),
        outputBudget,
        reasoningEffort,
      });
    if (includeChat)
      plan.push({
        name: 'chat-original',
        protocol: 'chat',
        probe: makeProbe('original'),
        outputBudget,
        reasoningEffort,
      });
  }
  return plan;
}

async function runLive({
  baseUrl,
  apiKey,
  model,
  mode = 'smoke',
  includeChat = false,
  outputBudget = 16,
  reasoningEffort = 'none',
  timeoutSec = 60,
  maxReportedTokens = 4000,
  runner = runProbe,
  onRecord = () => {},
}) {
  integer(maxReportedTokens, 1, 1000000, '验收已报告token上限');
  const profile = normalizeProfile({
    name: 'Explicit live acceptance',
    baseUrl,
    apiKey,
    model,
    timeoutSec,
    outputBudget,
    reasoningEffort,
    guard: false,
    keepAwake: false,
  });
  const plan = livePlan({ mode, includeChat, outputBudget, reasoningEffort }),
    records = [];
  let knownTokens = 0,
    stoppedBecause = null;
  const report = () =>
    scrub(
      {
        schemaVersion: 1,
        testedAt: new Date().toISOString(),
        model,
        endpoint: endpoint(baseUrl, 'responses'),
        mode,
        requestedCases: plan.length,
        completedCases: records.length,
        passed: records.filter((r) => r.status === 'pass').length,
        knownTokens,
        unknownUsage: records.filter((r) => r.usage?.total == null).length,
        maxReportedTokens,
        stoppedBecause,
        records,
        limitations: [
          'Provider-reported tokens are not a hard billing cap',
          'Live answers do not prove model identity',
          'Codex interruption is not exercised',
        ],
      },
      [apiKey],
    );
  for (const entry of plan) {
    const record = await runner({ ...profile, protocol: entry.protocol }, entry.probe);
    const safe = scrub({ name: entry.name, ...record }, [apiKey]);
    records.push(safe);
    knownTokens += usageOf({ usage: { total_tokens: safe.usage?.total } })?.total || 0;
    if (records.length < plan.length) {
      if (safe.diagnostic?.httpStatus === 401 || safe.diagnostic?.httpStatus === 403)
        stoppedBecause = 'Credential rejected; no more requests sent';
      else if (safe.usage?.total == null) stoppedBecause = 'Usage unknown; no more requests sent';
      else if (knownTokens >= maxReportedTokens)
        stoppedBecause = 'Reported token ceiling reached; no more requests sent';
    }
    await onRecord(safe, report());
    if (stoppedBecause) break;
  }
  return report();
}
async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log(
      'Explicit paid verification: set SENTINEL_API_KEY, then run node scripts/live.cjs --url URL --model ID [--matrix [--chat]] [--budget 16] [--effort none] [--token-ceiling 4000] [--output report.local.json]. Use --url URL --models for discovery. Results are saved after each request. Reported token ceiling cannot cap provider billing.',
    );
    return;
  }
  const flags = {};
  while (argv.length) {
    const key = argv.shift();
    if (Object.hasOwn(flags, key)) throw Error('Duplicate argument: ' + key);
    if (key === '--matrix' || key === '--chat' || key === '--models') flags[key] = true;
    else if (
      ['--url', '--model', '--output', '--budget', '--effort', '--token-ceiling'].includes(key)
    ) {
      const value = argv.shift();
      if (!value || value.startsWith('--')) throw Error('Missing value for ' + key);
      flags[key] = value;
    } else throw Error('Unknown argument: ' + key);
  }
  if (!flags['--url']) throw Error('Provide --url (full Responses endpoint recommended)');
  const apiKey = process.env.SENTINEL_API_KEY || '';
  if (flags['--models']) {
    const models = await listModels({ baseUrl: flags['--url'], apiKey });
    console.log(JSON.stringify(models, null, 2));
    if (!models.ok) process.exitCode = 1;
    return;
  }
  if (!flags['--model']) throw Error('Provide --model with the exact provider ID');
  const file = flags['--output'] || 'sentinel-live.local.json';
  if (!file.endsWith('.local.json'))
    throw Error('Report filename must end in .local.json to avoid accidental publication');
  const options = {
    baseUrl: flags['--url'],
    apiKey,
    model: flags['--model'],
    mode: flags['--matrix'] ? 'matrix' : 'smoke',
    includeChat: !!flags['--chat'],
    outputBudget: flags['--budget'] ? Number(flags['--budget']) : 16,
    reasoningEffort: flags['--effort'] || 'none',
    maxReportedTokens: flags['--token-ceiling'] ? Number(flags['--token-ceiling']) : 4000,
  };
  normalizeProfile(options);
  livePlan(options);
  integer(options.maxReportedTokens, 1, 1000000, '验收已报告token上限');
  try {
    fs.closeSync(fs.openSync(file, 'wx', 0o600));
  } catch (e) {
    if (e.code === 'EEXIST')
      throw Error('Report already exists; choose another .local.json file before sending requests');
    throw e;
  }
  const save = (report) => atomicWrite(file, Buffer.from(JSON.stringify(report, null, 2) + '\n'));
  let report,
    progress = {
      schemaVersion: 1,
      status: 'running',
      model: options.model,
      endpoint: endpoint(options.baseUrl, 'responses'),
      records: [],
    };
  try {
    save(progress);
    report = await runLive({
      ...options,
      onRecord: (_record, partial) => {
        progress = { ...partial, status: 'running' };
        save(progress);
      },
    });
    save({
      ...report,
      status: report.completedCases === report.requestedCases ? 'complete' : 'stopped',
    });
  } catch (e) {
    try {
      save({ ...progress, status: 'interrupted', error: redact(e.message, [apiKey]) });
    } catch {
      /* Preserve the most recent report when storage fails. */
    }
    throw e;
  }
  console.log(
    JSON.stringify({
      report: file,
      completedCases: report.completedCases,
      passed: report.passed,
      knownTokens: report.knownTokens,
      stoppedBecause: report.stoppedBecause,
    }),
  );
  if (report.passed !== report.requestedCases) process.exitCode = 1;
}
if (require.main === module)
  main(process.argv.slice(2)).catch((e) => {
    console.error(redact(e.message, [process.env.SENTINEL_API_KEY]));
    process.exitCode = 1;
  });
module.exports = { listModels, livePlan, runLive, main };
