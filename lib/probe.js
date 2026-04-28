// Tool-capability probe.
// Her chat-supports operational model için:
//   1) tools=[get_weather] ile bir test isteği gönder, NATIVE tool_calls dönüyor mu?
//   2) Dönmüyorsa, system prompt inject ile aynı isteği gönder, XML <tool_calls> üretiyor mu?
// Sonuç: data/tool_capability.json snapshot'ına yaz.

import { config } from './config.js';
import { log } from './logger.js';
import { fetchModels, upstreamJson, UpstreamError } from './upstream.js';
import { saveCapability } from './store.js';
import { renderToolsBlock } from './tool-engine/inject.js';
import { extractToolCalls } from './tool-engine/parse.js';
import { sleep, nowIso } from './util.js';

const TEST_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather in a given city',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name' },
          unit: { type: 'string', enum: ['c', 'f'] },
        },
        required: ['city'],
      },
    },
  },
];

const TEST_USER = 'What is the weather in Istanbul right now? Use the get_weather tool.';

function shouldSkipModel(m) {
  if (!m.supports_chat) return true;
  if (m.status !== 'operational') return true;
  if (!m.supports_streaming && !m.supports_non_streaming) return true;
  const id = (m.id || '').toLowerCase();
  for (const sub of config.probe.skipSubstrings || []) {
    if (id.includes(String(sub).toLowerCase())) return true;
  }
  if (!config.probe.includePayg && id.includes('-p2g')) return true;
  return false;
}

async function probeXml(modelId) {
  const block = renderToolsBlock(TEST_TOOLS, { dialect: 'openai' });
  const body = {
    model: modelId,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.\n\n' + block },
      { role: 'user', content: TEST_USER },
    ],
    stream: false,
  };
  const { json } = await upstreamJson('POST', '/v1/chat/completions', body, {
    timeoutMs: config.probe.timeoutMs,
    maxAttempts: 1,
  });
  const text = json?.choices?.[0]?.message?.content || '';
  const parsed = extractToolCalls(text);
  const ok = parsed.calls.length > 0 && parsed.calls[0].name === 'get_weather';
  const isPaygMessage = typeof text === 'string' && text.includes('Pay-As-You-Go');
  return { ok, payg: isPaygMessage, sample: text.slice(0, 240) };
}

export async function runProbe({ onProgress } = {}) {
  const start = Date.now();
  log.info('probe: starting model capability scan');

  let models;
  try {
    models = await fetchModels();
  } catch (err) {
    log.error('probe: cannot fetch /v1/models', { err: err.message });
    throw err;
  }

  const out = { last_run_iso: nowIso(), duration_ms: 0, models: {} };

  let processed = 0;
  for (const m of models) {
    if (shouldSkipModel(m)) {
      out.models[m.id] = {
        owned_by: m.owned_by,
        status: 'skipped',
        reason: m.status !== 'operational' ? `status=${m.status}` : 'filtered',
        checked_at: nowIso(),
        xml: false,
      };
      continue;
    }

    // Sadece XML inject testi: bizim akışımız bu modelle çalışıyor mu?
    let xml = { ok: false };
    let lastError = null;
    try {
      xml = await probeXml(m.id);
    } catch (err) {
      lastError = err.message;
      log.debug(`probe: xml error for ${m.id}`, { err: err.message });
    }

    let status;
    if (xml.payg) status = 'payg';
    else if (!xml.ok) status = 'incompatible';
    else status = 'ok';

    out.models[m.id] = {
      owned_by: m.owned_by,
      latency_ms: m.latency_ms,
      status,
      xml: Boolean(xml.ok),
      checked_at: nowIso(),
      last_error: lastError,
      sample: xml.sample || null,
    };

    processed++;
    if (typeof onProgress === 'function') {
      try { onProgress({ processed, total: models.length, model: m.id, result: out.models[m.id] }); } catch {}
    }

    log.info(`probe: ${m.id}`, { status, xml: xml.ok });

    // Incremental save so the panel shows progress live.
    if (processed % 3 === 0) {
      out.duration_ms = Date.now() - start;
      out.last_run_iso = nowIso();
      saveCapability(out);
    }

    // gentle pace
    await sleep(80);
  }

  out.duration_ms = Date.now() - start;
  saveCapability(out);

  const okCount = Object.values(out.models).filter((x) => x.status === 'ok').length;
  log.info(`probe: finished — ${okCount}/${models.length} capable, ${(out.duration_ms / 1000).toFixed(1)}s`);

  return out;
}
