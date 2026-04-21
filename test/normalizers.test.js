import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAnthropicNormalization,
  applyOpenAiChatNormalization,
  extractPseudoToolCalls
} from '../lib/normalizers.js';

test('extractPseudoToolCalls parses think and tool tags', () => {
  const sample = `<think>internal</think>
I'll read files.
<tool_call>ReadFile path="C:\\demo\\AGENTS.md"</arg_value></arg_value>
<tool_call>ReadFile path="C:\\demo\\config.php"</arg_value>`;

  const parsed = extractPseudoToolCalls(sample);
  assert.equal(parsed.text, "I'll read files.");
  assert.equal(parsed.toolCalls.length, 2);
  assert.equal(parsed.toolCalls[0].name, 'ReadFile');
  assert.equal(parsed.toolCalls[0].input.path, 'C:\\demo\\AGENTS.md');
});

test('extractPseudoToolCalls parses official <tool_use> tags', () => {
  const sample = `<think>internal<[PLHD36_never_used_51bce0c785ca2f68081bfa7d91973934]>
I'll read files.
<tool_use>ReadFile path="C:\\demo\\AGENTS.md"</tool_use>
<tool_use>ReadFile path="C:\\demo\\config.php"</tool_use>`;

  const parsed = extractPseudoToolCalls(sample);
  assert.equal(parsed.text, "I'll read files.");
  assert.equal(parsed.toolCalls.length, 2);
  assert.equal(parsed.toolCalls[0].name, 'ReadFile');
  assert.equal(parsed.toolCalls[0].input.path, 'C:\\demo\\AGENTS.md');
});

test('applyAnthropicNormalization converts pseudo tool calls into tool_use blocks', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: 'Starting.\n<tool_call>ReadFile path="/tmp/a.txt"'
    }],
    stop_reason: 'end_turn'
  });

  assert.equal(payload.stop_reason, 'tool_use');
  assert.equal(payload.content[0].type, 'text');
  assert.equal(payload.content[1].type, 'tool_use');
  assert.equal(payload.content[1].name, 'ReadFile');
});

test('applyOpenAiChatNormalization sets tool_calls on malformed chat completion responses', () => {
  const payload = applyOpenAiChatNormalization({
    id: 'chatcmpl_1',
    object: 'chat.completion',
    created: 0,
    model: 'demo',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '<tool_call>ReadFile path="/tmp/a.txt"'
      }
    }]
  });

  assert.equal(payload.choices[0].finish_reason, 'tool_calls');
  assert.equal(payload.choices[0].message.tool_calls[0].function.name, 'ReadFile');
});

test('applyOpenAiChatNormalization remaps opencode-style read aliases and args', () => {
  const payload = applyOpenAiChatNormalization({
    id: 'chatcmpl_2',
    object: 'chat.completion',
    created: 0,
    model: 'demo',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '<tool_call>ReadFileContents path="C:\\\\demo\\\\AGENTS.md"'
      }
    }]
  }, {
    tools: [{
      type: 'function',
      function: {
        name: 'read',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            filePath: { type: 'string' }
          },
          required: ['filePath']
        }
      }
    }]
  });

  const toolCall = payload.choices[0].message.tool_calls[0];
  assert.equal(toolCall.function.name, 'read');
  assert.equal(JSON.parse(toolCall.function.arguments).filePath, 'C:\\demo\\AGENTS.md');
});

test('applyOpenAiChatNormalization fills bash description and command', () => {
  const payload = applyOpenAiChatNormalization({
    id: 'chatcmpl_3',
    object: 'chat.completion',
    created: 0,
    model: 'demo',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '```json\n{"name":"bash","arguments":{"cmd":"git status"}}\n```'
      }
    }]
  }, {
    tools: [{
      type: 'function',
      function: {
        name: 'bash',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            description: { type: 'string' }
          },
          required: ['command', 'description']
        }
      }
    }]
  });

  const args = JSON.parse(payload.choices[0].message.tool_calls[0].function.arguments);
  assert.equal(args.command, 'git status');
  assert.match(args.description, /Runs command:/);
});

test('extractPseudoToolCalls parses fenced json tool calls', () => {
  const parsed = extractPseudoToolCalls('```json\n{"name":"get_weather","arguments":{"location":"Istanbul"}}\n```');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, 'get_weather');
  assert.equal(parsed.toolCalls[0].input.location, 'Istanbul');
});

test('extractPseudoToolCalls parses xml-style tool name blocks', () => {
  const parsed = extractPseudoToolCalls('<tool_call><tool_name>get_weather</tool_name><arguments>{"city":"Istanbul"}</arguments>');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, 'get_weather');
  assert.equal(parsed.toolCalls[0].input.city, 'Istanbul');
});

test('extractPseudoToolCalls parses claude-style angle tool shorthand', () => {
  const parsed = extractPseudoToolCalls('Bash>find');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, 'Bash');
  assert.equal(parsed.toolCalls[0].input.value, 'find');
});

test('extractPseudoToolCalls strips malformed filesystem server marker noise', () => {
  const parsed = extractPseudoToolCalls('tool_use>\n<server_name>filesystem</server_name>');
  assert.equal(parsed.text, '');
  assert.equal(parsed.toolCalls.length, 0);
});

test('extractPseudoToolCalls strips standalone tool_use marker with leading whitespace', () => {
  const parsed = extractPseudoToolCalls('  tool_use>\nRead README.md');
  assert.equal(parsed.text, '');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, 'Read');
});

test('extractPseudoToolCalls strips standalone filesystem marker lines around normal text', () => {
  const parsed = extractPseudoToolCalls('tool_use>\n<server_name>filesystem</server_name>\nLet me read the key files.');
  assert.equal(parsed.text, 'Let me read the key files.');
  assert.equal(parsed.toolCalls.length, 0);
});

test('extractPseudoToolCalls drops repeated bare tool_use markers instead of inventing a tool_use tool', () => {
  const parsed = extractPseudoToolCalls('tool_use>tool_use>tool_use>\ntool_use\nRead C:\\Users\\ALICOMERT\\Documents\\PROJELER\\airforce\\package.json');
  assert.equal(parsed.text, '');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, 'Read');
  assert.equal(parsed.toolCalls[0].input.value, 'C:\\Users\\ALICOMERT\\Documents\\PROJELER\\airforce\\package.json');
});

test('applyOpenAiChatNormalization remaps loose read line into filePath', () => {
  const payload = applyOpenAiChatNormalization({
    id: 'chatcmpl_4',
    object: 'chat.completion',
    created: 0,
    model: 'demo',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: 'Read C:\\\\Users\\\\ALICOMERT\\\\Documents\\\\PROJELER\\\\kariyer\\\\AGENTS.md'
      }
    }]
  }, {
    tools: [{
      type: 'function',
      function: {
        name: 'read',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            filePath: { type: 'string' }
          },
          required: ['filePath']
        }
      }
    }]
  });

  const args = JSON.parse(payload.choices[0].message.tool_calls[0].function.arguments);
  assert.equal(payload.choices[0].message.tool_calls[0].function.name, 'read');
  assert.equal(args.filePath, 'C:\\Users\\ALICOMERT\\Documents\\PROJELER\\kariyer\\AGENTS.md');
  // Schema sync: both filePath and file_path are populated (client may use either)
  assert.ok(Object.keys(args).includes('filePath'));
  assert.ok(Object.keys(args).includes('file_path'));
});

test('applyAnthropicNormalization remaps inline bash shorthand into bash tool input', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_bash',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Bash>find' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['command', 'description']
      }
    }]
  });

  assert.equal(payload.content[0].type, 'tool_use');
  assert.equal(payload.content[0].name, 'bash');
  assert.equal(payload.content[0].input.command, 'find');
});

test('applyAnthropicNormalization splits concatenated Bash command carrier', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_bash_concat',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: '<tool_call>Bashfind . -maxdepth 3 -type f | sort' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['command']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(payload.stop_reason, 'tool_use');
  assert.equal(toolBlock.name, 'Bash');
  assert.equal(toolBlock.input.command, 'find . -maxdepth 3 -type f | sort');
});

test('applyAnthropicNormalization parses xml server_name tool use', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_glob',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: '<tool_use><server_name>glob</server_name><arguments>{"pattern":"README*"}</arguments>' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'glob',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: { type: 'string' }
        },
        required: ['pattern']
      }
    }]
  });

  assert.equal(payload.content[0].name, 'glob');
  assert.equal(payload.content[0].input.pattern, 'README*');
});

test('applyOpenAiChatNormalization fills task required fields', () => {
  const payload = applyOpenAiChatNormalization({
    id: 'chatcmpl_task',
    object: 'chat.completion',
    created: 0,
    model: 'demo',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '```json\n{"name":"task","arguments":{"task":"Inspect repository"}}\n```'
      }
    }]
  }, {
    tools: [{
      type: 'function',
      function: {
        name: 'task',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string' },
            prompt: { type: 'string' },
            subagent_type: { type: 'string' }
          },
          required: ['description', 'prompt', 'subagent_type']
        }
      }
    }]
  });

  const args = JSON.parse(payload.choices[0].message.tool_calls[0].function.arguments);
  assert.equal(args.description, 'Inspect repository');
  assert.equal(args.prompt, 'Inspect repository');
  assert.equal(args.subagent_type, 'general');
});

test('extractPseudoToolCalls parses arg_key and arg_value pairs', () => {
  const parsed = extractPseudoToolCalls('<tool_call>Bash<arg_key>command</arg_key><arg_value>find . -maxdepth 1</arg_value>');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, 'Bash');
  assert.equal(parsed.toolCalls[0].input.command, 'find . -maxdepth 1');
});

test('applyAnthropicNormalization remaps bash variant names to bash', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_bash_variant',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: '<tool_call>Bash.Find()<arg_key>command</arg_key><arg_value>find . -maxdepth 1</arg_value>' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['command', 'description']
      }
    }]
  });

  assert.equal(payload.content[0].name, 'bash');
  assert.equal(payload.content[0].input.command, 'find . -maxdepth 1');
});

test('applyAnthropicNormalization repairs structured empty bash tool_use with following command carrier', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_structured',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'toolu_a', name: 'Bash', input: {} },
      { type: 'text', text: '<tool_call>command</arg_key><arg_value>{"value":"find . -maxdepth 1"}</arg_value>' }
    ],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' }
        },
        required: ['command']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.name, 'Bash');
  assert.equal(toolBlock.input.command, 'find . -maxdepth 1');
});

