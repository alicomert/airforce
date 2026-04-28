import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeOpenaiMessages, normalizeAnthropicMessages } from '../lib/tool-engine/serialize-history.js';

test('OpenAI assistant message with tool_calls is serialized to XML', () => {
  const msgs = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: 'calling tool', tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
    ]},
    { role: 'tool', tool_call_id: 'call_1', content: 'file body' },
    { role: 'user', content: 'now summarize' },
  ];
  const out = normalizeOpenaiMessages(msgs);
  assert.equal(out.length, 4);
  // assistant turn'ünde XML olmalı
  assert.match(out[1].content, /<tool_calls>/);
  assert.match(out[1].content, /read_file/);
  // tool result user mesajına dönmüş
  assert.equal(out[2].role, 'user');
  assert.match(out[2].content, /<tool_results>/);
  assert.match(out[2].content, /file body/);
});

test('OpenAI tool_calls with object arguments still serializes', () => {
  const msgs = [{
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: { y: 1 } } }],
  }];
  const out = normalizeOpenaiMessages(msgs);
  assert.match(out[0].content, /<parameter name="y">1<\/parameter>/);
});

test('Anthropic tool_use blocks serialized to XML', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [
      { type: 'text', text: 'one moment' },
      { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'deno' } },
    ]},
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'result body' },
    ]},
  ];
  const out = normalizeAnthropicMessages(msgs);
  assert.match(out[1].content, /one moment/);
  assert.match(out[1].content, /<tool_calls>/);
  assert.match(out[1].content, /search/);
  assert.match(out[2].content, /<tool_results>/);
  assert.match(out[2].content, /result body/);
});
