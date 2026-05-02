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
  const sentBody = JSON.parse(lastInit.body);
  assert.equal(sentBody.system, undefined);
  assert.equal(json.id, 'msg');
});
