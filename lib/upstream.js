// api.airforce upstream'e güvenli fetch — retry, timeout, JSON+SSE.

import { config } from './config.js';
import { log } from './logger.js';
import { sleep } from './util.js';
import { getBucket } from './rate-limit.js';

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RATE_LIMIT_COOLDOWN_MS = 60_000;

export class UpstreamError extends Error {
  constructor(message, { status = 0, body = null, cause = null } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.body = body;
    this.cause = cause;
  }
}

function buildHeaders(extra = {}) {
  const key = config.airforceApiKey;
  if (!key) {
    throw new UpstreamError('AIRFORCE_API_KEY tanımlı değil — .env dosyasını kontrol et.', { status: 0 });
  }
  return {
    'authorization': `Bearer ${key}`,
    'x-api-key': key,
    'content-type': 'application/json',
    'accept': 'application/json',
    'user-agent': 'airforce-bridge/0.1',
    ...extra,
  };
}

async function fetchOnce(method, urlPath, body, { timeoutMs, headers } = {}) {
  const url = config.upstreamBaseUrl + urlPath;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('upstream timeout')), timeoutMs ?? config.upstreamTimeoutMs);
  try {
    const init = {
      method,
      headers: buildHeaders(headers),
      signal: ctrl.signal,
    };
    if (body !== undefined && body !== null) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(url, init);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function upstreamJson(method, urlPath, body, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? config.upstreamMaxAttempts;
  const baseDelay = config.upstreamRetryBaseMs;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchOnce(method, urlPath, body, opts);
      if (res.ok) {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          return { res, json: await res.json() };
        }
        const text = await res.text();
        return { res, json: null, text };
      }
      // Non-OK status
      const errText = await safeText(res);
      const isRetryable = RETRYABLE_STATUS.has(res.status);
      log.warn(`upstream ${method} ${urlPath} → ${res.status}`, { attempt, retryable: isRetryable, body_preview: errText.slice(0, 200) });
      if (!isRetryable || attempt === maxAttempts) {
        throw new UpstreamError(`Upstream ${res.status}`, { status: res.status, body: errText });
      }
      // 429 rate-limit ise sabit 60s bekle, exponential backoff yapma.
      if (res.status === 429) {
        log.warn(`upstream ${method} ${urlPath} 429 → 60s cooldown`);
        try { getBucket().cooldown60s(`429 on ${urlPath}`); } catch {}
        await sleep(RATE_LIMIT_COOLDOWN_MS);
        continue;
      }
    } catch (err) {
      if (err instanceof UpstreamError && !RETRYABLE_STATUS.has(err.status)) throw err;
      lastErr = err;
      log.warn(`upstream ${method} ${urlPath} hata`, { attempt, err: err.message });
      if (attempt === maxAttempts) {
        throw err instanceof UpstreamError ? err : new UpstreamError(err.message, { cause: err });
      }
    }
    const jitter = Math.random() * baseDelay;
    await sleep(baseDelay * Math.pow(2, attempt - 1) + jitter);
  }
  throw lastErr || new UpstreamError('Upstream beklenmeyen hata');
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// Convenience: fetch /v1/models (with retry).
export async function fetchModels() {
  const { json } = await upstreamJson('GET', '/v1/models', null);
  if (!json || !Array.isArray(json.data)) throw new UpstreamError('Invalid /v1/models response');
  return json.data;
}

// Convenience: post chat completion (non-stream). Returns parsed JSON.
export async function postChatCompletion(body, opts = {}) {
  const { json } = await upstreamJson('POST', '/v1/chat/completions', { ...body, stream: false }, opts);
  return json;
}
