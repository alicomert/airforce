// Anthropic native provider: api.anthropic.com'a OpenAI-shape body alıp
// Anthropic-shape body göndererek dönen yanıtı OpenAI-shape'e çevirir.
// Adapter (bridge'in /v1/messages endpoint'i) için public `request()` metodu da var
// (format dönüşümsüz; çünkü o adapter zaten Anthropic-shape body geliyor).

import { BaseProvider, ProviderError, classifyError } from './base.js';
import { openaiToAnthropicBody, anthropicToOpenaiResponse } from './format-conversion.js';
import { sleep } from '../util.js';

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 200;

export class AnthropicNativeProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.baseUrl = String(config.base_url || 'https://api.anthropic.com').replace(/\/+$/, '');
    this.apiKey = config.api_key || '';
    this.headers = config.headers || {};
    this.timeoutMs = Number(config.timeout_ms) || DEFAULT_TIMEOUT;
    this.maxAttempts = Number(config.max_attempts) || DEFAULT_MAX_ATTEMPTS;
    this.retryBaseMs = Number(config.retry_base_ms) || DEFAULT_RETRY_BASE_MS;
  }

  supportsNativeTools() { return true; }

  buildHeaders(extra = {}) {
    const h = {
      'content-type': 'application/json',
      'accept': 'application/json',
      'user-agent': 'llm-bridge/0.4',
      'anthropic-version': '2023-06-01',
      ...this.headers,
      ...extra,
    };
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  }

  async _fetchOnce(method, urlPath, body, opts = {}) {
    const url = this.baseUrl + urlPath;
    const ctrl = new AbortController();
    const timeoutMs = opts.timeout_ms || this.timeoutMs;
    const timer = setTimeout(() => ctrl.abort(new Error('upstream timeout')), timeoutMs);
    try {
      const init = { method, headers: this.buildHeaders(opts.headers), signal: ctrl.signal };
      if (body !== undefined && body !== null) {
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      return await fetch(url, init);
    } finally {
      clearTimeout(timer);
    }
  }

  async _request(method, urlPath, body, opts = {}) {
    const maxAttempts = opts.max_attempts ?? this.maxAttempts;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await this._fetchOnce(method, urlPath, body, opts);
        if (res.ok) {
          const ct = res.headers.get('content-type') || '';
          if (ct.includes('application/json')) return { res, json: await res.json() };
          return { res, json: null, text: await res.text() };
        }
        const errText = await res.text().catch(() => '');
        const cat = classifyError(res.status, errText);
        if (cat === 'transient' && attempt < maxAttempts) {
          await sleep(this.retryBaseMs * Math.pow(2, attempt - 1) + Math.random() * this.retryBaseMs);
          continue;
        }
        throw new ProviderError(`upstream ${res.status}`, { status: res.status, body: errText, category: cat });
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        lastErr = err;
        if (attempt === maxAttempts) {
          throw new ProviderError(err.message || 'network error', { status: 0, category: 'transient', cause: err });
        }
        await sleep(this.retryBaseMs * Math.pow(2, attempt - 1));
      }
    }
    throw lastErr || new ProviderError('unexpected');
  }

  async chat(body, opts = {}) {
    const anthropicBody = openaiToAnthropicBody(body);
    const { json } = await this._request('POST', '/v1/messages', anthropicBody, opts);
    if (!json) throw new ProviderError('upstream returned no payload', { status: 0, category: 'transient' });
    const oaiShape = anthropicToOpenaiResponse(json, body.model);
    const choice = oaiShape.choices[0];
    const out = {
      text: choice.message.content || '',
      usage: oaiShape.usage,
      finish_reason: choice.finish_reason,
      raw: oaiShape,
    };
    if (choice.message.tool_calls && choice.message.tool_calls.length) {
      out.native_tool_calls = choice.message.tool_calls;
    }
    return out;
  }

  async listModels() {
    try {
      const { json } = await this._request('GET', '/v1/models', null);
      if (!json || !Array.isArray(json.data)) return [];
      return json.data;
    } catch (err) {
      if (err instanceof ProviderError && err.category === 'bad_model') return [];
      throw err;
    }
  }

  async healthCheck({ model } = {}) {
    const start = Date.now();
    try {
      await this.chat(
        { model: model || 'claude-sonnet-4', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
        { max_attempts: 1 },
      );
      return { ok: true, latency_ms: Date.now() - start };
    } catch (err) {
      return {
        ok: false, latency_ms: Date.now() - start,
        category: err?.category || 'transient', status: err?.status || 0,
        error: err?.message || String(err),
      };
    }
  }

  // Public bridge (Anthropic-shape body, no format conversion). bridge'in /v1/messages
  // endpoint adapter'ı kullanır.
  async request(method, urlPath, body, opts = {}) {
    return this._request(method, urlPath, body, opts);
  }
}