test('applyAnthropicNormalization keeps incomplete bash tool call long enough to coerce required fields', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_bash_coerce',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'toolu_b', name: 'bash', input: {} },
      { type: 'text', text: '<tool_call>command</arg_key><arg_value>git status</arg_value>' }
    ],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['command', 'description']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.name, 'bash');
  assert.equal(toolBlock.input.command, 'git status');
  assert.match(toolBlock.input.description, /Runs command:/);
});

test('applyAnthropicNormalization maps filesystem.read_file to Read-style input', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_fs_read',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: '<tool_use><server_name>filesystem</server_name><tool_name>read_file</tool_name><arguments>{"path":"README.md"}</arguments></tool_use>' }
    ],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Read',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string' }
        },
        required: ['file_path']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.name, 'Read');
  assert.equal(toolBlock.input.file_path, 'README.md');
});

test('applyAnthropicNormalization maps filesystem.list_directory to Glob-style pattern', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_fs_list',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: '<tool_use><server_name>filesystem</server_name><tool_name>list_directory</tool_name><arguments>{"path":"."}</arguments></tool_use>' }
    ],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Glob',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: { type: 'string' }
        },
        required: ['pattern']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.name, 'Glob');
  assert.equal(toolBlock.input.pattern, '*');
});

test('applyAnthropicNormalization maps query-string read shorthand to file_path', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_query_read',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Read ?file=c:\\Users\\ALICOMERT\\Documents\\PROJELER\\kariyer\\README.md' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Read',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string' }
        },
        required: ['file_path']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.name, 'Read');
  assert.equal(toolBlock.input.file_path, 'c:\\Users\\ALICOMERT\\Documents\\PROJELER\\kariyer\\README.md');
});

test('applyAnthropicNormalization strips invalid unicode suffix from bash command', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_bad_bash',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Bash>find . -maxdepth 1 | head -100帛' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' }
        },
        required: ['command']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.input.command, 'find . -maxdepth 1 | head -100');
});

test('applyAnthropicNormalization strips parameter closing tags from bash command', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_param_bash',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Bash>ls -la</parameter>' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' }
        },
        required: ['command']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.input.command, 'ls -la');
});

test('applyAnthropicNormalization strips trailing UI artifact suffix from bash command', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_nearly_bash',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Bash>find . -maxdepth 1 -type f | head -30Nearly>' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' }
        },
        required: ['command']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.input.command, 'find . -maxdepth 1 -type f | head -30');
});

test('applyAnthropicNormalization converts fenced bash blocks into bash tool_use', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_fenced_bash',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: '```bash\nls -la /root/airforce/\n```' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' }
        },
        required: ['command']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.name, 'Bash');
  assert.equal(toolBlock.input.command, 'ls -la /root/airforce/');
});

test('applyAnthropicNormalization remaps cat tool use into Read input', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_cat_read',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_cat', name: 'cat', input: { command: 'cat README.md' } }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Read',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string' }
        },
        required: ['file_path']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.name, 'Read');
  assert.equal(toolBlock.input.file_path, 'README.md');
});

test('applyAnthropicNormalization remaps shell command tool names into Bash', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_ls_bash',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_ls', name: 'ls', input: {} }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' }
        },
        required: ['command']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.name, 'Bash');
  assert.equal(toolBlock.input.command, 'ls');
});

test('applyAnthropicNormalization extracts fenced bash even when other tool uses exist', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_mixed_tools',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: '```bash\nls -la /workspace/\n```\n<tool_use><server_name>glob</server_name><arguments>{"pattern":"*.md"}</arguments>'
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [
      {
        name: 'Bash',
        input_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: { type: 'string' }
          },
          required: ['command']
        }
      },
      {
        name: 'Glob',
        input_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            pattern: { type: 'string' }
          },
          required: ['pattern']
        }
      }
    ],
    messages: [
      {
        role: 'user',
        content: '<command-message>/init</command-message>'
      }
    ]
  });

  const toolBlocks = payload.content.filter((block) => block.type === 'tool_use');
  assert.equal(toolBlocks.length, 2);
  const bashBlock = toolBlocks.find((block) => block.name === 'Bash');
  const globBlock = toolBlocks.find((block) => block.name === 'Glob');
  assert.equal(bashBlock.input.command, 'ls -la /workspace/');
  assert.equal(globBlock.input.pattern, '*.md');
});

test('applyAnthropicNormalization drops empty bare Skill tool line', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_bare_skill',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: "I'll analyze the repo.\n\nskill" }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Skill',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string' }
        },
        required: ['prompt']
      }
    }]
  });

  assert.equal(payload.stop_reason, 'end_turn');
  assert.equal(payload.content.filter((block) => block.type === 'tool_use').length, 0);
  assert.equal(payload.content[0].type, 'text');
  assert.match(payload.content[0].text, /I'll analyze the repo/);
});

test('applyAnthropicNormalization does not synthesize exploration tools for ordinary short replies without action context', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_plain_short',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'I can help with that.' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' }
        },
        required: ['command']
      }
    }],
    messages: [
      { role: 'user', content: 'hello there' }
    ]
  });

  assert.equal(payload.stop_reason, 'end_turn');
  assert.equal(payload.content.filter((block) => block.type === 'tool_use').length, 0);
});

test('applyAnthropicNormalization parses malformed xml parameters tool text into tool_use blocks', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_malformed_xml',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: '<tool_call>Skill tool_use>\n<tool_name>Read</tool_name>\n<parameters>\n<file_path>README.md</file_path>\n</parameters>\n<tool_name>Read</tool_name>\n<parameters>\n<file_path>AGENTS.md</file_path>\n</parameters>'
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Read',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string' }
        },
        required: ['file_path']
      }
    }]
  });

  const toolBlocks = payload.content.filter((block) => block.type === 'tool_use');
  assert.equal(payload.stop_reason, 'tool_use');
  assert.equal(toolBlocks.length, 2);
  assert.equal(toolBlocks[0].name, 'Read');
  assert.equal(toolBlocks[0].input.file_path, 'README.md');
  assert.equal(toolBlocks[1].input.file_path, 'AGENTS.md');
});

test('applyAnthropicNormalization keeps empty post-tool text empty when no explicit command exists', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_empty_after_tool',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' }
        },
        required: ['command']
      }
    }],
    messages: [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_prev', content: 'ok' }]
      }
    ]
  });

  assert.equal(payload.stop_reason, 'end_turn');
  assert.equal(payload.content.some((block) => block.type === 'tool_use'), false);
});

test('applyAnthropicNormalization keeps follow-up intent text as text when no explicit command exists', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_followup_intent',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Let me check the existing CLAUDE.md and AGENTS.md, plus key files to verify accuracy.' }],
    stop_reason: 'end_turn'
  }, {
    tools: [
      {
        name: 'Bash',
        input_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: { type: 'string' },
            description: { type: 'string' }
          },
          required: ['command']
        }
      },
      {
        name: 'Read',
        input_schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file_path: { type: 'string' }
          },
          required: ['file_path']
        }
      }
    ],
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_prev', name: 'Bash', input: { command: 'find .' } }]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_prev', content: 'ok' }]
      }
    ]
  });

  const toolBlocks = payload.content.filter((block) => block.type === 'tool_use');
  assert.equal(payload.stop_reason, 'end_turn');
  assert.equal(toolBlocks.length, 0);
});

test('applyAnthropicNormalization does not inject synthetic exploration tool calls when upstream produced none', () => {
  // Regression: eski surumlerde proxy, upstream hic tool_use uretmediginde kendisi
  // 'find . -maxdepth 2' gibi Linux'a ozgu komutlar enjekte ediyordu. Bu proje-agnostik
  // olmayi ve Windows/macOS/Linux hepsinde calismayi bozuyordu. Artik proxy sadece
  // upstream'in gercek ciktisini normalize eder, kendisi komut uretmez.
  const payload = applyAnthropicNormalization({
    id: 'msg_no_synthesis',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: "I'll analyze the codebase to understand its architecture." }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['command']
      }
    }],
    messages: [
      { role: 'user', content: '<command-message>/init</command-message>' }
    ]
  });

  assert.equal(payload.stop_reason, 'end_turn');
  assert.equal(payload.content.filter((block) => block.type === 'tool_use').length, 0);
});

test('applyAnthropicNormalization parses plain Read filename lines into tool_use', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_plain_read',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Read README.md' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Read',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string' }
        },
        required: ['file_path']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.name, 'Read');
  assert.equal(toolBlock.input.file_path, 'README.md');
});

test('applyAnthropicNormalization parses plain Write filename lines into tool_use', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_plain_write',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Write C:\\Users\\ALICOMERT\\Documents\\PROJELER\\kariyer\\CLAUDE.md' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Write',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string' }
        },
        required: ['file_path']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.name, 'Write');
  assert.equal(toolBlock.input.file_path, 'C:\\Users\\ALICOMERT\\Documents\\PROJELER\\kariyer\\CLAUDE.md');
});

test('extractPseudoToolCalls ignores generic Write file placeholder and bare Agent label', () => {
  const parsed = extractPseudoToolCalls([
    'Write file',
    'Agent:',
    'Read c:\\Users\\ALICOMERT\\Documents\\PROJELER\\airforce\\README.md'
  ].join('\n'));

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, 'Read');
  assert.equal(parsed.toolCalls[0].input.value, 'c:\\Users\\ALICOMERT\\Documents\\PROJELER\\airforce\\README.md');
});

test('applyAnthropicNormalization drops bogus ReadFile marker reads while preserving real reads', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_bogus_readfile_marker',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: [
        'Read c:\\Users\\ALICOMERT\\Documents\\PROJELER\\airforce\\package.json',
        'Read CLAUDE.md',
        'Read ReadFile>',
        'Read ReadFile>'
      ].join('\n')
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Read',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path']
      }
    }]
  });

  const toolBlocks = payload.content.filter((block) => block.type === 'tool_use');
  assert.equal(toolBlocks.length, 2);
  assert.equal(toolBlocks[0].name, 'Read');
  assert.equal(toolBlocks[0].input.file_path, 'c:\\Users\\ALICOMERT\\Documents\\PROJELER\\airforce\\package.json');
  assert.equal(toolBlocks[1].name, 'Read');
  assert.equal(toolBlocks[1].input.file_path, 'CLAUDE.md');
});

test('applyAnthropicNormalization drops bogus Plaintext tool_use blocks', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_plaintext_bogus',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Now let me read the remaining files:' },
      { type: 'tool_use', id: 'toolu_plaintext', name: 'Plaintext', input: {} }
    ],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Read',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path']
      }
    }]
  });

  assert.equal(payload.stop_reason, 'end_turn');
  assert.equal(payload.content.some((block) => block.type === 'tool_use'), false);
  assert.match(payload.content[0].text, /remaining files/i);
});

