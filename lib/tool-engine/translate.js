// Parser çıktısını OpenAI ya da Anthropic native formatlarına çevirir.

import { newToolCallId } from '../util.js';

// OpenAI Chat Completions assistant message:
// { role: "assistant", content: "...", tool_calls: [{ id, type: "function", function: { name, arguments: <json string> } }] }
export function toOpenaiToolCalls(parsed) {
  const calls = (parsed.calls || []).map((c) => ({
    id: newToolCallId(),
    type: 'function',
    function: {
      name: c.name,
      arguments: JSON.stringify(c.args ?? {}),
    },
  }));
  return calls;
}

// Anthropic Messages content blocks:
// [{type:"text", text:"..."}, {type:"tool_use", id, name, input}]
export function toAnthropicBlocks(parsed) {
  const blocks = [];
  const text = (parsed.textWithoutBlocks || '').trim();
  if (text) blocks.push({ type: 'text', text });
  for (const c of parsed.calls || []) {
    blocks.push({
      type: 'tool_use',
      id: newToolCallId(),
      name: c.name,
      input: c.args ?? {},
    });
  }
  return blocks;
}

// Build a full OpenAI choice from the original assistant message + extracted calls.
export function buildOpenaiAssistantMessage(originalContent, parsed) {
  const text = (parsed.textWithoutBlocks || '').trim();
  const tool_calls = toOpenaiToolCalls(parsed);
  const message = { role: 'assistant', content: text || null };
  if (tool_calls.length) message.tool_calls = tool_calls;
  return { message, hadToolCalls: tool_calls.length > 0 };
}
