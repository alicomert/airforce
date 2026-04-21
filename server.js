import http from 'node:http';
import process from 'node:process';
import { inspect } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  maybeRewriteModel,
  normalizeJsonPayload,
  normalizeRequestMessages,
  normalizeRequestTools,
  restorePresentedModel
} from './lib/normalizers.js';
import {
  anthropicSseFromMessage,
  openAiChatSseFromCompletion
} from './lib/sse.js';
import { injectSystemPromptForPath } from './lib/system-prompt-injection.js';

const PORT = Number(process.env.PORT || 2393);
const HOST = process.env.HOST || '0.0.0.0';
const UPSTREAM_BASE_URL = (process.env.UPSTREAM_BASE_URL || 'https://api.airforce').replace(/\/+$/, '');
const DEFAULT_API_KEY = process.env.AIRFORCE_API_KEY || '';
const MODEL_ALIASES = parseAliases(process.env.MODEL_ALIASES);
const DEBUG_LOGS = process.env.DEBUG_LOGS !== '0';
// Upstream retry config. Network/5xx/408/425/429 icin exponential backoff.
// Default degerler: hizli ama agresif olmayan. Uzun sureler (kullanicinin
// "6 dakika bekledim" sikayetleri) icin pratik secimler:
//   - Attempt sayisi: 4 (3 retry + orjinal deneme). 6 fazla idi.
//   - Base delay: 300ms. 500 fazla idi.
//   - Max delay: 3 saniye. 8 saniye asiridir.
const UPSTREAM_MAX_ATTEMPTS = Math.max(1, Number(process.env.UPSTREAM_MAX_ATTEMPTS || 4));
const UPSTREAM_RETRY_BASE_MS = Math.max(100, Number(process.env.UPSTREAM_RETRY_BASE_MS || 300));
const UPSTREAM_RETRY_MAX_MS = Math.max(500, Number(process.env.UPSTREAM_RETRY_MAX_MS || 3000));
// Tek bir upstream isteginin max suresi (ms). Uzun modeller icin rahat olsun diye 3dk default.
const UPSTREAM_TIMEOUT_MS = Math.max(5000, Number(process.env.UPSTREAM_TIMEOUT_MS || 180000));
// Normalize sonrasi tamamen bos (ne text ne tool_use) cevap gelirse tekrar cagir.
// Default: 1 retry (asil + 1 tekrar). 3 retry * backoff cok uzun surelere yol aciyor.
const RETRY_ON_EMPTY_RESPONSE = process.env.RETRY_ON_EMPTY_RESPONSE !== '0';
const EMPTY_RESPONSE_MAX_RETRIES = Math.max(0, Number(process.env.EMPTY_RESPONSE_MAX_RETRIES || 3));

