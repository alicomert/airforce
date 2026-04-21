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
// FAST_MODE=1: kullanici "sistem yavas" dedi; default degerleri sikistirilmis
// versiyona getir. Her biri env ile tekil override edilebilir.
const FAST_MODE = process.env.FAST_MODE !== '0';

// Upstream retry config. Network/5xx/408/425/429 icin exponential backoff.
// FAST_MODE defaults (hizli ama hala resilient):
//   - Attempt sayisi: 3 (2 retry + orjinal). 4 uzundu.
//   - Base delay: 150ms. 300 yavas kaliyordu.
//   - Max delay: 1.5s. 3s cok uzun.
// Normal mode defaults (eski deger):
//   - 4 attempt, 300ms base, 3s max
const UPSTREAM_MAX_ATTEMPTS = Math.max(1, Number(process.env.UPSTREAM_MAX_ATTEMPTS || (FAST_MODE ? 3 : 4)));
const UPSTREAM_RETRY_BASE_MS = Math.max(50, Number(process.env.UPSTREAM_RETRY_BASE_MS || (FAST_MODE ? 150 : 300)));
const UPSTREAM_RETRY_MAX_MS = Math.max(200, Number(process.env.UPSTREAM_RETRY_MAX_MS || (FAST_MODE ? 1500 : 3000)));
// Tek bir upstream isteginin max suresi (ms). Default 2 dakika (FAST_MODE)
// veya 3 dakika (normal). Modeller artik daha hizli, 3dk fazla.
const UPSTREAM_TIMEOUT_MS = Math.max(5000, Number(process.env.UPSTREAM_TIMEOUT_MS || (FAST_MODE ? 120000 : 180000)));
// Normalize sonrasi tamamen bos (ne text ne tool_use) cevap gelirse tekrar cagir.
// Her retry'da upstream prompt'una daha direkt bir nudge eklenir; conversation
// state (messages history) DEGISMEZ, sadece request body icindeki system
// bolumune temporary bir hint eklenir. Bu, zayif modelleri (glm-5 vb.) tool
// kullanmaya ittirir ve kullanicinin "sistem durdu" deneyimini onler.
//
// Butce: toplam `EMPTY_RESPONSE_BUDGET_MS` (default FAST_MODE'da 60s, normal
// 120s) boyunca retry devam eder. Tek upstream cagri timeout'u (UPSTREAM_
// TIMEOUT_MS) bundan bagimsizdir. Safety net olarak 10 retry hard limit var
// - upstream cok hizli cevap donup bos geliyorsa bile butce kullanici bekleme
// toleransini asmasin.
const RETRY_ON_EMPTY_RESPONSE = process.env.RETRY_ON_EMPTY_RESPONSE !== '0';
const EMPTY_RESPONSE_MAX_RETRIES = Math.max(0, Number(process.env.EMPTY_RESPONSE_MAX_RETRIES || 10));
const EMPTY_RESPONSE_BUDGET_MS = Math.max(5000, Number(process.env.EMPTY_RESPONSE_BUDGET_MS || (FAST_MODE ? 60000 : 120000)));

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

// "No progress" turu tespiti (dil-bagimsiz, deterministik):
//   - Tool_use yok, thinking yok
//   - Text ya tamamen bos ya da proxy'nin kendi "empty response" mesaji
// Onceki versiyonu modelin "Let me check" / "bakiyorum" gibi cumlelerini
// yakalayip retry tetikliyordu. Bu dile bagli, ayrica gereksiz yere yavaslik
// yaratiyordu (gecerli end_turn cevaplarinda bile retry ediyordu).
// Artik sadece gerekten bos/proxy-fallback response'larda retry tetikleyecegiz.
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
  // Sadece proxy'nin kendi empty-response fallback mesajini no-progress say.
  // Diger text icerigi (meshru assistant cevabi) retry TETIKLEMEZ artik.
  return textBlocks.every((text) => text === EMPTY_RESPONSE_USER_MESSAGE);
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