test('applyAnthropicNormalization drops unknown tool names not present in client registry', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_unknown_tool',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Now let me read the remaining files:' },
      { type: 'tool_use', id: 'toolu_unknown', name: 'NilCommand', input: { foo: 'bar' } }
    ],
    stop_reason: 'tool_use'
  }, {
    tools: [{ name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }]
  });

  assert.equal(payload.stop_reason, 'end_turn');
  assert.equal(payload.content.some((block) => block.type === 'tool_use'), false);
});

test('applyAnthropicNormalization remaps bash cat command into Read tool_use', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_bash_cat_to_read',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_bash_cat', name: 'Bash', input: { command: 'cat CLAUDE.md' } }],
    stop_reason: 'tool_use'
  }, {
    tools: [
      { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }
    ]
  });

  const toolBlocks = payload.content.filter((block) => block.type === 'tool_use');
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].name, 'Read');
  assert.equal(toolBlocks[0].input.file_path, 'CLAUDE.md');
});

test('applyAnthropicNormalization remaps xml-wrapped bash cat command into Read tool_use', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_bash_cat_xml_to_read',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_bash_cat_xml', name: 'Bash', input: { command: '<command>cat manifest.json</command>' } }],
    stop_reason: 'tool_use'
  }, {
    tools: [
      { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }
    ]
  });

  const toolBlocks = payload.content.filter((block) => block.type === 'tool_use');
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].name, 'Read');
  assert.equal(toolBlocks[0].input.file_path, 'manifest.json');
});

test('applyAnthropicNormalization remaps bash listing command into Glob tool_use', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_bash_find_to_glob',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_bash_find', name: 'Bash', input: { command: 'find . -maxdepth 3 -type f | sort' } }],
    stop_reason: 'tool_use'
  }, {
    tools: [
      { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'Glob', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } }
    ]
  });

  const toolBlocks = payload.content.filter((block) => block.type === 'tool_use');
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].name, 'Glob');
  assert.equal(toolBlocks[0].input.pattern, '**/*');
});

test('applyAnthropicNormalization deduplicates and caps parallel Read tool_use blocks', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_many_reads',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.md' } },
      { type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: 'b.md' } },
      { type: 'tool_use', id: 'r3', name: 'Read', input: { file_path: 'a.md' } },
      { type: 'tool_use', id: 'r4', name: 'Read', input: { file_path: 'c.md' } },
      { type: 'tool_use', id: 'r5', name: 'Read', input: { file_path: 'd.md' } },
      { type: 'tool_use', id: 'r6', name: 'Read', input: { file_path: 'e.md' } }
    ],
    stop_reason: 'tool_use'
  }, {
    tools: [{ name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }]
  });

  const toolBlocks = payload.content.filter((block) => block.type === 'tool_use');
  assert.equal(toolBlocks.length, 4);
  assert.deepEqual(toolBlocks.map((b) => b.input.file_path), ['a.md', 'b.md', 'c.md', 'd.md']);
});

test('applyAnthropicNormalization attaches fenced text content to preceding Write path tool call', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_write_path_then_code',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: 'Write CLAUDE.md\n```md\n# CLAUDE.md\n\nRepo guidance.\n```'
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Write',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['file_path', 'content']
      }
    }]
  });

  const toolBlocks = payload.content.filter((block) => block.type === 'tool_use');
  assert.equal(payload.stop_reason, 'tool_use');
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].name, 'Write');
  assert.equal(toolBlocks[0].input.file_path, 'CLAUDE.md');
  assert.match(toolBlocks[0].input.content, /# CLAUDE\.md/);
});

test('applyOpenAiChatNormalization coerces generic write path and text fields', () => {
  const payload = applyOpenAiChatNormalization({
    id: 'chatcmpl_write_generic',
    object: 'chat.completion',
    created: 0,
    model: 'demo',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '```json\n{"name":"Write","arguments":{"path":"/tmp/CLAUDE.md","text":"hello"}}\n```'
      }
    }]
  }, {
    tools: [{
      type: 'function',
      function: {
        name: 'Write',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file_path: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['file_path', 'content']
        }
      }
    }]
  });

  const args = JSON.parse(payload.choices[0].message.tool_calls[0].function.arguments);
  assert.equal(payload.choices[0].message.tool_calls[0].function.name, 'Write');
  assert.equal(args.file_path, '/tmp/CLAUDE.md');
  assert.equal(args.content, 'hello');
});

test('applyOpenAiChatNormalization maps delete_file into bash rm command', () => {
  const payload = applyOpenAiChatNormalization({
    id: 'chatcmpl_delete_file',
    object: 'chat.completion',
    created: 0,
    model: 'demo',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '```json\n{"name":"delete_file","arguments":{"path":"C:\\\\Users\\\\ali64\\\\Documents\\\\demo.cmd"}}\n```'
      }
    }]
  }, {
    tools: [{
      type: 'function',
      function: {
        name: 'Bash',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            command: { type: 'string' },
            description: { type: 'string' }
          },
          required: ['command', 'description']
        }
      }
    }]
  });

  const toolCall = payload.choices[0].message.tool_calls[0];
  const args = JSON.parse(toolCall.function.arguments);
  assert.equal(toolCall.function.name, 'Bash');
  assert.equal(args.command, "rm -f -- 'C:\\Users\\ali64\\Documents\\demo.cmd'");
  assert.match(args.description, /Delete file/);
});

test('applyAnthropicNormalization strips trailing bash suffix before prose', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_bash_suffix_prose',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Bash>cat /workspace/src/transforms.js 2>/dev/null | head -150</bash>Now I have a comprehensive understanding.' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['command']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.name, 'Bash');
  assert.equal(toolBlock.input.command, 'cat /workspace/src/transforms.js 2>/dev/null | head -150');
});

test('applyAnthropicNormalization parses file-to-write blocks into write tool_use', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_file_write_block',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: `<file:///workspace/docs/PROJECT.md>
\`\`\`
# PROJECT.md

hello
\`\`\`
</file-to-write>`
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Write',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['file_path', 'content']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(payload.stop_reason, 'tool_use');
  assert.equal(toolBlock.name, 'Write');
  assert.equal(toolBlock.input.file_path, '/workspace/docs/PROJECT.md');
  assert.match(toolBlock.input.content, /# PROJECT\.md/);
});

test('applyAnthropicNormalization keeps ordinary completion text after prior assistant tool use', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_done_after_tools',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Done.' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' }
        },
        required: ['command']
      }
    }],
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_prev', name: 'Bash', input: { command: 'find .' } }]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_prev', content: 'ok' }]
      }
    ]
  });

  assert.equal(payload.stop_reason, 'end_turn');
  assert.equal(payload.content.filter((block) => block.type === 'tool_use').length, 0);
});

test('applyAnthropicNormalization strips malformed trailing slash-angle from bash command', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_bad_bash_suffix',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Bash>find . -type f -name "*.php" | head -30</' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' }
        },
        required: ['command']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.input.command, 'find . -type f -name "*.php" | head -30');
});

test('applyAnthropicNormalization strips trailing closing bash tag from bash command', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_bad_bash_tag_suffix',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Bash>find . -maxdepth 1 -type f | head -30</bash>' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' }
        },
        required: ['command']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.input.command, 'find . -maxdepth 1 -type f | head -30');
});

test('applyAnthropicNormalization strips trailing sortify artifact from bash command', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_bad_bash_sortify_suffix',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Bash>find . -maxdepth 3 -type f -name "*.php" | sortify>' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' }
        },
        required: ['command']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.input.command, 'find . -maxdepth 3 -type f -name "*.php" |');
});

test('applyAnthropicNormalization strips trailing quoted ify artifact from bash command', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_bad_bash_ify_suffix',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Bash>cat README.md 2>/dev/null || echo "---NO README---"ify>' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' }
        },
        required: ['command']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.input.command, 'cat README.md 2>/dev/null || echo "---NO README---"');
});

test('applyAnthropicNormalization strips trailing think prose from bash command', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_bad_bash_think_suffix',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Bash>echo "done"</think>I created the file successfully.' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' }
        },
        required: ['command']
      }
    }]
  });

  const toolBlock = payload.content.find((block) => block.type === 'tool_use');
  assert.equal(toolBlock.input.command, 'echo "done"');
});

test('applyAnthropicNormalization collapses parallel bash tool_use blocks to a single call', () => {
  // Regression: upstream modelleri tek turda 5-6 bash call'u birden atiyor.
  // Anthropic istemcileri (Claude Code) bunlari paralel calistirir, biri fail
  // edince "parallel tool call errored" ile kalanlari iptal eder ve sistem
  // kilitlenir. Proxy ayni turda birden fazla bash varsa sadece ilkini birakir.
  // Komut icerigi HIC degistirilmez, sadece paralel duplicate'lar elenir.
  const payload = applyAnthropicNormalization({
    id: 'msg_parallel_bash',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'find /some/path -maxdepth 3' } },
      { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'cd /some/path && ls -la' } },
      { type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: 'cat /some/path/index.html' } },
      { type: 'tool_use', id: 'toolu_4', name: 'Bash', input: { command: 'powershell.exe -Command "Get-ChildItem"' } }
    ],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          command: { type: 'string' }
        },
        required: ['command']
      }
    }]
  });

  const toolBlocks = payload.content.filter((block) => block.type === 'tool_use');
  assert.equal(payload.stop_reason, 'tool_use');
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].name, 'Bash');
  // Komut icerigi degistirilmemis olmali (ilk call aynen gecer)
  assert.equal(toolBlocks[0].input.command, 'find /some/path -maxdepth 3');
});

test('applyAnthropicNormalization preserves parallel read+bash mix (different tools)', () => {
  // Collapse sadece ayni STATEFUL tool icin yapiliyor. Farkli tool'larin paralel
  // calismasi OK (read stateless, bash stateful).
  const payload = applyAnthropicNormalization({
    id: 'msg_mix_tools',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: 'README.md' } },
      { type: 'tool_use', id: 'toolu_3', name: 'Read', input: { file_path: 'AGENTS.md' } }
    ],
    stop_reason: 'tool_use'
  }, {
    tools: [
      { name: 'Bash', input_schema: { type: 'object', additionalProperties: false, properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'Read', input_schema: { type: 'object', additionalProperties: false, properties: { file_path: { type: 'string' } }, required: ['file_path'] } }
    ]
  });

  const toolBlocks = payload.content.filter((block) => block.type === 'tool_use');
  // 1 bash + 2 read: read stateless oldugu icin ikisi de korunur, bash 1 kalir
  assert.equal(toolBlocks.length, 3);
  assert.equal(toolBlocks.filter((b) => b.name === 'Bash').length, 1);
  assert.equal(toolBlocks.filter((b) => b.name === 'Read').length, 2);
});