function parseAliases(raw) {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function summarizeMessageContent(content) {
  if (typeof content === 'string') {
    return content.slice(0, 160);
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.map((block) => {
    if (block?.type === 'text') {
      return `text:${String(block.text ?? '').slice(0, 80)}`;
    }
    if (block?.type === 'tool_use') {
      return `tool_use:${block.name}`;
    }
    if (block?.type === 'tool_result') {
      return `tool_result:${block.tool_use_id}`;
    }
    return block?.type ?? typeof block;
  }).join(' | ').slice(0, 200);
}

function logDebug(label, value) {
  if (!DEBUG_LOGS) {
    return;
  }
  // Node'un default inspect depth 2'dir; tool_use.input ic ice oldugu icin
  // `[Object]` seklinde cikiyor. Tani icin genislet.
  console.log(`[DEBUG] ${label}:`, inspect(value, { depth: 5, colors: false, breakLength: 120 }));
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta',
    'access-control-allow-methods': 'GET,POST,OPTIONS'
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function buildUpstreamHeaders(req, bodyLength) {
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) {
      continue;
    }
    if (['host', 'content-length', 'connection', 'x-api-key', 'authorization'].includes(key.toLowerCase())) {
      continue;
    }
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }

  if (DEFAULT_API_KEY) {
    headers.set('authorization', `Bearer ${DEFAULT_API_KEY}`);
    headers.set('x-api-key', DEFAULT_API_KEY);
  }
  if (bodyLength != null) {
    headers.set('content-length', String(bodyLength));
  }

  return headers;
}

export function shouldHandleSyntheticStream(pathname, requestBody) {
  return Boolean(requestBody?.stream) && (
    pathname.includes('/anthropic/') ||
    pathname === '/v1/messages' ||
    pathname.endsWith('/chat/completions')
  );
}

function mapUpstreamPath(pathname) {
  if (pathname.startsWith('/anthropic/')) {
    return pathname.slice('/anthropic'.length) || '/';
  }
  return pathname;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffDelay(attempt) {
  const exp = UPSTREAM_RETRY_BASE_MS * Math.pow(2, attempt - 1);
  const capped = Math.min(exp, UPSTREAM_RETRY_MAX_MS);
  // Jitter: +/-25%
  const jitter = capped * (0.75 + Math.random() * 0.5);
  return Math.floor(jitter);
}

function isRetriableStatus(status) {
  // 408 timeout, 425 too early, 429 rate limit, 5xx server errors
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

// Normalize sonrasi cevap gercekten bos mu? Anthropic: content[] tamamen bos/text-empty
// ve tool_use yok. OpenAI chat: choices bos veya tum choice'larin mesaji bos ve tool_call yok.
function isEffectivelyEmpty(pathname, payload) {
  if (!payload || typeof payload !== 'object') {
    return true;
  }
  if (pathname.includes('/anthropic/') || pathname === '/v1/messages') {
    if (!Array.isArray(payload.content)) {
      return true;
    }
    const hasToolUse = payload.content.some((b) => b?.type === 'tool_use');
    const hasThinking = payload.content.some((b) => b?.type === 'thinking' && typeof b?.thinking === 'string' && b.thinking.trim().length > 0);
    const hasText = payload.content.some((b) => b?.type === 'text' && typeof b?.text === 'string' && b.text.trim().length > 0);
    return !hasToolUse && !hasText && !hasThinking;
  }
  if (pathname.endsWith('/chat/completions')) {
    if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
      return true;
    }
    return payload.choices.every((choice) => {
      const msg = choice?.message;
      const hasContent = typeof msg?.content === 'string' && msg.content.trim().length > 0;
      const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
      return !hasContent && !hasToolCalls;
    });
  }
  return false;
}

const NO_PROGRESS_TEXT_RE = /\b(let me (?:first |just |quickly )?(?:check|see|look|explore|analy[sz]e|examine|understand|read|review|inspect)|i(?:'|’)ll (?:first |now |start|begin)?\s*(?:check|look|explore|analy[sz]e|examine|understand|read|review|inspect)|going to (?:check|look|explore|analy[sz]e|examine|understand|read|review|inspect)|exploring the codebase|checking the repository|reading the files|let me explore the full codebase|let me explore the codebase properly)\b/i;

export function isNoProgressAssistantTurn(pathname, payload) {
  if (!payload || typeof payload !== 'object') {
    return true;
  }
  if (isEffectivelyEmpty(pathname, payload)) {
    return true;
  }
  if (!(pathname.includes('/anthropic/') || pathname === '/v1/messages')) {
    return false;
  }
  if (!Array.isArray(payload.content) || payload.content.length === 0) {
    return true;
  }
  const hasToolUse = payload.content.some((b) => b?.type === 'tool_use');
  const hasThinking = payload.content.some((b) => b?.type === 'thinking' && typeof b?.thinking === 'string' && b.thinking.trim());
  if (hasToolUse || hasThinking) {
    return false;
  }
  const textBlocks = payload.content
    .filter((b) => b?.type === 'text' && typeof b?.text === 'string')
    .map((b) => b.text.trim())
    .filter(Boolean);
  if (textBlocks.length === 0) {
    return true;
  }
  if (textBlocks.every((text) => text === EMPTY_RESPONSE_USER_MESSAGE)) {
    return true;
  }
  return textBlocks.every((text) => NO_PROGRESS_TEXT_RE.test(text));
}

// Model bos cevap atmis ve retry'lar da bosa cikmissa, sessizce bos
// response'u donmek yerine kullaniciya problem hakkinda kisa bir aciklama
// dondur. Boylece Claude Code / OpenCode gibi istemciler asili kalmaz,
// kullanici ne olduysa gorur ve tekrar dener / model degistirir.
const EMPTY_RESPONSE_USER_MESSAGE = 'The upstream model returned an empty response. Please rephrase the request or try a different model.';

function injectEmptyResponseFallback(pathname, payload) {
  if (!payload || typeof payload !== 'object') {
    payload = {};
  }
  if (pathname.includes('/anthropic/') || pathname === '/v1/messages') {
    return {
      ...payload,
      content: [{ type: 'text', text: EMPTY_RESPONSE_USER_MESSAGE }],
      stop_reason: payload.stop_reason && payload.stop_reason !== 'tool_use' ? payload.stop_reason : 'end_turn'
    };
  }
  if (pathname.endsWith('/chat/completions')) {
    const firstChoice = Array.isArray(payload.choices) && payload.choices[0] ? payload.choices[0] : {};
    return {
      ...payload,
      choices: [{
        ...firstChoice,
        index: firstChoice.index ?? 0,
        finish_reason: firstChoice.finish_reason && firstChoice.finish_reason !== 'tool_calls' ? firstChoice.finish_reason : 'stop',
        message: {
          role: 'assistant',
          content: EMPTY_RESPONSE_USER_MESSAGE
        }
      }]
    };
  }
  return payload;
}

// Upstream'e fetch + timeout + retry. Network hatasi, 5xx, 408/425/429'da otomatik yeniden dener.
// 4xx (429 disinda) ve 2xx/3xx durumunda response'u oldugu gibi dondurur.
async function fetchUpstreamWithRetry(upstreamUrl, fetchOptions, logLabel) {
  let lastError = null;
  let lastResponse = null;
  for (let attempt = 1; attempt <= UPSTREAM_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('upstream-timeout')), UPSTREAM_TIMEOUT_MS);
    try {
      const response = await fetch(upstreamUrl, { ...fetchOptions, signal: controller.signal });
      clearTimeout(timer);
      if (!isRetriableStatus(response.status)) {
        return response;
      }
      lastResponse = response;
      logDebug('upstream_retry_status', { attempt, status: response.status, label: logLabel });
      if (attempt >= UPSTREAM_MAX_ATTEMPTS) {
        return response;
      }
      // Body'yi okuyup at (connection reuse icin)
      try { await response.text(); } catch { /* ignore */ }
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      logDebug('upstream_retry_error', {
        attempt,
        label: logLabel,
        message: error instanceof Error ? error.message : String(error)
      });
      if (attempt >= UPSTREAM_MAX_ATTEMPTS) {
        break;
      }
    }
    await sleep(backoffDelay(attempt));
  }
  if (lastResponse) {
    return lastResponse;
  }
  throw lastError ?? new Error('Upstream request failed after retries');
}

function appendAliasModels(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data) || Object.keys(MODEL_ALIASES).length === 0) {
    return payload;
  }

  const existingIds = new Set(payload.data.map((item) => item?.id).filter(Boolean));
  const appended = Object.keys(MODEL_ALIASES)
    .filter((alias) => !existingIds.has(alias))
    .map((alias) => ({
      id: alias,
      object: 'model',
      created: 0,
      owned_by: 'airforce-compat-proxy'
    }));

  return {
    ...payload,
    data: [...payload.data, ...appended]
  };
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: 'Missing request URL' });
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type, x-api-key, anthropic-version, anthropic-beta',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    });
    res.end();
    return;
  }

  if (requestUrl.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      upstream: UPSTREAM_BASE_URL,
      port: PORT,
      aliases: MODEL_ALIASES
    });
    return;
  }

  if (!requestUrl.pathname.startsWith('/anthropic/') && !requestUrl.pathname.startsWith('/v1/')) {
    sendJson(res, 404, {
      error: 'Use /anthropic/* or /v1/* on this proxy'
    });
    return;
  }

  try {
    const rawBody = ['POST', 'PUT', 'PATCH'].includes(req.method || '') ? await readBody(req) : '';
    const parsedBody = rawBody ? JSON.parse(rawBody) : null;
    logDebug('request', {
      method: req.method,
      path: requestUrl.pathname,
      stream: Boolean(parsedBody?.stream),
      model: parsedBody?.model,
      tools: Array.isArray(parsedBody?.tools)
        ? parsedBody.tools.map((tool) => tool?.name ?? tool?.function?.name).filter(Boolean)
        : [],
      messages: Array.isArray(parsedBody?.messages)
        ? parsedBody.messages.slice(-3).map((message) => ({
          role: message?.role,
          summary: summarizeMessageContent(message?.content)
        }))
        : []
    });
    const shouldStreamLocally = shouldHandleSyntheticStream(requestUrl.pathname, parsedBody);
    const upstreamPath = mapUpstreamPath(requestUrl.pathname);
    let bodyToNormalize = shouldStreamLocally ? { ...parsedBody, stream: false } : parsedBody;
    if (parsedBody?.messages) {
      const lastMsg = parsedBody.messages[parsedBody.messages.length - 1];
      if (lastMsg?.role === 'assistant' && lastMsg?.content) {
        const contentStr = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
        logDebug('raw_assistant_content', contentStr.slice(0, 800));
      }
    }
    const upstreamBody = parsedBody
      ? injectSystemPromptForPath(
        upstreamPath,
        normalizeRequestTools(
          normalizeRequestMessages(
            maybeRewriteModel(bodyToNormalize, MODEL_ALIASES),
            upstreamPath
          ),
          upstreamPath
        )
      )
      : null;
    if (upstreamBody?.messages) {
      const lastMsg = upstreamBody.messages[upstreamBody.messages.length - 1];
      if (lastMsg?.role === 'assistant') {
        const content = lastMsg?.content;
        if (Array.isArray(content)) {
          logDebug('normalized_tool_calls', content.filter((b) => b?.type === 'tool_use').map((b) => ({ name: b.name, input: b.input })));
        }
      }
    }
    const encodedUpstreamBody = upstreamBody ? JSON.stringify(upstreamBody) : undefined;
    const upstreamUrl = new URL(upstreamPath + requestUrl.search, UPSTREAM_BASE_URL);
    const upstreamFetchOptions = {
      method: req.method,
      headers: buildUpstreamHeaders(req, encodedUpstreamBody ? Buffer.byteLength(encodedUpstreamBody) : null),
      body: encodedUpstreamBody
    };

    // Ana loop: upstream'i cagir, normalize et. Normalize sonrasi cevap effectively
    // bossa (hic text, hic tool_use) 1 kere daha upstream'i yeniden cagir. Bu
    // "model bazen hic cevap uretmiyor" durumunu absorbe eder. Asiri retry
    // (3x) istemciyi bekletir - EMPTY_RESPONSE_MAX_RETRIES ile kontrol edilir.
    const maxEmptyRetries = RETRY_ON_EMPTY_RESPONSE ? EMPTY_RESPONSE_MAX_RETRIES : 0;
    let upstreamResponse;
    let contentType = '';
    let upstreamText = '';
    let payload = null;
    let rawPayload = null;
    let nonJsonPassthrough = false;
    let lastWasEmpty = false;

    for (let emptyAttempt = 0; emptyAttempt <= maxEmptyRetries; emptyAttempt += 1) {
      upstreamResponse = await fetchUpstreamWithRetry(upstreamUrl, upstreamFetchOptions, `${req.method} ${upstreamPath}`);
      contentType = upstreamResponse.headers.get('content-type') || '';
      upstreamText = await upstreamResponse.text();

      if (!contentType.includes('application/json')) {
        nonJsonPassthrough = true;
        break;
      }

      payload = upstreamText ? JSON.parse(upstreamText) : {};
      rawPayload = payload;
      payload = normalizeJsonPayload(requestUrl.pathname, payload, parsedBody);
      payload = restorePresentedModel(parsedBody, payload);

      const effectivelyEmpty = isEffectivelyEmpty(requestUrl.pathname, payload);
      const noProgress = isNoProgressAssistantTurn(requestUrl.pathname, payload);
      lastWasEmpty = noProgress;

      // Basarili response ama normalize sonrasi bomboss → bir daha cagir
      if (
        upstreamResponse.status >= 200 && upstreamResponse.status < 300 &&
        RETRY_ON_EMPTY_RESPONSE &&
        emptyAttempt < maxEmptyRetries &&
        noProgress
      ) {
        logDebug('upstream_empty_payload_retry', {
          attempt: emptyAttempt + 1,
          path: requestUrl.pathname,
          reason: effectivelyEmpty ? 'empty' : 'no_progress',
          raw_content_length: typeof rawPayload === 'object' && Array.isArray(rawPayload?.content) ? rawPayload.content.length : undefined,
          raw_choices_length: typeof rawPayload === 'object' && Array.isArray(rawPayload?.choices) ? rawPayload.choices.length : undefined
        });
        await sleep(backoffDelay(emptyAttempt + 1));
        continue;
      }
      break;
    }

    // Retry'lar bitti ve cevap hala bos → sessizce bosa gonderme; kullaniciya
    // anlamli bir aciklama dondurs ki Claude Code 4+ dakika asili kalmasin.
    if (
      !nonJsonPassthrough &&
      lastWasEmpty &&
      upstreamResponse?.status >= 200 && upstreamResponse?.status < 300
    ) {
      payload = injectEmptyResponseFallback(requestUrl.pathname, payload);
    }

    if (nonJsonPassthrough) {
      res.writeHead(upstreamResponse.status, {
        'content-type': contentType || 'text/plain; charset=utf-8',
        'access-control-allow-origin': '*'
      });
      res.end(upstreamText);
      return;
    }
    if (
      requestUrl.pathname.includes('/anthropic/') &&
      Array.isArray(rawPayload?.content) &&
      Array.isArray(payload?.content) &&
      rawPayload.content.length > 0 &&
      payload.content.length === 0
    ) {
      logDebug('normalization_emptied_content', {
        path: requestUrl.pathname,
        raw: rawPayload.content.map((block) => ({
          type: block?.type,
          name: block?.name,
          text: typeof block?.text === 'string' ? block.text.slice(0, 200) : undefined
        }))
      });
    }
    logDebug('response', requestUrl.pathname.includes('/anthropic/')
      ? {
          stop_reason: payload?.stop_reason,
          content: Array.isArray(payload?.content)
            ? payload.content.map((block) => {
                const entry = { type: block?.type };
                if (block?.name !== undefined) entry.name = block.name;
                if (typeof block?.text === 'string') entry.text = block.text.slice(0, 120);
                if (block?.type === 'tool_use' && block?.input && typeof block.input === 'object') {
                  // Tool_use input'unu kisaltilmis halde goster (debug icin kritik).
                  entry.input = Object.fromEntries(
                    Object.entries(block.input).map(([key, value]) => {
                      if (typeof value === 'string') {
                        return [key, value.length > 120 ? `${value.slice(0, 120)}...` : value];
                      }
                      return [key, value];
                    })
                  );
                }
                return entry;
              })
            : []
        }
      : {
          choices: Array.isArray(payload?.choices)
            ? payload.choices.map((choice) => ({
                finish_reason: choice?.finish_reason,
                content: typeof choice?.message?.content === 'string' ? choice.message.content.slice(0, 80) : choice?.message?.content,
                tool_calls: Array.isArray(choice?.message?.tool_calls)
                  ? choice.message.tool_calls.map((toolCall) => ({
                      name: toolCall?.function?.name,
                      arguments: typeof toolCall?.function?.arguments === 'string' && toolCall.function.arguments.length > 200
                        ? `${toolCall.function.arguments.slice(0, 200)}...`
                        : toolCall?.function?.arguments
                    }))
                  : []
              }))
            : []
        });

    if (requestUrl.pathname.endsWith('/models')) {
      payload = appendAliasModels(payload);
    }

    if (shouldStreamLocally) {
      if (requestUrl.pathname.includes('/anthropic/') || requestUrl.pathname === '/v1/messages') {
        const sse = anthropicSseFromMessage(payload);
        res.writeHead(upstreamResponse.status, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
          'x-airforce-proxy-stream': 'synthetic'
        });
        res.end(sse);
        return;
      }

      if (requestUrl.pathname.endsWith('/chat/completions')) {
        const sse = openAiChatSseFromCompletion(payload);
        res.writeHead(upstreamResponse.status, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
          'x-airforce-proxy-stream': 'synthetic'
        });
        res.end(sse);
        return;
      }
    }

    sendJson(res, upstreamResponse.status, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logDebug('proxy_fatal', { path: requestUrl.pathname, message });
    sendJson(res, 502, {
      error: 'Proxy request failed',
      details: message
    });
  }
});

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  server.listen(PORT, HOST, () => {
    console.log(`Airforce compat proxy listening on http://${HOST}:${PORT}`);
    console.log(`Upstream: ${UPSTREAM_BASE_URL}`);
  });
}
