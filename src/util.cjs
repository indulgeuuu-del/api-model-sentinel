'use strict';
const crypto = require('node:crypto');

class AppError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const id = () => crypto.randomUUID();
const clone = (value) => structuredClone(value);
const clip = (value, limit = 8000) => String(value ?? '').slice(0, limit);
function redact(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets
    .filter((s) => typeof s === 'string' && s.length > 0)
    .sort((a, b) => b.length - a.length))
    text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}
function scrub(value, secrets = []) {
  const text = JSON.stringify(value, (key, item) =>
    /^(api_?key|authorization|access_token|encrypted_content|token|password|secret)$/i.test(key)
      ? '[REDACTED]'
      : typeof item === 'string'
        ? redact(item, secrets)
        : item,
  );
  return text === undefined ? null : JSON.parse(text);
}
function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new AppError(`${name} 必须是 ${min}–${max} 之间的整数`);
  return value;
}
function string(value, min, max, name) {
  if (
    typeof value !== 'string' ||
    value.trim().length < min ||
    value.length > max ||
    /[\x00-\x08\x0b-\x1f]/.test(value)
  )
    throw new AppError(`${name} 格式无效`);
  return value.trim();
}
function stableEqual(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a).sort();
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && stableEqual(a[key], b[key]))
  );
}
function csv(rows) {
  const cell = (value) => {
    let s = String(value ?? '');
    if (/^[\s\uFEFF]*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n');
}
module.exports = { AppError, id, clone, clip, redact, scrub, integer, string, stableEqual, csv };
