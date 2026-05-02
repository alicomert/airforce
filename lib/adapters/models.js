// /v1/models handler. Registry'deki tüm aktif modelleri döner.
// Capability snapshot varsa native/xml flag'leri ekler.

import { getRouter } from '../providers/factory.js';
import { getCapability } from '../capability.js';
import { unixSeconds } from '../util.js';
import { log } from '../logger.js';

export async function handleListModels(req, res) {
  let router;
  try {
    router = await getRouter();
  } catch (err) {
    log.error('models: router init failed', { err: err.message });
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { message: err.message } }));
    return;
  }

  const snap = getCapability();
  const all = router.registry.listAllModels();

  const data = all.filter((m) => m.enabled).map((m) => {
    const capKey = `${m.provider_id}/${m.upstream_id}`;
    const cap = snap?.models?.[capKey];
    return {
      id: m.presented_id,
      object: 'model',
      created: unixSeconds(),
      owned_by: m.provider_id,
      provider_id: m.provider_id,
      upstream_id: m.upstream_id,
      priority: m.priority,
      tool_capable: cap ? Boolean(cap.xml || cap.native) : null,
      native_tools: cap?.native ?? null,
      latency_ms: cap?.latency_ms ?? null,
      note: cap ? undefined : 'capability not yet probed',
    };
  });

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ object: 'list', data }));
}
