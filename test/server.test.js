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

test('isNoProgressAssistantTurn: text-only first-turn reply with no prior tool_use is retryable (structural)', () => {
  // User sent message, model returned only text and no tool_use, no prior
  // assistant tool_use in history. This is "model said words, did no work".
  assert.equal(isNoProgressAssistantTurn('/anthropic/v1/messages', {
    content: [{ type: 'text', text: 'I will start by exploring the codebase.' }],
    stop_reason: 'end_turn'
  }, {
    messages: [{ role: 'user', content: 'analyze this project' }]
  }), true);
});

test('isNoProgressAssistantTurn: real tool_use response is never retryable', () => {
  assert.equal(isNoProgressAssistantTurn('/anthropic/v1/messages', {
    content: [
      { type: 'text', text: 'Exploring now.' },
      { type: 'tool_use', name: 'Glob', input: { pattern: '**/*' } }
    ],
    stop_reason: 'tool_use'
  }, {
    messages: [{ role: 'user', content: 'analyze' }]
  }), false);
});

test('isNoProgressAssistantTurn: mid-session text after exploration-only history IS retryable', () => {
  // Session has only exploration tool_use (Read), no mutation (Write/Edit).
  // Model returning text-only here means exploration ended without producing
  // the requested change -> retry to push for mutation.
  assert.equal(isNoProgressAssistantTurn('/anthropic/v1/messages', {
    content: [{ type: 'text', text: 'Let me try a different approach:' }],
    stop_reason: 'end_turn'
  }, {
    messages: [
      { role: 'user', content: 'create CLAUDE.md' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.md' } }]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] }
    ]
  }), true);
});

test('isNoProgressAssistantTurn: text after MUTATION (Write) is NOT retryable (work is done)', () => {
  // Model wrote file, tool_result came back, now model gives summary text.
  // This is legitimate completion - do not retry.
  assert.equal(isNoProgressAssistantTurn('/anthropic/v1/messages', {
    content: [{ type: 'text', text: 'Done! Created the file.' }],
    stop_reason: 'end_turn'
  }, {
    messages: [
      { role: 'user', content: 'create CLAUDE.md' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'CLAUDE.md', content: '# hi' } }]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }
    ]
  }), false);
});

test('isNoProgressAssistantTurn: completely empty payload is retryable', () => {
  assert.equal(isNoProgressAssistantTurn('/anthropic/v1/messages', {
    content: []
  }, { messages: [{ role: 'user', content: 'hi' }] }), true);
});
