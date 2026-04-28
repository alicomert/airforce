// /admin/api/* JSON endpoint'leri.
// HTML panel ayrı bir route ile servis ediliyor (server.js).

import { isAuthorized, listKeys, createKey, deleteKey, loginWithCredentials, passwordLoginEnabled, logoutSession } from './auth.js';
import { recentLogs, clearLogs } from './logger.js';
import { getCapability } from './capability.js';
import { triggerSafe, isRunning as isProbeRunning } from './scheduler.js';
import { config, summarize } from './config.js';
import { log } from './logger.js';
import { getBucket } from './rate-limit.js';
import { loadProvidersConfig, saveProvidersConfig } from './store.js';
import { getRouter, invalidateRouterCache, buildProviderInstance } from './providers/factory.js';
import { validateProviderConfig, validateProvidersFile } from './providers/config-schema.js';

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1_000_000) { reject(new Error('payload too large')); req.destroy(); }});
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(obj));
}

function denied(res) {
  return send(res, 401, { error: 'unauthorized' });
}

export async function handleAdminApi(req, res, urlPath) {
  // Public (no auth) endpoints first
  if (urlPath === '/admin/api/auth-mode' && req.method === 'GET') {
    return send(res, 200, {
      password_login: passwordLoginEnabled(),
      token_login: true, // Bearer token her zaman destekli
    });
  }
  if (urlPath === '/admin/api/login' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { return send(res, 400, { error: 'bad json' }); }
    const r = loginWithCredentials(body?.username, body?.password);
    if (!r.ok) return send(res, 401, { error: r.error });
    log.info('admin: password login', { username: body.username });
    return send(res, 200, { ok: true, token: r.token });
  }
  if (urlPath === '/admin/api/logout' && req.method === 'POST') {
    const auth = req.headers['authorization'] || '';
    if (auth.toLowerCase().startsWith('bearer ')) {
      logoutSession(auth.slice(7).trim());
    }
    return send(res, 200, { ok: true });
  }

  // From here on, admin auth required
  if (!isAuthorized(req, { requireAdmin: true })) return denied(res);

  // Routes:
  if (urlPath === '/admin/api/state' && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      now: new Date().toISOString(),
      config: summarize(),
      probe: {
        running: isProbeRunning(),
        snapshot: getCapability(),
      },
      rate_limit: getBucket().snapshot(),
      keys: listKeys(),
    });
  }

  if (urlPath === '/admin/api/capability' && req.method === 'GET') {
    return send(res, 200, getCapability());
  }

  if (urlPath === '/admin/api/probe/run' && req.method === 'POST') {
    if (isProbeRunning()) return send(res, 409, { error: 'already_running' });
    triggerSafe('manual'); // fire-and-forget
    return send(res, 202, { ok: true, message: 'probe started' });
  }

  if (urlPath === '/admin/api/keys' && req.method === 'GET') {
    return send(res, 200, { keys: listKeys() });
  }
  if (urlPath === '/admin/api/keys' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch (e) { return send(res, 400, { error: 'bad json' }); }
    const created = createKey(body.label || 'unnamed');
    log.info('admin: created bridge key', { id: created.id, label: created.label });
    return send(res, 201, { ok: true, key: created });
  }

  const keyDelMatch = urlPath.match(/^\/admin\/api\/keys\/([^/]+)$/);
  if (keyDelMatch && req.method === 'DELETE') {
    const ok = deleteKey(keyDelMatch[1]);
    if (!ok) return send(res, 404, { error: 'not_found' });
    log.info('admin: deleted bridge key', { id: keyDelMatch[1] });
    return send(res, 200, { ok: true });
  }

  if (urlPath === '/admin/api/logs' && req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const n = Math.min(1000, Math.max(1, Number(url.searchParams.get('n')) || 200));
    return send(res, 200, { logs: recentLogs(n) });
  }
  if (urlPath === '/admin/api/logs' && req.method === 'DELETE') {
    clearLogs();
    return send(res, 200, { ok: true });
  }

  // ===== Phase 4a: provider CRUD + discover + breaker reset + export/import =====

  if (urlPath === '/admin/api/providers' && req.method === 'GET') {
    const cfg = loadProvidersConfig() || { providers: [] };
    return send(res, 200, { providers: (cfg.providers || []).map(maskProvider) });
  }

  if (urlPath === '/admin/api/providers' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { return send(res, 400, { error: 'bad json' }); }
    const v = validateProviderConfig(body);
    if (!v.ok) return send(res, 400, { error: v.error });
    const cfg = loadProvidersConfig() || { schema_version: 1, providers: [], aliases: {}, global: {} };
    if ((cfg.providers || []).some((p) => p.id === body.id)) {
      return send(res, 409, { error: { field: 'id', message: 'duplicate id' } });
    }
    cfg.providers = cfg.providers || [];
    cfg.providers.push({
      id: body.id, label: body.label || body.id, type: body.type,
      base_url: body.base_url, api_key: body.api_key,
      headers: body.headers || {}, timeout_ms: body.timeout_ms || 180000,
      enabled: body.enabled ?? true,
      rate_limit: body.rate_limit || {},
      models: body.models || [],
    });
    saveProvidersConfig(cfg);
    invalidateRouterCache();
    log.info('admin: provider created', { id: body.id });
    return send(res, 201, { ok: true });
  }

  const provIdMatch = urlPath.match(/^\/admin\/api\/providers\/([^/]+)$/);
  if (provIdMatch && req.method === 'PUT') {
    let body;
    try { body = await readJsonBody(req); } catch { return send(res, 400, { error: 'bad json' }); }
    const cfg = loadProvidersConfig();
    if (!cfg) return send(res, 404, { error: 'no config' });
    const idx = (cfg.providers || []).findIndex((p) => p.id === provIdMatch[1]);
    if (idx < 0) return send(res, 404, { error: 'not_found' });
    const merged = { ...cfg.providers[idx] };
    for (const k of ['label', 'base_url', 'api_key', 'headers', 'timeout_ms', 'enabled', 'rate_limit']) {
      if (body[k] !== undefined) merged[k] = body[k];
    }
    const v = validateProviderConfig(merged);
    if (!v.ok) return send(res, 400, { error: v.error });
    cfg.providers[idx] = merged;
    saveProvidersConfig(cfg);
    invalidateRouterCache();
    log.info('admin: provider updated', { id: provIdMatch[1] });
    return send(res, 200, { ok: true });
  }

  if (provIdMatch && req.method === 'DELETE') {
    const cfg = loadProvidersConfig();
    if (!cfg) return send(res, 404, { error: 'no config' });
    const before = (cfg.providers || []).length;
    cfg.providers = (cfg.providers || []).filter((p) => p.id !== provIdMatch[1]);
    if (cfg.providers.length === before) return send(res, 404, { error: 'not_found' });
    saveProvidersConfig(cfg);
    invalidateRouterCache();
    log.info('admin: provider deleted', { id: provIdMatch[1] });
    return send(res, 200, { ok: true });
  }

  const provTestMatch = urlPath.match(/^\/admin\/api\/providers\/([^/]+)\/test$/);
  if (provTestMatch && req.method === 'POST') {
    const cfg = loadProvidersConfig();
    const p = (cfg?.providers || []).find((x) => x.id === provTestMatch[1]);
    if (!p) return send(res, 404, { error: 'not_found' });
    try {
      const inst = buildProviderInstance(p);
      const model = (p.models?.[0]?.upstream_id) || 'unknown';
      const h = await inst.healthCheck({ model });
      return send(res, 200, h);
    } catch (err) {
      return send(res, 500, { ok: false, error: err.message });
    }
  }

  const provDiscoverMatch = urlPath.match(/^\/admin\/api\/providers\/([^/]+)\/discover$/);
  if (provDiscoverMatch && req.method === 'POST') {
    const cfg = loadProvidersConfig();
    const p = (cfg?.providers || []).find((x) => x.id === provDiscoverMatch[1]);
    if (!p) return send(res, 404, { error: 'not_found' });
    try {
      const inst = buildProviderInstance(p);
      const models = await inst.listModels();
      return send(res, 200, { models });
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  }

  const provModelsMatch = urlPath.match(/^\/admin\/api\/providers\/([^/]+)\/models$/);
  if (provModelsMatch && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { return send(res, 400, { error: 'bad json' }); }
    const cfg = loadProvidersConfig();
    const p = (cfg?.providers || []).find((x) => x.id === provModelsMatch[1]);
    if (!p) return send(res, 404, { error: 'not_found' });
    p.models = p.models || [];
    const incoming = Array.isArray(body.models) ? body.models : [];
    for (const m of incoming) {
      if (!m.upstream_id) continue;
      const i = p.models.findIndex((x) => x.upstream_id === m.upstream_id);
      const entry = {
        upstream_id: m.upstream_id,
        priority: m.priority ?? 0,
        enabled: m.enabled ?? true,
      };
      if (m.presented_id) entry.presented_id = m.presented_id;
      if (i >= 0) p.models[i] = entry; else p.models.push(entry);
    }
    saveProvidersConfig(cfg);
    invalidateRouterCache();
    log.info('admin: bulk model add', { provider: p.id, count: incoming.length });
    return send(res, 200, { ok: true, models: p.models });
  }

  const provModelMatch = urlPath.match(/^\/admin\/api\/providers\/([^/]+)\/models\/(.+)$/);
  if (provModelMatch && req.method === 'PUT') {
    let body;
    try { body = await readJsonBody(req); } catch { return send(res, 400, { error: 'bad json' }); }
    const cfg = loadProvidersConfig();
    const p = (cfg?.providers || []).find((x) => x.id === provModelMatch[1]);
    if (!p) return send(res, 404, { error: 'provider_not_found' });
    const upstream = decodeURIComponent(provModelMatch[2]);
    const m = (p.models || []).find((x) => x.upstream_id === upstream);
    if (!m) return send(res, 404, { error: 'model_not_found' });
    if (body.priority !== undefined) m.priority = Number(body.priority);
    if (body.enabled !== undefined) m.enabled = Boolean(body.enabled);
    if (body.presented_id !== undefined) m.presented_id = body.presented_id || undefined;
    saveProvidersConfig(cfg);
    invalidateRouterCache();
    return send(res, 200, { ok: true, model: m });
  }

  if (provModelMatch && req.method === 'DELETE') {
    const cfg = loadProvidersConfig();
    const p = (cfg?.providers || []).find((x) => x.id === provModelMatch[1]);
    if (!p) return send(res, 404, { error: 'provider_not_found' });
    const upstream = decodeURIComponent(provModelMatch[2]);
    const before = (p.models || []).length;
    p.models = (p.models || []).filter((x) => x.upstream_id !== upstream);
    if (p.models.length === before) return send(res, 404, { error: 'model_not_found' });
    saveProvidersConfig(cfg);
    invalidateRouterCache();
    return send(res, 200, { ok: true });
  }

  const breakerMatch = urlPath.match(/^\/admin\/api\/providers\/([^/]+)\/breaker\/reset$/);
  if (breakerMatch && req.method === 'POST') {
    try {
      const router = await getRouter();
      router.breakers.reset(breakerMatch[1]);
      log.info('admin: breaker reset', { id: breakerMatch[1] });
      return send(res, 200, { ok: true });
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  }

  if (urlPath === '/admin/api/breakers' && req.method === 'GET') {
    try {
      const router = await getRouter();
      return send(res, 200, { breakers: router.breakers.snapshot() });
    } catch {
      return send(res, 200, { breakers: [] });
    }
  }

  if (urlPath === '/admin/api/aliases' && req.method === 'GET') {
    const cfg = loadProvidersConfig();
    return send(res, 200, { aliases: cfg?.aliases || {} });
  }

  if (urlPath === '/admin/api/aliases' && req.method === 'PUT') {
    let body;
    try { body = await readJsonBody(req); } catch { return send(res, 400, { error: 'bad json' }); }
    const cfg = loadProvidersConfig();
    if (!cfg) return send(res, 404, { error: 'no config' });
    cfg.aliases = body.aliases || {};
    saveProvidersConfig(cfg);
    invalidateRouterCache();
    return send(res, 200, { ok: true });
  }

  if (urlPath === '/admin/api/export' && req.method === 'GET') {
    const cfg = loadProvidersConfig();
    if (!cfg) return send(res, 404, { error: 'no config' });
    return send(res, 200, cfg);
  }

  if (urlPath === '/admin/api/import' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch { return send(res, 400, { error: 'bad json' }); }
    const v = validateProvidersFile(body);
    if (!v.ok) return send(res, 400, { error: v.error });
    saveProvidersConfig(body);
    invalidateRouterCache();
    log.info('admin: config imported', { providers: body.providers.length });
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { error: 'not_found' });
}

function maskProvider(p) {
  const keyStr = String(p.api_key || '');
  return {
    ...p,
    api_key: '****',
    api_key_last4: keyStr.slice(-4),
  };
}