// ---- Intent Synthesis regression tests ----

test('intent synthesis: model emits code block + user wants "index.html olustur" → synthesizes Write tool', () => {
  // Zayif modeller (glm-5 vb.) dosyayi text icinde yaziyor, Write tool_use
  // uretmiyor. Proxy kullanicinin isteginde gecen dosya adini kullanarak
  // Write sentezlemeli ki Claude Code dosyayi diske yazsin.
  const payload = applyAnthropicNormalization({
    id: 'msg_write_synthesis',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: 'Hemen olusturuyorum:\n\n```html\n<!DOCTYPE html>\n<html><body>Hi</body></html>\n```\n\nDosyayi kaydet.'
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Write',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['file_path', 'content']
      }
    }],
    messages: [
      { role: 'user', content: 'index.html olustur, kariyer sitesi yap' }
    ]
  });

  const toolBlocks = payload.content.filter((b) => b.type === 'tool_use');
  assert.equal(payload.stop_reason, 'tool_use');
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].name, 'Write');
  assert.equal(toolBlocks[0].input.file_path, 'index.html');
  assert.match(toolBlocks[0].input.content, /<!DOCTYPE html>/);
});

test('intent synthesis: code block with no filename and unknown language → no synthesis (keep as text)', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_code_no_filename',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Here is a snippet:\n\n```\nrandom text\n```' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Write',
      input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] }
    }],
    messages: [{ role: 'user', content: 'hi' }]
  });

  assert.equal(payload.stop_reason, 'end_turn');
  assert.equal(payload.content.filter((b) => b.type === 'tool_use').length, 0);
});

test('intent synthesis: /init + stalling text → synthesizes Glob with **/* (cross-platform)', () => {
  // Zayif modeller "/init" gibi explore komutlarina "Let me first check" deyip
  // end_turn ile bitiriyor. Proxy Glob sentezleyerek loop'u devam ettirir.
  // Glob her OS'ta calisir, hardcoded Linux komutu (find .) ICERMEZ.
  const payload = applyAnthropicNormalization({
    id: 'msg_init_stalling',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: "Let me first check what's in the repository." }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Glob',
      input_schema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern']
      }
    }],
    messages: [
      { role: 'user', content: '<command-name>/init</command-name>\nPlease analyze this codebase' }
    ]
  });

  const toolBlocks = payload.content.filter((b) => b.type === 'tool_use');
  assert.equal(payload.stop_reason, 'tool_use');
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].name, 'Glob');
  assert.equal(toolBlocks[0].input.pattern, '**/*');
  // Hardcoded yol veya Linux komutu OLMAMALI
  assert.doesNotMatch(JSON.stringify(toolBlocks[0].input), /\/(workspace|root|tmp|home)\//);
  assert.doesNotMatch(JSON.stringify(toolBlocks[0].input), /\bfind\s+\./);
});

test('intent synthesis: single file read intent → synthesizes Read tool with that file', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_single_read',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: "Let me read package.json to understand the project." }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Read',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path']
      }
    }],
    messages: [{ role: 'user', content: 'bu projeyi anlatabilir misin' }]
  });

  const toolBlocks = payload.content.filter((b) => b.type === 'tool_use');
  assert.equal(payload.stop_reason, 'tool_use');
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].name, 'Read');
  assert.equal(toolBlocks[0].input.file_path, 'package.json');
});

test('intent synthesis: after exploration tool_result, synthesizes Read for key discovered file', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_followup_read_after_glob',
    type: 'message',
    role: 'assistant',
    content: [],
    stop_reason: 'end_turn'
  }, {
    tools: [
      {
        name: 'Glob',
        input_schema: {
          type: 'object',
          properties: { pattern: { type: 'string' } },
          required: ['pattern']
        }
      },
      {
        name: 'Read',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path']
        }
      }
    ],
    messages: [
      { role: 'user', content: '<command-name>/init</command-name>\nPlease analyze this codebase' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll start by exploring the codebase structure and key files." },
          { type: 'tool_use', id: 'toolu_glob', name: 'Glob', input: { pattern: '**/*' } }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_glob',
            content: 'src/index.js\nREADME.md\nAGENTS.md\npackage.json\nlib/normalizers.js'
          }
        ]
      }
    ]
  });

  const toolBlocks = payload.content.filter((b) => b.type === 'tool_use');
  assert.equal(payload.stop_reason, 'tool_use');
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].name, 'Read');
  assert.equal(toolBlocks[0].input.file_path, 'AGENTS.md');
});

test('intent synthesis: generic "read key files" after exploration prefers Read over Glob', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_followup_generic_read_after_glob',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Let me read the key files to understand the project.' }],
    stop_reason: 'end_turn'
  }, {
    tools: [
      {
        name: 'Glob',
        input_schema: {
          type: 'object',
          properties: { pattern: { type: 'string' } },
          required: ['pattern']
        }
      },
      {
        name: 'Read',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path']
        }
      }
    ],
    messages: [
      { role: 'user', content: 'analyze this repo' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_glob_recent', name: 'Glob', input: { pattern: '**/*' } }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_glob_recent',
            content: 'README.md\nAGENTS.md\npackage.json\nserver.js'
          }
        ]
      }
    ]
  });

  const toolBlocks = payload.content.filter((b) => b.type === 'tool_use');
  assert.equal(payload.stop_reason, 'tool_use');
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].name, 'Read');
  assert.equal(toolBlocks[0].input.file_path, 'AGENTS.md');
});

test('intent synthesis: after one Read, generic follow-up picks next unread key file from prior listing', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_followup_next_unread_after_read',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'It seems the file listing keeps repeating. Let me try to directly read the key files.' }],
    stop_reason: 'end_turn'
  }, {
    tools: [
      {
        name: 'Glob',
        input_schema: {
          type: 'object',
          properties: { pattern: { type: 'string' } },
          required: ['pattern']
        }
      },
      {
        name: 'Read',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path']
        }
      }
    ],
    messages: [
      { role: 'user', content: 'analyze this repo' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_glob_initial', name: 'Glob', input: { pattern: '**/*' } }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_glob_initial',
            content: 'README.md\nAGENTS.md\npackage.json\nserver.js'
          }
        ]
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_read_first', name: 'Read', input: { file_path: 'AGENTS.md' } }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_read_first',
            content: '# AGENTS\nrepo instructions'
          }
        ]
      }
    ]
  });

  const toolBlocks = payload.content.filter((b) => b.type === 'tool_use');
  assert.equal(payload.stop_reason, 'tool_use');
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].name, 'Read');
  assert.equal(toolBlocks[0].input.file_path, 'README.md');
});

test('applyAnthropicNormalization suppresses repeated Read loop after prior read tool_result', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_repeat_read_loop',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'toolu_read_repeat_a', name: 'Read', input: { file_path: 'AGENTS.md' } },
      { type: 'tool_use', id: 'toolu_read_repeat_b', name: 'Read', input: { file_path: 'README.md' } },
      { type: 'tool_use', id: 'toolu_read_repeat_c', name: 'Read', input: { file_path: 'package.json' } },
      { type: 'tool_use', id: 'toolu_read_repeat_d', name: 'Read', input: { file_path: 'CLAUDE.md' } }
    ],
    stop_reason: 'tool_use'
  }, {
    tools: [
      { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }
    ],
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_prev_read', name: 'Read', input: { file_path: 'AGENTS.md' } }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_prev_read',
            content: '# AGENTS.md\n\nrepo instructions'
          }
        ]
      }
    ]
  });

  const toolBlocks = payload.content.filter((block) => block.type === 'tool_use');
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].name, 'Read');
  assert.equal(toolBlocks[0].input.file_path, 'README.md');
});

test('intent synthesis: plain chitchat (no code, no intent) → no synthesis', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_chitchat',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Merhaba! Nasil yardimci olabilirim?' }],
    stop_reason: 'end_turn'
  }, {
    tools: [
      { name: 'Write', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
      { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
      { name: 'Glob', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } }
    ],
    messages: [{ role: 'user', content: 'selam' }]
  });

  assert.equal(payload.stop_reason, 'end_turn');
  assert.equal(payload.content.filter((b) => b.type === 'tool_use').length, 0);
  // Text bozulmadan gelsin
  assert.match(payload.content[0].text, /Merhaba/);
});

test('intent synthesis: respects client tool naming (write_file snake_case variant)', () => {
  // Farkli istemciler farkli tool isimleri kullaniyor olabilir (write_file,
  // WriteFile, create_file). Sentez istemciden GELEN ismi kullanmali.
  const payload = applyAnthropicNormalization({
    id: 'msg_write_snake',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: '```js\nconsole.log("hi");\n```' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'write_file',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content']
      }
    }],
    messages: [{ role: 'user', content: 'app.js olustur' }]
  });

  const toolBlocks = payload.content.filter((b) => b.type === 'tool_use');
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].name, 'write_file');
  assert.equal(toolBlocks[0].input.path, 'app.js');
  assert.match(toolBlocks[0].input.content, /console\.log/);
});

test('intent synthesis: real-world Claude Code + glm-5 scenario (kariyer site)', () => {
  // User log'undan ger\u00e7ek senaryo. Kullanici "index.html olustur, kariyer
  // sitesi yap" dedi; glm-5 HTML'i text icinde bastirdi, Write cagrisi uretmedi.
  // Proxy kullanicinin isteginden 'index.html' ismini, model cevabindan kod
  // blogunu alip Write sentezlemeli.
  const htmlContent = '<!DOCTYPE html>\n<html lang="tr">\n<head><title>Kariyer</title></head>\n<body>Hi</body>\n</html>';
  const payload = applyAnthropicNormalization({
    id: 'msg_real_kariyer',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: `Hemen olusturuyorum:\n\n\`\`\`html\n${htmlContent}\n\`\`\`\n\nTek sayfa, karanlik tema, dosyayi index.html olarak kaydet.`
    }],
    stop_reason: 'end_turn'
  }, {
    // Claude Code'un gercek tool listesi (debug log'undaki subset)
    tools: [
      { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
      { name: 'Write', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
      { name: 'Edit', input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] } },
      { name: 'Glob', input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } }
    ],
    messages: [
      {
        role: 'user',
        content: 'senden istedigim index.html olusturup cok ufak sekilde kariyer sitesi yapman tek sayfa olsun acil olsun'
      }
    ]
  });

  const toolBlocks = payload.content.filter((b) => b.type === 'tool_use');
  assert.equal(payload.stop_reason, 'tool_use');
  assert.equal(toolBlocks.length, 1);
  assert.equal(toolBlocks[0].name, 'Write');
  assert.equal(toolBlocks[0].input.file_path, 'index.html');
  assert.match(toolBlocks[0].input.content, /<!DOCTYPE html>/);
  assert.match(toolBlocks[0].input.content, /<title>Kariyer/);
});

