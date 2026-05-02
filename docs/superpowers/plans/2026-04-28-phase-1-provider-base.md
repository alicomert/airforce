# Phase 1 — Provider Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tek-upstream varsayımını koddan çıkar, provider plugin abstraction'ını kur (`BaseProvider` + `OpenaiCompatProvider`), tüm mevcut adapter ve probe kodu yeni provider üzerinden çalışsın. Sonuçta tek api.airforce provider'ı kullanılıyor olacak ama abstraction altında — Faz 2 (router/registry) bunun üzerine çoklu provider getirecek.

**Architecture:** `lib/upstream.js` silinir. Yerine `lib/providers/base.js` (sözleşme + hata sınıflandırma) ve `lib/providers/openai-compat.js` (OpenAI-compatible HTTP istemci) konur. `getDefaultProvider()` factory mevcut `.env` config'inden tek provider instance'ı üretir. Adapter'lar (`adapters/openai.js`, `adapters/anthropic.js`) ve `probe.js` `postChatCompletion` çağrılarını `provider.chat()` ile değiştirir. Tool-engine modülleri (`inject.js`, `parse.js`, `translate.js`, `serialize-history.js`, `anti-leak.js`) **dokunulmaz**.

**Tech Stack:** Node.js >=20, ES modules, native `node:http` + `fetch`, `node:test`, no external deps.

---

## File Structure

**Create:**
- `lib/providers/base.js` — `BaseProvider` class, `ProviderError` class, `classifyError()` helper
- `lib/providers/openai-compat.js` — `OpenaiCompatProvider extends BaseProvider`
- `lib/providers/factory.js` — `getDefaultProvider()` (config → instance)
- `test/providers/base.test.js` — `ProviderError` ve `classifyError` testleri
- `test/providers/openai-compat.test.js` — `chat`, `listModels`, `healthCheck` testleri (fetch mock)

**Modify:**
- `lib/adapters/openai.js` — `postChatCompletion` import'unu kaldır, `getDefaultProvider().chat()` kullan
- `lib/adapters/anthropic.js` — aynı
- `lib/adapters/models.js` — `fetchModels` import'unu kaldır, `provider.listModels()` kullan
- `lib/probe.js` — `upstreamJson` ve `fetchModels` import'larını kaldır, provider üzerinden çağrı
- `lib/admin-router.js` — `fetchModels` import'unu güncelle
- `package.json` — `test` script'ine yeni test path'leri ekle

