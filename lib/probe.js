// Multi-provider tool-capability probe.
// Her enabled (provider, model) çifti için:
//   1) XML inject testi (mevcut)
//   2) (Faz 5'te eklenecek: native test)
// Sonuç: data/capability.json snapshot'ına yaz.

import { config } from './config.js';
import { log } from './logger.js';
import { getRouter } from './providers/factory.js';
import { saveCapability } from './store.js';
import { renderToolsBlock } from './tool-engine/inject.js';
import { extractToolCalls } from './tool-engine/parse.js';
import { nowIso } from './util.js';
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

async function probeXml(provider, modelId) {
  const block = renderToolsBlock(TEST_TOOLS, { dialect: 'openai' });
  const body = {
    model: modelId,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.\n\n' + block },
      { role: 'user', content: TEST_USER },
    ],
    stream: false,
  };
  const result = await provider.chat(body, {
    timeout_ms: config.probe.timeoutMs,
    max_attempts: 1,
  });
  const text = result.text || '';
  const parsed = extractToolCalls(text);
  const ok = parsed.calls.length > 0 && parsed.calls[0].name === 'get_weather';
  return { ok, sample: text.slice(0, 240) };
}

export async function runProbe({ onProgress } = {}) {
  const start = Date.now();
  const router = await getRouter();
  const all = router.registry.listAllModels();
  log.info(`probe: starting ${all.length} (provider,model) pairs`);

  const out = { last_run_iso: nowIso(), schema_version: 2, duration_ms: 0, models: {} };

  let processed = 0;
  for (const m of all) {
    if (!m.enabled) continue;
    const provider = router.registry.providers.get(m.provider_id);
    if (!provider) continue;

    const key = `${m.provider_id}/${m.upstream_id}`;
    const bucket = getBucket(m.provider_id);
    await bucket.charge(1, `probe:${key}`);

    let xml = { ok: false };
    let lastError = null;
    try {
      xml = await probeXml(provider, m.upstream_id);
    } catch (err) {
      lastError = err.message;
      log.debug(`probe: xml error for ${key}`, { err: err.message });
    }

    const status = xml.ok ? 'ok' : 'incompatible';
    out.models[key] = {
      provider_id: m.provider_id,
      upstream_id: m.upstream_id,
      presented_id: m.presented_id,
      priority: m.priority,
      status,
      xml: Boolean(xml.ok),
      native: null,
      checked_at: nowIso(),
      last_error: lastError,
      sample: xml.sample || null,
    };

    processed++;
    if (typeof onProgress === 'function') {
      try { onProgress({ processed, total: all.length, key, result: out.models[key] }); } catch {}
    }
    log.info(`probe: ${key}`, { status, xml: xml.ok });

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
  log.info(`probe: finished — ${okCount}/${all.length} capable, ${(out.duration_ms / 1000).toFixed(1)}s`);
  return out;
}