// Bos cevap durumunda upstream'e yeniden cagri atarken, modeli tool kullanimina
// tesvik eden bir "nudge" ekler. Conversation state DEGISMEZ: sadece request
// body'nin system bolumune gecici bir hint yazilir. Nudge'lar dile bagimsiz,
// yapisal. Her retry'da artan bir siddetle:
//   Level 1: nazik hatirlatma
//   Level 2: daha acik (tool kullanma zorunlulugu)
//   Level 3+: sonuc odakli ("son turdaki goreve geri don")
function buildEmptyRetryNudge(attempt, priorToolCategories) {
  const hasExploration = priorToolCategories.has('bash') || priorToolCategories.has('list') || priorToolCategories.has('grep') || priorToolCategories.has('read');
  const hasMutation = priorToolCategories.has('write') || priorToolCategories.has('edit');

  // Temel mesaj her seviyede ayni dil-bagimsiz yapisal talimat
  const parts = [
    '[airforce-proxy retry nudge]',
    `Your previous response had no tool_use block and no text content.`
  ];

  if (attempt === 1) {
    parts.push('If the user asked for an action, call the appropriate tool. If you need more information, produce a short clarifying text instead of an empty reply.');
  } else if (attempt === 2) {
    parts.push('Previous retry also returned empty. You MUST produce either a tool_use block (preferred if the user requested an action) or at least one non-empty text block explaining the blocker.');
  } else {
    // 3+ - en direkt
    parts.push('Multiple retries returned empty responses. Do ONE of the following right now: (a) emit a tool_use block that progresses the task, or (b) emit a text block describing exactly what information or clarification you need from the user. Do not return empty content.');
  }

  // Context-aware ekleme: onceki turlarda kesif yapildi ama yazma yok
  if (hasExploration && !hasMutation) {
    parts.push('The session already performed exploration tool calls. If the user asked you to create, modify, or generate a file, you likely have enough context to invoke the write/edit tool now.');
  }

  return parts.join(' ');
}

// Request body'ye gecici nudge ekle. Anthropic format (system: string|array)
// ve OpenAI chat format (messages icinde role:'system') ikisini de destekle.
function injectEmptyRetryNudgeIntoBody(parsedBody, upstreamBody, pathname, nudgeText) {
  if (!upstreamBody || typeof upstreamBody !== 'object') return upstreamBody;

  if (pathname.includes('/anthropic/') || pathname === '/v1/messages') {
    const existing = upstreamBody.system;
    let newSystem;
    if (existing == null || existing === '') {
      newSystem = nudgeText;
    } else if (typeof existing === 'string') {
      newSystem = `${existing}\n\n${nudgeText}`;
    } else if (Array.isArray(existing)) {
      newSystem = [...existing, { type: 'text', text: nudgeText }];
    } else {
      newSystem = existing;
    }
    return { ...upstreamBody, system: newSystem };
  }

  if (pathname.endsWith('/chat/completions') || pathname.endsWith('/responses')) {
    const messages = Array.isArray(upstreamBody.messages) ? upstreamBody.messages : [];
    const newMessages = [
      ...messages,
      { role: 'system', content: nudgeText }
    ];
    return { ...upstreamBody, messages: newMessages };
  }

  return upstreamBody;
}

