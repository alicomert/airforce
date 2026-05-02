// OpenAI Chat Completions ↔ Anthropic Messages format dönüşümleri.
// AnthropicNativeProvider için kullanılıyor.

const DEFAULT_MAX_TOKENS = 4096;

const STOP_REASON_MAP = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
};

function flattenContentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : (c?.text ?? ''))).join('');
  }
  return content == null ? '' : String(content);
}

function safeJsonParse(s, fallback) {
  if (typeof s !== 'string') return s ?? fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

export function openaiToAnthropicBody(body) {
  const messages = body.messages || [];
  const systemParts = [];
  const out = [];

  for (const m of messages) {
    if (m.role === 'system') {
      const t = flattenContentToText(m.content);
      if (t) systemParts.push(t);
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
        }],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      const text = flattenContentToText(m.content);
      if (text) blocks.push({ type: 'text', text });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name || tc.name,
            input: safeJsonParse(tc.function?.arguments, {}),
          });
        }
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
      continue;
    }
    if (typeof m.content === 'string') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
    } else if (Array.isArray(m.content)) {
      out.push({ role: 'user', content: m.content });
    } else {
      out.push({ role: 'user', content: [{ type: 'text', text: String(m.content ?? '') }] });
    }
  }

  const result = {
    model: body.model,
    messages: out,
    max_tokens: body.max_tokens || DEFAULT_MAX_TOKENS,
  };

  if (systemParts.length) result.system = systemParts.join('\n\n');
  if (body.temperature != null) result.temperature = body.temperature;
  if (body.top_p != null) result.top_p = body.top_p;
  if (body.stop) result.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  if (Array.isArray(body.tools) && body.tools.length) {
    result.tools = body.tools.map((t) => {
      const fn = t.function || t;
      return {
        name: fn.name,
        description: fn.description || '',
        input_schema: fn.parameters || fn.input_schema || { type: 'object', properties: {} },
      };
    });
  }

  return result;
}

export function anthropicToOpenaiResponse(payload, modelId) {
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  let text = '';
  const toolCalls = [];

  for (const b of blocks) {
    if (b.type === 'text') text += b.text || '';
    else if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id,
        type: 'function',
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input || {}),
        },
      });
    }
  }

  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const finishReason = STOP_REASON_MAP[payload.stop_reason] || 'stop';

  const usage = payload.usage || {};
  return {
    id: payload.id || 'chatcmpl-anth',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId || payload.model || 'unknown',
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length ? 'tool_calls' : finishReason,
    }],
    usage: {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    },
  };
}
