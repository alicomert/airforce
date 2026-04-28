// Airforce Bridge — HTTP entry point.
//
// Routes:
//   GET  /healthz                         (auth: none)
//   GET  /v1/models                       (auth: bridge)
//   POST /v1/chat/completions             (auth: bridge)
//   POST /v1/messages                     (auth: bridge — Anthropic-native)
//   GET  /admin                           (auth: admin — panel HTML)
//   GET  /admin/static/*                  (auth: admin — JS/CSS)
//   GET/POST/DELETE /admin/api/*          (auth: admin)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, summarize, ROOT_DIR } from './lib/config.js';
import { log } from './lib/logger.js';
import { isAuthorized } from './lib/auth.js';
import { handleListModels } from './lib/adapters/models.js';
import { handleOpenAiChatCompletions } from './lib/adapters/openai.js';
import { handleAnthropicMessages } from './lib/adapters/anthropic.js';
import { handleAdminApi } from './lib/admin-router.js';
import * as scheduler from './lib/scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_DIR = path.join(__dirname, 'web');

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, obj, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

function notFound(res) { return send(res, 404, { error: 'not_found' }); }
function unauthorized(res) { return send(res, 401, { error: 'unauthorized' }); }

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let limited = false;
    req.on('data', (c) => {
      data += c;
      if (data.length > 8 * 1024 * 1024) {
        limited = true;
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (limited) return;
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function corsPreflight(req, res) {
  res.statusCode = 204;
  res.setHeader('access-control-allow-origin', req.headers.origin || '*');
  res.setHeader('access-control-allow-headers', 'authorization, x-api-key, content-type, anthropic-version, anthropic-beta');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('access-control-max-age', '86400');
  res.end();
}

function applyCors(req, res) {
  res.setHeader('access-control-allow-origin', req.headers.origin || '*');
  res.setHeader('access-control-expose-headers', 'x-airforce-bridge-stream');
}

function serveStatic(req, res, urlPath) {
  // /admin/static/foo.js → web/foo.js
  let fname = urlPath.replace(/^\/admin\/static\//, '');
  if (fname === '' || fname.includes('..')) return notFound(res);
  const fp = path.join(WEB_DIR, fname);
  if (!fp.startsWith(WEB_DIR)) return notFound(res);
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return notFound(res);
  const ext = path.extname(fp).toLowerCase();
  res.setHeader('content-type', STATIC_MIME[ext] || 'application/octet-stream');
  res.setHeader('cache-control', 'no-cache');
  fs.createReadStream(fp).pipe(res);
}

function servePanel(req, res) {
  const fp = path.join(WEB_DIR, 'index.html');
  if (!fs.existsSync(fp)) return send(res, 500, { error: 'panel not built' });
  res.setHeader('content-type', 'text/html; charset=utf-8');
  fs.createReadStream(fp).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const start = Date.now();
  const urlPath = req.url.split('?')[0];
  const method = req.method;

  applyCors(req, res);

  try {
    if (method === 'OPTIONS') return corsPreflight(req, res);

    if (urlPath === '/healthz' || urlPath === '/health') {
      return send(res, 200, { ok: true, ...summarize() });
    }

    if (urlPath === '/' || urlPath === '/admin' || urlPath === '/admin/') {
      return servePanel(req, res);
    }
    if (urlPath.startsWith('/admin/static/')) {
      return serveStatic(req, res, urlPath);
    }
    if (urlPath.startsWith('/admin/api/')) {
      return handleAdminApi(req, res, urlPath);
    }

    if (urlPath === '/v1/models' && method === 'GET') {
      if (!isAuthorized(req)) return unauthorized(res);
      return handleListModels(req, res);
    }

    if (urlPath === '/v1/chat/completions' && method === 'POST') {
      if (!isAuthorized(req)) return unauthorized(res);
      let body;
      try { body = await readJsonBody(req); } catch (e) { return send(res, 400, { error: { message: 'bad json: ' + e.message } }); }
      log.info(`POST /v1/chat/completions model=${body.model || '?'} stream=${!!body.stream} tools=${(body.tools||[]).length}`);
      return handleOpenAiChatCompletions(req, res, body);
    }

    if (urlPath === '/v1/messages' && method === 'POST') {
      if (!isAuthorized(req)) return unauthorized(res);
      let body;
      try { body = await readJsonBody(req); } catch (e) { return send(res, 400, { error: { type: 'invalid_request_error', message: 'bad json: ' + e.message } }); }
      log.info(`POST /v1/messages model=${body.model || '?'} stream=${!!body.stream} tools=${(body.tools||[]).length}`);
      return handleAnthropicMessages(req, res, body);
    }

    return notFound(res);
  } catch (err) {
    log.error('server: unhandled error', { err: err.message, stack: err.stack?.split('\n')[0] });
    if (!res.headersSent) return send(res, 500, { error: { message: err.message || 'internal error' } });
  } finally {
    const dur = Date.now() - start;
    if (urlPath !== '/healthz') {
      log.debug(`${method} ${urlPath} → ${res.statusCode} ${dur}ms`);
    }
  }
});

server.keepAliveTimeout = 30_000;
server.headersTimeout = 35_000;

server.listen(config.port, config.host, () => {
  log.info(`airforce-bridge listening on http://${config.host}:${config.port}`, summarize());
  scheduler.start();
});

function shutdown(sig) {
  log.info(`received ${sig}, shutting down`);
  scheduler.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('unhandledRejection', { err: err?.message || String(err) }));