**Delete:**
- `lib/upstream.js` (içeriği `providers/openai-compat.js`'e taşındı)

**Untouched (kritik — dokunma):**
- `lib/tool-engine/*` (5 dosya)
- `lib/config.js`, `lib/store.js`, `lib/capability.js`, `lib/rate-limit.js`, `lib/tier.js`, `lib/util.js`, `lib/auth.js`, `lib/sse.js`, `lib/logger.js`, `lib/scheduler.js`, `server.js`
- `web/*`
- Mevcut testler (`test/parse.test.js`, `test/inject.test.js`, `test/serialize-history.test.js`, `test/tier.test.js`)

---

## Task 0: Branch setup

**Files:** _(none — git only)_

- [ ] **Step 1: Develop branch oluştur**

```bash
cd ~/Desktop/llm-bridge
git checkout master
git pull origin master
git checkout -b develop
git push -u origin develop
```

- [ ] **Step 2: Feature branch oluştur**

```bash
git checkout -b feat/01-provider-base
git push -u origin feat/01-provider-base
```

- [ ] **Step 3: Plan dosyası develop'da var mı kontrol et**

```bash
git log --oneline master..develop -- docs/superpowers/plans/
```

Expected: boş (plan henüz commit edilmedi develop'a). Master'dan rebase yapacağız.

```bash
git rebase master
```

- [ ] **Step 4: Doğrula**

```bash
git status
git log --oneline -3
```

Expected: clean working tree, plan commit'i HEAD'de.

---

## Task 1: ProviderError + classifyError

**Files:**
- Create: `lib/providers/base.js`
- Test: `test/providers/base.test.js`

**Background:** Spec §4.4 — provider plugin'leri HTTP yanıtlarını şu kategorilere döker: `transient`, `auth`, `bad_model`, `client`, `ok`. Router (Faz 2) bu kategoriyi okuyup karar verir.

- [ ] **Step 1: Test dizinini oluştur**

```bash
mkdir -p test/providers lib/providers
```

- [ ] **Step 2: Failing test yaz**

`test/providers/base.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, classifyError } from '../../lib/providers/base.js';

test('ProviderError stores status, body, category', () => {
  const err = new ProviderError('boom', { status: 500, body: 'srv', category: 'transient' });
  assert.equal(err.message, 'boom');
  assert.equal(err.status, 500);
  assert.equal(err.body, 'srv');
  assert.equal(err.category, 'transient');
  assert.equal(err.name, 'ProviderError');
});

test('classifyError: 5xx and 408/425/429 are transient', () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(classifyError(s, ''), 'transient', `status ${s}`);
  }
});

test('classifyError: 401/403 are auth', () => {
  assert.equal(classifyError(401, ''), 'auth');
  assert.equal(classifyError(403, ''), 'auth');
});

test('classifyError: 404 is bad_model', () => {
  assert.equal(classifyError(404, ''), 'bad_model');
});

test('classifyError: 400 with model_not_found is bad_model', () => {
  assert.equal(classifyError(400, '{"error":{"code":"model_not_found"}}'), 'bad_model');
  assert.equal(classifyError(400, 'unknown model "foo"'), 'bad_model');
});

test('classifyError: other 4xx is client', () => {
  assert.equal(classifyError(400, '{"error":{"message":"bad messages"}}'), 'client');
  assert.equal(classifyError(422, ''), 'client');
});

test('classifyError: 2xx is ok', () => {
  assert.equal(classifyError(200, ''), 'ok');
  assert.equal(classifyError(201, ''), 'ok');
});

test('classifyError: network errors (status=0) are transient', () => {
  assert.equal(classifyError(0, ''), 'transient');
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd ~/Desktop/llm-bridge
node --test test/providers/base.test.js
```

Expected: FAIL with `Cannot find module '../../lib/providers/base.js'`

- [ ] **Step 4: Implement minimal lib/providers/base.js**

```js
// lib/providers/base.js
// Provider plugin sözleşmesi + hata sınıflandırma.

const TRANSIENT_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

export class ProviderError extends Error {
  constructor(message, { status = 0, body = null, category = 'transient', cause = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.body = body;
    this.category = category;
    this.cause = cause;
  }
}

// HTTP status + response body'den kategori türet.
// Kategoriler: 'ok' | 'transient' | 'auth' | 'bad_model' | 'client'
export function classifyError(status, body) {
  if (status >= 200 && status < 300) return 'ok';
  if (TRANSIENT_STATUSES.has(status)) return 'transient';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'bad_model';
  if (status === 400) {
    const lower = String(body || '').toLowerCase();
    if (lower.includes('model_not_found') || /unknown model|model.*not.*found/.test(lower)) {
      return 'bad_model';
    }
    return 'client';
  }
  if (status >= 400 && status < 500) return 'client';
  return 'transient';
}

// BaseProvider — alt sınıflar override eder.
export class BaseProvider {
  constructor(config) {
    if (!config || !config.id) throw new Error('BaseProvider: config.id zorunlu');
    this.id = config.id;
    this.config = config;
  }

  async chat(_body, _opts = {}) {
    throw new Error(`${this.constructor.name}.chat not implemented`);
  }

  async listModels() {
    throw new Error(`${this.constructor.name}.listModels not implemented`);
  }

  async healthCheck() {
    throw new Error(`${this.constructor.name}.healthCheck not implemented`);
  }

  supportsNativeTools() { return false; }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
node --test test/providers/base.test.js
```

Expected: 8/8 PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/providers/base.js test/providers/base.test.js
git commit -m "feat(providers): add BaseProvider + ProviderError + classifyError"
```

---

## Task 2: OpenaiCompatProvider — chat() (mocked)

**Files:**
- Create: `lib/providers/openai-compat.js`
- Test: `test/providers/openai-compat.test.js`

**Background:** Spec §4.2 — OpenaiCompatProvider HTTPS POST `{base_url}/v1/chat/completions` yapar; cevabı `{ text, native_tool_calls?, usage, finish_reason, raw }` formatına normalize eder. Mevcut `lib/upstream.js`'in `postChatCompletion` ve retry/cooldown mantığını burada içselleştirir.

- [ ] **Step 1: Failing test yaz — basit chat yanıtı**

`test/providers/openai-compat.test.js`:

```js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OpenaiCompatProvider } from '../../lib/providers/openai-compat.js';
import { ProviderError } from '../../lib/providers/base.js';

const realFetch = globalThis.fetch;
let mockResponses = [];

function setMock(...responses) {
  mockResponses = responses.slice();
  globalThis.fetch = async (url, init) => {
    const next = mockResponses.shift();
    if (!next) throw new Error('mock: unexpected fetch call to ' + url);
    if (typeof next === 'function') return next(url, init);
    return next;
  };
}

beforeEach(() => { mockResponses = []; });
afterEach(() => { globalThis.fetch = realFetch; });

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('chat() POSTs to /v1/chat/completions and normalizes response', async () => {
  setMock(jsonResponse(200, {
    id: 'chatcmpl-1',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'merhaba' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  }));

  const p = new OpenaiCompatProvider({
    id: 'test',
    base_url: 'https://api.example.com',
    api_key: 'sk-test',
    timeout_ms: 5000,
  });

  const out = await p.chat({
    model: 'm1',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(out.text, 'merhaba');
  assert.equal(out.finish_reason, 'stop');
  assert.equal(out.native_tool_calls, undefined);
  assert.deepEqual(out.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  assert.ok(out.raw);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/providers/openai-compat.test.js
```

Expected: FAIL — `Cannot find module '../../lib/providers/openai-compat.js'`.

- [ ] **Step 3: Minimal implementation**

`lib/providers/openai-compat.js`:

```js
// OpenAI-compat provider plugin: POST {base_url}/v1/chat/completions
// + GET /v1/models, healthCheck, retry+timeout.

import { BaseProvider, ProviderError, classifyError } from './base.js';
import { sleep } from '../util.js';

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 200;

export class OpenaiCompatProvider extends BaseProvider {
  constructor(config) {
    super(config);
    this.baseUrl = String(config.base_url || '').replace(/\/+$/, '');
    if (!this.baseUrl) throw new Error(`provider ${this.id}: base_url zorunlu`);
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
      'user-agent': 'llm-bridge/0.2',
      ...this.headers,
      ...extra,
    };
    if (this.apiKey) {
      h['authorization'] = `Bearer ${this.apiKey}`;
      h['x-api-key'] = this.apiKey;
    }
    return h;
  }

  async _fetchOnce(method, urlPath, body, opts = {}) {
    const url = this.baseUrl + urlPath;
    const ctrl = new AbortController();
    const timeoutMs = opts.timeout_ms || this.timeoutMs;
    const timer = setTimeout(() => ctrl.abort(new Error('upstream timeout')), timeoutMs);
    try {
      const init = {
        method,
        headers: this.buildHeaders(opts.headers),
        signal: ctrl.signal,
      };
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
          if (ct.includes('application/json')) {
            return { res, json: await res.json() };
          }
          return { res, json: null, text: await res.text() };
        }
        const errText = await res.text().catch(() => '');
        const cat = classifyError(res.status, errText);
        if (cat === 'transient' && attempt < maxAttempts) {
          const jitter = Math.random() * this.retryBaseMs;
          await sleep(this.retryBaseMs * Math.pow(2, attempt - 1) + jitter);
          continue;
        }
        throw new ProviderError(`upstream ${res.status}`, {
          status: res.status,
          body: errText,
          category: cat,
        });
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        lastErr = err;
        if (attempt === maxAttempts) {
          throw new ProviderError(err.message || 'network error', {
            status: 0,
            category: 'transient',
            cause: err,
          });
        }
        const jitter = Math.random() * this.retryBaseMs;
        await sleep(this.retryBaseMs * Math.pow(2, attempt - 1) + jitter);
      }
    }
    throw lastErr || new ProviderError('unexpected');
  }

  async chat(body, opts = {}) {
    const upstreamBody = { ...body, stream: false };
    const { json } = await this._request('POST', '/v1/chat/completions', upstreamBody, opts);
    if (!json || !json.choices) {
      throw new ProviderError('upstream returned no choices', {
        status: 0,
        category: 'transient',
      });
    }
    const choice = json.choices[0] || {};
    const message = choice.message || {};
    const text = typeof message.content === 'string' ? message.content : '';
    const out = {
      text,
      usage: json.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      finish_reason: choice.finish_reason || 'stop',
      raw: json,
    };
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      out.native_tool_calls = message.tool_calls;
    }
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/providers/openai-compat.test.js
```

Expected: 1/1 PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/providers/openai-compat.js test/providers/openai-compat.test.js
git commit -m "feat(providers): add OpenaiCompatProvider.chat() with retry"
```

---

## Task 3: OpenaiCompatProvider — native tool_calls passthrough

**Files:**
- Modify: `test/providers/openai-compat.test.js`
- (Implementation already supports it; only verify with test.)

- [ ] **Step 1: Add failing test for native_tool_calls**

`test/providers/openai-compat.test.js` dosyasının sonuna ekle:

```js
test('chat() passes through native tool_calls when present', async () => {
  setMock(jsonResponse(200, {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Istanbul"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  }));

  const p = new OpenaiCompatProvider({
    id: 'test', base_url: 'https://api.example.com', api_key: 'sk-test',
  });
  const out = await p.chat({ model: 'm1', messages: [] });

  assert.ok(Array.isArray(out.native_tool_calls));
  assert.equal(out.native_tool_calls.length, 1);
  assert.equal(out.native_tool_calls[0].function.name, 'get_weather');
  assert.equal(out.text, '');
  assert.equal(out.finish_reason, 'tool_calls');
});
```

- [ ] **Step 2: Run test**

```bash
node --test test/providers/openai-compat.test.js
```

Expected: 2/2 PASS (Task 2 implementation zaten bunu destekliyor).

- [ ] **Step 3: Commit**

```bash
git add test/providers/openai-compat.test.js
git commit -m "test(providers): cover native tool_calls passthrough"
```

---

## Task 4: OpenaiCompatProvider — error categorization tests

**Files:**
- Modify: `test/providers/openai-compat.test.js`

- [ ] **Step 1: Failing test — auth error**

`test/providers/openai-compat.test.js` sonuna ekle:

```js
test('chat() throws ProviderError(category=auth) on 401', async () => {
  setMock(jsonResponse(401, { error: { message: 'invalid key' } }));

  const p = new OpenaiCompatProvider({
    id: 'test', base_url: 'https://api.example.com', api_key: 'sk-bad',
    max_attempts: 1,
  });
  await assert.rejects(
    () => p.chat({ model: 'm1', messages: [] }),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.category, 'auth');
      assert.equal(err.status, 401);
      return true;
    }
  );
});

test('chat() retries on 502 then succeeds', async () => {
  setMock(
    jsonResponse(502, { error: { message: 'bad gateway' } }),
    jsonResponse(200, {
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  );

  const p = new OpenaiCompatProvider({
    id: 'test', base_url: 'https://api.example.com', api_key: 'sk',
    max_attempts: 3, retry_base_ms: 1,
  });
  const out = await p.chat({ model: 'm1', messages: [] });
  assert.equal(out.text, 'ok');
});

test('chat() throws ProviderError(category=client) on 422', async () => {
  setMock(jsonResponse(422, { error: { message: 'invalid messages' } }));
  const p = new OpenaiCompatProvider({
    id: 'test', base_url: 'https://api.example.com', api_key: 'sk', max_attempts: 1,
  });
  await assert.rejects(
    () => p.chat({ model: 'm1', messages: [] }),
    (err) => err.category === 'client' && err.status === 422,
  );
});
```

- [ ] **Step 2: Run test**

```bash
node --test test/providers/openai-compat.test.js
```

Expected: 5/5 PASS.

- [ ] **Step 3: Commit**

```bash
git add test/providers/openai-compat.test.js
git commit -m "test(providers): cover error categorization (auth/transient/client)"
```

---

## Task 5: OpenaiCompatProvider — listModels()

**Files:**
- Modify: `lib/providers/openai-compat.js`
- Modify: `test/providers/openai-compat.test.js`

- [ ] **Step 1: Failing test**

`test/providers/openai-compat.test.js` sonuna ekle:

```js
test('listModels() GETs /v1/models and returns data array', async () => {
  setMock(jsonResponse(200, {
    object: 'list',
    data: [
      { id: 'gpt-4o', object: 'model', owned_by: 'openai' },
      { id: 'glm-4.6', object: 'model', owned_by: 'zai' },
    ],
  }));

  const p = new OpenaiCompatProvider({
    id: 'test', base_url: 'https://api.example.com', api_key: 'sk',
  });
  const models = await p.listModels();
  assert.equal(models.length, 2);
  assert.deepEqual(models.map((m) => m.id), ['gpt-4o', 'glm-4.6']);
});

test('listModels() returns [] when /v1/models 404s', async () => {
  setMock(jsonResponse(404, { error: { message: 'not found' } }));
  const p = new OpenaiCompatProvider({
    id: 'test', base_url: 'https://api.example.com', api_key: 'sk',
    max_attempts: 1,
  });
  const models = await p.listModels();
  assert.deepEqual(models, []);
});
```

- [ ] **Step 2: Run test**

```bash
node --test test/providers/openai-compat.test.js
```

Expected: FAIL — `listModels not implemented`.

- [ ] **Step 3: Implement**

`lib/providers/openai-compat.js`'e ekle (class içinde, `chat()`'ten sonra):

```js
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
```

- [ ] **Step 4: Run test**

```bash
node --test test/providers/openai-compat.test.js
```

Expected: 7/7 PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/providers/openai-compat.js test/providers/openai-compat.test.js
git commit -m "feat(providers): OpenaiCompatProvider.listModels()"
```

---

## Task 6: OpenaiCompatProvider — healthCheck()

**Files:**
- Modify: `lib/providers/openai-compat.js`
- Modify: `test/providers/openai-compat.test.js`

- [ ] **Step 1: Failing test**

`test/providers/openai-compat.test.js` sonuna ekle:

```js
test('healthCheck() returns ok=true on 200', async () => {
  setMock(jsonResponse(200, {
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));

  const p = new OpenaiCompatProvider({
    id: 'test', base_url: 'https://api.example.com', api_key: 'sk',
  });
  const h = await p.healthCheck({ model: 'm1' });
  assert.equal(h.ok, true);
  assert.ok(typeof h.latency_ms === 'number');
});

test('healthCheck() returns ok=false on 401', async () => {
  setMock(jsonResponse(401, { error: { message: 'no' } }));

  const p = new OpenaiCompatProvider({
    id: 'test', base_url: 'https://api.example.com', api_key: 'bad',
    max_attempts: 1,
  });
  const h = await p.healthCheck({ model: 'm1' });
  assert.equal(h.ok, false);
  assert.equal(h.category, 'auth');
});
```

- [ ] **Step 2: Run test**

```bash
node --test test/providers/openai-compat.test.js
```

Expected: FAIL — `healthCheck not implemented`.

- [ ] **Step 3: Implement**

`lib/providers/openai-compat.js`'e ekle:

```js
  async healthCheck({ model } = {}) {
    const start = Date.now();
    try {
      await this.chat(
        {
          model: model || 'unknown',
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        },
        { max_attempts: 1 },
      );
      return { ok: true, latency_ms: Date.now() - start };
    } catch (err) {
      return {
        ok: false,
        latency_ms: Date.now() - start,
        category: err?.category || 'transient',
        status: err?.status || 0,
        error: err?.message || String(err),
      };
    }
  }
```

- [ ] **Step 4: Run test**

```bash
node --test test/providers/openai-compat.test.js
```

Expected: 9/9 PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/providers/openai-compat.js test/providers/openai-compat.test.js
git commit -m "feat(providers): OpenaiCompatProvider.healthCheck()"
```

---

## Task 7: getDefaultProvider() factory

**Files:**
- Create: `lib/providers/factory.js`
- Test: `test/providers/factory.test.js`

**Background:** Faz 1'de henüz `data/providers.json` yok; factory tek provider'ı `.env` config'inden yaratır. Faz 2'de bu, registry tarafından replace edilecek. Bu Faz 1 abstraction'ı oluşturur ki adapter'lar `getDefaultProvider().chat()` çağırabilsin.

- [ ] **Step 1: Failing test**

`test/providers/factory.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderFromEnvConfig } from '../../lib/providers/factory.js';
import { OpenaiCompatProvider } from '../../lib/providers/openai-compat.js';

test('buildProviderFromEnvConfig creates OpenaiCompatProvider with api.airforce defaults', () => {
  const cfg = {
    airforceApiKey: 'sk-air-test',
    upstreamBaseUrl: 'https://api.airforce',
    upstreamTimeoutMs: 90000,
    upstreamMaxAttempts: 2,
    upstreamRetryBaseMs: 100,
  };
  const p = buildProviderFromEnvConfig(cfg);
  assert.ok(p instanceof OpenaiCompatProvider);
  assert.equal(p.id, 'airforce');
  assert.equal(p.baseUrl, 'https://api.airforce');
  assert.equal(p.apiKey, 'sk-air-test');
  assert.equal(p.timeoutMs, 90000);
});

test('buildProviderFromEnvConfig throws when api key missing', () => {
  assert.throws(
    () => buildProviderFromEnvConfig({ airforceApiKey: '', upstreamBaseUrl: 'x' }),
    /api key/i,
  );
});
```

- [ ] **Step 2: Run test**

```bash
node --test test/providers/factory.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`lib/providers/factory.js`:

```js
// Tek-provider factory (Faz 1).
// Faz 2'de ModelRegistry bu modülü replace edecek.

import { OpenaiCompatProvider } from './openai-compat.js';

let cached = null;

export function buildProviderFromEnvConfig(cfg) {
  if (!cfg.airforceApiKey) {
    throw new Error('AIRFORCE_API_KEY tanımlı değil — .env dosyasını kontrol et (api key zorunlu)');
  }
  return new OpenaiCompatProvider({
    id: 'airforce',
    base_url: cfg.upstreamBaseUrl || 'https://api.airforce',
    api_key: cfg.airforceApiKey,
    timeout_ms: cfg.upstreamTimeoutMs,
    max_attempts: cfg.upstreamMaxAttempts,
    retry_base_ms: cfg.upstreamRetryBaseMs,
  });
}

export function getDefaultProvider() {
  if (!cached) {
    // Lazy import to avoid circular: config.js loads .env at import time.
    const { config } = await import('../config.js');
    cached = buildProviderFromEnvConfig(config);
  }
  return cached;
}

// Test/admin reload için.
export function _resetDefaultProvider() { cached = null; }
```

**Not:** `getDefaultProvider()` `await import` kullanıyor → bu yanlış syntax (regular function async olmalı). Düzeltilmiş hali:

```js
export async function getDefaultProvider() {
  if (!cached) {
    const { config } = await import('../config.js');
    cached = buildProviderFromEnvConfig(config);
  }
  return cached;
}
```

- [ ] **Step 4: Run test**

```bash
node --test test/providers/factory.test.js
```

Expected: 2/2 PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/providers/factory.js test/providers/factory.test.js
git commit -m "feat(providers): getDefaultProvider() factory from env config"
```

---

## Task 8: Adapter migration — adapters/openai.js

**Files:**
- Modify: `lib/adapters/openai.js`
- Modify: `package.json` (test script)

**Background:** Mevcut `lib/adapters/openai.js`, `postChatCompletion(upstreamBody)` çağırıyor. Şimdi `getDefaultProvider().chat(upstreamBody)` ile değiştir. Tool-engine logic değişmiyor.

- [ ] **Step 1: Mevcut test'leri çalıştır (regression baseline)**

```bash
cd ~/Desktop/llm-bridge
node --test test/parse.test.js test/inject.test.js test/serialize-history.test.js test/tier.test.js
```

Expected: tüm testler geçmeli (mevcut sistem). Geçmiyorsa bu plana başlamadan önce sorun var, dur.

- [ ] **Step 2: `lib/adapters/openai.js`'i edit et**

Aç ve şu değişiklikleri yap:

**Eski import:**
```js
import { postChatCompletion, UpstreamError } from '../upstream.js';
```

**Yeni import:**
```js
import { getDefaultProvider } from '../providers/factory.js';
import { ProviderError } from '../providers/base.js';
```

**Eski body construction + call (içeride `postChatCompletion(upstreamBody)`):**

```js
  let completion;
  try {
    completion = await postChatCompletion(upstreamBody);
  } catch (err) {
    log.error('openai upstream error', { err: err.message, status: err.status });
    return errorResponse(res, err.status || 502, err.message || 'Upstream error');
  }
```

**Yeni:**

```js
  let providerResult;
  try {
    const provider = await getDefaultProvider();
    providerResult = await provider.chat(upstreamBody);
  } catch (err) {
    const status = (err instanceof ProviderError) ? (err.status || 502) : 502;
    log.error('openai upstream error', { err: err.message, status, category: err?.category });
    return errorResponse(res, status, err.message || 'Upstream error');
  }
```

**Akabinde `completion = ...` kullanan kodda:**

Eski:
```js
  if (!completion || !completion.choices) { ... }
  const choice = completion.choices[0] || {};
  const message = choice.message || {};
  const rawText = typeof message.content === 'string' ? message.content : flattenContent(message.content);
```

Yeni:
```js
  // Provider'dan normalize edilmiş yanıt: { text, native_tool_calls?, usage, finish_reason, raw }
  const rawText = providerResult.text || '';
  const completion = providerResult.raw;  // mevcut yardımcılar (respondWithMessage) ham OpenAI shape'ini bekleyebilir
  const choice = (completion?.choices?.[0]) || {};
  const message = choice.message || {};
```

**Tool-call selection logic'i (`if (parsed.calls.length)` etrafı):** native vs xml karar şu an snapshot'tan değil, sadece "tools varsa XML inject" varsayımıyla çalışıyor (mevcut davranış). Faz 1'de korunuyor — Faz 2/3'te capability snapshot'a göre native passthrough değiştirilecek.

- [ ] **Step 3: Tüm mevcut testleri tekrar çalıştır**

```bash
node --test test/parse.test.js test/inject.test.js test/serialize-history.test.js test/tier.test.js
```

Expected: hepsi PASS.

- [ ] **Step 4: package.json test script'i güncelle**

Aç `package.json`, `scripts.test`:

Eski:
```json
"test": "node --test test/parse.test.js test/inject.test.js test/serialize-history.test.js test/tier.test.js"
```

Yeni:
```json
"test": "node --test test/*.test.js test/providers/*.test.js"
```

- [ ] **Step 5: npm test çalıştır**

```bash
npm test 2>&1 | tail -25
```

Expected: tüm testler PASS (24 mevcut + 9+ yeni).

- [ ] **Step 6: Commit**

```bash
git add lib/adapters/openai.js package.json
git commit -m "feat(adapters): openai.js uses provider abstraction (getDefaultProvider)"
```

---

## Task 9: Adapter migration — adapters/anthropic.js

**Files:**
- Modify: `lib/adapters/anthropic.js`

**Background:** Aynı pattern, OpenAI adapter ile birebir.

- [ ] **Step 1: Mevcut anthropic.js'i incele**

```bash
grep -n "postChatCompletion\|UpstreamError\|upstream\.js" lib/adapters/anthropic.js
```

- [ ] **Step 2: Aynı değişikliği yap**

`lib/adapters/anthropic.js`:

Eski import:
```js
import { postChatCompletion, UpstreamError } from '../upstream.js';
```

Yeni:
```js
import { getDefaultProvider } from '../providers/factory.js';
import { ProviderError } from '../providers/base.js';
```

Eski upstream call (`completion = await postChatCompletion(upstreamBody)`):
```js
  let completion;
  try {
    completion = await postChatCompletion(upstreamBody);
  } catch (err) {
    ...
  }
```

Yeni:
```js
  let providerResult;
  try {
    const provider = await getDefaultProvider();
    providerResult = await provider.chat(upstreamBody);
  } catch (err) {
    const status = (err instanceof ProviderError) ? (err.status || 502) : 502;
    log.error('anthropic upstream error', { err: err.message, status, category: err?.category });
    return errorResponse(res, status, err.message || 'Upstream error');
  }
  const completion = providerResult.raw;
```

(Geri kalan tool-engine işleyişi `completion` değişkenini OpenAI shape olarak bekliyor; `providerResult.raw` aynı shape'i veriyor.)

- [ ] **Step 3: Test çalıştır**

```bash
npm test 2>&1 | tail -10
```

Expected: tüm testler PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/adapters/anthropic.js
git commit -m "feat(adapters): anthropic.js uses provider abstraction"
```

---

## Task 10: Models adapter migration

**Files:**
- Modify: `lib/adapters/models.js`

**Background:** `models.js` şu anda `fetchModels` (upstream.js'den) çağırıyor. `provider.listModels()` ile değiştir.

- [ ] **Step 1: Edit**

Eski import:
```js
import { fetchModels } from '../upstream.js';
```

Yeni:
```js
import { getDefaultProvider } from '../providers/factory.js';
```

Eski `fetchModels()` çağrısı:
```js
      const upstream = await fetchModels();
      const data = upstream
        .filter((m) => m.supports_chat && m.status === 'operational')
        .map((m) => ({
          id: m.id,
          object: 'model',
          ...
```

Yeni:
```js
      const provider = await getDefaultProvider();
      const upstream = await provider.listModels();
      const data = upstream
        .filter((m) => m.supports_chat && m.status === 'operational')
        .map((m) => ({
          id: m.id,
          object: 'model',
          ...
```

(API.airforce'un `/v1/models` cevabı `supports_chat`, `status`, `owned_by` alanlarını içeriyor — provider.listModels() ham `data[]`'i döndürüyor, dolayısıyla bu alanlar erişilebilir.)

- [ ] **Step 2: Test çalıştır**

```bash
npm test 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/adapters/models.js
git commit -m "feat(adapters): models.js uses provider.listModels()"
```

---

## Task 11: Probe migration

**Files:**
- Modify: `lib/probe.js`

**Background:** `probe.js` `fetchModels` ve `upstreamJson` kullanıyor. `provider.listModels()` ve `provider.chat()` ile değiştir.

- [ ] **Step 1: probe.js'in mevcut import'larını oku**

```bash
grep -n "upstream\|fetchModels\|UpstreamError" lib/probe.js
```

- [ ] **Step 2: Import'ları değiştir**

Eski:
```js
import { fetchModels, upstreamJson, UpstreamError } from './upstream.js';
```

Yeni:
```js
import { getDefaultProvider } from './providers/factory.js';
import { ProviderError } from './providers/base.js';
```

- [ ] **Step 3: `fetchModels()` çağrılarını `provider.listModels()` ile değiştir**

`probe.js` içinde tüm `fetchModels()` veya `await fetchModels(...)` esnasında:

Eski örnek:
```js
const all = await fetchModels();
```

Yeni:
```js
const provider = await getDefaultProvider();
const all = await provider.listModels();
```

- [ ] **Step 4: `upstreamJson(...)` çağrılarını `provider.chat(...)` ile değiştir**

Probe içinde native test ve XML test için `upstreamJson('POST', '/v1/chat/completions', body)` çağrıları var. Bunları:

Eski:
```js
const { json } = await upstreamJson('POST', '/v1/chat/completions', body);
```

Yeni:
```js
const result = await provider.chat(body, { max_attempts: 1 });
const json = result.raw;  // probe mevcutta json'u bekliyor
```

- [ ] **Step 5: `UpstreamError` referanslarını `ProviderError` yap**

```bash
sed -i '' 's/UpstreamError/ProviderError/g' lib/probe.js
```

(macOS sed; Linux'ta `-i` boş string olmadan.)

- [ ] **Step 6: Test çalıştır**

```bash
npm test 2>&1 | tail -10
```

Expected: PASS (probe.js'in unit test'i yok, sadece import patlarsa diğer modüller etkilenir).

- [ ] **Step 7: Probe komutunu manuel çalıştır**

`.env` dosyasında geçerli `AIRFORCE_API_KEY` olduğunu varsayarak (lokal dev'de):

```bash
test -f .env && npm run probe 2>&1 | tail -15
```

Expected: hata yok; "probe: ... ok" mesajları (gerçek api.airforce'a vurur, internet gerek). `.env` yoksa skip.

- [ ] **Step 8: Commit**

```bash
git add lib/probe.js
git commit -m "feat(probe): use provider abstraction"
```

---

## Task 12: Admin router migration + delete upstream.js

**Files:**
- Modify: `lib/admin-router.js`
- Delete: `lib/upstream.js`

- [ ] **Step 1: admin-router.js'in upstream import'larını bul**

```bash
grep -n "upstream\|fetchModels" lib/admin-router.js
```

Beklenen: `import { fetchModels } from '../upstream.js';` veya benzeri.

- [ ] **Step 2: Değiştir**

Eski:
```js
import { fetchModels } from './upstream.js';
```

Yeni:
```js
import { getDefaultProvider } from './providers/factory.js';
```

İçeride `await fetchModels()` çağrılarını:
```js
const provider = await getDefaultProvider();
const list = await provider.listModels();
```

- [ ] **Step 3: lib/upstream.js'i sil**

```bash
rm lib/upstream.js
```

- [ ] **Step 4: Hâlâ upstream.js'e referans var mı kontrol et**

```bash
grep -rn "from.*upstream\.js\|require.*upstream\.js" lib/ test/ server.js 2>&1 | grep -v node_modules
```

Expected: boş (silindi, hiçbir yerde referans olmamalı).

- [ ] **Step 5: Tüm testleri çalıştır**

```bash
npm test 2>&1 | tail -15
```

Expected: tüm testler PASS.

- [ ] **Step 6: Server'ı boot edip /healthz kontrolü**

```bash
node server.js &
SERVER_PID=$!
sleep 2
curl -s http://localhost:2393/healthz
kill $SERVER_PID
```

Expected: JSON yanıt, `haveAirforceKey: true` (lokalde .env varsa).

- [ ] **Step 7: Commit**

```bash
git add lib/admin-router.js
git rm lib/upstream.js
git commit -m "refactor: remove lib/upstream.js (replaced by provider abstraction)"
```

---

## Task 13: End-to-end smoke (telefondaki kuruluma deploy + test)

**Files:** _(none — runtime test)_

**Background:** Faz 1 değişiklikleri lokal test'lerden geçti, ama gerçek telefon kurulumunda da çalıştığını doğrulayalım. Telefonda `~/airforce-bridge/` mevcut kurulum (eski kod). Bu testten **önce** telefondaki klasöre dokunma — Faz 1 stabil olunca bridge'i upgrade edeceğiz.

Bu task sadece doğrulama amaçlı bir lokal smoke test, telefona deploy etmiyoruz.

- [ ] **Step 1: Lokal `.env` hazırla**

```bash
cd ~/Desktop/llm-bridge
test -f .env || cat > .env <<'EOF'
AIRFORCE_API_KEY=sk-air-CGmiWbVbf6lcQsBIRcJRPl5qUAkrYJFPh8CncXD8VzjWW0MjVA62eLt4ao8ZHOim
PORT=2399
HOST=127.0.0.1
BRIDGE_API_KEYS=test-key
TOOL_ENGINE_FORCE_XML=1
LOG_LEVEL=info
EOF
```

(Lokal port 2399, telefondaki 2393'ten farklı.)

- [ ] **Step 2: Server'ı başlat**

```bash
node server.js > /tmp/llm-bridge-test.log 2>&1 &
SERVER_PID=$!
sleep 3
```

- [ ] **Step 3: /healthz**

```bash
curl -s http://127.0.0.1:2399/healthz
```

Expected: JSON `{"ok":true,...}`.

- [ ] **Step 4: /v1/models (auth)**

```bash
curl -s http://127.0.0.1:2399/v1/models -H "Authorization: Bearer test-key" | head -c 400
```

Expected: model listesi.

- [ ] **Step 5: Gerçek chat completion**

```bash
curl -s -X POST http://127.0.0.1:2399/v1/chat/completions \
  -H "Authorization: Bearer test-key" \
  -H "content-type: application/json" \
  -d '{"model":"glm-4.6","messages":[{"role":"user","content":"sadece tek kelime yaz: ping"}]}' \
  --max-time 60
```

Expected: `{"id":"chatcmpl-...","choices":[{"message":{"content":"ping",...}}],...}`.

- [ ] **Step 6: Server'ı durdur**

```bash
kill $SERVER_PID
rm /tmp/llm-bridge-test.log
```

- [ ] **Step 7: Eğer hepsi geçtiyse commit (CHANGELOG)**

`CHANGELOG.md` (yoksa oluştur):

```markdown
# Changelog

## [Unreleased] — Phase 1: Provider Base

- Provider plugin abstraction (`BaseProvider`, `OpenaiCompatProvider`)
- `lib/upstream.js` removed; replaced by `lib/providers/openai-compat.js`
- Adapter'lar (`openai`, `anthropic`, `models`) ve `probe.js` artık provider üzerinden çalışıyor
- Tool-engine modülleri değişmedi
- Yeni testler: `test/providers/base.test.js`, `test/providers/openai-compat.test.js`, `test/providers/factory.test.js`
```

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for phase 1"
```

---

## Task 14: PR develop'a → master release

**Files:** _(none — git only)_

- [ ] **Step 1: Branch'i push'la**

```bash
git push origin feat/01-provider-base
```

- [ ] **Step 2: develop'a PR aç**

```bash
gh pr create --base develop --head feat/01-provider-base \
  --title "Phase 1: Provider Base abstraction" \
  --body "$(cat <<'EOF'
## Summary
- `lib/upstream.js` silindi; yerine `lib/providers/{base,openai-compat,factory}.js` kuruldu
- Adapter'lar (`openai`, `anthropic`, `models`) ve `probe.js` artık provider abstraction üzerinden çalışıyor
- Tool-engine modülleri **dokunulmadı**
- Tek-provider varsayımı korundu (Faz 2'de router/registry ekleyeceğiz)

## Test plan
- [x] `node --test test/providers/base.test.js` PASS (8)
- [x] `node --test test/providers/openai-compat.test.js` PASS (9)
- [x] `node --test test/providers/factory.test.js` PASS (2)
- [x] Mevcut testler PASS (parse, inject, serialize-history, tier — 24 toplam)
- [x] Server boot + /healthz + /v1/models + gerçek chat completion smoke test geçti
EOF
)"
```

- [ ] **Step 3: PR yeşilse develop'a merge**

```bash
gh pr merge --squash --delete-branch
```

- [ ] **Step 4: develop → master release PR**

```bash
git checkout develop
git pull origin develop
gh pr create --base master --head develop \
  --title "Release: phase 1 (provider base)" \
  --body "Phase 1 implementation merged."
```

- [ ] **Step 5: Master'a merge**

```bash
gh pr merge --squash
```

- [ ] **Step 6: Tag'le**

```bash
git checkout master
git pull origin master
git tag v0.2.0-phase1
git push origin v0.2.0-phase1
```

---

## Self-Review

**Spec coverage:**
- §3.1 (klasör yapısı): Task 1, 2, 7, 12 — `providers/` ve `upstream.js` silinmesi ✓
- §3.2 (request flow): Task 8, 9 — adapter'lar provider üzerinden ✓
- §4.1 (BaseProvider): Task 1 ✓
- §4.2 (OpenaiCompatProvider): Task 2-6 ✓
- §4.3 (AnthropicNativeProvider): Faz 3'te (şu plan kapsamı dışı) ✓
- §4.4 (Hata sınıflandırması): Task 1 + Task 4 ✓
- §4.5 (Native tool calling sinyali): Task 3 (passthrough). Capability snapshot entegrasyonu Faz 2'de. ✓
- §5 (Router/Registry/Breaker): Faz 2 ✓
- §6 (Config/Migration): Faz 4 ✓
- §7 (Admin Panel): Faz 4 ✓
- §8 (Probe): Task 11 (mevcut probe provider üzerinden); multi-provider probe Faz 5 ✓
- §9 (Testing): Task 1-7 + 13 ✓
- §13 (DoD): Mevcut testler korunuyor (Task 8 baseline + Task 13 smoke) ✓

**Placeholder scan:** Task 7'de `getDefaultProvider`'ın yanlış syntax (`await` non-async function'da) örneğinden sonra düzeltilmiş hali var; dikkat — implement ederken **düzeltilmiş hali** kullan. Diğer her step'te tam kod.

**Type consistency:**
- `ProviderError(message, { status, body, category, cause })` — tutarlı (Task 1, 2, 4, 8, 9).
- `provider.chat(body)` → `{ text, native_tool_calls?, usage, finish_reason, raw }` — tutarlı.
- `provider.listModels()` → `Array<{id, ...}>` — tutarlı.
- `getDefaultProvider()` async return → adapter'larda `await getDefaultProvider()` — tutarlı.

**Risks:**
- Task 11 (probe) `upstreamJson` kullanımının yapısı `probe.js`'in iç akışına göre özel; orijinal kodla göz alışkanlığı gerekebilir, sed bazlı toplu değişiklik yetmeyebilir. İmplementasyonda `probe.js`'i tek tek incele.
- `respondWithMessage(res, presentedModel, completion, ...)` `completion`'ın `id` ve `created` alanlarını okuyor; `providerResult.raw` bunları içeriyor (api.airforce response shape). Diğer provider'lara geçince Faz 2'de re-test gerek.