test('intent synthesis: disabled via SYNTHESIZE_INTENT=0', () => {
  // Not: Bu test runtime'da env read edildigi icin yuklendigi anda karar veriyor.
  // Dolayisiyla env toggle test'ini ayri process'te calistirmak gerek. Bunun yerine
  // 'synthesis yoksa neler olmuyor' davranisini test ediyoruz.
  // (Env flag'i manual test edilebilir: SYNTHESIZE_INTENT=0 node --test)
  // Burada sadece synth olmadan da plain text'e zarar verilmedigini kontrol edelim:
  const payload = applyAnthropicNormalization({
    id: 'msg_plain_with_no_tools',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Cevap: 42' }],
    stop_reason: 'end_turn'
  }, {
    // Tool listesi bos = hic sentez yapilamaz
    tools: [],
    messages: [{ role: 'user', content: 'nedir 42?' }]
  });

  assert.equal(payload.stop_reason, 'end_turn');
  assert.equal(payload.content.filter((b) => b.type === 'tool_use').length, 0);
});

// ---- Claude Code instrumentation tag leakage fixes ----

test('sanitizeCommand strips <command_message> block that leaks into bash command', () => {
  // Real log: upstream model leaked <command_message> into bash command:
  //   "find . -type f | head -80\n<command_message>find . -type f | head -80"
  // bash syntax / unknown-command fail here.
  const payload = applyAnthropicNormalization({
    id: 'msg_command_message_leak',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_leak1',
      name: 'Bash',
      input: { command: 'find . -type f | head -80\n<command_message>find . -type f | head -80' }
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
    }]
  });

  const block = payload.content.find((b) => b.type === 'tool_use');
  assert.ok(block, 'tool_use block expected');
  assert.doesNotMatch(block.input.command, /<command_message>/i);
  assert.doesNotMatch(block.input.command, /<\/command_message>/i);
  assert.match(block.input.command, /find \. -type f \| head -80/);
});

test('sanitizeCommand strips leading single dash from bash command (-find -> find)', () => {
  // Upstream model sometimes starts command with '-find'. bash rejects:
  //   '/bin/bash: eval: -f: invalid option'
  const payload = applyAnthropicNormalization({
    id: 'msg_leading_dash',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_dash',
      name: 'Bash',
      input: { command: '-find . -type f | head -80' }
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
    }]
  });

  const block = payload.content.find((b) => b.type === 'tool_use');
  assert.equal(block.input.command, 'find . -type f | head -80');
});

test('sanitizeCommand preserves legitimate dash flags and double-dash options', () => {
  // Leading-dash fix must stay conservative: -c, --help should be preserved.
  const payload = applyAnthropicNormalization({
    id: 'msg_preserve_flags',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: '--help' } }
    ],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
    }]
  });

  const blocks = payload.content.filter((b) => b.type === 'tool_use');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].input.command, '--help');
});

test('Read tool_use with trailing XML artifact in file_path is sanitized', () => {
  // Real log: Read(index.html</Read-Ray>) - Claude Code instrumentation tag
  // leaked into the path. Tool input path fields must be sanitized too.
  const payload = applyAnthropicNormalization({
    id: 'msg_read_path_xml',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_read_xml',
      name: 'Read',
      input: { file_path: 'index.html</Read-Ray>' }
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Read',
      input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
    }]
  });

  const block = payload.content.find((b) => b.type === 'tool_use');
  assert.equal(block.input.file_path, 'index.html');
});

test('Write tool_use with trailing XML artifact in file_path is sanitized', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_write_path_xml',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_write_xml',
      name: 'Write',
      input: { file_path: 'output.md</Write-Block>', content: 'hello' }
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Write',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
        required: ['file_path', 'content']
      }
    }]
  });

  const block = payload.content.find((b) => b.type === 'tool_use');
  assert.equal(block.input.file_path, 'output.md');
  assert.equal(block.input.content, 'hello');
});

test('Glob tool_use with system-reminder tag in pattern is sanitized', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg_glob_reminder',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_glob_tag',
      name: 'Glob',
      input: { pattern: '**/*<system-reminder>context changed</system-reminder>' }
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Glob',
      input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] }
    }]
  });

  const block = payload.content.find((b) => b.type === 'tool_use');
  assert.equal(block.input.pattern, '**/*');
});

// ---- OpenAI structured tool_calls schema fix (OpenCode Zod compatibility) ----

test('applyOpenAiChatNormalization fills filePath when upstream sent only file_path (OpenCode schema)', () => {
  // Real log from OpenCode + glm-5: upstream gonderdi arguments='{"file_path":"AGENTS.md"}'
  // ama OpenCode Zod validator 'filePath' (camelCase) bekliyor, required field.
  // Sonuc: 'Invalid input: expected string, received undefined' hatasi ve sonsuz
  // loop. Proxy structured tool_calls'i canonicalize etmeli - istemcinin schema
  // 'property' listesine gore dogru alan(lar)i doldurmali.
  const payload = applyOpenAiChatNormalization({
    id: 'chat_1',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_abc',
          type: 'function',
          function: {
            name: 'read',
            arguments: '{"file_path":"AGENTS.md"}'
          }
        }]
      }
    }]
  }, {
    // OpenCode schema: filePath camelCase, required
    tools: [{
      type: 'function',
      function: {
        name: 'read',
        parameters: {
          type: 'object',
          properties: { filePath: { type: 'string' } },
          required: ['filePath']
        }
      }
    }]
  });

  const tc = payload.choices[0].message.tool_calls[0];
  assert.equal(tc.function.name, 'read');
  const args = JSON.parse(tc.function.arguments);
  assert.equal(args.filePath, 'AGENTS.md');
});

test('applyOpenAiChatNormalization fills file_path when upstream sent only filePath (Anthropic-style schema)', () => {
  // Ters durum: upstream filePath yazdi, istemci file_path bekliyor.
  // canonicalizeToolCalls her iki field'i da doldurur.
  const payload = applyOpenAiChatNormalization({
    id: 'chat_2',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_xyz',
          type: 'function',
          function: {
            name: 'read',
            arguments: '{"filePath":"server.js"}'
          }
        }]
      }
    }]
  }, {
    tools: [{
      type: 'function',
      function: {
        name: 'read',
        parameters: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path']
        }
      }
    }]
  });

  const tc = payload.choices[0].message.tool_calls[0];
  const args = JSON.parse(tc.function.arguments);
  assert.equal(args.file_path, 'server.js');
});

test('applyOpenAiChatNormalization sanitizes XML artifact in structured tool_call path argument', () => {
  // Claude Code instrumentation tag'i path'e sizmis - structured tool_calls
  // path'indan da temizlenmeli (Anthropic tarafi gibi OpenAI tarafi da).
  const payload = applyOpenAiChatNormalization({
    id: 'chat_sanitize',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_san',
          type: 'function',
          function: {
            name: 'read',
            arguments: '{"filePath":"index.html</Read-Ray>"}'
          }
        }]
      }
    }]
  }, {
    tools: [{
      type: 'function',
      function: {
        name: 'read',
        parameters: {
          type: 'object',
          properties: { filePath: { type: 'string' } },
          required: ['filePath']
        }
      }
    }]
  });

  const tc = payload.choices[0].message.tool_calls[0];
  const args = JSON.parse(tc.function.arguments);
  assert.equal(args.filePath, 'index.html');
});

test('applyOpenAiChatNormalization collapses parallel bash tool_calls (stateful tool)', () => {
  // Structured tool_calls array'inde birden fazla bash varsa - sadece ilki kalsin.
  const payload = applyOpenAiChatNormalization({
    id: 'chat_collapse',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls -la"}' } },
          { id: 'c2', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } },
          { id: 'c3', type: 'function', function: { name: 'bash', arguments: '{"command":"whoami"}' } }
        ]
      }
    }]
  }, {
    tools: [{
      type: 'function',
      function: {
        name: 'bash',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command']
        }
      }
    }]
  });

  const toolCalls = payload.choices[0].message.tool_calls;
  assert.equal(toolCalls.length, 1);
  const args = JSON.parse(toolCalls[0].function.arguments);
  assert.equal(args.command, 'ls -la');
});

test('applyOpenAiChatNormalization handles malformed JSON arguments gracefully', () => {
  // Upstream bazen invalid JSON gonderir ('{broken'). Proxy patlamadan empty obj'e dusurur.
  const payload = applyOpenAiChatNormalization({
    id: 'chat_malformed',
    choices: [{
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'c1',
          type: 'function',
          function: {
            name: 'read',
            arguments: '{"filePath":"broken'  // missing closing
          }
        }]
      }
    }]
  }, {
    tools: [{
      type: 'function',
      function: {
        name: 'read',
        parameters: {
          type: 'object',
          properties: { filePath: { type: 'string' } },
          required: ['filePath']
        }
      }
    }]
  });

  // Crash etmemeli, tool_calls array cikmali (bos input ile).
  assert.ok(Array.isArray(payload.choices[0].message.tool_calls));
  assert.equal(payload.choices[0].message.tool_calls.length, 1);
});

test('drops upstream tool_use Read with empty input (no file_path)', () => {
  // Upstream bazen (ozellikle glm-5) {type:'tool_use', name:'Read', input:{}}
  // gonderiyor. coerceToolInput path alanlarini undefined ile dolduruyordu;
  // eski dropEmptyBrokenToolCalls `Object.keys(input).length === 0` kontrolu
  // yaptigi icin dusmuyordu -> client Zod validation error atip donuyordu.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_broken_read',
      name: 'Read',
      input: {}
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Read',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path']
      }
    }]
  });

  // Broken Read dusuruldu, tool_use yok, stop_reason end_turn'e indirildi.
  assert.equal(payload.stop_reason, 'end_turn');
  const toolUseBlocks = payload.content.filter((b) => b?.type === 'tool_use');
  assert.equal(toolUseBlocks.length, 0);
});

test('drops upstream tool_use Glob with empty input (no pattern)', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_broken_glob',
      name: 'Glob',
      input: {}
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Glob',
      input_schema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern']
      }
    }]
  });

  assert.equal(payload.stop_reason, 'end_turn');
  const toolUseBlocks = payload.content.filter((b) => b?.type === 'tool_use');
  assert.equal(toolUseBlocks.length, 0);
});

