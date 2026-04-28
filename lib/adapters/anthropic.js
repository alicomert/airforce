// /v1/messages handler — Anthropic uyumlu.
// Akış aynısı: history düzleştir → XML inject → upstream non-stream → text'ten XML parse → Anthropic content blocks.

import { newMessageId, unixSeconds } from '../util.js';
import { log } from '../logger.js';
import { resolveModel, getCapability } from '../capability.js';
import { getDefaultProvider } from '../providers/factory.js';
import { ProviderError } from '../providers/base.js';
import { injectIntoAnthropicBody } from '../tool-engine/inject.js';
import { normalizeAnthropicMessages } from '../tool-engine/serialize-history.js';
import { extractToolCalls } from '../tool-engine/parse.js';
import { toAnthropicBlocks } from '../tool-engine/translate.js';
import { streamAnthropicMessage } from '../sse.js';
import { getBucket } from '../rate-limit.js';

export async function handleAnthropicMessages(req, res, body) {
  const wantStream = Boolean(body.stream);
  const presentedModel = body.model || 'unknown';
  const upstreamModel = resolveModel(presentedModel);

  const messages = normalizeAnthropicMessages(body.messages || []);
  const stage1 = injectIntoAnthropicBody({ ...body, messages });
  const toolsForRequest = stage1.tools;

  const upstreamBody = {
    ...stage1.body,
    model: upstreamModel,
    stream: false,
  };

  const cap = getCapability();
  const mult = cap?.models?.[upstreamModel]?.multiplier ?? 1;
  await getBucket().charge(mult, `messages:${upstreamModel}`);

  let payload;
  try {
    const provider = await getDefaultProvider();
    const { json } = await provider.request('POST', '/v1/messages', upstreamBody);
    payload = json;
  } catch (err) {
    const status = (err instanceof ProviderError) ? (err.status || 502) : 502;
    log.error('anthropic upstream error', { err: err.message, status, category: err?.category });
    return errorResponse(res, status, err.message || 'Upstream error');
  }

  if (!payload || !Array.isArray(payload.content)) {
    return errorResponse(res, 502, 'Upstream returned no message');
  }

  // Tüm tool-call mantığını köprü kuruyor. Upstream'den dönen "tool_use" block'larını
  // GÜVENİLMEZ kabul ediyoruz ve text'e çevirip kendi XML parse'ımızdan geçiyoruz.
  // Böylece davranış her modelde aynı, öngörülebilir ve doğrulanmış olur.
  const allText = payload.content
    .map((b) => {
      if (b.type === 'text') return b.text || '';
      if (b.type === 'tool_use') {
        // Upstream'in döndürdüğü tool_use'u XML formatına çevir, parse'ımız yakalasın.
        const argsJson = JSON.stringify(b.input || {});
        return `<tool_calls><invoke name="${b.name}"><parameter name="__json">${argsJson}</parameter></invoke></tool_calls>`;
      }
      return '';
    })
    .join('\n');

  let blocks;
  let stopReason = payload.stop_reason || 'end_turn';

  if (toolsForRequest.length) {
    const parsed = extractToolCalls(allText);
    if (parsed.calls.length) {
      // __json kısayolunu aç: tek __json key'i varsa onun içeriğini gerçek args yap.
      for (const c of parsed.calls) {
        if (c.args && Object.keys(c.args).length === 1 && '__json' in c.args) {
          c.args = c.args.__json;
        }
      }
      blocks = toAnthropicBlocks(parsed);
      stopReason = 'tool_use';
    } else {
      blocks = [{ type: 'text', text: parsed.textWithoutBlocks || allText }];
    }
  } else {
    blocks = payload.content;
  }

  const message = {
    id: payload.id || newMessageId(),
    type: 'message',
    role: 'assistant',
    model: presentedModel,
    content: blocks,
    stop_reason: stopReason,
    stop_sequence: payload.stop_sequence ?? null,
    usage: payload.usage || { input_tokens: 0, output_tokens: 0 },
  };

  if (wantStream) {
    return streamAnthropicMessage(res, message, { model: presentedModel });
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(message));
}

function errorResponse(res, status, msg) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: msg } }));
}
