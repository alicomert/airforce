import { test } from 'node:test';
import assert from 'node:assert/strict';

import { injectIntoOpenaiBody, injectIntoAnthropicBody, renderToolsBlock } from '../lib/tool-engine/inject.js';

const sampleTools = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name' },
        unit: { type: 'string', enum: ['c', 'f'] },
      },
      required: ['city'],
    },
  },
}];

test('renderToolsBlock contains tool name and parameter list', () => {
  const block = renderToolsBlock(sampleTools, { dialect: 'openai' });
  assert.match(block, /<tool_calls>/);
  assert.match(block, /get_weather/);
  assert.match(block, /city/);
  assert.match(block, /\(required\)/);
});

test('injectIntoOpenaiBody appends to system message and removes tools (force_xml=true)', () => {
  const body = {
    model: 'foo',
    messages: [
      { role: 'system', content: 'You are X.' },
      { role: 'user', content: 'hi' },
    ],
    tools: sampleTools,
  };
  const r = injectIntoOpenaiBody(body);
  assert.equal(r.injected, true);
  const sys = r.body.messages.find((m) => m.role === 'system');
  assert.match(sys.content, /You are X\./);
  assert.match(sys.content, /<tool_calls>/);
  // tools removed
  assert.equal(r.body.tools, undefined);
  assert.equal(r.body.tool_choice, undefined);
  // user mesajı değişmemiş
  assert.equal(r.body.messages[1].content, 'hi');
});

test('injectIntoOpenaiBody adds system message if none exists', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }], tools: sampleTools };
  const r = injectIntoOpenaiBody(body);
  assert.equal(r.body.messages[0].role, 'system');
  assert.match(r.body.messages[0].content, /<tool_calls>/);
});

test('injectIntoAnthropicBody appends to system field', () => {
  const body = {
    model: 'foo',
    system: 'You are X.',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'get_weather', description: 'd', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
  };
  const r = injectIntoAnthropicBody(body);
  assert.match(r.body.system, /You are X\./);
  assert.match(r.body.system, /<tool_calls>/);
  assert.equal(r.body.tools, undefined);
});

test('no tools = no injection', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }] };
  const r = injectIntoOpenaiBody(body);
  assert.equal(r.injected, false);
  assert.deepEqual(r.body.messages, body.messages);
});
