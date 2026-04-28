# Phase 3 — Anthropic Native Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `api.anthropic.com`'a direkt bağlanan `AnthropicNativeProvider` ekle. İki kullanım: (1) OpenAI istemcisi `claude-sonnet-4` derse Router bu provider'a yönlendirir, format dönüşümü yapılır; (2) `/v1/messages` endpoint'i (bridge'in Anthropic adapter'ı) anthropic-native provider'ın `request()` köprüsünden direkt geçer (format dönüşümsüz, çünkü body zaten Anthropic-shape).

**Architecture:** Yeni `lib/providers/anthropic-native.js` — `BaseProvider`'ı extend eder. Ortak format dönüşüm fonksiyonları `lib/providers/format-conversion.js`'e çıkarılır (OpenAI body → Anthropic body, Anthropic response → OpenAI shape). `lib/providers/factory.js` `'anthropic-native': AnthropicNativeProvider` map'i kazanır. `lib/adapters/anthropic.js` Phase 2 köprüsünü güçlendirir: artık önce anthropic-native provider'ı arar, yoksa openai-compat'a fallback eder.

**Tech Stack:** Node.js >=20, ES modules, native fetch. No external deps.

**Scope (v1 limit):** Sadece text + tool_use + tool_result content blocks. Image/document block'lar `client` kategori hata ile reddedilir (Phase 4 sonrası).

---

## File Structure

**Create:**
- `lib/providers/format-conversion.js` — `openaiToAnthropicBody(body)`, `anthropicToOpenaiResponse(payload)`, ortak yardımcılar
- `lib/providers/anthropic-native.js` — `AnthropicNativeProvider` (chat, listModels, healthCheck, request)
- `test/providers/format-conversion.test.js`
- `test/providers/anthropic-native.test.js`

**Modify:**
- `lib/providers/factory.js` — `PROVIDER_TYPES` map'ine `'anthropic-native'` ekle
- `lib/adapters/anthropic.js` — anthropic-native provider'ı önce dene; yoksa openai-compat fallback (Phase 2 davranışı)
- `CHANGELOG.md` — Phase 3 entry; `package.json` `version: 0.4.0`

**Untouched:**
- Tool-engine modülleri (5 dosya)
- Phase 1/2 çıktıları (`circuit-breaker.js`, `model-registry.js`, `router.js`, `store.js`, `rate-limit.js`, `providers/{base,openai-compat,factory}.js`)

---

## Task 0: Branch setup

- [ ] **Step 1: develop'tan feat branch'i**

```bash
cd ~/Desktop/llm-bridge
git checkout develop
git pull origin develop
git checkout -b feat/03-anthropic-native
git push -u origin feat/03-anthropic-native
```

---

## Task 1: Format conversion utilities

**Files:**
- Create: `lib/providers/format-conversion.js`
- Test: `test/providers/format-conversion.test.js`

**Background:** OpenAI Chat Completions body Anthropic Messages body'sine çevirilir. Iki shape farkı:

| Alan | OpenAI | Anthropic |
|---|---|---|
| Sistem prompt | `messages[0]` (role:'system') | top-level `system: string` |
| User text | `{role:'user', content:'...'}` | `{role:'user', content:[{type:'text', text:'...'}]}` |
| Assistant tool call | `{role:'assistant', tool_calls:[{id, function:{name, arguments:string}}]}` | `{role:'assistant', content:[{type:'tool_use', id, name, input}]}` |
| Tool result | `{role:'tool', tool_call_id, content}` | `{role:'user', content:[{type:'tool_result', tool_use_id, content}]}` |
| Tools | `[{type:'function', function:{name, description, parameters}}]` | `[{name, description, input_schema}]` |
| Response usage | `{prompt_tokens, completion_tokens, total_tokens}` | `{input_tokens, output_tokens}` |
| Response stop | `finish_reason: 'stop'/'tool_calls'` | `stop_reason: 'end_turn'/'tool_use'` |

