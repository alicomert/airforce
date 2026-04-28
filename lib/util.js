// Küçük genel yardımcılar.

import crypto from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

export function newToolCallId() {
  return `call_${crypto.randomBytes(10).toString('hex')}`;
}

export function newMessageId() {
  return `msg_${crypto.randomBytes(12).toString('hex')}`;
}

export function newCompletionId() {
  return `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;
}

export function safeJsonParse(text, fallback = null) {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

export function clone(x) {
  if (x == null) return x;
  if (typeof x !== 'object') return x;
  return JSON.parse(JSON.stringify(x));
}

export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export function unixSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Estimate token count (very rough, used only for billing-ish display).
export function estimateTokens(text) {
  if (!text) return 0;
  if (typeof text !== 'string') text = JSON.stringify(text);
  return Math.ceil(text.length / 4);
}

// Stringify for log; redact long values.
export function shortStringify(obj, maxLen = 400) {
  let s;
  try {
    s = JSON.stringify(obj);
  } catch {
    s = String(obj);
  }
  if (s.length > maxLen) s = s.slice(0, maxLen) + `...(${s.length}b)`;
  return s;
}

// Pluck first defined property from a list of paths.
export function pickFirst(obj, paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
    if (v != null) return v;
  }
  return undefined;
}
