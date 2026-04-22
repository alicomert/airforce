// Auto-recovery testleri: upstream bos payload donerse proxy'nin
// deterministik bir progress cevabi ureterek kullaniciya "empty response"
// mesaji GOSTERMEDIGINI dogrular.
//
// Kontrat:
//   - history'de exploration tool_result varsa: bir Read sentezlenir
//   - hic history yok + user niyeti acikca belli: Glob('**/*') sentezlenir
//   - son tool_result bir hata ise: tool sentezi ATLANIR (ayni hatayi
//     tekrar tetiklememek icin), minimal '.' text doner
//   - sentez imkansiz: '.' text + end_turn, upstream id/model/usage korunur

import test from 'node:test';
import assert from 'node:assert/strict';

const { buildAutoRecoveryPayload, SILENT_PROGRESS_TEXT } = await import('../lib/auto-recovery.js');

test('auto-recovery (Anthropic): synthesizes Read from prior exploration tool_result', () => {
  const payload = buildAutoRecoveryPayload('/anthropic/v1/messages', {
    tools: [
      {
        name: 'Glob',
        input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }
      },
      {
        name: 'Read',
        input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
      }
    ],
    messages: [
      { role: 'user', content: 'analyze this project' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Glob', input: { pattern: '**/*' } }]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'README.md\npackage.json\nsrc/index.js' }]
      }
    ]
  }, {
    id: 'msg_empty',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4',
    content: [],
    stop_reason: 'end_turn'
  });

  assert.ok(Array.isArray(payload.content), 'content must be array');
  const toolUse = payload.content.find((b) => b.type === 'tool_use');
  assert.ok(toolUse, 'expected a tool_use block');
  assert.equal(toolUse.name, 'Read');
  // Picks README.md (highest priority key file)
  assert.equal(toolUse.input.file_path, 'README.md');
  assert.equal(payload.stop_reason, 'tool_use');
  assert.equal(payload.id, 'msg_empty', 'upstream id preserved');
  assert.equal(payload.model, 'claude-sonnet-4', 'upstream model preserved');
});

test('auto-recovery (OpenAI Chat): synthesizes Read from prior exploration tool_result', () => {
  const payload = buildAutoRecoveryPayload('/v1/chat/completions', {
    tools: [
      { type: 'function', function: { name: 'Glob', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
      { type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } } }
    ],
    messages: [
      { role: 'user', content: 'what is this project' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_g', type: 'function', function: { name: 'Glob', arguments: JSON.stringify({ pattern: '**/*' }) } }]
      },
      { role: 'tool', tool_call_id: 'call_g', content: 'README.md\npackage.json' }
    ]
  }, {
    id: 'chatcmpl_empty',
    object: 'chat.completion',
    choices: []
  });

  assert.ok(Array.isArray(payload.choices));
  const choice = payload.choices[0];
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.ok(Array.isArray(choice.message.tool_calls));
  assert.equal(choice.message.tool_calls[0].function.name, 'Read');
  const args = JSON.parse(choice.message.tool_calls[0].function.arguments);
  assert.equal(args.filePath, 'README.md', 'uses client schema field name (filePath)');
  assert.equal(payload.id, 'chatcmpl_empty', 'upstream id preserved');
});

test('auto-recovery: SKIPS tool synthesis when last tool_result is an error', () => {
  // Regression: model called Read with a wrong path, tool returned
  // "File not found", upstream then returned empty payload. Synthesizing
  // another tool here risks picking the same wrong file again. Return
  // silent progress instead so client (OpenCode) surfaces the error and
  // retries with a correct path.
  const payload = buildAutoRecoveryPayload('/v1/chat/completions', {
    tools: [
      { type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } } }
    ],
    messages: [
      { role: 'user', content: 'read the normalizer' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"filePath":"normalizers.js"}' } }]
      },
      { role: 'tool', tool_call_id: 'c1', content: 'File not found: C:\\Users\\x\\normalizers.js' }
    ]
  }, { id: 'chatcmpl_err', choices: [] });

  const choice = payload.choices[0];
  // No tool_calls should be synthesized — fall through to silent progress text
  assert.ok(!choice.message.tool_calls || choice.message.tool_calls.length === 0);
  assert.equal(choice.message.content, SILENT_PROGRESS_TEXT);
  assert.equal(choice.finish_reason, 'stop');
});

test('auto-recovery: returns silent progress text when no synthesis possible (empty history)', () => {
  const payload = buildAutoRecoveryPayload('/anthropic/v1/messages', {
    tools: [],  // no tools -> synthesis impossible
    messages: [{ role: 'user', content: 'x' }]
  }, {
    id: 'msg_no_tools',
    type: 'message',
    role: 'assistant',
    content: [],
    stop_reason: 'end_turn'
  });

  assert.equal(payload.content.length, 1);
  assert.equal(payload.content[0].type, 'text');
  assert.equal(payload.content[0].text, SILENT_PROGRESS_TEXT);
  assert.equal(payload.stop_reason, 'end_turn');
  assert.ok(
    !payload.content[0].text.includes('empty response'),
    'must NOT contain the legacy "empty response" string'
  );
  assert.ok(
    !payload.content[0].text.includes('try a different model'),
    'must NOT contain the legacy "try a different model" string'
  );
});

test('auto-recovery: never leaks legacy "empty response" text to user', () => {
  // Hard contract: regardless of what upstream sent, output MUST NOT contain
  // the banned strings. This is the whole point of auto-recovery.
  const payload = buildAutoRecoveryPayload('/v1/chat/completions', {
    tools: [
      { type: 'function', function: { name: 'Glob', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } }
    ],
    messages: [{ role: 'user', content: 'anything' }]
  }, { choices: [] });

  const json = JSON.stringify(payload);
  assert.ok(!/empty response/i.test(json), 'payload MUST NOT contain "empty response"');
  assert.ok(!/try a different model/i.test(json), 'payload MUST NOT contain "try a different model"');
  assert.ok(!/rephrase/i.test(json), 'payload MUST NOT contain "rephrase"');
});

test('auto-recovery: handles /responses endpoint with silent progress', () => {
  const payload = buildAutoRecoveryPayload('/v1/responses', {
    tools: [],
    messages: [{ role: 'user', content: 'hi' }]
  }, { id: 'resp_empty', output: [] });

  assert.ok(Array.isArray(payload.output));
  assert.equal(payload.output.length, 1);
  assert.equal(payload.output[0].type, 'message');
  const textPart = payload.output[0].content.find((p) => p.type === 'output_text');
  assert.ok(textPart);
  assert.equal(textPart.text, SILENT_PROGRESS_TEXT);
});

test('auto-recovery: unknown path returns null (caller handles)', () => {
  const payload = buildAutoRecoveryPayload('/some/weird/path', {
    tools: [],
    messages: []
  }, {});
  assert.equal(payload, null);
});
