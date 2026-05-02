# Phase 4a — Admin Panel Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mevcut tek sayfa admin panel'i 3 sekmeli yapıya (`Providers` / `Models` / `Logs`) çevir; provider CRUD, model discover/checkbox add, breaker reset, manual probe trigger, export/import endpoint'lerini tamamla; hot-reload mekanizmasını kur.

**Architecture:** Backend: `lib/admin-router.js` genişlemiş + yeni `lib/providers/config-schema.js` validation modülü; `lib/providers/factory.js` `_invalidateCache()` exposed. Frontend: tek sayfa vanilla JS, sekme bazlı dosyalara split (`web/tabs/{providers,models,logs}.js` + ortak `web/components/{modal,table,card}.js`).

**Tech Stack:** Node.js >=20, ESM, native fetch, `node:test`, vanilla JS (no framework).

---

## File Structure

**Create:**
- `lib/providers/config-schema.js` — `validateProviderConfig`, `validateModelConfig`, `validateProvidersFile`
- `web/tabs/providers.js`, `web/tabs/models.js`, `web/tabs/logs.js`
- `web/components/modal.js`, `web/components/table.js`, `web/components/card.js`
- `test/admin/config-schema.test.js`
- `test/admin/providers-api.test.js`
- `test/admin/hot-reload.test.js`

**Modify:**
- `lib/admin-router.js` — yeni endpoint'ler (provider CRUD, discover, breaker reset, probe trigger, export, import, models bulk-add/toggle, aliases bulk-update)
- `lib/providers/factory.js` — `_invalidateCache()` public + non-test signature
- `lib/store.js` — `loadProvidersConfig`/`saveProvidersConfig` zaten var; `appendAuditLog` (sadece export'taki gibi mutating endpoint'ler için satır yaz)
- `server.js` — `/admin/static/` derinliği için izin: `tabs/foo.js` ve `components/foo.js` path traversal'a karşı korumalı şekilde serve edilir
- `web/index.html` — sekme barı + slot
- `web/app.js` — tab router + session
- `web/styles.css` — sekme + form + table stilleri (~200 satır ek)
- `package.json` — `version: "0.5.0"`; test glob `test/admin/*.test.js` ekle
- `CHANGELOG.md`

**Untouched:**
- `lib/{router,model-registry,circuit-breaker,probe,rate-limit,store(load/save part),capability,sse,auth}.js`
- `lib/providers/{base,openai-compat,anthropic-native,format-conversion}.js`
- `lib/tool-engine/*` (5 dosya)
- `lib/adapters/*` (3 dosya)
- Mevcut testler

---

## Task 0: Branch setup

- [ ] **Step 1: develop'tan feat branch'i**

```bash
cd ~/Desktop/llm-bridge
git checkout develop
git pull origin develop
git rebase master
git push origin develop --force-with-lease
git checkout -b feat/04a-admin-panel
git push -u origin feat/04a-admin-panel
```

---

## Task 1: config-schema.js validation

**Files:**
- Create: `lib/providers/config-schema.js`
- Test: `test/admin/config-schema.test.js`

- [ ] **Step 1: Failing test**

`test/admin/config-schema.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProviderConfig, validateModelConfig, validateProvidersFile } from '../../lib/providers/config-schema.js';

test('validateProviderConfig: valid openai-compat passes', () => {
  const r = validateProviderConfig({
    id: 'airforce', type: 'openai-compat', base_url: 'https://api.airforce', api_key: 'sk-x',
    enabled: true, models: [],
  });
  assert.equal(r.ok, true);
});

test('validateProviderConfig: invalid id rejected', () => {
  const r = validateProviderConfig({ id: 'AirForce!', type: 'openai-compat', base_url: 'x', api_key: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.error.field, 'id');
});

test('validateProviderConfig: missing base_url rejected', () => {
  const r = validateProviderConfig({ id: 'a', type: 'openai-compat', api_key: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.error.field, 'base_url');
});

test('validateProviderConfig: bad type rejected', () => {
  const r = validateProviderConfig({ id: 'a', type: 'wat', base_url: 'x', api_key: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.error.field, 'type');
});

test('validateProviderConfig: invalid url rejected', () => {
  const r = validateProviderConfig({ id: 'a', type: 'openai-compat', base_url: 'not a url', api_key: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.error.field, 'base_url');
});

test('validateModelConfig: requires upstream_id', () => {
  assert.equal(validateModelConfig({ priority: 0 }).ok, false);
  assert.equal(validateModelConfig({ upstream_id: 'glm-4.6' }).ok, true);
});

test('validateProvidersFile: catches duplicate ids', () => {
  const r = validateProvidersFile({
    schema_version: 1,
    providers: [
      { id: 'x', type: 'openai-compat', base_url: 'a', api_key: 'k', enabled: true, models: [] },
      { id: 'x', type: 'openai-compat', base_url: 'b', api_key: 'k', enabled: true, models: [] },
    ],
    aliases: {}, global: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /duplicate/i);
});

test('validateProvidersFile: ok on healthy config', () => {
  const r = validateProvidersFile({
    schema_version: 1,
    providers: [
      { id: 'x', type: 'openai-compat', base_url: 'https://api.x', api_key: 'k', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
    ],
    aliases: {}, global: {},
  });
  assert.equal(r.ok, true);
});
```