- [ ] **Step 1: Failing test yaz**

`test/providers/format-conversion.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openaiToAnthropicBody,
  anthropicToOpenaiResponse,
} from '../../lib/providers/format-conversion.js';

test('openaiToAnthropicBody: extracts system messages to top-level system field', () => {
  const body = {
    model: 'claude-sonnet-4',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ],
    max_tokens: 100,
  };
  const out = openaiToAnthropicBody(body);
  assert.equal(out.system, 'You are helpful.');
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].role, 'user');
  assert.deepEqual(out.messages[0].content, [{ type: 'text', text: 'Hi' }]);
  assert.equal(out.max_tokens, 100);
});

test('openaiToAnthropicBody: concats multiple system messages with newlines', () => {
  const out = openaiToAnthropicBody({
    model: 'm',
    messages: [
      { role: 'system', content: 'One.' },
      { role: 'system', content: 'Two.' },
      { role: 'user', content: 'q' },
    ],
  });
  assert.equal(out.system, 'One.\n\nTwo.');
});

test('openaiToAnthropicBody: assistant tool_calls → tool_use content blocks', () => {
  const out = openaiToAnthropicBody({
    model: 'm',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'sure',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Istanbul"}' } },
        ],
      },
    ],
  });
  const asst = out.messages[1];
  assert.equal(asst.role, 'assistant');
  assert.equal(asst.content[0].type, 'text');
  assert.equal(asst.content[0].text, 'sure');
  assert.equal(asst.content[1].type, 'tool_use');
  assert.equal(asst.content[1].id, 'call_1');
  assert.equal(asst.content[1].name, 'get_weather');
  assert.deepEqual(asst.content[1].input, { city: 'Istanbul' });
});

test('openaiToAnthropicBody: tool role → user message with tool_result block', () => {
  const out = openaiToAnthropicBody({
    model: 'm',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{"temp":15}' },
    ],
  });
  const last = out.messages[out.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.content[0].type, 'tool_result');
  assert.equal(last.content[0].tool_use_id, 'c1');
  assert.equal(last.content[0].content, '{"temp":15}');
});

test('openaiToAnthropicBody: tools → input_schema', () => {
  const out = openaiToAnthropicBody({
    model: 'm',
    messages: [{ role: 'user', content: 'q' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      },
    ],
  });
  assert.equal(out.tools.length, 1);
  assert.equal(out.tools[0].name, 'get_weather');
  assert.equal(out.tools[0].description, 'Get weather');
  assert.deepEqual(out.tools[0].input_schema, {
    type: 'object', properties: { city: { type: 'string' } }, required: ['city'],
  });
});

test('openaiToAnthropicBody: defaults max_tokens when missing (Anthropic requires)', () => {
  const out = openaiToAnthropicBody({
    model: 'm',
    messages: [{ role: 'user', content: 'q' }],
  });
  assert.ok(out.max_tokens > 0);
});

test('anthropicToOpenaiResponse: text-only response', () => {
  const payload = {
    id: 'msg_1',
    content: [{ type: 'text', text: 'hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 2 },
  };
  const out = anthropicToOpenaiResponse(payload, 'claude-sonnet-4');
  assert.equal(out.id, 'msg_1');
  assert.equal(out.choices[0].message.content, 'hello');
  assert.equal(out.choices[0].message.tool_calls, undefined);
  assert.equal(out.choices[0].finish_reason, 'stop');
  assert.deepEqual(out.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
});

test('anthropicToOpenaiResponse: tool_use blocks → OpenAI tool_calls', () => {
  const payload = {
    id: 'msg_2',
    content: [
      { type: 'text', text: 'let me check' },
      { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Istanbul' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 6 },
  };
  const out = anthropicToOpenaiResponse(payload, 'claude-sonnet-4');
  assert.equal(out.choices[0].message.content, 'let me check');
  assert.equal(out.choices[0].message.tool_calls.length, 1);
  const tc = out.choices[0].message.tool_calls[0];
  assert.equal(tc.id, 'tu_1');
  assert.equal(tc.type, 'function');
  assert.equal(tc.function.name, 'get_weather');
  assert.equal(JSON.parse(tc.function.arguments).city, 'Istanbul');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
});

test('anthropicToOpenaiResponse: max_tokens stop_reason → length finish_reason', () => {
  const out = anthropicToOpenaiResponse(
    { id: 'm', content: [{ type: 'text', text: 't' }], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 1 } },
    'claude',
  );
  assert.equal(out.choices[0].finish_reason, 'length');
});
```

