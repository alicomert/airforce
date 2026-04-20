function encodeSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function anthropicSseFromMessage(message) {
  const chunks = [];
  const messagePayload = {
    id: message.id,
    type: 'message',
    role: message.role ?? 'assistant',
    content: [],
    model: message.model,
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: message.usage?.input_tokens ?? 0,
      output_tokens: 0
    }
  };

  chunks.push(encodeSse('message_start', { type: 'message_start', message: messagePayload }));

  let blockIndex = 0;
  for (const block of message.content ?? []) {
    if (block?.type === 'text') {
      chunks.push(encodeSse('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' }
      }));
      chunks.push(encodeSse('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'text_delta', text: block.text ?? '' }
      }));
      chunks.push(encodeSse('content_block_stop', {
        type: 'content_block_stop',
        index: blockIndex
      }));
      blockIndex += 1;
      continue;
    }

    if (block?.type === 'tool_use') {
      chunks.push(encodeSse('content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {}
        }
      }));
      chunks.push(encodeSse('content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input ?? {})
        }
      }));
      chunks.push(encodeSse('content_block_stop', {
        type: 'content_block_stop',
        index: blockIndex
      }));
      blockIndex += 1;
    }
  }

  chunks.push(encodeSse('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: message.stop_reason ?? 'end_turn',
      stop_sequence: message.stop_sequence ?? null
    },
    usage: {
      output_tokens: message.usage?.output_tokens ?? 0
    }
  }));
  chunks.push(encodeSse('message_stop', { type: 'message_stop' }));

  return chunks.join('');
}

export function openAiChatSseFromCompletion(payload) {
  const chunks = [];
  for (const choice of payload.choices ?? []) {
    chunks.push(`data: ${JSON.stringify({
      id: payload.id,
      object: 'chat.completion.chunk',
      created: payload.created,
      model: payload.model,
      choices: [{
        index: choice.index ?? 0,
        delta: { role: 'assistant' },
        finish_reason: null
      }]
    })}\n\n`);

    if (choice.message?.content) {
      chunks.push(`data: ${JSON.stringify({
        id: payload.id,
        object: 'chat.completion.chunk',
        created: payload.created,
        model: payload.model,
        choices: [{
          index: choice.index ?? 0,
          delta: { content: choice.message.content },
          finish_reason: null
        }]
      })}\n\n`);
    }

    if (Array.isArray(choice.message?.tool_calls) && choice.message.tool_calls.length > 0) {
      chunks.push(`data: ${JSON.stringify({
        id: payload.id,
        object: 'chat.completion.chunk',
        created: payload.created,
        model: payload.model,
        choices: [{
          index: choice.index ?? 0,
          delta: {
            tool_calls: choice.message.tool_calls.map((toolCall, toolIndex) => ({
              index: toolIndex,
              id: toolCall.id,
              type: 'function',
              function: toolCall.function
            }))
          },
          finish_reason: null
        }]
      })}\n\n`);
    }

    chunks.push(`data: ${JSON.stringify({
      id: payload.id,
      object: 'chat.completion.chunk',
      created: payload.created,
      model: payload.model,
      choices: [{
        index: choice.index ?? 0,
        delta: {},
        finish_reason: choice.finish_reason ?? 'stop'
      }]
    })}\n\n`);
  }

  chunks.push('data: [DONE]\n\n');
  return chunks.join('');
}