test('drops bash tool_use with only tool-name as command (context/Bash/:message=...)', () => {
  // Upstream bazen Bash(command="context") ya da Bash(command=":message=...")
  // gibi anlamsiz komutlar gonderiyor. Bunlar /bin/bash: exit 127 uretiyor ve
  // ajan loop'u kiliyor. Bu bogus komutlar drop edilmeli.
  for (const bogusCommand of ['context', 'Bash', ':message="Update test"', '-message=foo', '--param=bar']) {
    const payload = applyAnthropicNormalization({
      id: 'msg',
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_bogus_bash',
        name: 'Bash',
        input: { command: bogusCommand }
      }],
      stop_reason: 'tool_use'
    }, {
      tools: [{
        name: 'Bash',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command']
        }
      }]
    });

    const toolUseBlocks = payload.content.filter((b) => b?.type === 'tool_use');
    assert.equal(toolUseBlocks.length, 0, `bogus command should be dropped: ${bogusCommand}`);
  }
});

test('suppresses read of file already read in earlier (not just last) turn', () => {
  // Weak models loop: Read AGENTS.md -> "empty" -> Read AGENTS.md -> "empty" -> ...
  // Eskiden sadece son assistant turunda kontrol ediliyordu; artik butun gecmis.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_read_again',
      name: 'Read',
      input: { file_path: 'AGENTS.md' }
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Read',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path']
      }
    }, {
      name: 'Glob',
      input_schema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern']
      }
    }],
    messages: [
      { role: 'user', content: 'explore' },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_read_1',
          name: 'Read',
          input: { file_path: 'AGENTS.md' }
        }]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_read_1', content: 'content' }]
      },
      // Aradaki asistant turu FARKLI bir sey yapiyor
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_glob_1',
          name: 'Glob',
          input: { pattern: '**/*' }
        }]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_glob_1', content: 'README.md\n' }]
      }
    ]
  });

  // Ayni dosya tekrar okunmaya calisildi (2. Read); drop edilmeli ve intent
  // synthesis baska bir dosya (README.md) sentezlemeli.
  const toolUseBlocks = payload.content.filter((b) => b?.type === 'tool_use');
  assert.equal(toolUseBlocks.length, 1);
  // Ya tamamen baska bir dosya, ya da bos (en azindan AGENTS.md degil)
  const readPath = toolUseBlocks[0].input?.file_path ?? toolUseBlocks[0].input?.filePath ?? toolUseBlocks[0].input?.path;
  assert.notEqual(String(readPath ?? '').toLowerCase(), 'agents.md');
});

test('intent synthesis picks a file after Glob tool_result when model emits broken Read', () => {
  // Conversation: user -> assistant uses Glob -> tool_result contains AGENTS.md
  // -> assistant emits broken Read with no file_path -> we drop it and
  // intent synthesis should pick AGENTS.md from the glob result.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_broken_read',
      name: 'Read',
      input: {}
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Read',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path']
      }
    }, {
      name: 'Glob',
      input_schema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern']
      }
    }],
    messages: [
      { role: 'user', content: 'incele' },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_glob_1',
          name: 'Glob',
          input: { pattern: '**/*' }
        }]
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_glob_1',
          content: 'AGENTS.md\npackage.json\nserver.js\n'
        }]
      }
    ]
  });

  const toolUseBlocks = payload.content.filter((b) => b?.type === 'tool_use');
  // Broken Read dusuruldu ama intent synthesis Read(AGENTS.md) sentezledi.
  assert.equal(toolUseBlocks.length, 1);
  assert.equal(toolUseBlocks[0].name, 'Read');
  const readPath = toolUseBlocks[0].input?.file_path ?? toolUseBlocks[0].input?.filePath ?? toolUseBlocks[0].input?.path;
  // AGENTS.md en oncelikli dosya (KEY_FILE_PRIORITY)
  assert.equal(String(readPath).toLowerCase(), 'agents.md');
});

test('strips command-message client instrumentation tags from bash command', () => {
  // Claude Code / OpenCode istemcileri <command-message>...</command-message>
  // gibi tag'leri text'e gomuyor; model bazen bunlari bash komutuna yapistirir.
  // Eski INSTRUMENTATION_TAG_RE sadece underscore'u yakaliyordu (command_message),
  // simdi dash'li (command-message) de yakalaniyor.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_bash',
      name: 'Bash',
      input: { command: 'ls -la\n<command-message>internal</command-message>' }
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' }, description: { type: 'string' } },
        required: ['command']
      }
    }]
  });

  const toolBlock = payload.content.find((b) => b?.type === 'tool_use');
  assert.ok(toolBlock);
  assert.equal(toolBlock.input.command, 'ls -la');
});

test('intent synthesis does NOT emit Write when model says "Let me read" (even with code block)', () => {
  // Regression: proxy was synthesizing Write(settings.local.json, ./.claude/...)
  // because model's bash output (a file listing in a ```code block```) was
  // mistaken for file content to write. Model explicitly said "Let me read" ->
  // no Write should be synthesized.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: '<details>\n<summary>Viewing all files in the repo</summary>\n\n```\n./.claude/settings.local.json\n./AGENTS.md\n./icon-192.png\n./index.html\n./manifest.json\n```\n</details>\nLet me read the key files to understand the project.'
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Write',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['file_path', 'content']
      }
    }, {
      name: 'Read',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path']
      }
    }, {
      name: 'Glob',
      input_schema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern']
      }
    }],
    messages: [
      { role: 'user', content: 'explore the repo' }
    ]
  });

  const writeBlocks = payload.content.filter((b) => b?.type === 'tool_use' && b?.name === 'Write');
  assert.equal(writeBlocks.length, 0, 'should not synthesize Write when model wants to read');
});

test('intent synthesis does NOT emit Write when fenced block is a file listing', () => {
  // Even if user says "make the file", if the fenced block is just a list of
  // paths (bash output), it is NOT file content to write.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: 'Here are the files:\n```\n./foo.md\n./bar.md\n./baz.js\n```'
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Write',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
        required: ['file_path', 'content']
      }
    }],
    messages: [
      { role: 'user', content: 'create a file foo.md for me' }
    ]
  });

  const writeBlocks = payload.content.filter((b) => b?.type === 'tool_use' && b?.name === 'Write');
  assert.equal(writeBlocks.length, 0, 'should not synthesize Write from a file-listing fenced block');
});

test('intent synthesis DOES emit Write when user asks to create a file with actual code block', () => {
  // Positive: user says 'olustur' (create), model returns fenced html code ->
  // Write(index.html, <html>...</html>) should be synthesized.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: "I'll create the file.\n```html\n<!DOCTYPE html>\n<html><body><h1>Hello</h1></body></html>\n```"
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Write',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
        required: ['file_path', 'content']
      }
    }],
    messages: [
      { role: 'user', content: 'index.html dosyasi olustur' }
    ]
  });

  const writeBlocks = payload.content.filter((b) => b?.type === 'tool_use' && b?.name === 'Write');
  assert.equal(writeBlocks.length, 1);
  assert.equal(writeBlocks[0].input.file_path, 'index.html');
  assert.ok(writeBlocks[0].input.content.includes('<!DOCTYPE html>'));
});

test('cleans consecutive tool_use> stray text that weak models emit', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: 'tool_use>\n\ntool_use>\n\ntool_use>'
    }],
    stop_reason: 'end_turn'
  });

  // Text tamamen temizlenmeli, bos content kalmamali (ya bos text ya hic text).
  const textBlocks = payload.content.filter((b) => b?.type === 'text');
  for (const block of textBlocks) {
    assert.ok(!/tool_use>\s*tool_use>/.test(block.text ?? ''), 'consecutive tool_use> tokens should be stripped');
  }
});

// --- Dile bagimsiz intent synthesis testleri ---
//
// Hardcoded "let me read" / "olustur" / vs. regex'leri kaldirildi. Artik
// sentez kararlari DETERMINISTIK sinyallerle yapiliyor: tool-history, fenced
// block yapisi, render container, kullanici metninde dosya adi.
// Bu yuzden testler Cince, Almanca, emoji gibi farkli dillerde de ayni
// sonuclari vermeli.

test('drops Write when content heading references DIFFERENT file (prevents overwriting wrong file)', () => {
  // Real log regression: model emitted Write(manifest.json, '# CLAUDE.md\n...').
  // This would overwrite manifest.json with CLAUDE.md content -> catastrophic.
  // Content first-line heading filename mismatches path.basename -> DROP.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_mismatch',
      name: 'Write',
      input: {
        file_path: 'manifest.json',
        content: '# CLAUDE.md\n\nThis file provides guidance to Claude Code.'
      }
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Write',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
        required: ['file_path', 'content']
      }
    }],
    messages: [{ role: 'user', content: 'create CLAUDE.md' }]
  });

  const writeBlocks = payload.content.filter((b) => b?.type === 'tool_use' && b?.name === 'Write');
  assert.equal(writeBlocks.length, 0, 'Write with content heading for different file must be dropped');
});

test('keeps Write when content heading matches path basename (legitimate)', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_ok',
      name: 'Write',
      input: {
        file_path: 'CLAUDE.md',
        content: '# CLAUDE.md\n\nThis file provides guidance.'
      }
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Write',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
        required: ['file_path', 'content']
      }
    }]
  });

  const writeBlocks = payload.content.filter((b) => b?.type === 'tool_use' && b?.name === 'Write');
  assert.equal(writeBlocks.length, 1, 'matching filename in heading should pass');
});

test('keeps Write when content has no filename heading (common case)', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_no_heading',
      name: 'Write',
      input: {
        file_path: 'config.json',
        content: '{"key":"value"}'
      }
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Write',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
        required: ['file_path', 'content']
      }
    }]
  });

  const writeBlocks = payload.content.filter((b) => b?.type === 'tool_use' && b?.name === 'Write');
  assert.equal(writeBlocks.length, 1, 'no filename heading in content -> no mismatch, pass');
});

test('drops Bash(timeout) alone - missing operand, produces exit 1', () => {
  // Real log: model emitted Bash(command='timeout'). That produces
  // "timeout: missing operand" on Linux. Useless call, drop it.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_to',
      name: 'Bash',
      input: { command: 'timeout' }
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Bash',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command']
      }
    }]
  });

  const toolBlocks = payload.content.filter((b) => b?.type === 'tool_use');
  assert.equal(toolBlocks.length, 0, 'bare "timeout" command should be dropped');
});

