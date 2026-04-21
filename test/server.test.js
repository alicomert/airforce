import test from 'node:test';
import assert from 'node:assert/strict';

process.env.AIRFORCE_API_KEY = 'sk-air-test';

const { buildUpstreamHeaders, isNoProgressAssistantTurn, shouldHandleSyntheticStream } = await import('../server.js');

test('buildUpstreamHeaders overrides inbound auth headers with configured upstream key', () => {
  const headers = buildUpstreamHeaders({
    headers: {
      host: 'localhost:2393',
      connection: 'keep-alive',
      'content-length': '123',
      authorization: 'Bearer sk-ant-user',
      'x-api-key': 'sk-ant-user',
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01'
    }
  }, 42);

  assert.equal(headers.get('authorization'), 'Bearer sk-air-test');
  assert.equal(headers.get('x-api-key'), 'sk-air-test');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('anthropic-version'), '2023-06-01');
  assert.equal(headers.get('content-length'), '42');
});

test('shouldHandleSyntheticStream enables anthropic-compatible streaming for /v1/messages', () => {
  assert.equal(shouldHandleSyntheticStream('/v1/messages', { stream: true }), true);
  assert.equal(shouldHandleSyntheticStream('/v1/messages', { stream: false }), false);
  assert.equal(shouldHandleSyntheticStream('/v1/models', { stream: true }), false);
});

test('isNoProgressAssistantTurn treats stalling anthropic text as retryable no-progress', () => {
  assert.equal(isNoProgressAssistantTurn('/anthropic/v1/messages', {
    content: [{ type: 'text', text: 'Let me explore the full codebase to create a proper CLAUDE.md.' }],
    stop_reason: 'end_turn'
  }), true);
});

test('isNoProgressAssistantTurn keeps real tool_use responses non-retryable', () => {
  assert.equal(isNoProgressAssistantTurn('/anthropic/v1/messages', {
    content: [
      { type: 'text', text: 'Let me explore the codebase properly.' },
      { type: 'tool_use', name: 'Glob', input: { pattern: '**/*' } }
    ],
    stop_reason: 'tool_use'
  }), false);
});