- [ ] **Step 2: Implement**

`lib/providers/config-schema.js`:

```js
// data/providers.json + tek provider kayıtları için validation.
// OK döner: { ok: true } | { ok: false, error: { field, message } }

const SLUG_RE = /^[a-z0-9_-]+$/;
const VALID_TYPES = new Set(['openai-compat', 'anthropic-native']);

function err(field, message) { return { ok: false, error: { field, message } }; }
function ok() { return { ok: true }; }

function isValidUrl(s) {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

export function validateProviderConfig(p) {
  if (!p || typeof p !== 'object') return err('', 'provider must be object');
  if (!p.id) return err('id', 'id required');
  if (!SLUG_RE.test(p.id)) return err('id', 'id must match /^[a-z0-9_-]+$/');
  if (!p.type) return err('type', 'type required');
  if (!VALID_TYPES.has(p.type)) return err('type', `type must be one of ${[...VALID_TYPES].join(', ')}`);
  if (!p.base_url) return err('base_url', 'base_url required');
  if (!isValidUrl(p.base_url)) return err('base_url', 'base_url must be http(s) URL');
  if (!p.api_key) return err('api_key', 'api_key required');
  if (p.models != null && !Array.isArray(p.models)) return err('models', 'models must be array');
  if (Array.isArray(p.models)) {
    for (let i = 0; i < p.models.length; i++) {
      const r = validateModelConfig(p.models[i]);
      if (!r.ok) return { ok: false, error: { field: `models[${i}].${r.error.field}`, message: r.error.message } };
    }
  }
  return ok();
}

export function validateModelConfig(m) {
  if (!m || typeof m !== 'object') return err('', 'model must be object');
  if (!m.upstream_id) return err('upstream_id', 'upstream_id required');
  if (typeof m.upstream_id !== 'string') return err('upstream_id', 'upstream_id must be string');
  if (m.priority != null && typeof m.priority !== 'number') return err('priority', 'priority must be number');
  return ok();
}

export function validateProvidersFile(cfg) {
  if (!cfg || typeof cfg !== 'object') return err('', 'config must be object');
  if (cfg.schema_version !== 1) return err('schema_version', 'schema_version must be 1');
  if (!Array.isArray(cfg.providers)) return err('providers', 'providers must be array');
  const seen = new Set();
  for (let i = 0; i < cfg.providers.length; i++) {
    const p = cfg.providers[i];
    const r = validateProviderConfig(p);
    if (!r.ok) return { ok: false, error: { field: `providers[${i}].${r.error.field}`, message: r.error.message } };
    if (seen.has(p.id)) return err(`providers[${i}].id`, `duplicate id: ${p.id}`);
    seen.add(p.id);
  }
  return ok();
}
```

- [ ] **Step 3: Run + commit**

```bash
node --test test/admin/config-schema.test.js
git add lib/providers/config-schema.js test/admin/config-schema.test.js
git commit -m "feat(admin): config-schema validation (provider/model/file)"
```

Expected: 8/8 PASS.

---

## Task 2: factory.js — _invalidateCache exposed

**Files:**
- Modify: `lib/providers/factory.js`

- [ ] **Step 1: `_resetRouterForTests` adını koru ama public alias ekle**

`lib/providers/factory.js`'in sonuna:

```js
// Public: admin endpoint'lerinden mutation sonrası çağrılır.
export function invalidateRouterCache() { cachedRouter = null; }
```

- [ ] **Step 2: Tests**

```bash
npm test 2>&1 | tail -5
```

Expected: hepsi PASS (sadece export ekledik).

- [ ] **Step 3: Commit**

```bash
git add lib/providers/factory.js
git commit -m "feat(providers): expose invalidateRouterCache() for admin mutations"
```

