import test from 'node:test';
import assert from 'node:assert/strict';

import {
  injectAnthropicSystemPrompt,
  injectOpenAiSystemPrompt,
  injectSystemPromptForPath,
  buildToolContract
} from '../lib/system-prompt-injection.js';

const CONTRACT_MARKER = 'airforce-proxy:tool-contract';

// Claude Code'un gercek tool listesinin ufak bir subset'i (PascalCase)
const claudeCodeTools = [
  {
    name: 'Write',
    description: 'Writes a file to the local filesystem.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path' },
        content: { type: 'string' }
      },
      required: ['file_path', 'content']
    }
  },
  {
    name: 'Read',
    description: 'Read a file.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' }
      },
      required: ['file_path']
    }
  },
  {
    name: 'Glob',
    description: 'Find files by glob pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' }
      },
      required: ['pattern']
    }
  }
];

// OpenAI tarafindaki aynI tool'lar, function wrapper + snake_case
const openAiTools = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read file contents.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        },
        required: ['path']
      }
    }
  }
];

test('buildToolContract returns null when tool list is empty', () => {
  assert.equal(buildToolContract({ tools: [] }), null);
  assert.equal(buildToolContract({}), null);
  assert.equal(buildToolContract(null), null);
});

test('buildToolContract includes client tool names verbatim (no hardcoded aliasing)', () => {
  const contract = buildToolContract({ tools: claudeCodeTools });
  assert.ok(contract);
  assert.match(contract, /Write\(/);
  assert.match(contract, /Read\(/);
  assert.match(contract, /Glob\(/);
  // Schema field adlari da korunmali
  assert.match(contract, /file_path/);
  assert.match(contract, /pattern/);
});

test('buildToolContract picks OpenAI function.name and parameters', () => {
  const contract = buildToolContract({ tools: openAiTools });
  assert.ok(contract);
  assert.match(contract, /write_file\(/);
  assert.match(contract, /read_file\(/);
  assert.match(contract, /path/);
  assert.match(contract, /content/);
});

test('buildToolContract has no hardcoded paths or OS-specific commands', () => {
  const contract = buildToolContract({ tools: claudeCodeTools });
  assert.ok(contract);
  // Proje-agnostik olmali: yol veya OS-spesifik komut YOK
  assert.doesNotMatch(contract, /\/(workspace|root|tmp|home)\//);
  assert.doesNotMatch(contract, /C:\\Users/i);
  assert.doesNotMatch(contract, /powershell\.exe/i);
  assert.doesNotMatch(contract, /\bfind\s+\./);
  // Dil/framework ornekleri de YOK
  assert.doesNotMatch(contract, /\b(react|vue|angular|django|flask|express)\b/i);
});

test('injectAnthropicSystemPrompt adds contract when no system prompt exists', () => {
  const body = { tools: claudeCodeTools, messages: [] };
  const out = injectAnthropicSystemPrompt(body);
  assert.ok(typeof out.system === 'string');
  assert.match(out.system, new RegExp(CONTRACT_MARKER));
  assert.match(out.system, /Write\(/);
});

test('injectAnthropicSystemPrompt appends to existing string system prompt without overwriting', () => {
  const body = {
    tools: claudeCodeTools,
    system: 'You are a helpful AI assistant called Claude.',
    messages: []
  };
  const out = injectAnthropicSystemPrompt(body);
  assert.match(out.system, /You are a helpful AI assistant called Claude\./);
  assert.match(out.system, new RegExp(CONTRACT_MARKER));
});

test('injectAnthropicSystemPrompt appends to array-style system prompt', () => {
  const body = {
    tools: claudeCodeTools,
    system: [{ type: 'text', text: 'Original system prompt.' }],
    messages: []
  };
  const out = injectAnthropicSystemPrompt(body);
  assert.ok(Array.isArray(out.system));
  assert.equal(out.system[0].text, 'Original system prompt.');
  assert.match(out.system[out.system.length - 1].text, new RegExp(CONTRACT_MARKER));
});

test('injectAnthropicSystemPrompt is idempotent (does not double-inject on retry)', () => {
  const body = { tools: claudeCodeTools, messages: [] };
  const once = injectAnthropicSystemPrompt(body);
  const twice = injectAnthropicSystemPrompt(once);
  // Iki kere marker olmamali
  const markerCount = (twice.system.match(new RegExp(CONTRACT_MARKER, 'g')) || []).length;
  assert.equal(markerCount, 2); // start + end
});

test('injectAnthropicSystemPrompt does nothing when tools list is empty', () => {
  const body = { tools: [], system: 'original', messages: [] };
  const out = injectAnthropicSystemPrompt(body);
  assert.equal(out.system, 'original');
});

test('injectOpenAiSystemPrompt prepends new system message when none exists', () => {
  const body = {
    tools: openAiTools,
    messages: [{ role: 'user', content: 'hello' }]
  };
  const out = injectOpenAiSystemPrompt(body);
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].role, 'system');
  assert.match(out.messages[0].content, new RegExp(CONTRACT_MARKER));
  assert.equal(out.messages[1].role, 'user');
});

test('injectOpenAiSystemPrompt appends to existing system message', () => {
  const body = {
    tools: openAiTools,
    messages: [
      { role: 'system', content: 'You are assistant.' },
      { role: 'user', content: 'hi' }
    ]
  };
  const out = injectOpenAiSystemPrompt(body);
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].role, 'system');
  assert.match(out.messages[0].content, /You are assistant\./);
  assert.match(out.messages[0].content, new RegExp(CONTRACT_MARKER));
});

test('injectOpenAiSystemPrompt idempotent', () => {
  const body = {
    tools: openAiTools,
    messages: [{ role: 'user', content: 'hi' }]
  };
  const once = injectOpenAiSystemPrompt(body);
  const twice = injectOpenAiSystemPrompt(once);
  const markerCount = (twice.messages[0].content.match(new RegExp(CONTRACT_MARKER, 'g')) || []).length;
  assert.equal(markerCount, 2);
});

test('injectSystemPromptForPath dispatches to correct encoder by pathname', () => {
  const anthropicBody = { tools: claudeCodeTools, messages: [] };
  const out1 = injectSystemPromptForPath('/v1/messages', anthropicBody);
  assert.ok(typeof out1.system === 'string');

  const out2 = injectSystemPromptForPath('/anthropic/v1/messages', anthropicBody);
  assert.ok(typeof out2.system === 'string');

  const openAiBody = { tools: openAiTools, messages: [{ role: 'user', content: 'hi' }] };
  const out3 = injectSystemPromptForPath('/v1/chat/completions', openAiBody);
  assert.equal(out3.messages[0].role, 'system');
});

test('injectSystemPromptForPath returns body unchanged for unknown path', () => {
  const body = { tools: claudeCodeTools, messages: [] };
  const out = injectSystemPromptForPath('/random/path', body);
  assert.equal(out.system, undefined);
});

test('contract explicitly instructs model to call tools, not describe actions in text', () => {
  // Bu contract'in core mesaji: "text'e yazma, tool cagir"
  const contract = buildToolContract({ tools: claudeCodeTools });
  assert.ok(contract);
  assert.match(contract, /MUST call/i);
  assert.match(contract, /instead of .*describing/i);
});
