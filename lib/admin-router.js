// /admin/api/* JSON endpoint'leri.
// HTML panel ayrı bir route ile servis ediliyor (server.js).

import { isAuthorized, listKeys, createKey, deleteKey, loginWithCredentials, passwordLoginEnabled, logoutSession } from './auth.js';
import { recentLogs, clearLogs } from './logger.js';
import { getCapability } from './capability.js';
import { triggerSafe, isRunning as isProbeRunning } from './scheduler.js';
import { config, summarize } from './config.js';
import { log } from './logger.js';
import { getBucket } from './rate-limit.js';

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

  return send(res, 404, { error: 'not_found' });
}
