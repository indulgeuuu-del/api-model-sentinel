'use strict';
const { performance } = require('node:perf_hooks');
const { endpoint, requestBody } = require('./profile.cjs');
const { grade } = require('./probes.cjs');
const { id, clip, scrub } = require('./util.cjs');
const MAX_BODY = 2 * 1024 * 1024;
const number = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
function usageOf(data) {
  const u = data?.usage;
  if (!u || typeof u !== 'object') return null;
  const input = number(u.input_tokens) ?? number(u.prompt_tokens),
    output = number(u.output_tokens) ?? number(u.completion_tokens);
  const total =
    number(u.total_tokens) ?? (input !== null && output !== null ? input + output : null);
  const reasoning =
    number(u.output_tokens_details?.reasoning_tokens) ??
    number(u.completion_tokens_details?.reasoning_tokens);
  const cached =
    number(u.input_tokens_details?.cached_tokens) ?? number(u.prompt_tokens_details?.cached_tokens);
  return [input, output, total, reasoning, cached].every((v) => v === null)
    ? null
    : { input, output, total, reasoning, cached };
}
function decode(body, contentType = '') {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    throw Error();
  } catch {
    if (!/text\/event-stream/i.test(contentType) && !/^\s*(?:event:|data:)/.test(body))
      throw Error('响应不是有效 JSON 对象');
  }
  let terminal = null,
    text = '',
    finish = null,
    usage = null,
    role = null,
    refusal = '';
  for (const block of body.replace(/\r\n?/g, '\n').split(/\n\n+/)) {
    const payload = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!payload || payload === '[DONE]') continue;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      throw Error('SSE 数据无效');
    }
    if (!event || typeof event !== 'object') throw Error('SSE 事件不是对象');
    if (event.error || event.type === 'error') return { error: event.error || event };
    if (
      ['response.completed', 'response.incomplete', 'response.failed'].includes(event.type) &&
      event.response
    )
      terminal = { ...event.response, status: event.type.slice(9) };
    if (Array.isArray(event.choices)) {
      const choice = event.choices[0];
      if (typeof choice?.delta?.content === 'string') text += choice.delta.content;
      if (choice?.delta?.refusal) refusal += choice.delta.refusal;
      role = choice?.delta?.role || role;
      if (choice?.finish_reason) finish = choice.finish_reason;
    }
    if (event.usage) usage = event.usage;
  }
  if (terminal) return terminal;
  if (finish)
    return {
      choices: [
        { message: { role: role || 'assistant', content: text, refusal }, finish_reason: finish },
      ],
      usage,
    };
  throw Error('流式响应缺少最终完成事件，不能判定答案');
}
function textParts(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content
        .filter((p) => p && ['text', 'output_text'].includes(p.type) && typeof p.text === 'string')
        .map((p) => p.text)
        .join('')
    : '';
}
function classify(data, protocol, probe) {
  const choice = data?.choices?.[0],
    messages = Array.isArray(data?.output)
      ? data.output.filter((p) => p?.type === 'message' && (!p.role || p.role === 'assistant'))
      : [];
  const answer =
    protocol === 'chat'
      ? textParts(choice?.message?.content) || choice?.text || ''
      : messages.map((m) => textParts(m.content)).join('\n') ||
        (typeof data?.output_text === 'string' ? data.output_text : '');
  const base = {
    answer: typeof answer === 'string' ? answer : '',
    usage: usageOf(data),
    modelReported: typeof data?.model === 'string' ? clip(data.model, 180) : null,
    responseComplete: false,
  };
  const result = (status, category, reason) => ({ ...base, status, category, reason });
  if (data?.error || data?.status === 'failed')
    return result(
      'error',
      'provider_error',
      '供应商返回错误：' +
        clip(data?.error?.message || data?.error?.code || 'response failed', 500),
    );
  if (
    choice?.message?.refusal ||
    choice?.finish_reason === 'content_filter' ||
    messages.some((m) => m.content?.some?.((p) => p.type === 'refusal'))
  )
    return result('inconclusive', 'refusal', '拒答或过滤；本次没有可判定答案');
  if (
    protocol === 'chat'
      ? !choice
      : !Array.isArray(data?.output) && typeof data?.output_text !== 'string'
  )
    return result(
      'error',
      'protocol_mismatch',
      '响应与所选协议不匹配，请检查 Responses / Chat 设置',
    );
  const incomplete =
    data?.status === 'incomplete' ||
    choice?.finish_reason === 'length' ||
    messages.some((m) => m.status === 'incomplete');
  base.responseComplete =
    !incomplete &&
    (protocol === 'chat'
      ? choice?.finish_reason === 'stop'
      : data?.status === 'completed' ||
        (!data?.status && messages.length > 0 && messages.every((m) => m.status === 'completed')));
  const graded = grade(base.answer, probe);
  // Budget metadata never vetoes a demonstrably correct answer.
  if (graded.verdict === 'pass')
    return { ...result('pass', 'correct', '答案正确'), actual: graded.actual };
  if (incomplete) return result('inconclusive', 'incomplete', '输出未完成；继续下一周期');
  if (data?.status && data.status !== 'completed')
    return result('inconclusive', 'pending', '供应商尚未返回完整终答');
  if (choice?.finish_reason && choice.finish_reason !== 'stop')
    return result('inconclusive', 'unfinished', '终答未完成：' + choice.finish_reason);
  if (!base.answer.trim()) return result('inconclusive', 'empty_answer', '没有返回答案文本');
  if (!base.responseComplete)
    return result('inconclusive', 'unfinished', '缺少最终完成状态；继续下一周期');
  return {
    ...result(
      graded.verdict,
      graded.verdict === 'pass'
        ? 'correct'
        : graded.verdict === 'fail'
          ? 'wrong_answer'
          : 'invalid_answer',
      graded.verdict === 'pass'
        ? '答案正确'
        : graded.verdict === 'fail'
          ? '完整答案与标准答案不符'
          : '终答不符合可判定格式',
    ),
    actual: graded.actual,
  };
}
async function readBody(response, limit = MAX_BODY) {
  if (!response.body) return '';
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let size = 0,
    text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw Error('响应超过2 MiB上限');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
async function runProbe(
  profile,
  probe,
  { signal, timeoutMs = profile.timeoutSec * 1000, fetchImpl = fetch } = {},
) {
  const started = performance.now(),
    startedAt = Date.now(),
    deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  let result,
    diagnostic = {},
    providerRequestId = null;
  try {
    if (combined.aborted) throw Error('Cancelled');
    const response = await fetchImpl(endpoint(profile.baseUrl, profile.protocol), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(profile.apiKey ? { Authorization: 'Bearer ' + profile.apiKey } : {}),
      },
      body: JSON.stringify(requestBody(profile, probe)),
      signal: combined,
      redirect: 'error',
    });
    providerRequestId = response.headers.get('x-request-id') || response.headers.get('request-id');
    const body = await readBody(response);
    let data;
    try {
      data = decode(body, response.headers.get('content-type') || '');
    } catch (e) {
      result = { status: 'error', category: 'invalid_response', answer: '', reason: e.message };
    }
    if (!response.ok)
      result = {
        status: 'error',
        category: 'http_error',
        answer: '',
        reason:
          `HTTP ${response.status}` +
          (data?.error?.message ? ' · ' + clip(data.error.message, 500) : ''),
        usage: usageOf(data),
      };
    else if (!result) result = classify(data, profile.protocol, probe);
    diagnostic = {
      httpStatus: response.status,
      responseStatus: data?.status ?? null,
      finishReason: data?.choices?.[0]?.finish_reason ?? null,
      reasoningEffort:
        typeof (data?.reasoning?.effort ?? data?.reasoning_effort) === 'string'
          ? clip(data?.reasoning?.effort ?? data?.reasoning_effort, 80)
          : null,
      outputBudget: number(
        data?.max_output_tokens ?? data?.max_completion_tokens ?? data?.max_tokens,
      ),
      error: data?.error ?? null,
    };
    if (!response.ok) diagnostic.hint = httpHint(response.status);
  } catch (e) {
    result = {
      status: signal?.aborted ? 'cancelled' : deadline.signal.aborted ? 'timeout' : 'error',
      category: signal?.aborted
        ? 'cancelled'
        : deadline.signal.aborted
          ? 'timeout'
          : 'network_error',
      answer: '',
      reason: signal?.aborted
        ? '已取消本地等待'
        : deadline.signal.aborted
          ? '本次超时；按原间隔继续'
          : '请求失败：' + clip(e.message, 500),
    };
  } finally {
    clearTimeout(timeout);
  }
  const warnings = [];
  if (
    profile.reasoningEffort !== 'default' &&
    diagnostic.reasoningEffort &&
    diagnostic.reasoningEffort !== profile.reasoningEffort
  )
    warnings.push(
      `请求推理强度 ${profile.reasoningEffort}，供应商回传 ${diagnostic.reasoningEffort}`,
    );
  if (
    diagnostic.outputBudget !== null &&
    diagnostic.outputBudget !== undefined &&
    diagnostic.outputBudget !== profile.outputBudget
  )
    warnings.push(
      `请求输出上限 ${profile.outputBudget}，供应商回传上限 ${diagnostic.outputBudget}`,
    );
  if (result.status === 'pass' && result.responseComplete === false)
    warnings.push('可判定答案正确，但供应商未标记完整完成');
  if (result.usage?.output > profile.outputBudget)
    warnings.push(
      `供应商报告输出 ${result.usage.output} token，超过请求上限 ${profile.outputBudget}`,
    );
  if (profile.reasoningEffort === 'none' && result.usage?.reasoning > 0)
    warnings.push(`请求关闭推理，供应商仍报告 ${result.usage.reasoning} 个推理 token`);
  if (result.usage?.output == null) warnings.push('缺少输出用量，实际费用未知');
  return scrub(
    {
      id: id(),
      profileId: profile.id,
      startedAt,
      timestamp: Date.now(),
      durationMs: Math.round(performance.now() - started),
      ...result,
      answer: clip(result.answer),
      reason: clip(result.reason, 2000),
      usage: result.usage || null,
      warnings,
      diagnostic,
      providerRequestId: clip(providerRequestId, 200),
      probe,
      model: profile.model,
      protocol: profile.protocol,
      settings: {
        outputBudget: profile.outputBudget,
        reasoningEffort: profile.reasoningEffort,
        intervalMin: profile.intervalMin,
      },
    },
    [profile.apiKey],
  );
}
function httpHint(status) {
  if (status === 401 || status === 403) return '检查 Key、余额及分组权限；不要在公开问题中粘贴 Key';
  if (status === 404) return '检查完整端点路径和所选协议，部分供应商不使用 /v1 前缀';
  if (status === 400 || status === 422)
    return '检查模型及参数支持；可手动将推理强度改为供应商默认，或切换 Chat token 参数';
  if (status === 429) return '供应商限流或额度不足；保持监测间隔或手动降低频率';
  if (status >= 500) return '供应商或所选分组暂时不可用；这不代表模型答错';
  return '检查供应商文档及本次请求 ID';
}
module.exports = { MAX_BODY, usageOf, decode, classify, readBody, runProbe, httpHint };
