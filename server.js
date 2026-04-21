import http from 'node:http';
import process from 'node:process';
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

const PORT = Number(process.env.PORT || 2393);
const HOST = process.env.HOST || '0.0.0.0';
const UPSTREAM_BASE_URL = (process.env.UPSTREAM_BASE_URL || 'https://api.airforce').replace(/\/+$/, '');
const DEFAULT_API_KEY = process.env.AIRFORCE_API_KEY || '';
const MODEL_ALIASES = parseAliases(process.env.MODEL_ALIASES);
const DEBUG_LOGS = process.env.DEBUG_LOGS !== '0';

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
  console.log(`[DEBUG] ${label}:`, value);
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
      ? normalizeRequestTools(
        normalizeRequestMessages(
          maybeRewriteModel(bodyToNormalize, MODEL_ALIASES),
          upstreamPath
        ),
        upstreamPath
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

    const upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers: buildUpstreamHeaders(req, encodedUpstreamBody ? Buffer.byteLength(encodedUpstreamBody) : null),
      body: encodedUpstreamBody
    });

    const contentType = upstreamResponse.headers.get('content-type') || '';
    const upstreamText = await upstreamResponse.text();

    if (!contentType.includes('application/json')) {
      res.writeHead(upstreamResponse.status, {
        'content-type': contentType || 'text/plain; charset=utf-8',
        'access-control-allow-origin': '*'
      });
      res.end(upstreamText);
      return;
    }

    let payload = upstreamText ? JSON.parse(upstreamText) : {};
    const rawPayload = payload;
    payload = normalizeJsonPayload(requestUrl.pathname, payload, parsedBody);
    payload = restorePresentedModel(parsedBody, payload);
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
            ? payload.content.map((block) => ({
                type: block?.type,
                name: block?.name,
                text: typeof block?.text === 'string' ? block.text.slice(0, 80) : undefined
              }))
            : []
        }
      : {
          choices: Array.isArray(payload?.choices)
            ? payload.choices.map((choice) => ({
                finish_reason: choice?.finish_reason,
                content: typeof choice?.message?.content === 'string' ? choice.message.content.slice(0, 80) : choice?.message?.content,
                tool_calls: Array.isArray(choice?.message?.tool_calls)
                  ? choice.message.tool_calls.map((toolCall) => toolCall?.function?.name)
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
    sendJson(res, 502, {
      error: 'Proxy request failed',
      details: error instanceof Error ? error.message : String(error)
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
