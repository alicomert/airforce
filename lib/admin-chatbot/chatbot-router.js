// POST /admin/api/chat handler with multi-turn tool loop and SSE streaming.

import { getRouter } from '../providers/factory.js';
import { listToolDefs, dispatch } from './tool-dispatcher.js';
import { buildSystemPrompt } from './system-prompt.js';
import { log } from '../logger.js';

const MAX_TURNS = 10;
const MAX_TOOL_RESULT_BYTES = 50_000;

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function flushNonStreamJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function truncate(s, max = MAX_TOOL_RESULT_BYTES) {
  if (typeof s !== 'string') s = String(s);
  return s.length > max ? s.slice(0, max) + `…(${s.length}b truncated)` : s;
}

export async function handleChatRequest(req, res, body, sessionId) {
  const stream = body.stream !== false;
  const model = body.model || 'glm-4.6';

  if (stream) {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('x-accel-buffering', 'no');
    res.setHeader('connection', 'keep-alive');
  }

  let messages;
  try {
    const sysPrompt = await buildSystemPrompt();
    messages = [
      { role: 'system', content: sysPrompt },
      ...(Array.isArray(body.messages) ? body.messages : []),
    ];
  } catch (err) {
    if (stream) { sseWrite(res, 'error', { message: err.message }); res.end(); return; }
    return flushNonStreamJson(res, 500, { error: { message: err.message } });
  }

  const router = await getRouter();
  let lastResult = null;

  if (stream) sseWrite(res, 'meta', { model, max_turns: MAX_TURNS });

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let out;
    try {
      out = await router.execute(model, {
        model,
        messages,
        tools: listToolDefs(),
        max_tokens: 4096,
      });
    } catch (err) {
      log.error('chatbot router error', { err: err.message, status: err.status });
      if (stream) {
        sseWrite(res, 'error', { message: err.message, status: err.status || 500 });
        res.end();
        return;
      }
      return flushNonStreamJson(res, err.status || 502, { error: { message: err.message } });
    }

    lastResult = out.result;
    const text = out.result.text || '';
    const tcs = out.result.native_tool_calls || [];

    if (stream && text) sseWrite(res, 'text', { content: text });

    if (!tcs.length) {
      if (stream) {
        sseWrite(res, 'done', {
          turns: turn + 1,
          finish_reason: out.result.finish_reason,
          usage: out.result.usage,
          provider_id: out.providerId,
        });
        res.end();
      } else {
        flushNonStreamJson(res, 200, {
          assistant: { content: text },
          turns: turn + 1,
          provider_id: out.providerId,
          usage: out.result.usage,
        });
      }
      return;
    }

    // Append assistant message with tool_calls
    messages.push({ role: 'assistant', content: text || null, tool_calls: tcs });

    // Dispatch each tool, append result, loop
    for (const tc of tcs) {
      const name = tc.function?.name;
      const args = tc.function?.arguments;
      if (stream) sseWrite(res, 'tool_use', { id: tc.id, name, args });
      let toolResult;
      try {
        toolResult = await dispatch(name, args, sessionId);
        const serialized = JSON.stringify(toolResult);
        if (stream) sseWrite(res, 'tool_result', { id: tc.id, name, content: truncate(serialized) });
      } catch (err) {
        toolResult = { error: err.message };
        if (stream) sseWrite(res, 'tool_result', { id: tc.id, name, error: err.message });
      }
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
      });
    }
  }

  // Max turns reached
  if (stream) {
    sseWrite(res, 'error', { message: `max turns (${MAX_TURNS}) reached` });
    res.end();
  } else {
    flushNonStreamJson(res, 200, {
      error: { message: `max turns (${MAX_TURNS}) reached` },
      last: lastResult,
    });
  }
}