test('collapses duplicate Glob calls with same pattern in one turn', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 't1', name: 'Glob', input: { pattern: '**/*' } },
      { type: 'tool_use', id: 't2', name: 'Glob', input: { pattern: '**/*' } },
      { type: 'tool_use', id: 't3', name: 'Glob', input: { pattern: '**/*' } }
    ],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Glob',
      input_schema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern']
      }
    }]
  });

  const toolBlocks = payload.content.filter((b) => b?.type === 'tool_use');
  assert.equal(toolBlocks.length, 1, '3 duplicate Glob calls -> 1');
  assert.equal(toolBlocks[0].input.pattern, '**/*');
});

test('keeps Glob calls with DIFFERENT patterns in one turn', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 't1', name: 'Glob', input: { pattern: '**/*.md' } },
      { type: 'tool_use', id: 't2', name: 'Glob', input: { pattern: '**/*.json' } }
    ],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Glob',
      input_schema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern']
      }
    }]
  });

  const toolBlocks = payload.content.filter((b) => b?.type === 'tool_use');
  assert.equal(toolBlocks.length, 2, 'different Glob patterns are preserved');
});

test('strips leaked <content> XML tags from text', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: '<content>\nLet me read the files.\n</content>\n\nHere is the result.'
    }],
    stop_reason: 'end_turn'
  });

  const textBlock = payload.content.find((b) => b?.type === 'text');
  assert.ok(textBlock);
  assert.ok(!textBlock.text.includes('<content>'), '<content> open tag stripped');
  assert.ok(!textBlock.text.includes('</content>'), '</content> close tag stripped');
  assert.ok(textBlock.text.includes('Let me read the files.'), 'inner text preserved');
  assert.ok(textBlock.text.includes('Here is the result.'), 'surrounding text preserved');
});

test('Bash(cat X) is rewritten to Read(X) to avoid stdout overflow on large files', () => {
  // Real log regression: model calls Bash(cat index.html) on a big HTML file.
  // cat dumps everything to stdout; Claude Code's bash tool_result truncates
  // or fails. Proxy should rewrite this to the client's Read tool which has
  // offset/limit support.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_cat',
      name: 'Bash',
      input: { command: 'cat index.html' }
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [
      { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }
    ]
  });

  const toolBlock = payload.content.find((b) => b?.type === 'tool_use');
  assert.ok(toolBlock);
  assert.equal(toolBlock.name, 'Read', 'cat should be rewritten to Read');
  assert.equal(toolBlock.input.file_path, 'index.html');
});

test('Bash(head -50 X) also rewritten to Read (head is a read-like cmd)', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_head',
      name: 'Bash',
      input: { command: 'head -50 package.json' }
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [
      { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }
    ]
  });

  const toolBlock = payload.content.find((b) => b?.type === 'tool_use');
  assert.ok(toolBlock);
  assert.equal(toolBlock.name, 'Read');
  assert.equal(toolBlock.input.file_path, 'package.json');
});

test('Bash with leading stray prefix "_ cat X" is cleaned to "cat X" then Read', () => {
  // Real log: model emitted "_ cat index.html" - the leading "_" would make
  // bash return "_: command not found". Proxy strips stray prefix chars AND
  // then detects cat -> rewrites to Read.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_stray',
      name: 'Bash',
      input: { command: '_ cat index.html' }
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [
      { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }
    ]
  });

  const toolBlock = payload.content.find((b) => b?.type === 'tool_use');
  assert.ok(toolBlock);
  assert.equal(toolBlock.name, 'Read');
  assert.equal(toolBlock.input.file_path, 'index.html');
});

test('Bash with parenthesized cat like "(cat x)" is unwrapped and rewritten to Read', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_paren',
      name: 'Bash',
      input: { command: '(cat index.html)' }
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [
      { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }
    ]
  });

  const toolBlock = payload.content.find((b) => b?.type === 'tool_use');
  assert.ok(toolBlock);
  assert.equal(toolBlock.name, 'Read');
  assert.equal(toolBlock.input.file_path, 'index.html');
});

test('Bash with pipe "cat X | head" is NOT rewritten (compound command)', () => {
  // Guard: only simple read-like commands are rewritten. Compound ones with
  // pipes/redirects run as-is (proxy doesn't understand their intent).
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_pipe',
      name: 'Bash',
      input: { command: 'cat index.html | head -20' }
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [
      { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
      { name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }
    ]
  });

  const toolBlock = payload.content.find((b) => b?.type === 'tool_use');
  assert.ok(toolBlock);
  assert.equal(toolBlock.name, 'Bash', 'pipe commands must stay as Bash');
});

test('strips <details> block containing only narration (no code, no list)', () => {
  // Real log: weak model writes self-narration inside <details><summary>...
  // Claude Code renders that literally. Proxy should strip it since there's
  // no real content (code/table/list/link) inside.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: '<details>\n<summary>Continue exploring...</summary>\n\nLet me read the key files to understand what this project is.\n\n</details>\nSome real text after.'
    }],
    stop_reason: 'end_turn'
  });

  const textBlock = payload.content.find((b) => b?.type === 'text');
  assert.ok(textBlock);
  assert.ok(!textBlock.text.includes('<details>'), '<details> narration block should be stripped');
  assert.ok(!textBlock.text.includes('<summary>'), '<summary> should be gone too');
  assert.ok(textBlock.text.includes('Some real text after.'), 'surrounding legitimate text preserved');
});

test('preserves <details> block that contains real content (code or list)', () => {
  // Positive: <details> with a code block inside is legitimate UI content,
  // should NOT be stripped.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: '<details>\n<summary>Example</summary>\n\n```js\nconst x = 1;\n```\n\n</details>'
    }],
    stop_reason: 'end_turn'
  });

  const textBlock = payload.content.find((b) => b?.type === 'text');
  assert.ok(textBlock);
  assert.ok(textBlock.text.includes('<details>'), '<details> with code should be preserved');
  assert.ok(textBlock.text.includes('```js'), 'code block inside preserved');
});

test('strips <thinking> chain-of-thought tag like <think>', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: '<thinking>\nLet me analyze this step by step.\n</thinking>\nHere is my answer.'
    }],
    stop_reason: 'end_turn'
  });

  const textBlock = payload.content.find((b) => b?.type === 'text');
  assert.ok(textBlock);
  assert.ok(!textBlock.text.includes('<thinking>'), '<thinking> should be stripped');
  assert.ok(!textBlock.text.includes('step by step'), 'chain-of-thought content should be hidden');
  assert.ok(textBlock.text.includes('Here is my answer.'), 'real answer preserved');
});

test('strips model-agnostic reasoning tags: <reasoning>, <scratchpad>, <planning>, <rationale>', () => {
  // Model-agnostic CoT cleanup: any non-HTML balanced tag block gets stripped.
  // This way GPT-3.5, Llama, Mistral, DeepSeek, Gemini all work without
  // needing a hardcoded list.
  const cases = [
    { tag: 'reasoning', hidden: 'I should plan first' },
    { tag: 'scratchpad', hidden: 'intermediate work here' },
    { tag: 'planning', hidden: 'step 1 step 2' },
    { tag: 'rationale', hidden: 'because of X' },
    { tag: 'monologue', hidden: 'thinking out loud' },
    { tag: 'analysis', hidden: 'breakdown of problem' },
    { tag: 'deliberation', hidden: 'weighing options' }
  ];

  for (const { tag, hidden } of cases) {
    const payload = applyAnthropicNormalization({
      id: 'msg',
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'text',
        text: `<${tag}>\n${hidden}\n</${tag}>\nFinal answer visible.`
      }],
      stop_reason: 'end_turn'
    });

    const textBlock = payload.content.find((b) => b?.type === 'text');
    assert.ok(textBlock, `${tag}: text block should exist`);
    assert.ok(!textBlock.text.includes(`<${tag}>`), `${tag}: opening tag stripped`);
    assert.ok(!textBlock.text.includes(hidden), `${tag}: inner content hidden`);
    assert.ok(textBlock.text.includes('Final answer visible.'), `${tag}: real answer preserved`);
  }
});

test('preserves legitimate HTML tags (<div>, <p>, <code>, <pre>, <ul>, <table>)', () => {
  // Counter-test: ensure HTML tags we want users to see are NOT stripped.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: '<div>Hello</div>\n<p>Paragraph</p>\n<ul><li>Item</li></ul>\n<code>var x = 1;</code>\n<pre>preformatted</pre>\n<table><tr><td>cell</td></tr></table>'
    }],
    stop_reason: 'end_turn'
  });

  const textBlock = payload.content.find((b) => b?.type === 'text');
  assert.ok(textBlock);
  assert.ok(textBlock.text.includes('<div>'), 'HTML <div> preserved');
  assert.ok(textBlock.text.includes('<p>'), 'HTML <p> preserved');
  assert.ok(textBlock.text.includes('<ul>'), 'HTML <ul> preserved');
  assert.ok(textBlock.text.includes('<code>'), 'HTML <code> preserved');
  assert.ok(textBlock.text.includes('<pre>'), 'HTML <pre> preserved');
  assert.ok(textBlock.text.includes('<table>'), 'HTML <table> preserved');
});

test('malformed completion detection works for ANY non-HTML stray close tag (model-agnostic)', () => {
  // Critical: GPT-3.5 might stray </answer>, Llama might stray </response>,
  // DeepSeek might stray </rationale>. All should be detected as malformed
  // without needing a hardcoded list.
  const strayTags = ['</answer>', '</rationale>', '</response>', '</planning>', '</scratchpad>', '</output>'];

  for (const strayTag of strayTags) {
    const payload = applyAnthropicNormalization({
      id: 'msg',
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'text',
        text: `I will create the file.${strayTag}\n\nCreated successfully.`
      }],
      stop_reason: 'end_turn'
    }, {
      tools: [{
        name: 'Write',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' }, content: { type: 'string' } },
          required: ['file_path', 'content']
        }
      }, {
        name: 'Read',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path']
        }
      }],
      messages: [
        { role: 'user', content: 'create a file' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.md' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'b.md' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'y' }] }
      ]
    });

    const textBlocks = payload.content.filter((b) => b?.type === 'text');
    assert.ok(textBlocks.length > 0, `${strayTag}: text returned`);
    assert.ok(
      textBlocks[0].text.includes('malformed completion'),
      `${strayTag}: should be detected as malformed completion (model-agnostic)`
    );
  }
});

test('does NOT treat stray </div> (legit HTML) as malformed', () => {
  // Counter-test: stray </div> is normal HTML fragment, not a reasoning tag.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: 'Here is some HTML fragment: hello</div>'
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Read',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path']
      }
    }],
    messages: [
      { role: 'user', content: 'explain' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'b.md' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'y' }] }
    ]
  });

  const textBlocks = payload.content.filter((b) => b?.type === 'text');
  assert.ok(textBlocks[0].text.includes('HTML fragment'));
  assert.ok(!textBlocks[0].text.includes('malformed'), 'legit HTML stray tag should not trigger error');
});

