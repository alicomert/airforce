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
