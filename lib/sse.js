// Synthetic SSE: tek bir non-stream upstream cevabını
// OpenAI `chat.completion.chunk` ya da Anthropic event-stream'ine dönüştürür.

import { newCompletionId, newMessageId, unixSeconds } from './util.js';

function writeEvent(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeData(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeRaw(res, line) {
  res.write(line);
}

// --- OpenAI Chat Completions stream synth ---
//
// completion: { id, model, choices: [{ index, message: { role, content, tool_calls? }, finish_reason }], usage }
// We emit chunks: role-only delta, then content chunks, then tool_calls chunk, then [DONE].
export function streamOpenAiCompletion(res, completion, { chunkSize = 80, model } = {}) {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-airforce-bridge-stream', 'synthetic');

  const id = completion.id || newCompletionId();
  const created = completion.created || unixSeconds();
  const modelName = model || completion.model || 'unknown';

  const choice = (completion.choices && completion.choices[0]) || {};
  const message = choice.message || {};
  const finishReason = choice.finish_reason || 'stop';

  // 1. Role chunk
  writeData(res, {
    id, object: 'chat.completion.chunk', created, model: modelName,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  });

  // 2. Content chunks
  const content = typeof message.content === 'string' ? message.content : '';
  if (content) {
    for (let i = 0; i < content.length; i += chunkSize) {
      const piece = content.slice(i, i + chunkSize);
      writeData(res, {
        id, object: 'chat.completion.chunk', created, model: modelName,
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      });
    }
  }

  // 3. Tool calls (single chunk per call)
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    for (let idx = 0; idx < message.tool_calls.length; idx++) {
      const tc = message.tool_calls[idx];
      writeData(res, {
        id, object: 'chat.completion.chunk', created, model: modelName,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: idx,
              id: tc.id,
              type: 'function',
              function: {
                name: tc.function?.name,
                arguments: tc.function?.arguments ?? '',
              },
            }],
          },
          finish_reason: null,
        }],
      });
    }
  }

  // 4. Final chunk with finish_reason
  writeData(res, {
    id, object: 'chat.completion.chunk', created, model: modelName,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: completion.usage || null,
  });

  // 5. [DONE]
  writeRaw(res, 'data: [DONE]\n\n');
  res.end();
}

// --- Anthropic Messages stream synth ---
//
// payload: { id, type:"message", role:"assistant", model, content:[blocks], stop_reason, usage }
export function streamAnthropicMessage(res, payload, { chunkSize = 80, model } = {}) {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-airforce-bridge-stream', 'synthetic');

  const id = payload.id || newMessageId();
  const modelName = model || payload.model || 'unknown';
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const stopReason = payload.stop_reason || (blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');

  // message_start
  writeEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: modelName,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: payload.usage || { input_tokens: 0, output_tokens: 0 },
    },
  });

  blocks.forEach((block, idx) => {
    if (block.type === 'text') {
      writeEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'text', text: '' },
      });
      const text = block.text || '';
      for (let i = 0; i < text.length; i += chunkSize) {
        writeEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'text_delta', text: text.slice(i, i + chunkSize) },
        });
      }
      writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index: idx });
    } else if (block.type === 'tool_use') {
      writeEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      const inputJson = JSON.stringify(block.input || {});
      // Tek parça veya küçük parçalarla emit.
      writeEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'input_json_delta', partial_json: inputJson },
      });
      writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index: idx });
    }
  });

  writeEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: payload.usage || { output_tokens: 0 },
  });
  writeEvent(res, 'message_stop', { type: 'message_stop' });
  res.end();
}
