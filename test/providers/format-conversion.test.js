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