// Request body'de daha once hangi tool kategorileri kullanildi? Dil-bagimsiz,
// tool adini proxy'nin bildigi alias listesiyle eslesir. Returns Set of
// category strings: 'bash', 'read', 'write', 'edit', 'list', 'grep'.
function collectPriorToolCategories(parsedBody) {
  const categories = new Set();
  const messages = Array.isArray(parsedBody?.messages) ? parsedBody.messages : [];
  // Simple inline mapping - tool name (case-insensitive, normalize) -> category
  const categoryMap = {
    bash: 'bash', shell: 'bash', exec: 'bash', powershell: 'bash',
    read: 'read', readfile: 'read', read_file: 'read', openfile: 'read', viewfile: 'read',
    write: 'write', writefile: 'write', write_file: 'write', createfile: 'write',
    edit: 'edit', editfile: 'edit', strreplace: 'edit', multiedit: 'edit',
    glob: 'list', listdirectory: 'list', list_directory: 'list', findfiles: 'list',
    grep: 'grep', search: 'grep', ripgrep: 'grep', contentsearch: 'grep'
  };
  for (const msg of messages) {
    if (msg?.role !== 'assistant' || !Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== 'tool_use') continue;
      const name = String(block?.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const cat = categoryMap[name];
      if (cat) categories.add(cat);
    }
  }
  return categories;
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

    // Ana loop: upstream'i cagir, normalize et. Bos cevap gelirse nudge'li
    // follow-up ile yeniden cagir. Loop, suresi bittiginde veya hard limit'e
    // ulastiginda durur (EMPTY_RESPONSE_BUDGET_MS butcesi kullanici bekleme
    // toleransini asmaz). Conversation state DEGISMEZ - sadece request body'nin
    // system bolumune gecici bir nudge eklenir.
    const maxEmptyRetries = RETRY_ON_EMPTY_RESPONSE ? EMPTY_RESPONSE_MAX_RETRIES : 0;
    const emptyRetryDeadline = Date.now() + EMPTY_RESPONSE_BUDGET_MS;
    const priorToolCategories = collectPriorToolCategories(parsedBody);

    let upstreamResponse;
    let contentType = '';
    let upstreamText = '';
    let payload = null;
    let rawPayload = null;
    let nonJsonPassthrough = false;
    let lastWasEmpty = false;
    // Her retry'da farkli nudge ile body'i yeniden uret. Ilk cagri (emptyAttempt=0)
    // normal body kullanir; sonraki cagrilarda nudge eklenir.
    let currentEncodedBody = encodedUpstreamBody;
    let currentFetchOptions = upstreamFetchOptions;

    for (let emptyAttempt = 0; emptyAttempt <= maxEmptyRetries; emptyAttempt += 1) {
      upstreamResponse = await fetchUpstreamWithRetry(upstreamUrl, currentFetchOptions, `${req.method} ${upstreamPath}`);
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

      // Basarili response + effectively empty → nudge'li yeniden cagri
      const canRetry =
        upstreamResponse.status >= 200 && upstreamResponse.status < 300 &&
        RETRY_ON_EMPTY_RESPONSE &&
        emptyAttempt < maxEmptyRetries &&
        Date.now() < emptyRetryDeadline &&
        noProgress;

      if (canRetry) {
        const nextAttempt = emptyAttempt + 1;
        const nudge = buildEmptyRetryNudge(nextAttempt, priorToolCategories);
        const nudgedBody = injectEmptyRetryNudgeIntoBody(parsedBody, upstreamBody, upstreamPath, nudge);
        currentEncodedBody = JSON.stringify(nudgedBody);
        currentFetchOptions = {
          ...upstreamFetchOptions,
          headers: buildUpstreamHeaders(req, Buffer.byteLength(currentEncodedBody)),
          body: currentEncodedBody
        };

        logDebug('upstream_empty_payload_retry', {
          attempt: nextAttempt,
          path: requestUrl.pathname,
          reason: effectivelyEmpty ? 'empty' : 'no_progress',
          budget_remaining_ms: Math.max(0, emptyRetryDeadline - Date.now()),
          raw_content_length: typeof rawPayload === 'object' && Array.isArray(rawPayload?.content) ? rawPayload.content.length : undefined,
          raw_choices_length: typeof rawPayload === 'object' && Array.isArray(rawPayload?.choices) ? rawPayload.choices.length : undefined
        });
        await sleep(backoffDelay(nextAttempt));
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
  // TCP keep-alive: istemcinin (Claude Code, OpenCode) ardisik request'lerinde
  // bagaltinin yeniden acilmasini onler (TLS handshake + TCP SYN latency kazanci).
  // Default 5s idle, biz 30s'ye cikaralim - ardisik tool_use turlarinda istemci
  // genelde 1-2s icinde geri sorar, o pencerede bagaltimi tut.
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000; // keepAlive + 5s buffer
  server.listen(PORT, HOST, () => {
    console.log(`Airforce compat proxy listening on http://${HOST}:${PORT}`);
    console.log(`Upstream: ${UPSTREAM_BASE_URL}`);
    console.log(`FAST_MODE: ${FAST_MODE ? 'on' : 'off'} | attempts=${UPSTREAM_MAX_ATTEMPTS} empty_retries=${EMPTY_RESPONSE_MAX_RETRIES} timeout=${UPSTREAM_TIMEOUT_MS}ms`);
  });
}
