'use strict';
const { AppError, id, integer, string } = require('./util.cjs');
const crypto = require('node:crypto');
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'default'];
function endpoint(baseUrl, protocol) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AppError('API URL 格式无效');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new AppError('URL 必须是 HTTP(S)，且不能含账号、查询参数或片段');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new AppError('远程 API 必须使用 HTTPS；HTTP 仅供本机服务');
  const original = url.pathname.replace(/\/+$/, '');
  const full = /\/(responses|chat\/completions)$/.test(original);
  let path = original.replace(/\/(responses|chat\/completions)$/, '');
  if (!path && !full) path = '/v1';
  url.pathname = path + (protocol === 'responses' ? '/responses' : '/chat/completions');
  return url.href;
}
function normalizeProfile(input, previous = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('缺少配置');
  const p = {
    id: previous?.id || id(),
    name: string(input.name ?? '未命名配置', 1, 80, '名称'),
    model: string(input.model, 1, 180, '模型'),
    baseUrl: string(input.baseUrl, 1, 2048, 'API URL'),
    protocol: input.protocol ?? 'responses',
    apiKey: previous?.apiKey || '',
    pack: input.pack ?? 'original',
    intervalMin: input.intervalMin ?? 30,
    timeoutSec: input.timeoutSec ?? 60,
    outputBudget: input.outputBudget ?? 16,
    reasoningEffort: input.reasoningEffort ?? 'none',
    chatTokenField: input.chatTokenField ?? 'auto',
    temperature: input.temperature ?? null,
    guard: input.guard ?? false,
    keepAwake: input.keepAwake ?? true,
    contextTag: string(input.contextTag ?? '', 0, 120, '分组标签'),
    credentialId: previous?.credentialId || id(),
  };
  if (
    !['responses', 'chat'].includes(p.protocol) ||
    !['original', 'rotating'].includes(p.pack) ||
    !EFFORTS.includes(p.reasoningEffort) ||
    !['auto', 'max_tokens', 'max_completion_tokens'].includes(p.chatTokenField)
  )
    throw new AppError('协议、探针或参数选项无效');
  integer(p.intervalMin, 1, 1440, '间隔');
  integer(p.timeoutSec, 5, 300, '超时');
  integer(p.outputBudget, 16, 32768, '输出预算');
  if (
    p.temperature !== null &&
    (typeof p.temperature !== 'number' ||
      !Number.isFinite(p.temperature) ||
      p.temperature < 0 ||
      p.temperature > 2)
  )
    throw new AppError('温度须为0到2之间的数字或留空');
  if (typeof p.guard !== 'boolean' || typeof p.keepAwake !== 'boolean')
    throw new AppError('保护设置须为布尔值');
  if (input.clearApiKey === true) p.apiKey = '';
  else if (input.apiKey !== undefined && input.apiKey !== '')
    p.apiKey = string(input.apiKey, 1, 4096, 'API Key');
  if (/[\r\n]/.test(p.apiKey)) throw new AppError('API Key 不能包含换行');
  if (previous && previous.apiKey !== p.apiKey) p.credentialId = id();
  endpoint(p.baseUrl, p.protocol);
  return p;
}
const publicProfile = (p) => {
  const { apiKey, credentialId, ...rest } = p;
  return { ...rest, hasApiKey: !!apiKey };
};
function requestBody(profile, probe) {
  const body = { model: profile.model, stream: false };
  if (profile.protocol === 'responses') {
    Object.assign(body, {
      input: probe.prompt,
      store: false,
      max_output_tokens: profile.outputBudget,
    });
    if (profile.reasoningEffort !== 'default') body.reasoning = { effort: profile.reasoningEffort };
  } else {
    body.messages = [{ role: 'user', content: probe.prompt }];
    const field =
      profile.chatTokenField === 'auto'
        ? /^(gpt-[56](?:[.-]|$)|o[1-9](?:[.-]|$))/i.test(profile.model)
          ? 'max_completion_tokens'
          : 'max_tokens'
        : profile.chatTokenField;
    body[field] = profile.outputBudget;
    if (profile.reasoningEffort !== 'default') body.reasoning_effort = profile.reasoningEffort;
  }
  if (profile.temperature !== null) body.temperature = profile.temperature;
  return body;
}
function fingerprint(p) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        p.model,
        p.baseUrl,
        p.protocol,
        p.pack,
        p.outputBudget,
        p.reasoningEffort,
        p.chatTokenField,
        p.temperature,
        p.timeoutSec,
        p.contextTag,
        p.credentialId,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
}
module.exports = { normalizeProfile, publicProfile, endpoint, requestBody, fingerprint };
