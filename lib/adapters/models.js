// /v1/models handler. Capability snapshot'ından sadece tool-capable modelleri döndürür.
// Boş snapshot durumunda upstream'e fallback yapar.

import { fetchModels } from '../upstream.js';
import { getCapability } from '../capability.js';
import { config } from '../config.js';
import { unixSeconds } from '../util.js';
import { log } from '../logger.js';

export async function handleListModels(req, res) {
  const snap = getCapability();
  let modelIds = Object.entries(snap.models || {})
    .filter(([, v]) => v.status === 'ok' && v.xml)
    .map(([id]) => id);

  // Snapshot boşsa upstream'i göster (in-place keşif), tool-test edilmemiş işaretiyle.
  if (!modelIds.length) {
    try {
      const upstream = await fetchModels();
      const data = upstream
        .filter((m) => m.supports_chat && m.status === 'operational')
        .map((m) => ({
          id: m.id,
          object: 'model',
          created: m.created || unixSeconds(),
          owned_by: m.owned_by || 'unknown',
          tool_capable: null,
          note: 'capability not yet probed',
        }));
      // Inject aliases
      for (const aliasId of Object.keys(config.modelAliases || {})) {
        if (!data.find((d) => d.id === aliasId)) {
          data.push({
            id: aliasId,
            object: 'model',
            created: unixSeconds(),
            owned_by: 'alias',
            tool_capable: null,
            note: `alias → ${config.modelAliases[aliasId]}`,
          });
        }
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ object: 'list', data }));
      return;
    } catch (err) {
      log.error('models: upstream fetch failed', { err: err.message });
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { message: 'Upstream unreachable' } }));
      return;
    }
  }

  const data = modelIds.map((id) => {
    const v = snap.models[id];
    return {
      id,
      object: 'model',
      created: unixSeconds(),
      owned_by: v.owned_by || 'unknown',
      tool_capable: true,
      latency_ms: v.latency_ms ?? null,
      multiplier: v.multiplier ?? null,
      tier: v.tier ?? null,
    };
  });

  // Inject configured aliases too.
  for (const [aliasId, target] of Object.entries(config.modelAliases || {})) {
    if (!data.find((d) => d.id === aliasId)) {
      const tcap = snap.models?.[target];
      data.push({
        id: aliasId,
        object: 'model',
        created: unixSeconds(),
        owned_by: 'alias',
        alias_target: target,
        tool_capable: tcap ? (tcap.status === 'ok') : null,
      });
    }
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ object: 'list', data }));
}
