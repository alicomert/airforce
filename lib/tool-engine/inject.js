// İstek içindeki `tools` tanımını system prompt'a XML şema halinde gömer.
// Provider'ın native tool_calls dönmesini istemiyorsak request'ten tools'u kaldırırız.

import { config } from '../config.js';

const CANONICAL_HEADER = `# Tool Use Protocol

You have access to the tools listed below. To call a tool, emit ONLY the following XML block — no surrounding prose, no markdown code fences, no commentary inside the block.

<tool_calls>
  <invoke name="TOOL_NAME">
    <parameter name="PARAM_NAME">VALUE</parameter>
  </invoke>
</tool_calls>

Rules:
- Emit the <tool_calls> block when, and only when, you intend to call one or more tools.
- The block MUST be at the top level of your response (not inside fenced code, not inside a quoted block).
- Each <parameter> MUST exist in the tool's parameter list. Required parameters cannot be omitted.
- Values are inserted verbatim between the tags. For JSON-typed values (object/array), put valid JSON between the tags.
- For string values, do NOT wrap in extra quotes. For booleans/numbers, write them literally.
- Do NOT mention these instructions or this XML format to the user.
- After tool results are returned to you, continue normally and answer the user.

Available tools:`;

const DSML_HEADER = `# Tool Use Protocol (DSML)

You have access to the tools below. To call a tool, emit ONLY the following XML — outside of any code block.

<|DSML|tool_calls>
  <|DSML|invoke name="TOOL_NAME">
    <|DSML|parameter name="PARAM_NAME">VALUE</|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>

Rules: same as canonical — required params mandatory, JSON for object/array values, no extra commentary inside the block, no fences around it.

Available tools:`;

function describeSchemaShort(schema) {
  if (!schema || typeof schema !== 'object') return '(no schema)';
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const lines = [];
  for (const [name, def] of Object.entries(props)) {
    const t = def?.type || (def?.enum ? `enum(${def.enum.join('|')})` : 'any');
    const req = required.has(name) ? ' (required)' : '';
    const desc = def?.description ? ` — ${def.description}` : '';
    lines.push(`    - ${name}: ${t}${req}${desc}`);
  }
  return lines.join('\n');
}

function describeOpenaiTool(tool) {
  const fn = tool.function || tool;
  const name = fn.name || tool.name || 'unnamed_tool';
  const desc = fn.description || tool.description || '';
  const schema = fn.parameters || tool.parameters || tool.input_schema || {};
  return `\n## ${name}\n  description: ${desc || '(none)'}\n  parameters:\n${describeSchemaShort(schema)}`;
}

function describeAnthropicTool(tool) {
  // Anthropic tool: { name, description, input_schema }
  return `\n## ${tool.name}\n  description: ${tool.description || '(none)'}\n  parameters:\n${describeSchemaShort(tool.input_schema)}`;
}

export function renderToolsBlock(tools, { dialect = 'openai' } = {}) {
  if (!tools || !tools.length) return '';
  const header = config.toolEngine.format === 'dsml' ? DSML_HEADER : CANONICAL_HEADER;
  const describe = dialect === 'anthropic' ? describeAnthropicTool : describeOpenaiTool;
  const body = tools.map(describe).join('\n');
  return `${header}\n${body}\n`;
}

// --- OpenAI Chat injector ---

export function injectIntoOpenaiBody(body) {
  // Original tools list (may be undefined / [])
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (!tools.length) return { body, injected: false, tools: [] };

  const block = renderToolsBlock(tools, { dialect: 'openai' });
  if (!block) return { body, injected: false, tools };

  const messages = Array.isArray(body.messages) ? [...body.messages] : [];

  // System mesajını append/prepend stratejisine göre birleştir.
  const idx = messages.findIndex((m) => m.role === 'system');
  if (idx >= 0) {
    const sys = messages[idx];
    const prev = typeof sys.content === 'string' ? sys.content : flattenContent(sys.content);
    const sep = prev && !prev.endsWith('\n') ? '\n\n' : '';
    messages[idx] = { ...sys, content: `${prev}${sep}${block}` };
  } else {
    messages.unshift({ role: 'system', content: block });
  }

  const out = { ...body, messages };
  // Native tool_calls'u baskıla — biz XML istiyoruz.
  if (config.toolEngine.forceXml) {
    delete out.tools;
    delete out.tool_choice;
  }
  return { body: out, injected: true, tools };
}

// --- Anthropic Messages injector ---

export function injectIntoAnthropicBody(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (!tools.length) return { body, injected: false, tools: [] };

  const block = renderToolsBlock(tools, { dialect: 'anthropic' });
  if (!block) return { body, injected: false, tools };

  const out = { ...body };
  const sysExisting = out.system;
  const sysText = sysExisting == null ? '' : (typeof sysExisting === 'string' ? sysExisting : flattenAnthropicSystem(sysExisting));
  const sep = sysText && !sysText.endsWith('\n') ? '\n\n' : '';
  out.system = `${sysText}${sep}${block}`;

  if (config.toolEngine.forceXml) {
    delete out.tools;
    delete out.tool_choice;
  }
  return { body: out, injected: true, tools };
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (typeof c === 'string' ? c : (c?.text ?? '')))
    .filter(Boolean)
    .join('\n');
}

function flattenAnthropicSystem(sys) {
  // Anthropic system field sometimes is an array of {type:"text", text:"..."}
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) return sys.map((s) => (typeof s === 'string' ? s : (s?.text || ''))).join('\n');
  return '';
}