- [ ] **Step 2: Run failing test**

```bash
node --test test/providers/format-conversion.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`lib/providers/format-conversion.js`:

```js
// OpenAI Chat Completions ↔ Anthropic Messages format dönüşümleri.
// AnthropicNativeProvider için kullanılıyor.

const DEFAULT_MAX_TOKENS = 4096;

const STOP_REASON_MAP = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
};

function flattenContentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : (c?.text ?? ''))).join('');
  }
  return content == null ? '' : String(content);
}

function safeJsonParse(s, fallback) {
  if (typeof s !== 'string') return s ?? fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

export function openaiToAnthropicBody(body) {
  const messages = body.messages || [];
  const systemParts = [];
  const out = [];

  for (const m of messages) {
    if (m.role === 'system') {
      const t = flattenContentToText(m.content);
      if (t) systemParts.push(t);
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
        }],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      const text = flattenContentToText(m.content);
      if (text) blocks.push({ type: 'text', text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name || tc.name,
            input: safeJsonParse(tc.function?.arguments, {}),
          });
        }
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
      continue;
    }
    // user
    if (typeof m.content === 'string') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
    } else if (Array.isArray(m.content)) {
      out.push({ role: 'user', content: m.content });
    } else {
      out.push({ role: 'user', content: [{ type: 'text', text: String(m.content ?? '') }] });
    }
  }

  const result = {
    model: body.model,
    messages: out,
    max_tokens: body.max_tokens || DEFAULT_MAX_TOKENS,
  };

  if (systemParts.length) result.system = systemParts.join('\n\n');
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;
  if (body.stop) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  if (Array.isArray(body.tools) && body.tools.length) {
    result.tools = body.tools.map((t) => {
      const fn = t.function || t;
      return {
        name: fn.name,
        description: fn.description || '',
        input_schema: fn.parameters || fn.input_schema || { type: 'object', properties: {} },
      };
    });
  }

  return result;
}

