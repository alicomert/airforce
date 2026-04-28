// /v1/chat/completions handler — OpenAI uyumlu.
// Akış:
//   1) request body'i normalize et (history → XML, tool_calls → XML)
//   2) tools varsa system prompt'a XML şema enjekte et
//   3) upstream'i NON-STREAM çağır
//   4) cevabın text'inden <tool_calls>'i parse et
//   5) OpenAI assistant message'a geri çevir (tool_calls + content)
//   6) stream isteklendiyse synthetic SSE üret

import { newCompletionId, unixSeconds, safeJsonParse } from '../util.js';
import { log } from '../logger.js';
import { resolveModel, getCapability } from '../capability.js';
import { postChatCompletion, UpstreamError } from '../upstream.js';
import { injectIntoOpenaiBody } from '../tool-engine/inject.js';
import { normalizeOpenaiMessages } from '../tool-engine/serialize-history.js';
import { extractToolCalls } from '../tool-engine/parse.js';
import { buildOpenaiAssistantMessage } from '../tool-engine/translate.js';
import { streamOpenAiCompletion } from '../sse.js';
import { getBucket } from '../rate-limit.js';

export async function handleOpenAiChatCompletions(req, res, body) {
  const wantStream = Boolean(body.stream);
  const presentedModel = body.model || 'unknown';
  const upstreamModel = resolveModel(presentedModel);

  // 1) Mesaj geçmişini düzleştir + tool calls'u XML'e çevir.
  const messages = normalizeOpenaiMessages(body.messages || []);

  // 2) Tools'u system prompt'a inject et.
  const stage1 = injectIntoOpenaiBody({ ...body, messages });
  const toolsForRequest = stage1.tools;

  // Upstream'e gönderilecek body:
  const upstreamBody = {
    ...stage1.body,
    model: upstreamModel,
    stream: false,
  };

  // Rate-limit bütçesinden modelin multiplier'ı kadar düş (capability snapshot'ından).
  const cap = getCapability();
  const mult = cap?.models?.[upstreamModel]?.multiplier ?? 1;
  await getBucket().charge(mult, `chat:${upstreamModel}`);

  let completion;
  try {
    completion = await postChatCompletion(upstreamBody);
  } catch (err) {
    log.error('openai upstream error', { err: err.message, status: err.status });
    return errorResponse(res, err.status || 502, err.message || 'Upstream error');
  }

  if (!completion || !completion.choices) {
    return errorResponse(res, 502, 'Upstream returned no completion');
  }

  // 4) İlk choice'taki text'i parse et.
  const choice = completion.choices[0] || {};
  const message = choice.message || {};
  const rawText = typeof message.content === 'string' ? message.content : flattenContent(message.content);

  // Tüm tool-call mantığı bu köprünün içinde yaşar. Upstream'in tool_calls field'ini
  // (varsa) GÜVENİLMEZ kabul ediyor ve göz ardı ediyoruz — sadece text'ten XML parse.
  let parsed = { calls: [], blockRanges: [], textWithoutBlocks: rawText || '' };
  if (toolsForRequest.length) {
    parsed = extractToolCalls(rawText || '');
  }

  // XML parsed çağrılar varsa onları kullan.
  if (parsed.calls.length) {
    const { message: synth } = buildOpenaiAssistantMessage(rawText, parsed);
    return respondWithMessage(res, presentedModel, completion, {
      content: synth.content,
      tool_calls: synth.tool_calls,
      finish_reason: 'tool_calls',
    }, wantStream);
  }

  // Tool çağrısı yoksa düz text dön. finish_reason'ı sanitize et:
  // upstream "tool_calls" diyebiliyor ama tool_calls field'ı boş — tüketici bağlantı SDK'larını çıldırtır.
  let finish = choice.finish_reason || 'stop';
  if (finish === 'tool_calls') finish = 'stop';
  return respondWithMessage(res, presentedModel, completion, {
    content: typeof message.content === 'string' ? message.content : flattenContent(message.content),
    tool_calls: undefined,
    finish_reason: finish,
  }, wantStream);
}

function respondWithMessage(res, presentedModel, upstream, fields, wantStream) {
  const id = upstream.id || newCompletionId();
  const created = upstream.created || unixSeconds();
  const usage = upstream.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  const message = { role: 'assistant', content: fields.content ?? null };
  if (fields.tool_calls && fields.tool_calls.length) {
    // Ensure each call has well-formed shape
    message.tool_calls = fields.tool_calls.map((tc, idx) => ({
      id: tc.id || `call_${id}_${idx}`,
      type: 'function',
      function: {
        name: tc.function?.name || tc.name || 'unknown',
        arguments: typeof tc.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments || tc.arguments || tc.input || {}),
      },
    }));
  }

  const completion = {
    id,
    object: 'chat.completion',
    created,
    model: presentedModel,
    choices: [{ index: 0, message, finish_reason: fields.finish_reason || 'stop' }],
    usage,
  };

  if (wantStream) {
    return streamOpenAiCompletion(res, completion, { model: presentedModel });
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(completion));
}

function errorResponse(res, status, msg) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: { message: msg, type: 'upstream_error' } }));
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : (c?.text ?? ''))).join('\n');
  }
  return content == null ? '' : String(content);
}
