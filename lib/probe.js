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
import { classifyTier, tierAllowed, tierPriority } from './tier.js';
import { getBucket } from './rate-limit.js';

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

function shouldSkipModel(m, allowedTier) {
  if (!m.supports_chat) return { skip: true, reason: 'not chat' };
  if (m.status !== 'operational') return { skip: true, reason: `status=${m.status}` };
  if (!m.supports_streaming && !m.supports_non_streaming) return { skip: true, reason: 'no chat surface' };
  const id = (m.id || '').toLowerCase();
  for (const sub of config.probe.skipSubstrings || []) {
    if (id.includes(String(sub).toLowerCase())) return { skip: true, reason: `substring "${sub}"` };
  }
  const tier = classifyTier(m.multiplier);
  if (!tierAllowed(tier, allowedTier)) {
    return { skip: true, reason: `tier ${tier} > ${allowedTier} (PROBE_TIER)` };
  }
  return { skip: false };
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
  const allowedTier = config.probe.tier || 'free';
  log.info(`probe: starting (tier<=${allowedTier}, rate=${config.rateLimit.multPerMin}/min)`);

  let models;
  try {
    models = await fetchModels();
  } catch (err) {
    log.error('probe: cannot fetch /v1/models', { err: err.message });
    throw err;
  }

  // Modeli tier + latency'e göre sırala — önce free'ler, sonra premium, en son p2g.
  const ordered = models.slice().map((m) => ({ ...m, _tier: classifyTier(m.multiplier) }));
  ordered.sort((a, b) => {
    const ta = tierPriority(a._tier);
    const tb = tierPriority(b._tier);
    if (ta !== tb) return ta - tb;
    const la = Number.isFinite(a.latency_ms) ? a.latency_ms : 9e9;
    const lb = Number.isFinite(b.latency_ms) ? b.latency_ms : 9e9;
    if (la !== lb) return la - lb;
    return (a.id || '').localeCompare(b.id || '');
  });

  const out = { last_run_iso: nowIso(), duration_ms: 0, allowed_tier: allowedTier, models: {} };
  const bucket = getBucket();

  let processed = 0;
  let probed = 0;
  for (const m of ordered) {
    const tier = m._tier;
    const skip = shouldSkipModel(m, allowedTier);
    if (skip.skip) {
      out.models[m.id] = {
        owned_by: m.owned_by,
        latency_ms: m.latency_ms ?? null,
        multiplier: m.multiplier ?? null,
        tier,
        status: 'skipped',
        reason: skip.reason,
        checked_at: nowIso(),
        xml: false,
      };
      continue;
    }

    // Rate limit: bu modelin maliyeti kadar bütçeden düş; doluysa pencere bitene kadar bekle.
    const cost = Math.max(1, Number(m.multiplier) || 1);
    await bucket.charge(cost, `probe:${m.id}`);

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
      latency_ms: m.latency_ms ?? null,
      multiplier: m.multiplier ?? null,
      tier,
      status,
      xml: Boolean(xml.ok),
      checked_at: nowIso(),
      last_error: lastError,
      sample: xml.sample || null,
    };

    processed++;
    probed++;
    if (typeof onProgress === 'function') {
      try { onProgress({ processed, total: ordered.length, model: m.id, result: out.models[m.id] }); } catch {}
    }

    log.info(`probe: ${m.id}`, { tier, mult: cost, status, xml: xml.ok });

    // Incremental save so the panel shows progress live.
    if (processed % 3 === 0) {
      out.duration_ms = Date.now() - start;
      out.last_run_iso = nowIso();
      saveCapability(out);
    }
  }

  out.duration_ms = Date.now() - start;
  out.last_run_iso = nowIso();
  saveCapability(out);

  const okCount = Object.values(out.models).filter((x) => x.status === 'ok').length;
  log.info(`probe: finished — ${okCount} capable, ${probed} probed, ${(out.duration_ms / 1000).toFixed(1)}s`);

  return out;
}