export function anthropicToOpenaiResponse(payload, modelId) {
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  let text = '';
  const toolCalls = [];

  for (const b of blocks) {
    if (b.type === 'text') text += b.text || '';
    else if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input || {}),
        },
      });
    }
  }

  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const finishReason = STOP_REASON_MAP[payload.stop_reason] || 'stop';

  const usage = payload.usage || {};
  return {
    id: payload.id || 'chatcmpl-anth',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId || payload.model || 'unknown',
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length ? 'tool_calls' : finishReason,
    }],
    usage: {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/providers/format-conversion.test.js
```

Expected: 9/9 PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/providers/format-conversion.js test/providers/format-conversion.test.js
git commit -m "feat(providers): OpenAI ↔ Anthropic format converters"
```

---

## Task 2: AnthropicNativeProvider — chat() (mocked)

**Files:**
- Create: `lib/providers/anthropic-native.js`
- Test: `test/providers/anthropic-native.test.js`

- [ ] **Step 1: Failing test**

`test/providers/anthropic-native.test.js`:

```js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicNativeProvider } from '../../lib/providers/anthropic-native.js';
import { ProviderError } from '../../lib/providers/base.js';

const realFetch = globalThis.fetch;
let mockResponses = [];
let lastInit;

function setMock(...responses) {
  mockResponses = responses.slice();
  globalThis.fetch = async (url, init) => {
    lastInit = init;
    const next = mockResponses.shift();
    if (!next) throw new Error('mock: unexpected fetch call');
    return next;
  };
}

beforeEach(() => { mockResponses = []; lastInit = null; });
afterEach(() => { globalThis.fetch = realFetch; });

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('chat() converts OpenAI body → Anthropic body and back', async () => {
  setMock(jsonResponse(200, {
    id: 'msg_1',
    content: [{ type: 'text', text: 'hello there' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 3 },
  }));

  const p = new AnthropicNativeProvider({
    id: 'anth', base_url: 'https://api.anthropic.com', api_key: 'sk-ant',
  });
  const out = await p.chat({
    model: 'claude-sonnet-4',
    messages: [
      { role: 'system', content: 'Be helpful.' },
      { role: 'user', content: 'Hi' },
    ],
    max_tokens: 50,
  });

  assert.equal(out.text, 'hello there');
  assert.equal(out.finish_reason, 'stop');
  assert.deepEqual(out.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });

  // verify request shape
  const sentBody = JSON.parse(lastInit.body);
  assert.equal(sentBody.system, 'Be helpful.');
  assert.equal(sentBody.messages.length, 1);
  assert.equal(sentBody.messages[0].role, 'user');
  assert.equal(sentBody.max_tokens, 50);

  assert.equal(lastInit.headers['x-api-key'], 'sk-ant');
  assert.equal(lastInit.headers['anthropic-version'], '2023-06-01');
});

test('chat() surfaces native_tool_calls when tool_use blocks come back', async () => {
  setMock(jsonResponse(200, {
    id: 'msg_2',
    content: [
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Istanbul' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 },
  }));

  const p = new AnthropicNativeProvider({
    id: 'anth', base_url: 'https://api.anthropic.com', api_key: 'sk-ant',
  });
  const out = await p.chat({
    model: 'claude-sonnet-4',
    messages: [{ role: 'user', content: 'weather?' }],
    tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
  });

  assert.equal(out.text, 'checking');
  assert.equal(out.finish_reason, 'tool_calls');
  assert.ok(Array.isArray(out.native_tool_calls));
  assert.equal(out.native_tool_calls.length, 1);
  assert.equal(out.native_tool_calls[0].function.name, 'get_weather');
});

test('chat() throws ProviderError(category=auth) on 401', async () => {
  setMock(jsonResponse(401, { type: 'error', error: { message: 'invalid key' } }));
  const p = new AnthropicNativeProvider({
    id: 'anth', base_url: 'https://api.anthropic.com', api_key: 'bad',
    max_attempts: 1,
  });
  await assert.rejects(
    () => p.chat({ model: 'm', messages: [] }),
    (err) => err instanceof ProviderError && err.category === 'auth' && err.status === 401,
  );
});

test('listModels() GETs /v1/models', async () => {
  setMock(jsonResponse(200, {
    data: [{ id: 'claude-sonnet-4', type: 'model' }, { id: 'claude-opus-4', type: 'model' }],
  }));
  const p = new AnthropicNativeProvider({
    id: 'anth', base_url: 'https://api.anthropic.com', api_key: 'sk',
  });
  const models = await p.listModels();
  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'claude-sonnet-4');
});

test('healthCheck() returns ok=true on 200', async () => {
  setMock(jsonResponse(200, {
    id: 'msg', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  const p = new AnthropicNativeProvider({
    id: 'anth', base_url: 'https://api.anthropic.com', api_key: 'sk',
  });
  const h = await p.healthCheck({ model: 'claude-sonnet-4' });
  assert.equal(h.ok, true);
});

test('request() bypasses format conversion (used by Anthropic adapter)', async () => {
  setMock(jsonResponse(200, { id: 'msg', content: [{ type: 'text', text: 'raw' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  const p = new AnthropicNativeProvider({
    id: 'anth', base_url: 'https://api.anthropic.com', api_key: 'sk',
  });
  const { json } = await p.request('POST', '/v1/messages', {
    model: 'claude', messages: [{ role: 'user', content: [{ type: 'text', text: 'raw' }] }], max_tokens: 1,
  });
  // request should NOT touch the body — system field absent because we didn't pass any.
  const sentBody = JSON.parse(lastInit.body);
  assert.equal(sentBody.system, undefined);
  assert.equal(json.id, 'msg');
});
```

- [ ] **Step 2: Run failing test**

```bash
node --test test/providers/anthropic-native.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`lib/providers/anthropic-native.js`:

```js
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
```

- [ ] **Step 4: Run test**

```bash
node --test test/providers/anthropic-native.test.js
```

Expected: 6/6 PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/providers/anthropic-native.js test/providers/anthropic-native.test.js
git commit -m "feat(providers): AnthropicNativeProvider with chat/list/health/request"
```

---

## Task 3: factory.js — register 'anthropic-native' type

**Files:**
- Modify: `lib/providers/factory.js`

- [ ] **Step 1: Edit**

Eski:
```js
import { OpenaiCompatProvider } from './openai-compat.js';
...
const PROVIDER_TYPES = {
  'openai-compat': OpenaiCompatProvider,
};
```

Yeni:
```js
import { OpenaiCompatProvider } from './openai-compat.js';
import { AnthropicNativeProvider } from './anthropic-native.js';
...
const PROVIDER_TYPES = {
  'openai-compat': OpenaiCompatProvider,
  'anthropic-native': AnthropicNativeProvider,
};
```

- [ ] **Step 2: Run all tests**

```bash
npm test
```

Expected: 78 + 15 = 93/93 PASS (Task 1 9 + Task 2 6 = 15 yeni).

- [ ] **Step 3: Commit**

```bash
git add lib/providers/factory.js
git commit -m "feat(providers): register anthropic-native type in factory"
```

---

## Task 4: adapters/anthropic.js — anthropic-native öncelikli

**Files:**
- Modify: `lib/adapters/anthropic.js`

**Background:** Phase 2'de "ilk provider"i kullanan geçici köprü vardı. Phase 3'te artık anthropic-native varsa onu önce dene; yoksa openai-compat'a düş (api.airforce gibi).

- [ ] **Step 1: Edit — provider seçimini akıllı yap**

`lib/adapters/anthropic.js`:

Eski:
```js
  try {
    const router = await getRouter();
    const provider = router.registry.providers.values().next().value;
    if (!provider || typeof provider.request !== 'function') {
      throw new Error('no provider with /v1/messages bridge available');
    }
    const { json } = await provider.request('POST', '/v1/messages', upstreamBody);
    payload = json;
  } catch (err) { ... }
```

Yeni:
```js
  try {
    const router = await getRouter();
    // Önce anthropic-native provider'ı ara; yoksa openai-compat'a düş.
    let provider = null;
    for (const p of router.registry.providers.values()) {
      if (p.constructor?.name === 'AnthropicNativeProvider') { provider = p; break; }
    }
    if (!provider) {
      for (const p of router.registry.providers.values()) {
        if (typeof p.request === 'function') { provider = p; break; }
      }
    }
    if (!provider) {
      throw new Error('no provider with /v1/messages bridge available');
    }
    const { json } = await provider.request('POST', '/v1/messages', upstreamBody);
    payload = json;
  } catch (err) {
    const status = (err instanceof ProviderError) ? (err.status || 502) : 502;
    log.error('anthropic upstream error', { err: err.message, status, category: err?.category });
    return errorResponse(res, status, err.message || 'Upstream error');
  }
```

- [ ] **Step 2: Tüm testler**

```bash
npm test
```

Expected: hepsi PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/adapters/anthropic.js
git commit -m "feat(adapters): anthropic adapter prefers anthropic-native provider"
```

---

## Task 5: End-to-end smoke (lokal — mock-only)

**Files:** _(none — runtime test)_

**Background:** Anthropic key olmadan gerçek api.anthropic.com'a vurmak istemiyoruz. Smoke test'i tüm test suite üzerinden yap; ek olarak `data/providers.json`'a anthropic provider entry'si eklenirse kompile olduğunu manuel doğrula.

- [ ] **Step 1: Tüm testleri tekrar çalıştır**

```bash
cd ~/Desktop/llm-bridge
npm test 2>&1 | tail -10
```

Expected: 93/93 PASS.

- [ ] **Step 2: Manuel: data/providers.json'a anthropic provider ekleyince server boot etmeli**

```bash
# Geçici providers.json yarat
mkdir -p data
cat > data/providers.json <<'EOF'
{
  "schema_version": 1,
  "providers": [
    {
      "id": "airforce",
      "label": "api.airforce",
      "type": "openai-compat",
      "base_url": "https://api.airforce",
      "api_key": "sk-air-CGmiWbVbf6lcQsBIRcJRPl5qUAkrYJFPh8CncXD8VzjWW0MjVA62eLt4ao8ZHOim",
      "enabled": true,
      "rate_limit": { "mult_per_min": 10 },
      "models": [{ "upstream_id": "glm-4.6", "priority": 0, "enabled": true }]
    },
    {
      "id": "anthropic",
      "label": "Anthropic Direct",
      "type": "anthropic-native",
      "base_url": "https://api.anthropic.com",
      "api_key": "sk-ant-PLACEHOLDER",
      "enabled": false,
      "models": [{ "upstream_id": "claude-sonnet-4", "priority": 0, "enabled": true }]
    }
  ],
  "aliases": {},
  "global": { "default_model": "glm-4.6", "circuit_breaker": { "fail_threshold": 3, "open_seconds": 60 } }
}
EOF
chmod 600 data/providers.json

# Boot
(node server.js > /tmp/p3-smoke.log 2>&1 &)
sleep 3
echo '--- /healthz ---'
curl -s http://127.0.0.1:2399/healthz
echo
echo '--- /v1/models ---'
curl -s http://127.0.0.1:2399/v1/models -H "Authorization: Bearer test-key" | head -c 500
echo
echo '--- /v1/chat/completions glm-4.6 ---'
curl -s -X POST http://127.0.0.1:2399/v1/chat/completions \
  -H "Authorization: Bearer test-key" -H "content-type: application/json" \
  -d '{"model":"glm-4.6","messages":[{"role":"user","content":"sadece tek kelime: ping"}]}' \
  --max-time 30
echo
pkill -f "node server.js"
sleep 1
echo '--- log tail ---'
tail -10 /tmp/p3-smoke.log
rm -f /tmp/p3-smoke.log
```

Expected:
- `/healthz` 200
- `/v1/models` ile tek `glm-4.6` (anthropic disabled olduğu için listede yok)
- `glm-4.6` chat completion `ping` döner
- Log'ta `router: 1 provider yüklü` — anthropic disabled

- [ ] **Step 3: CHANGELOG + version bump**

`CHANGELOG.md` başına ekle:

```markdown
## [0.4.0] — Phase 3: Anthropic Native Provider

- `lib/providers/anthropic-native.js` — `AnthropicNativeProvider` plugin
- `lib/providers/format-conversion.js` — OpenAI ↔ Anthropic body/response converters
- `lib/providers/factory.js` — `'anthropic-native'` tipi register edildi
- `lib/adapters/anthropic.js` — anthropic-native provider'ı önce dener; yoksa openai-compat'a fallback
- v1 limit: text + tool_use + tool_result content blocks (image/document v2)
- 15 yeni test (format-conversion 9 + anthropic-native 6 → 93/93 PASS)
```

`package.json` `version: "0.4.0"`.

```bash
git add CHANGELOG.md package.json
git commit -m "docs: changelog for phase 3; version 0.4.0"
```

---

## Task 6: PR develop → master + tag v0.4.0-phase3

- [ ] **Step 1: Push feat branch**

```bash
git push origin feat/03-anthropic-native
```

- [ ] **Step 2: PR feat → develop**

```bash
gh pr create --repo NeronSignal/llm-bridge --base develop --head feat/03-anthropic-native \
  --title "Phase 3: Anthropic Native Provider" \
  --body "$(cat <<'EOF'
## Summary
- `AnthropicNativeProvider` (chat with format conversion, listModels, healthCheck, request bridge)
- `format-conversion.js` — OpenAI body ↔ Anthropic body, response shape converter
- factory'de `anthropic-native` tipi register
- Anthropic adapter artık önce anthropic-native provider'ı dener; yoksa openai-compat'a düşer
- v1 limit: text + tool_use + tool_result content blocks

## Test plan
- [x] format-conversion tests (9) PASS
- [x] anthropic-native tests (6) PASS
- [x] Phase 1+2 testleri kırılmadan PASS
- [x] Server boot + glm-4.6 smoke OK (anthropic provider disabled durumda config'de bulunsa da OK)
EOF
)"
```

- [ ] **Step 3: Merge feat→develop, develop→master, tag**

```bash
gh pr merge --repo NeronSignal/llm-bridge --squash --delete-branch
git checkout develop
git pull origin develop
gh pr create --repo NeronSignal/llm-bridge --base master --head develop \
  --title "Release: phase 3 (anthropic native)" \
  --body "Phase 3 implementation merged. 93/93 tests. See CHANGELOG.md."
gh pr merge --repo NeronSignal/llm-bridge --squash
git checkout master
git pull origin master
git tag v0.4.0-phase3
git push origin v0.4.0-phase3
```

---

## Self-Review

**Spec coverage:**
- §4.3 (AnthropicNativeProvider): Task 2 ✓
- §4.3 detayı (system extract, tool_use blocks, tools→input_schema): Task 1 (format-conversion) ✓
- §4.3 v1 limit (text+tool_use+tool_result, image/document reddedilir): Task 1'de tool_result ve text destekleniyor; image/document için açık reddetme **yok**, üstündeki layer (Phase 4) eklediğimizde ele alınacak. Bu spec'le uyumlu (v2'ye bırakılan).
- §4.4 (hata kategorileri): Task 2'de retry/classify mevcut ✓
- §4.5 (native sinyali): Task 2 — `supportsNativeTools()` true; capability snapshot key ile entegrasyon Phase 5'te.
- §3.2 (request flow): Task 4 — adapter anthropic-native öncelikli ✓
- Faz 3 kapsamı — bu plan'la tamamen örtüşüyor.

**Placeholder scan:** "TBD"/"TODO" yok.

**Type consistency:**
- `openaiToAnthropicBody({model, messages, tools?, max_tokens?, ...}) → {model, messages, system?, max_tokens, tools?, ...}` — Task 1, 2'de tutarlı.
- `anthropicToOpenaiResponse(payload, modelId) → {id, object, choices:[{message, finish_reason}], usage:{prompt_tokens, completion_tokens, total_tokens}}` — Task 1, 2'de tutarlı.
- `AnthropicNativeProvider.chat(body) → {text, native_tool_calls?, usage, finish_reason, raw}` — Phase 1/2 OpenaiCompatProvider ile aynı kontrat.

**Risks:**
- Task 4'te `provider.constructor?.name === 'AnthropicNativeProvider'` runtime check — minify edilirse kırılır, ama Node.js'te source code çalışıyor; risk düşük. Daha temiz: `instanceof AnthropicNativeProvider` import et — ama bu adapter'a gereksiz bağımlılık ekler. Şu anlık name check yeterli.
- Anthropic gerçek API'sine vurmadan smoke test sınırlı; gerçek key'le manuel test gerekirse `data/providers.json` üzerinden eklenir.
- Image/document content block'lar reddedilmiyor — istemci gönderirse Anthropic 400 döner (bizim `client` kategorisi → fatal). Açık validation Phase 4 admin panelle birlikte gelir.
