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
  assert.deepEqual(Object.keys(args), ['filePath']);
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