test('model claims completion with unclosed </think> but no tool_use -> returns clear error to user', () => {
  // Real log regression: model said "Created CLAUDE.md...</think>..." with
  // end_turn and NO tool_use. Prior turns had many reads. Model reports
  // completion but never actually did Write. Proxy must not stall or let
  // accidental file writes happen - return a clear error message.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: 'I need to use the Write tool properly. Let me create the file.</think>\n\nCreated CLAUDE.md with project overview.'
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Write',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
        required: ['file_path', 'content']
      }
    }, {
      name: 'Read',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path']
      }
    }],
    messages: [
      { role: 'user', content: '/init' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'AGENTS.md' } }]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'content' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'package.json' } }]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'content' }] }
    ]
  });

  const textBlocks = payload.content.filter((b) => b?.type === 'text');
  assert.equal(textBlocks.length, 1);
  assert.ok(textBlocks[0].text.includes('malformed completion'), 'should return malformed completion error');
  assert.equal(payload.stop_reason, 'end_turn');
  // NO tool_use injected (safe)
  assert.equal(payload.content.filter((b) => b?.type === 'tool_use').length, 0);
});

test('well-formed end_turn with prior tool_use passes through without error wrapping', () => {
  // Counter-test: model legitimately ended with end_turn + final summary text
  // (no stray tags). Proxy must NOT wrap this in an error.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: 'Done! I have finished the analysis.'
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Read',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path']
      }
    }],
    messages: [
      { role: 'user', content: 'analyze' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'AGENTS.md' } }]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'content' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'package.json' } }]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'content' }] }
    ]
  });

  const textBlocks = payload.content.filter((b) => b?.type === 'text');
  assert.equal(textBlocks.length, 1);
  assert.ok(!textBlocks[0].text.includes('malformed'), 'well-formed end_turn should NOT be wrapped in error');
  assert.ok(textBlocks[0].text.includes('Done!'), 'original text preserved');
});

test('model returns only text on first turn -> proxy synthesizes Glob fallback (no stall)', () => {
  // Critical regression: user asked anything, model returned just text
  // "I'll start by exploring..." with stop_reason: end_turn, no tool_use.
  // Proxy must NOT let this stall. Language-agnostic: any user text + no
  // tool_use + no prior tools -> fallback Glob.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: "I'll start by exploring the codebase structure to understand the project."
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Glob',
      input_schema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern']
      }
    }],
    messages: [
      { role: 'user', content: 'projeyi analiz et' } // Turkish, no slash-command
    ]
  });

  const toolBlocks = payload.content.filter((b) => b?.type === 'tool_use');
  assert.equal(toolBlocks.length, 1, 'language-agnostic fallback should work for any user text');
  assert.equal(toolBlocks[0].name, 'Glob');
  assert.equal(toolBlocks[0].input.pattern, '**/*');
});

test('instrumentation-only user text (tags stripped) -> no false triggering by embedded filenames', () => {
  // User text is entirely <system-reminder> tags (common in Claude Code).
  // Those contain tool manifests mentioning files like 'settings.local.json'.
  // Must NOT block Glob synthesis: stripInstrumentationTags removes them
  // before extractFilenameFromText check.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: "I'll start by exploring."
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Glob',
      input_schema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern']
      }
    }],
    messages: [
      {
        role: 'user',
        content: '<system-reminder>Skills include: settings.local.json config.json</system-reminder>\n<command-name>/init</command-name>\n<command-message>in</command-message>'
      }
    ]
  });

  const toolBlocks = payload.content.filter((b) => b?.type === 'tool_use');
  assert.equal(toolBlocks.length, 1, 'instrumentation filenames should not block fallback');
  assert.equal(toolBlocks[0].name, 'Glob');
});

test('/init wrapped in <command-name> XML tag still triggers Glob synthesis', () => {
  // Real log regression: Claude Code wraps /init as <command-name>/init</command-name>.
  // Old regex required whitespace before `/`, so `>/init` did not match and
  // no synthesis happened -> stall. New regex allows XML-tag boundary (>, ", etc).
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: "I'll start by exploring the repository structure and key files."
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Glob',
      input_schema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern']
      }
    }],
    messages: [
      {
        role: 'user',
        content: '<command-name>/init</command-name>\n<system-reminder>skills available</system-reminder>'
      }
    ]
  });

  const toolBlocks = payload.content.filter((b) => b?.type === 'tool_use');
  assert.equal(toolBlocks.length, 1, '/init inside XML tags must still trigger synthesis');
  assert.equal(toolBlocks[0].name, 'Glob');
  assert.equal(toolBlocks[0].input.pattern, '**/*');
});

test('drops Write tool_use with empty content (would overwrite file with blank)', () => {
  // Regression from real log: model emitted Write(CLAUDE.md, content: '')
  // first, then real content in next turn. The first call, if passed through,
  // overwrites the existing file with empty. Proxy must drop it and let the
  // model retry.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'toolu_empty_write',
      name: 'Write',
      input: { file_path: 'CLAUDE.md', content: '', filePath: 'CLAUDE.md' }
    }],
    stop_reason: 'tool_use'
  }, {
    tools: [{
      name: 'Write',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['file_path', 'content']
      }
    }],
    messages: [
      { role: 'user', content: 'create CLAUDE.md' }
    ]
  });

  const writeBlocks = payload.content.filter((b) => b?.type === 'tool_use' && b?.name === 'Write');
  assert.equal(writeBlocks.length, 0, 'empty content Write should be dropped');
});

test('strips post-Write duplicate fenced block from text (model re-prints content)', () => {
  // Weak models after a successful Write(X, content) often print the same
  // content again as a fenced block in the next turn, thinking they are
  // summarizing. Claude Code renders that text literally; user thinks the
  // file was not written. This deterministic cleanup removes the duplicate.
  const writtenContent = '# CLAUDE.md\n\nThis file provides guidance to Claude Code when working with code in this repository.\n\n## Overview\n\nLine 5.\nLine 6.\nLine 7.';
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: '```\n' + writtenContent + '\n```'
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Write',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
        required: ['file_path', 'content']
      }
    }],
    messages: [
      { role: 'user', content: 'create CLAUDE.md' },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_write_prev',
          name: 'Write',
          input: { file_path: 'CLAUDE.md', content: writtenContent }
        }]
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_write_prev',
          content: 'File created successfully'
        }]
      }
    ]
  });

  // Fenced block silinmeli; post-Write duplicate basma tespit edildi.
  const textBlocks = payload.content.filter((b) => b?.type === 'text');
  for (const block of textBlocks) {
    assert.ok(!block.text.includes(writtenContent), 'duplicate content should be stripped');
  }
});

test('Write synthesis works with Chinese user request (language-agnostic)', () => {
  // Kullanici Cince "index.html dosyasi olustur" demis; dil Cince ama
  // "index.html" dosya adi evrensel. Deterministik sinyal: user text'inde
  // acik dosya adi + fenced block gercek kod + render container'da degil.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: '好的,\u6211\u4f1a\u521b\u5efa\u6587\u4ef6\u3002\n```html\n<!DOCTYPE html>\n<html><body>Hello</body></html>\n```'
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Write',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
        required: ['file_path', 'content']
      }
    }],
    messages: [
      { role: 'user', content: '\u8bf7\u521b\u5efa index.html' } // "Please create index.html" in Chinese
    ]
  });

  const writeBlocks = payload.content.filter((b) => b?.type === 'tool_use' && b?.name === 'Write');
  assert.equal(writeBlocks.length, 1, 'Chinese request with explicit filename should trigger Write');
  assert.equal(writeBlocks[0].input.file_path, 'index.html');
});

test('Write NOT synthesized when no filename in user text (deterministic guard)', () => {
  // Dile bagimsiz kontrol: kullanicinin metninde acik dosya adi yoksa, tum
  // fenced block'lar gercek kod gibi gorunse bile Write sentezlenmez.
  // Ornek: model bir aciklama + kod bloku donduruyor, ama hangi dosyaya
  // yazilacagi belli degil -> guvenli davranis, sentez yok.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: 'Here is some code:\n```js\nconst x = 1;\nconsole.log(x);\n```'
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Write',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
        required: ['file_path', 'content']
      }
    }],
    messages: [
      // Dosya adi yok, sadece soru
      { role: 'user', content: 'how do i log a variable' }
    ]
  });

  const writeBlocks = payload.content.filter((b) => b?.type === 'tool_use' && b?.name === 'Write');
  assert.equal(writeBlocks.length, 0, 'no filename in user text -> Write must not be synthesized');
});

test('List/Glob synthesis only on first turn with exploratory user request', () => {
  // Kullanicinin mesaji "hello" - acik dosya adi yok, hicbir prior tool_use
  // yok -> exploratory fallback olarak Glob sentezle.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Glob',
      input_schema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern']
      }
    }],
    messages: [
      { role: 'user', content: 'hello there please explain something' }
    ]
  });

  const globBlocks = payload.content.filter((b) => b?.type === 'tool_use' && b?.name === 'Glob');
  assert.equal(globBlocks.length, 1);
  assert.equal(globBlocks[0].input.pattern, '**/*');
});

test('List/Glob NOT synthesized when user mentions a specific file', () => {
  // Kullanici acikca bir dosya adi belirtmis -> file-specific request, glob
  // fallback'i dogru degil.
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Glob',
      input_schema: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern']
      }
    }],
    messages: [
      { role: 'user', content: 'show me config.json' }
    ]
  });

  const globBlocks = payload.content.filter((b) => b?.type === 'tool_use' && b?.name === 'Glob');
  assert.equal(globBlocks.length, 0, 'user mentioned config.json -> no Glob fallback');
});

test('Write NOT synthesized when fenced block is inside <details> render container', () => {
  const payload = applyAnthropicNormalization({
    id: 'msg',
    type: 'message',
    role: 'assistant',
    content: [{
      type: 'text',
      text: '<details>\n<summary>Output</summary>\n\n```\nactual content here\n```\n</details>'
    }],
    stop_reason: 'end_turn'
  }, {
    tools: [{
      name: 'Write',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, content: { type: 'string' } },
        required: ['file_path', 'content']
      }
    }],
    messages: [
      { role: 'user', content: 'make config.json for me' }
    ]
  });

  const writeBlocks = payload.content.filter((b) => b?.type === 'tool_use' && b?.name === 'Write');
  assert.equal(writeBlocks.length, 0, 'block inside <details> is a render container, not file content');
});