---

## Task 3: admin-router CRUD endpoint'leri

**Files:**
- Modify: `lib/admin-router.js`
- Test: `test/admin/providers-api.test.js`

**Background:** Spec §4. Yeni endpoint'ler:
```
GET    /admin/api/providers
POST   /admin/api/providers
PUT    /admin/api/providers/:id
DELETE /admin/api/providers/:id
POST   /admin/api/providers/:id/test
POST   /admin/api/providers/:id/discover
POST   /admin/api/providers/:id/models   (bulk add)
PUT    /admin/api/providers/:id/models/:upstream
DELETE /admin/api/providers/:id/models/:upstream
POST   /admin/api/providers/:id/breaker/reset
POST   /admin/api/probe/run
GET    /admin/api/aliases
PUT    /admin/api/aliases
GET    /admin/api/export
POST   /admin/api/import
```

- [ ] **Step 1: Failing test (smoke + key endpoint'ler)**

`test/admin/providers-api.test.js`:

```js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { setDataDirForTests, resetDataDirForTests, saveProvidersConfig } from '../../lib/store.js';
import { handleAdminApi } from '../../lib/admin-router.js';
import { invalidateRouterCache } from '../../lib/providers/factory.js';

let tmpDir, server, port;

function makeReq(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: { 'authorization': 'Bearer test-admin', 'content-type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-admin-test-'));
  setDataDirForTests(tmpDir);
  invalidateRouterCache();
  process.env.ADMIN_TOKEN = 'test-admin';
  process.env.BRIDGE_API_KEYS = 'test-admin';
  // start a tiny http server that delegates to handleAdminApi
  server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/admin/api/')) await handleAdminApi(req, res, req.url.split('?')[0]);
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  saveProvidersConfig({
    schema_version: 1,
    providers: [
      { id: 'airforce', type: 'openai-compat', base_url: 'https://api.airforce', api_key: 'sk-1', enabled: true, models: [] },
    ],
    aliases: {}, global: { default_model: 'm' },
  });
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  resetDataDirForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('GET /admin/api/providers returns masked keys', async () => {
  const r = await makeReq('GET', '/admin/api/providers');
  assert.equal(r.status, 200);
  assert.equal(r.body.providers.length, 1);
  assert.equal(r.body.providers[0].api_key, '****');
  assert.equal(r.body.providers[0].api_key_last4, 'sk-1'.slice(-4));
});

test('POST /admin/api/providers creates new', async () => {
  const r = await makeReq('POST', '/admin/api/providers', {
    id: 'or', type: 'openai-compat', base_url: 'https://or.test', api_key: 'sk-or-1', enabled: true,
  });
  assert.equal(r.status, 201);
  const list = await makeReq('GET', '/admin/api/providers');
  assert.equal(list.body.providers.length, 2);
});

test('POST /admin/api/providers rejects duplicate id', async () => {
  const r = await makeReq('POST', '/admin/api/providers', {
    id: 'airforce', type: 'openai-compat', base_url: 'https://x', api_key: 'k',
  });
  assert.equal(r.status, 409);
});

test('PUT /admin/api/providers/:id updates fields (key replaced if provided)', async () => {
  const r = await makeReq('PUT', '/admin/api/providers/airforce', { label: 'AF', api_key: 'sk-new' });
  assert.equal(r.status, 200);
  const list = await makeReq('GET', '/admin/api/providers');
  assert.equal(list.body.providers[0].label, 'AF');
  assert.equal(list.body.providers[0].api_key_last4, '-new');
});

test('DELETE /admin/api/providers/:id removes', async () => {
  const r = await makeReq('DELETE', '/admin/api/providers/airforce');
  assert.equal(r.status, 200);
  const list = await makeReq('GET', '/admin/api/providers');
  assert.equal(list.body.providers.length, 0);
});

test('POST /admin/api/providers/:id/breaker/reset 200', async () => {
  const r = await makeReq('POST', '/admin/api/providers/airforce/breaker/reset', {});
  assert.equal(r.status, 200);
});

test('POST /admin/api/providers/:id/models bulk add', async () => {
  const r = await makeReq('POST', '/admin/api/providers/airforce/models', {
    models: [{ upstream_id: 'glm-4.6', priority: 0, enabled: true }, { upstream_id: 'llama', priority: 1, enabled: true }],
  });
  assert.equal(r.status, 200);
  const list = await makeReq('GET', '/admin/api/providers');
  assert.equal(list.body.providers[0].models.length, 2);
});

test('GET /admin/api/export returns full json', async () => {
  const r = await makeReq('GET', '/admin/api/export');
  assert.equal(r.status, 200);
  assert.equal(r.body.providers[0].api_key, 'sk-1');   // export includes raw keys
});

test('POST /admin/api/import overwrites config', async () => {
  const r = await makeReq('POST', '/admin/api/import', {
    schema_version: 1,
    providers: [{ id: 'newone', type: 'openai-compat', base_url: 'https://new', api_key: 'sk', enabled: true, models: [] }],
    aliases: {}, global: {},
  });
  assert.equal(r.status, 200);
  const list = await makeReq('GET', '/admin/api/providers');
  assert.equal(list.body.providers.length, 1);
  assert.equal(list.body.providers[0].id, 'newone');
});
```

- [ ] **Step 2: Implement endpoint'leri admin-router.js'e ekle**

(Mevcut `lib/admin-router.js`'i oku, sonuna yeni route'lar ekle. Her route handler:
- auth check (mevcut helper)
- body parse
- validation (config-schema.js)
- store mutation (saveProvidersConfig)
- `invalidateRouterCache()`
- response

Detaylı kod ~400 satır; mevcut helper'ları kullan, DRY tut.)

**Önemli:** key masking (`api_key_last4`), GET response'larda key tam değeri yerine `****` döndürür.

- [ ] **Step 3: Run + commit**

```bash
node --test test/admin/providers-api.test.js
npm test 2>&1 | tail -5
git add lib/admin-router.js test/admin/providers-api.test.js
git commit -m "feat(admin): provider/model CRUD + discover + breaker reset + export/import"
```

Expected: 9/9 PASS, mevcut testler hâlâ yeşil.

---

## Task 4: server.js static handler — tabs/components alt klasörler

**Files:**
- Modify: `server.js`

- [ ] **Step 1: serveStatic fonksiyonu zaten path traversal'ı engelliyor; sadece klasör derinliği için hiçbir ek değişiklik gerekmiyor.** Doğrula:

```bash
grep -A 10 "function serveStatic" server.js
```

Expected: `if (!fp.startsWith(WEB_DIR)) return notFound(res);` zaten var → tabs/, components/ kendiliğinden çalışacak.

- [ ] **Step 2: Sadece commit notu (değişiklik yoksa skip)**

Bu task no-op çıkarsa atla, Task 5'e geç.

---

## Task 5: web/index.html sekmeli yapı

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Yeniden yaz**

`web/index.html`:

```html
<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<title>llm-bridge admin</title>
<link rel="stylesheet" href="/admin/static/styles.css">
</head>
<body>
<header>
  <h1>llm-bridge</h1>
  <nav id="tabs">
    <button data-tab="providers" class="active">Providers</button>
    <button data-tab="models">Models</button>
    <button data-tab="logs">Logs</button>
  </nav>
  <div id="auth"></div>
</header>
<main id="content"></main>
<script type="module" src="/admin/static/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Manuel smoke (server start + browser açma)**

```bash
node server.js &
sleep 2
curl -s http://127.0.0.1:2399/admin | head -20
pkill -f "node server.js"
```

Expected: HTML iskelet döner.

---

## Task 6: web/app.js tab router + session

**Files:**
- Modify: `web/app.js`

`web/app.js`:

```js
// Entry: tab router + auth + tab loader.
import { initProviders } from './tabs/providers.js';
import { initModels } from './tabs/models.js';
import { initLogs } from './tabs/logs.js';

const TABS = {
  providers: initProviders,
  models: initModels,
  logs: initLogs,
};

let activeTab = 'providers';
let token = sessionStorage.getItem('llm-bridge-token') || null;

async function ensureAuth() {
  if (token) return token;
  // Mevcut /admin/api/login pattern'ı (admin-router.js'de zaten var)
  const u = prompt('Admin user'); const p = prompt('Admin pass');
  const r = await fetch('/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  const j = await r.json();
  if (!j.ok) { alert('login fail'); return null; }
  token = j.token;
  sessionStorage.setItem('llm-bridge-token', token);
  return token;
}

export async function api(method, urlPath, body) {
  const tk = await ensureAuth();
  const r = await fetch(urlPath, {
    method,
    headers: { 'authorization': `Bearer ${tk}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { sessionStorage.removeItem('llm-bridge-token'); token = null; return api(method, urlPath, body); }
  return r;
}

async function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  const root = document.getElementById('content');
  root.innerHTML = '';
  await TABS[name](root, api);
}

document.querySelectorAll('#tabs button').forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
});

switchTab('providers');
```

- [ ] **Step 2: Commit**

```bash
git add web/app.js web/index.html
git commit -m "feat(admin-ui): tabbed shell + auth + api helper"
```

---

## Task 7: web/tabs/providers.js

**Files:**
- Create: `web/tabs/providers.js`

(Provider kartları render + Add/Edit modal + delete + test connection. ~250 satır vanilla JS.)

```js
// Provider tab — listele, ekle, düzenle, sil, test et.
export async function initProviders(root, api) {
  root.innerHTML = `
    <div class="toolbar">
      <button id="add-provider">+ Add Provider</button>
    </div>
    <div id="providers-list"></div>
  `;
  document.getElementById('add-provider').addEventListener('click', () => openAddModal(api, refresh));
  await refresh();

  async function refresh() {
    const r = await api('GET', '/admin/api/providers');
    const j = await r.json();
    const list = document.getElementById('providers-list');
    list.innerHTML = '';
    for (const p of j.providers) list.appendChild(renderProviderCard(p, api, refresh));
  }
}

function renderProviderCard(p, api, refresh) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-header">
      <input type="checkbox" ${p.enabled ? 'checked' : ''} data-action="toggle">
      <strong>${escapeHtml(p.id)}</strong>
      <span class="type">${escapeHtml(p.type)}</span>
      <span class="grow"></span>
      <button data-action="test">Test</button>
      <button data-action="edit">Edit</button>
      <button data-action="delete" class="danger">Delete</button>
    </div>
    <div class="card-body">
      <div>base_url: <code>${escapeHtml(p.base_url)}</code></div>
      <div>key: <code>****${escapeHtml(p.api_key_last4 || '')}</code></div>
      <div>models: ${p.models?.length || 0}</div>
    </div>
  `;
  card.querySelector('[data-action="toggle"]').addEventListener('change', async (e) => {
    await api('PUT', `/admin/api/providers/${p.id}`, { enabled: e.target.checked });
    refresh();
  });
  card.querySelector('[data-action="test"]').addEventListener('click', async () => {
    const r = await api('POST', `/admin/api/providers/${p.id}/test`, {});
    const j = await r.json();
    alert(j.ok ? `OK ${j.latency_ms}ms` : `FAIL: ${j.error}`);
  });
  card.querySelector('[data-action="edit"]').addEventListener('click', () => openEditModal(p, api, refresh));
  card.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    if (!confirm(`Delete provider "${p.id}"?`)) return;
    await api('DELETE', `/admin/api/providers/${p.id}`);
    refresh();
  });
  return card;
}

function openAddModal(api, refresh) {
  // Plain prompt sequence for Phase 4a v1 (basit). Komponent modal v2.
  const id = prompt('Provider ID (slug)'); if (!id) return;
  const type = prompt('Type: openai-compat | anthropic-native', 'openai-compat'); if (!type) return;
  const base_url = prompt('Base URL'); if (!base_url) return;
  const api_key = prompt('API Key'); if (!api_key) return;
  api('POST', '/admin/api/providers', { id, type, base_url, api_key, enabled: true })
    .then(async (r) => {
      if (r.status === 201) refresh();
      else alert((await r.json()).error?.message || 'fail');
    });
}

function openEditModal(p, api, refresh) {
  const label = prompt('Label', p.label || ''); if (label === null) return;
  const new_key = prompt('New API key (boş bırak değiştirme)'); 
  const patch = { label };
  if (new_key) patch.api_key = new_key;
  api('PUT', `/admin/api/providers/${p.id}`, patch).then(refresh);
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
```

- [ ] **Step 2: Commit**

```bash
git add web/tabs/providers.js
git commit -m "feat(admin-ui): providers tab (list, add, edit, delete, test, toggle)"
```

---

## Task 8: web/tabs/models.js

**Files:**
- Create: `web/tabs/models.js`

(Birleşik tablo + provider başına Discover butonu + checkbox modal.)

`web/tabs/models.js`:

```js
export async function initModels(root, api) {
  root.innerHTML = `
    <div class="toolbar">
      <button id="discover-all">Discover models for…</button>
    </div>
    <table id="models-table">
      <thead>
        <tr><th>Model</th><th>Provider</th><th>Type</th><th>Native</th><th>XML</th><th>Priority</th><th>Enabled</th><th>Latency</th><th></th></tr>
      </thead>
      <tbody></tbody>
    </table>
  `;
  document.getElementById('discover-all').addEventListener('click', () => discoverPrompt(api, refresh));
  await refresh();

  async function refresh() {
    const r = await api('GET', '/admin/api/providers');
    const { providers } = await r.json();
    const cap = await api('GET', '/admin/api/capability').then(r => r.json()).catch(() => ({ models: {} }));
    const tbody = document.querySelector('#models-table tbody');
    tbody.innerHTML = '';
    for (const p of providers) {
      for (const m of (p.models || [])) {
        tbody.appendChild(renderRow(p, m, cap.models, api, refresh));
      }
    }
  }
}

async function discoverPrompt(api, refresh) {
  const list = await api('GET', '/admin/api/providers').then(r => r.json());
  const id = prompt(`Provider ID? (${list.providers.map(p => p.id).join(', ')})`);
  if (!id) return;
  const r = await api('POST', `/admin/api/providers/${id}/discover`, {});
  const j = await r.json();
  if (!j.models) { alert('Discover failed: ' + (j.error?.message || '')); return; }
  const filter = prompt(`Found ${j.models.length} models. Filter (regex, boş = hepsi):`, '') || '';
  const re = filter ? new RegExp(filter) : null;
  const filtered = re ? j.models.filter(m => re.test(m.id)) : j.models;
  const csv = prompt(`Add which? (comma-separated ids; veya "all"):\n${filtered.slice(0, 30).map(m => m.id).join('\n')}${filtered.length > 30 ? '\n...' : ''}`);
  if (!csv) return;
  const ids = csv === 'all' ? filtered.map(m => m.id) : csv.split(',').map(s => s.trim()).filter(Boolean);
  await api('POST', `/admin/api/providers/${id}/models`, {
    models: ids.map(uid => ({ upstream_id: uid, priority: 0, enabled: true })),
  });
  refresh();
}

function renderRow(p, m, capMap, api, refresh) {
  const tr = document.createElement('tr');
  const capKey = `${p.id}/${m.upstream_id}`;
  const cap = capMap?.[capKey];
  tr.innerHTML = `
    <td>${m.upstream_id}</td>
    <td>${p.id}</td>
    <td>${p.type}</td>
    <td>${cap?.native ? '✓' : ''}</td>
    <td>${cap?.xml ? '✓' : ''}</td>
    <td><input type="number" value="${m.priority || 0}" data-action="priority" style="width:50px"></td>
    <td><input type="checkbox" ${m.enabled ? 'checked' : ''} data-action="enabled"></td>
    <td>${cap?.latency_ms || ''}</td>
    <td><button data-action="del" class="danger">×</button></td>
  `;
  tr.querySelector('[data-action="priority"]').addEventListener('change', async (e) => {
    await api('PUT', `/admin/api/providers/${p.id}/models/${encodeURIComponent(m.upstream_id)}`, { priority: Number(e.target.value) });
  });
  tr.querySelector('[data-action="enabled"]').addEventListener('change', async (e) => {
    await api('PUT', `/admin/api/providers/${p.id}/models/${encodeURIComponent(m.upstream_id)}`, { enabled: e.target.checked });
  });
  tr.querySelector('[data-action="del"]').addEventListener('click', async () => {
    if (!confirm(`Remove ${m.upstream_id} from ${p.id}?`)) return;
    await api('DELETE', `/admin/api/providers/${p.id}/models/${encodeURIComponent(m.upstream_id)}`);
    refresh();
  });
  return tr;
}
```

- [ ] **Step 2: `/admin/api/capability` endpoint'i admin-router.js'de yoksa ekle**

```js
if (urlPath === '/admin/api/capability' && req.method === 'GET') {
  return send(res, 200, loadCapability());
}
```

- [ ] **Step 3: Commit**

```bash
git add web/tabs/models.js lib/admin-router.js
git commit -m "feat(admin-ui): models tab (table, discover, priority/enabled inline)"
```

---

## Task 9: web/tabs/logs.js

**Files:**
- Create: `web/tabs/logs.js`

```js
export async function initLogs(root, api) {
  root.innerHTML = `
    <div class="toolbar">
      <button id="probe-now">Run probe (all)</button>
      <button id="export-cfg">Export config</button>
      <input type="file" id="import-file" accept=".json" style="display:none">
      <button id="import-cfg">Import config…</button>
    </div>
    <h3>Circuit breakers</h3>
    <div id="breakers"></div>
    <h3>Logs</h3>
    <pre id="logs"></pre>
  `;
  document.getElementById('probe-now').addEventListener('click', async () => {
    const r = await api('POST', '/admin/api/probe/run', {});
    alert((await r.json()).ok ? 'Probe started' : 'Failed');
  });
  document.getElementById('export-cfg').addEventListener('click', async () => {
    const r = await api('GET', '/admin/api/export');
    const j = await r.json();
    const blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'providers.json'; a.click();
  });
  document.getElementById('import-cfg').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const text = await file.text();
    if (!confirm('Import overwrites current config. Continue?')) return;
    const r = await api('POST', '/admin/api/import', JSON.parse(text));
    alert(r.status === 200 ? 'Imported' : 'Fail: ' + (await r.json()).error?.message);
  });
  await refresh();
  setInterval(refresh, 5000);

  async function refresh() {
    const r = await api('GET', '/admin/api/breakers').then(r => r.json()).catch(() => ({ breakers: [] }));
    const bdiv = document.getElementById('breakers');
    bdiv.innerHTML = '';
    for (const b of r.breakers || []) {
      const row = document.createElement('div');
      row.innerHTML = `<code>${b.id}</code> [${b.state}] ${b.reason || ''} <button data-id="${b.id}">Reset</button>`;
      row.querySelector('button').addEventListener('click', async (e) => {
        await api('POST', `/admin/api/providers/${e.target.dataset.id}/breaker/reset`, {});
        refresh();
      });
      bdiv.appendChild(row);
    }
    const lr = await api('GET', '/admin/api/logs').then(r => r.json()).catch(() => ({ lines: [] }));
    document.getElementById('logs').textContent = (lr.lines || []).slice(-100).join('\n');
  }
}
```

- [ ] **Step 2: `/admin/api/breakers` endpoint'i admin-router.js'e ekle**

```js
if (urlPath === '/admin/api/breakers' && req.method === 'GET') {
  const router = await getRouter().catch(() => null);
  return send(res, 200, { breakers: router?.breakers.snapshot() || [] });
}
```

- [ ] **Step 3: Commit**

```bash
git add web/tabs/logs.js lib/admin-router.js
git commit -m "feat(admin-ui): logs tab (breakers, probe trigger, export/import)"
```

---

## Task 10: styles.css genişlet

**Files:**
- Modify: `web/styles.css`

Mevcut CSS'i koruyarak ekle:

```css
header { display: flex; align-items: center; gap: 1em; padding: 0.5em 1em; border-bottom: 1px solid #333; }
header h1 { margin: 0; font-size: 1.2em; }
nav#tabs { display: flex; gap: 0.5em; }
nav#tabs button { background: transparent; color: inherit; border: 1px solid transparent; padding: 0.4em 1em; cursor: pointer; }
nav#tabs button.active { border-color: #555; background: #1a1a1a; }
.toolbar { padding: 0.5em 0; display: flex; gap: 0.5em; }
.card { background: #1a1a1a; border: 1px solid #333; margin: 0.5em 0; padding: 0.5em; }
.card-header { display: flex; align-items: center; gap: 0.5em; }
.card-header .grow { flex: 1; }
.card-header .type { font-size: 0.85em; color: #888; padding: 0 0.5em; border: 1px solid #444; border-radius: 3px; }
.card-body { margin-top: 0.5em; font-size: 0.9em; color: #aaa; }
button.danger { color: #f55; }
table { width: 100%; border-collapse: collapse; }
table th, table td { padding: 0.3em 0.5em; border-bottom: 1px solid #222; text-align: left; }
table th { color: #888; font-weight: normal; }
pre#logs { background: #0a0a0a; padding: 1em; max-height: 50vh; overflow: auto; }
```

- [ ] **Commit**

```bash
git add web/styles.css
git commit -m "feat(admin-ui): tab + card + table styles"
```

---

## Task 11: Hot-reload integration test

**Files:**
- Create: `test/admin/hot-reload.test.js`

```js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setDataDirForTests, resetDataDirForTests, saveProvidersConfig } from '../../lib/store.js';
import { getRouter, invalidateRouterCache } from '../../lib/providers/factory.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-hot-'));
  setDataDirForTests(tmpDir);
  invalidateRouterCache();
});

afterEach(() => {
  invalidateRouterCache();
  resetDataDirForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('mutation + invalidateRouterCache → next getRouter sees new state', async () => {
  saveProvidersConfig({
    schema_version: 1,
    providers: [{ id: 'a', type: 'openai-compat', base_url: 'https://a.x', api_key: 'k1', enabled: true, models: [] }],
    aliases: {}, global: {},
  });
  const r1 = await getRouter();
  assert.equal(r1.registry.providers.size, 1);

  saveProvidersConfig({
    schema_version: 1,
    providers: [
      { id: 'a', type: 'openai-compat', base_url: 'https://a.x', api_key: 'k1', enabled: true, models: [] },
      { id: 'b', type: 'openai-compat', base_url: 'https://b.x', api_key: 'k2', enabled: true, models: [] },
    ],
    aliases: {}, global: {},
  });
  // henüz invalidate yok — eski instance dönmeli
  const r2 = await getRouter();
  assert.equal(r2, r1);

  invalidateRouterCache();
  const r3 = await getRouter();
  assert.equal(r3.registry.providers.size, 2);
});
```

- [ ] **Run + commit**

```bash
node --test test/admin/hot-reload.test.js
git add test/admin/hot-reload.test.js
git commit -m "test(admin): hot-reload integration"
```

---

## Task 12: package.json + CHANGELOG + smoke

- [ ] **package.json:**

```json
"version": "0.5.0",
"test": "node --test test/*.test.js test/providers/*.test.js test/integration/*.test.js test/admin/*.test.js"
```

- [ ] **CHANGELOG entry:**

```markdown
## [0.5.0] — Phase 4a: Admin Panel Core

- 3 sekmeli admin panel (Providers/Models/Logs)
- Provider CRUD + test connection + auto-discover
- Models birleşik tablo + inline priority/enabled edit
- Breaker durumu + reset + manual probe trigger
- Export/import providers.json
- Hot-reload: mutation sonrası router cache invalidate
- `lib/providers/config-schema.js` validation
- `lib/admin-router.js` ~15 yeni endpoint
- 18 yeni test (config-schema 8 + providers-api 9 + hot-reload 1)
```

- [ ] **Lokal smoke**:

```bash
rm -f data/providers.json
(node server.js > /tmp/p4a-smoke.log 2>&1 &) && sleep 3
echo '--- panel HTML ---'
curl -s http://127.0.0.1:2399/admin | head -10
echo '--- providers list ---'
curl -s http://127.0.0.1:2399/admin/api/providers -H "Authorization: Bearer test-key"
pkill -f "node server.js"
rm -f /tmp/p4a-smoke.log
```

- [ ] **Commit**:

```bash
git add package.json CHANGELOG.md
git commit -m "docs: changelog phase 4a; version 0.5.0"
```

---

## Task 13: PR + tag v0.5.0-phase4a

- [ ] Push, PR feat→develop, merge, develop→master, tag.

```bash
git push origin feat/04a-admin-panel
gh pr create --repo NeronSignal/llm-bridge --base develop --head feat/04a-admin-panel \
  --title "Phase 4a: Admin Panel Core" \
  --body "Tabs (Providers/Models/Logs) + CRUD + discover + breaker reset + probe trigger + export/import + hot-reload. 18 new tests."
gh pr merge --repo NeronSignal/llm-bridge --squash --delete-branch
git checkout develop
git pull origin develop
gh pr create --repo NeronSignal/llm-bridge --base master --head develop \
  --title "Release: phase 4a (admin panel core)" --body "Phase 4a merged."
gh pr merge --repo NeronSignal/llm-bridge --squash
git checkout master
git pull origin master
git tag v0.5.0-phase4a
git push origin v0.5.0-phase4a
```

---

## Self-Review

**Spec coverage:**
- §3 UI architecture: Task 5-10 ✓
- §4 Endpoints: Task 3 ✓
- §5 Hot-reload: Task 2 + Task 11 ✓
- §6 Validation: Task 1 ✓
- §7 Frontend structure: Task 5-10 ✓
- §8 Testing: Task 1, 3, 11 ✓
- §10 DoD: Task 12 (smoke + CHANGELOG)

**Placeholder scan:** "TBD"/"TODO" yok.

**Type consistency:**
- `validateProviderConfig(p) → {ok, error?}` — Task 1, 3 tutarlı
- `api(method, urlPath, body) → Response` — Task 6, 7, 8, 9 tutarlı
- `invalidateRouterCache()` ad — Task 2, 3, 11 tutarlı

**Risks:**
- Task 7'de prompt() kullanımı v1 için basit; modal v2'de eklenir (kullanıcı "basit" dedi).
- Hot-reload'da in-flight istekler eski instance'ı kullanır (referans tutuldu) — bu istenen davranış; race yok.
- Discover endpoint büyük listeler dönerse (200+ model) UI textarea prompt'u çirkin görünür; yine de v1 kabul.
