# Phase 2 — Router & Model Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faz 1'in provider abstraction'ı üzerine **çoklu provider** routing'i kur: `CircuitBreaker`, `ModelRegistry`, `Router.execute()`. `data/providers.json` schema'sı (ilk açılışta `.env` → JSON migration) + per-provider rate-limit. OpenAI istemcisi (`/v1/chat/completions`) router üzerinden çalışacak; aynı modeli birden fazla provider sunarsa priority + automatic fallback.

**Architecture:** Yeni dosyalar: `lib/circuit-breaker.js`, `lib/model-registry.js`, `lib/router.js`. `lib/store.js` `data/providers.json` okuma/yazma + migration ekleniyor. `lib/providers/factory.js` `getRouter()` ekliyor (tek-provider yerine). `lib/rate-limit.js` Map<providerId, Bucket>'a geçiyor. Adapter'lar (`adapters/openai.js`, `adapters/models.js`, `lib/probe.js`) registry/router üzerinden çalışıyor. Tool-engine modülleri **dokunulmaz**.

**Anthropic adapter (Faz 2 kapsamı dışı):** `lib/adapters/anthropic.js` Faz 2'de mevcut `provider.request('POST', '/v1/messages', body)` köprüsünü tutmaya devam eder; tek-airforce varsayımıyla yaşar. Faz 3'te `AnthropicNativeProvider` ile değişecek.

**Tech Stack:** Node.js >=20, ES modules, native `fetch` + `node:test`, no external deps.

---

## File Structure

**Create:**
- `lib/circuit-breaker.js` — `CircuitBreaker` class + `CircuitBreakerRegistry` (provider id'ye göre)
- `lib/model-registry.js` — `ModelRegistry` (resolve/index/markUnavailable)
- `lib/router.js` — `Router.execute(modelId, body, opts)` + custom error sınıfları (`ModelNotFoundError`, `AllProvidersFailedError`)
- `test/circuit-breaker.test.js`
- `test/model-registry.test.js`
- `test/router.test.js`
- `test/store.test.js` — atomic write + migration testi
- `test/integration/e2e-fallback.test.js` — mock provider'larla fallback E2E

**Modify:**
- `lib/store.js` — `loadProvidersConfig()`, `saveProvidersConfig()`, migration helper (`maybeMigrateLegacyEnv()`)
- `lib/providers/factory.js` — `getRouter()` async (cached); `_resetForTests()`
- `lib/rate-limit.js` — Map<providerId, Bucket>; `getBucket(providerId)`
- `lib/adapters/openai.js` — `provider.chat()` çağrısı yerine `router.execute(modelId, body)`
- `lib/adapters/models.js` — registry'den birleşik model listesi
- `lib/probe.js` — registry'deki tüm `(provider, model)` çiftlerini gez
- `lib/capability.js` — snapshot key formatı `${providerId}/${modelId}`'ye geçer; geriye uyumlu okuma
- `package.json` — `test` script'i `test/integration/*.test.js` ekle; `version: 0.3.0`
- `CHANGELOG.md` — Phase 2 entry

**Untouched:**
- `lib/tool-engine/*` (5 dosya)
- `lib/adapters/anthropic.js` (Faz 3'te değişir)
- `lib/auth.js`, `lib/admin-router.js`, `lib/sse.js`, `lib/logger.js`, `lib/config.js`, `lib/scheduler.js`, `lib/util.js`, `lib/tier.js`, `server.js`
- `web/*`
- Mevcut testler (parse, inject, serialize-history, tier, providers/*)

---

## Task 0: Branch setup

**Files:** _(none — git only)_

- [ ] **Step 1: develop'tan feat branch'i aç**

```bash
cd ~/Desktop/llm-bridge
git checkout develop
git pull origin develop
git checkout -b feat/02-router-registry
git push -u origin feat/02-router-registry
```

- [ ] **Step 2: Doğrula**

```bash
git status
git log --oneline -3
```

Expected: clean working tree; HEAD'de develop'ın son commit'i (Phase 1 squash).

---

## Task 1: CircuitBreaker

**Files:**
- Create: `lib/circuit-breaker.js`
- Test: `test/circuit-breaker.test.js`

**Background:** Spec §5.4 — provider başına ayrı breaker; 10s pencere içinde 3 ardışık transient failure → `open`, 60s sonra `half-open`. `tripUntil(ts)` manuel açık (auth hatası). Reset için `reset()`.

- [ ] **Step 1: Failing test yaz**

`test/circuit-breaker.test.js`:

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../lib/circuit-breaker.js';

let breaker;

beforeEach(() => {
  breaker = new CircuitBreaker('test', { failThreshold: 3, openSeconds: 60, windowSeconds: 10 });
});

test('starts closed', () => {
  assert.equal(breaker.isOpen(), false);
  assert.equal(breaker.state, 'closed');
});

test('opens after fail threshold consecutive transient failures', () => {
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.isOpen(), false);
  breaker.recordFailure();
  assert.equal(breaker.isOpen(), true);
  assert.equal(breaker.state, 'open');
});

test('successes within window reset failure count', () => {
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordSuccess();
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.isOpen(), false);
});

test('failures outside window do not accumulate', () => {
  const now = { t: 0 };
  const b = new CircuitBreaker('t2', {
    failThreshold: 3, openSeconds: 60, windowSeconds: 10,
    now: () => now.t,
  });
  b.recordFailure(); b.recordFailure();
  now.t = 11_000;
  b.recordFailure();
  assert.equal(b.isOpen(), false);
});

test('open transitions to half-open after openSeconds', () => {
  const now = { t: 0 };
  const b = new CircuitBreaker('t3', {
    failThreshold: 3, openSeconds: 60, windowSeconds: 10,
    now: () => now.t,
  });
  b.recordFailure(); b.recordFailure(); b.recordFailure();
  assert.equal(b.state, 'open');
  now.t = 60_001;
  assert.equal(b.isOpen(), false);
  assert.equal(b.state, 'half-open');
});

test('half-open success closes; failure reopens', () => {
  const now = { t: 0 };
  const b = new CircuitBreaker('t4', {
    failThreshold: 3, openSeconds: 60, windowSeconds: 10,
    now: () => now.t,
  });
  b.recordFailure(); b.recordFailure(); b.recordFailure();
  now.t = 60_001;
  void b.isOpen();
  assert.equal(b.state, 'half-open');
  b.recordSuccess();
  assert.equal(b.state, 'closed');

  b.recordFailure(); b.recordFailure(); b.recordFailure();
  now.t = 120_002;
  void b.isOpen();
  b.recordFailure();
  assert.equal(b.state, 'open');
});

test('tripUntil opens until given timestamp', () => {
  const now = { t: 0 };
  const b = new CircuitBreaker('t5', {
    failThreshold: 3, openSeconds: 60, windowSeconds: 10,
    now: () => now.t,
  });
  b.tripUntil(5_000_000, 'auth error');
  assert.equal(b.isOpen(), true);
  assert.equal(b.reason, 'auth error');
  now.t = 5_000_001;
  assert.equal(b.isOpen(), false);
});

test('reset() forces closed and clears counters', () => {
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.state, 'open');
  breaker.reset();
  assert.equal(breaker.state, 'closed');
  assert.equal(breaker.isOpen(), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Desktop/llm-bridge
node --test test/circuit-breaker.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`lib/circuit-breaker.js`:

```js
// Provider başına failure window + open/half-open/closed state machine.
// Usage:
//   const b = new CircuitBreaker('airforce', { failThreshold: 3, openSeconds: 60, windowSeconds: 10 });
//   if (b.isOpen()) skip;
//   try { await provider.chat(...); b.recordSuccess(); }
//   catch (err) { b.recordFailure(); throw; }

const DEFAULTS = {
  failThreshold: 3,
  openSeconds: 60,
  windowSeconds: 10,
};

export class CircuitBreaker {
  constructor(id, opts = {}) {
    this.id = id;
    this.failThreshold = opts.failThreshold ?? DEFAULTS.failThreshold;
    this.openSeconds = opts.openSeconds ?? DEFAULTS.openSeconds;
    this.windowSeconds = opts.windowSeconds ?? DEFAULTS.windowSeconds;
    this._now = opts.now || (() => Date.now());

    this.state = 'closed';
    this.failures = [];   // timestamps
    this.openedAt = null;
    this.openUntil = null;
    this.reason = null;
  }

  // External: bu noktada open mı? Side-effect: openSeconds geçmişse state'i half-open'a taşı.
  isOpen() {
    const now = this._now();
    if (this.state === 'open') {
      const limit = this.openUntil ?? (this.openedAt + this.openSeconds * 1000);
      if (now >= limit) {
        this.state = 'half-open';
        this.failures = [];
        return false;
      }
      return true;
    }
    return false;
  }

  recordFailure() {
    const now = this._now();
    if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAt = now;
      this.openUntil = null;
      this.reason = 'half-open probe failed';
      this.failures = [];
      return;
    }
    // Window dışındaki failure'ları at.
    const cutoff = now - this.windowSeconds * 1000;
    this.failures = this.failures.filter((t) => t >= cutoff);
    this.failures.push(now);
    if (this.failures.length >= this.failThreshold) {
      this.state = 'open';
      this.openedAt = now;
      this.openUntil = null;
      this.reason = `${this.failures.length} failures in ${this.windowSeconds}s`;
      this.failures = [];
    }
  }

  recordSuccess() {
    if (this.state === 'half-open') {
      this.state = 'closed';
      this.failures = [];
      this.reason = null;
      return;
    }
    this.failures = [];
  }

  // External (auth / quota): belirli bir timestamp'e kadar zorla open.
  tripUntil(timestamp, reason = 'tripped') {
    this.state = 'open';
    this.openedAt = this._now();
    this.openUntil = timestamp;
    this.reason = reason;
    this.failures = [];
  }

  reset() {
    this.state = 'closed';
    this.failures = [];
    this.openedAt = null;
    this.openUntil = null;
    this.reason = null;
  }

  snapshot() {
    return {
      id: this.id,
      state: this.state,
      failures: this.failures.length,
      reason: this.reason,
      open_until: this.openUntil,
    };
  }
}

// Provider id'lerine göre breaker registry'si.
export class CircuitBreakerRegistry {
  constructor(opts = {}) {
    this.opts = opts;
    this._map = new Map();
  }

  get(providerId) {
    if (!this._map.has(providerId)) {
      this._map.set(providerId, new CircuitBreaker(providerId, this.opts));
    }
    return this._map.get(providerId);
  }

  reset(providerId) {
    const b = this._map.get(providerId);
    if (b) b.reset();
  }

  snapshot() {
    return Array.from(this._map.values()).map((b) => b.snapshot());
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/circuit-breaker.test.js
```

Expected: 8/8 PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/circuit-breaker.js test/circuit-breaker.test.js
git commit -m "feat(router): CircuitBreaker + CircuitBreakerRegistry"
```

---

## Task 2: store.js — providers.json schema + migration

**Files:**
- Modify: `lib/store.js`
- Test: `test/store.test.js`

**Background:** Spec §6.1, §6.2, §10. `data/providers.json` admin panel + boot tarafından yazılır. Atomic write (temp + rename). İlk açılışta `data/providers.json` yoksa ve `.env`'de `AIRFORCE_API_KEY` varsa → otomatik tek-provider config'e migrate.

- [ ] **Step 1: Failing test yaz**

`test/store.test.js`:

```js
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadProvidersConfig,
  saveProvidersConfig,
  maybeMigrateLegacyEnv,
  setDataDirForTests,
  resetDataDirForTests,
} from '../lib/store.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-bridge-test-'));
  setDataDirForTests(tmpDir);
});

afterEach(() => {
  resetDataDirForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('loadProvidersConfig returns null when file missing', () => {
  assert.equal(loadProvidersConfig(), null);
});

test('saveProvidersConfig writes mode 600 atomic', () => {
  const cfg = {
    schema_version: 1,
    providers: [{ id: 'a', label: 'A', type: 'openai-compat', base_url: 'x', api_key: 'k', enabled: true, models: [] }],
    aliases: {},
    global: { default_model: 'a' },
  };
  saveProvidersConfig(cfg);
  const p = path.join(tmpDir, 'providers.json');
  assert.ok(fs.existsSync(p));
  const stat = fs.statSync(p);
  assert.equal(stat.mode & 0o777, 0o600);
  const out = loadProvidersConfig();
  assert.deepEqual(out, cfg);
});

test('saveProvidersConfig is atomic (no .tmp left over)', () => {
  saveProvidersConfig({
    schema_version: 1, providers: [], aliases: {}, global: { default_model: 'x' },
  });
  const tmp = path.join(tmpDir, 'providers.json.tmp');
  assert.equal(fs.existsSync(tmp), false);
});

test('maybeMigrateLegacyEnv writes single-provider config from env', () => {
  const env = {
    AIRFORCE_API_KEY: 'sk-air-test',
    UPSTREAM_BASE_URL: 'https://api.airforce',
    RATE_LIMIT_MULT_PER_MIN: '15',
  };
  const migrated = maybeMigrateLegacyEnv(env);
  assert.equal(migrated, true);
  const cfg = loadProvidersConfig();
  assert.equal(cfg.schema_version, 1);
  assert.equal(cfg.providers.length, 1);
  const p = cfg.providers[0];
  assert.equal(p.id, 'airforce');
  assert.equal(p.type, 'openai-compat');
  assert.equal(p.base_url, 'https://api.airforce');
  assert.equal(p.api_key, 'sk-air-test');
  assert.equal(p.enabled, true);
  assert.equal(p.rate_limit.mult_per_min, 15);
  assert.deepEqual(p.models, []);
});

test('maybeMigrateLegacyEnv is no-op when providers.json exists', () => {
  saveProvidersConfig({
    schema_version: 1,
    providers: [{ id: 'manual', type: 'openai-compat', base_url: 'x', api_key: 'k', enabled: true, models: [] }],
    aliases: {}, global: { default_model: 'manual' },
  });
  const migrated = maybeMigrateLegacyEnv({ AIRFORCE_API_KEY: 'sk-air-other' });
  assert.equal(migrated, false);
  assert.equal(loadProvidersConfig().providers[0].id, 'manual');
});

test('maybeMigrateLegacyEnv is no-op when env has no key', () => {
  const migrated = maybeMigrateLegacyEnv({});
  assert.equal(migrated, false);
  assert.equal(loadProvidersConfig(), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/store.test.js
```

Expected: FAIL — exports `loadProvidersConfig`/`saveProvidersConfig`/`maybeMigrateLegacyEnv`/`setDataDirForTests`/`resetDataDirForTests` not present.

- [ ] **Step 3: Implement**

`lib/store.js` dosyasının sonuna ekle:

```js
// --- Providers config (Phase 2) ---

const PROVIDERS_FILE = 'providers.json';

let _dataDirOverride = null;

export function setDataDirForTests(dir) {
  _dataDirOverride = dir;
}

export function resetDataDirForTests() {
  _dataDirOverride = null;
}

function providersPath() {
  return _dataDirOverride
    ? path.join(_dataDirOverride, PROVIDERS_FILE)
    : pathOf(PROVIDERS_FILE);
}

export function loadProvidersConfig() {
  const p = providersPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    log.warn(`store: providers.json parse hatası`, { err: err.message });
    return null;
  }
}

export function saveProvidersConfig(cfg) {
  const p = providersPath();
  const tmp = p + '.tmp';
  // Ensure dir exists
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
  // chmod again in case umask interfered
  fs.chmodSync(p, 0o600);
}

export function maybeMigrateLegacyEnv(env = process.env) {
  if (loadProvidersConfig()) return false;
  if (!env.AIRFORCE_API_KEY) return false;
  const cfg = {
    schema_version: 1,
    providers: [{
      id: 'airforce',
      label: 'api.airforce',
      type: 'openai-compat',
      base_url: env.UPSTREAM_BASE_URL || 'https://api.airforce',
      api_key: env.AIRFORCE_API_KEY,
      headers: {},
      timeout_ms: Number(env.UPSTREAM_TIMEOUT_MS) || 180000,
      enabled: true,
      rate_limit: { mult_per_min: Number(env.RATE_LIMIT_MULT_PER_MIN) || 10 },
      models: [],
    }],
    aliases: {},
    global: {
      default_model: env.DEFAULT_MODEL || 'glm-4.6',
      circuit_breaker: { fail_threshold: 3, open_seconds: 60 },
    },
  };
  saveProvidersConfig(cfg);
  log.info('migrated AIRFORCE_API_KEY → data/providers.json');
  return true;
}
```

**NOT:** Mevcut `loadCapability`/`saveCapability`/`loadKeys`/`saveKeys` fonksiyonları aynı kalır.

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/store.test.js
```

Expected: 6/6 PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/store.js test/store.test.js
git commit -m "feat(store): providers.json schema + .env migration"
```

---

## Task 3: ModelRegistry

**Files:**
- Create: `lib/model-registry.js`
- Test: `test/model-registry.test.js`

**Background:** Spec §5.1, §5.2 — model adı → ProviderEntry[] çözümü; kısa ad / prefix / alias; `markModelUnavailable`.

- [ ] **Step 1: Failing test yaz**

`test/model-registry.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry, ModelNotFoundError } from '../lib/model-registry.js';

function fakeProvider(id) { return { id, chat: async () => ({}) }; }

function buildRegistry() {
  const cfg = {
    schema_version: 1,
    providers: [
      {
        id: 'airforce', type: 'openai-compat', base_url: 'x', api_key: 'k', enabled: true,
        models: [
          { upstream_id: 'glm-4.6', priority: 0, enabled: true },
          { upstream_id: 'llama-4-scout', priority: 0, enabled: true },
        ],
      },
      {
        id: 'openrouter', type: 'openai-compat', base_url: 'y', api_key: 'k2', enabled: true,
        models: [
          { upstream_id: 'z-ai/glm-4.6', priority: 1, enabled: true, presented_id: 'glm-4.6' },
          { upstream_id: 'anthropic/claude-sonnet-4', priority: 1, enabled: true },
        ],
      },
    ],
    aliases: { 'glm-fast': 'glm-4.6' },
    global: { default_model: 'glm-4.6' },
  };
  const reg = new ModelRegistry();
  reg.load(cfg, {
    airforce: fakeProvider('airforce'),
    openrouter: fakeProvider('openrouter'),
  });
  return reg;
}

test('resolve: short id returns priority-ordered entries', () => {
  const reg = buildRegistry();
  const entries = reg.resolve('glm-4.6');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].providerId, 'airforce');
  assert.equal(entries[0].upstreamModelId, 'glm-4.6');
  assert.equal(entries[1].providerId, 'openrouter');
  assert.equal(entries[1].upstreamModelId, 'z-ai/glm-4.6');
});

test('resolve: prefix id returns single provider, no fallback', () => {
  const reg = buildRegistry();
  const entries = reg.resolve('openrouter/z-ai/glm-4.6');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].providerId, 'openrouter');
  assert.equal(entries[0].upstreamModelId, 'z-ai/glm-4.6');
});

test('resolve: alias resolves to target model', () => {
  const reg = buildRegistry();
  const entries = reg.resolve('glm-fast');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].providerId, 'airforce');
});

test('resolve: short id without prefix uses last segment for slashed upstream', () => {
  const reg = buildRegistry();
  const entries = reg.resolve('claude-sonnet-4');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].providerId, 'openrouter');
  assert.equal(entries[0].upstreamModelId, 'anthropic/claude-sonnet-4');
});

test('resolve: unknown model throws ModelNotFoundError', () => {
  const reg = buildRegistry();
  assert.throws(() => reg.resolve('nonexistent'), ModelNotFoundError);
});

test('resolve: presented_id override wins over slash-derived short id', () => {
  // Üstte openrouter z-ai/glm-4.6 → presented_id 'glm-4.6' override; çalışıyor mu?
  const reg = buildRegistry();
  const entries = reg.resolve('glm-4.6');
  // İki entry: airforce/glm-4.6 (priority 0) + openrouter/z-ai/glm-4.6 (priority 1, presented as glm-4.6)
  assert.equal(entries.length, 2);
});

test('markModelUnavailable disables the entry from future resolves', () => {
  const reg = buildRegistry();
  const before = reg.resolve('glm-4.6');
  assert.equal(before.length, 2);
  reg.markModelUnavailable(before[0]);
  const after = reg.resolve('glm-4.6');
  assert.equal(after.length, 1);
  assert.equal(after[0].providerId, 'openrouter');
});

test('listAllModels returns flat catalog with presented_id, provider, priority', () => {
  const reg = buildRegistry();
  const all = reg.listAllModels();
  // 2 (airforce) + 2 (openrouter) = 4
  assert.equal(all.length, 4);
  const presentedIds = new Set(all.map((m) => m.presented_id));
  assert.ok(presentedIds.has('glm-4.6'));
  assert.ok(presentedIds.has('claude-sonnet-4'));
});

test('disabled provider entries are filtered out of resolves', () => {
  const cfg = {
    schema_version: 1,
    providers: [
      {
        id: 'airforce', type: 'openai-compat', base_url: 'x', api_key: 'k', enabled: false,
        models: [{ upstream_id: 'glm-4.6', priority: 0, enabled: true }],
      },
      {
        id: 'openrouter', type: 'openai-compat', base_url: 'y', api_key: 'k2', enabled: true,
        models: [{ upstream_id: 'z-ai/glm-4.6', priority: 1, enabled: true, presented_id: 'glm-4.6' }],
      },
    ],
    aliases: {}, global: { default_model: 'glm-4.6' },
  };
  const reg = new ModelRegistry();
  reg.load(cfg, {
    airforce: fakeProvider('airforce'),
    openrouter: fakeProvider('openrouter'),
  });
  const entries = reg.resolve('glm-4.6');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].providerId, 'openrouter');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/model-registry.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`lib/model-registry.js`:

```js
// Model adı → provider entry[] çözümü.
// Kısa ad: priority-ordered, fallback'li liste.
// Prefix'li ad (provider/model): tek provider, fallback yok.
// Alias: hedef adı tek adımda çözer.

export class ModelNotFoundError extends Error {
  constructor(modelId) {
    super(`model not found: ${modelId}`);
    this.name = 'ModelNotFoundError';
    this.modelId = modelId;
    this.status = 404;
  }
}

function shortIdOf(entry) {
  if (entry.presented_id) return entry.presented_id;
  const u = entry.upstream_id;
  if (u.includes('/')) return u.split('/').pop();
  return u;
}

export class ModelRegistry {
  constructor() {
    this.providers = new Map();   // id → ProviderInstance
    this._byShort = new Map();    // shortId → ProviderEntry[]
    this._byKey = new Map();      // `${providerId}/${upstream}` → ProviderEntry
    this.aliases = new Map();     // aliasId → targetId
  }

  load(providersCfg, providerInstances) {
    this.providers = new Map(Object.entries(providerInstances));
    this._byShort = new Map();
    this._byKey = new Map();
    this.aliases = new Map(Object.entries(providersCfg.aliases || {}));

    for (const p of providersCfg.providers || []) {
      if (!p.enabled) continue;
      for (const m of p.models || []) {
        if (!m.enabled) continue;
        const entry = {
          providerId: p.id,
          upstreamModelId: m.upstream_id,
          priority: Number(m.priority) || 0,
          enabled: true,
          presented_id: m.presented_id,
          lastUsedAt: 0,
          _runtimeUnavailable: false,
        };
        const key = `${p.id}/${m.upstream_id}`;
        this._byKey.set(key, entry);
        const shortId = shortIdOf(m);
        if (!this._byShort.has(shortId)) this._byShort.set(shortId, []);
        this._byShort.get(shortId).push(entry);
      }
    }
    // Sort each short-id bucket by priority asc, then lastUsedAt asc.
    for (const arr of this._byShort.values()) {
      arr.sort((a, b) => a.priority - b.priority || a.lastUsedAt - b.lastUsedAt);
    }
  }

  resolve(modelId) {
    if (!modelId) throw new ModelNotFoundError(modelId || '<empty>');

    // 1) alias
    if (this.aliases.has(modelId)) {
      const target = this.aliases.get(modelId);
      return this.resolve(target);
    }

    // 2) prefix `provider/upstream/...` — bridge providers'tan biriyle başlıyor mu?
    for (const pid of this.providers.keys()) {
      const prefix = pid + '/';
      if (modelId.startsWith(prefix)) {
        const upstreamId = modelId.slice(prefix.length);
        const key = `${pid}/${upstreamId}`;
        const entry = this._byKey.get(key);
        if (entry && entry.enabled && !entry._runtimeUnavailable) return [entry];
        throw new ModelNotFoundError(modelId);
      }
    }

    // 3) short id
    const arr = this._byShort.get(modelId);
    if (arr && arr.length) {
      const live = arr.filter((e) => e.enabled && !e._runtimeUnavailable);
      if (live.length) return live;
    }

    throw new ModelNotFoundError(modelId);
  }

  markModelUnavailable(entry) {
    if (!entry) return;
    entry._runtimeUnavailable = true;
  }

  resetUnavailable() {
    for (const e of this._byKey.values()) e._runtimeUnavailable = false;
  }

  listAllModels() {
    const out = [];
    for (const [key, entry] of this._byKey.entries()) {
      const shortId = (() => {
        if (entry.presented_id) return entry.presented_id;
        const [, ...rest] = key.split('/');
        const upstream = rest.join('/');
        return upstream.includes('/') ? upstream.split('/').pop() : upstream;
      })();
      out.push({
        provider_id: entry.providerId,
        upstream_id: entry.upstreamModelId,
        presented_id: shortId,
        priority: entry.priority,
        enabled: entry.enabled && !entry._runtimeUnavailable,
      });
    }
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/model-registry.test.js
```

Expected: 9/9 PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/model-registry.js test/model-registry.test.js
git commit -m "feat(router): ModelRegistry with prefix/alias/short-id resolution"
```

---

## Task 4: Router

**Files:**
- Create: `lib/router.js`
- Test: `test/router.test.js`

**Background:** Spec §5.3 — `Router.execute(modelId, body, opts)`. Provider listesini gez; transient/auth/bad_model'da fallback; client'ta fatal.

- [ ] **Step 1: Failing test yaz**

`test/router.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router, AllProvidersFailedError } from '../lib/router.js';
import { ProviderError } from '../lib/providers/base.js';
import { ModelRegistry, ModelNotFoundError } from '../lib/model-registry.js';
import { CircuitBreakerRegistry } from '../lib/circuit-breaker.js';

function makeProvider(id, behavior) {
  // behavior is array of responses (in order); each is either a return value or a thrown ProviderError
  let i = 0;
  return {
    id,
    chat: async (body) => {
      const next = behavior[i++] || behavior[behavior.length - 1];
      if (next instanceof Error) throw next;
      return { text: next, usage: {}, finish_reason: 'stop', raw: { id: 'r', choices: [] } };
    },
  };
}

function buildRouter(providers, registryConfig) {
  const reg = new ModelRegistry();
  reg.load(registryConfig, providers);
  const breakers = new CircuitBreakerRegistry();
  return new Router(reg, breakers);
}

test('execute() returns first provider success', async () => {
  const providers = {
    a: makeProvider('a', ['hello-from-a']),
    b: makeProvider('b', ['hello-from-b']),
  };
  const cfg = {
    providers: [
      { id: 'a', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
      { id: 'b', enabled: true, models: [{ upstream_id: 'm', priority: 1, enabled: true }] },
    ],
    aliases: {}, global: {},
  };
  const router = buildRouter(providers, cfg);
  const out = await router.execute('m', { model: 'm', messages: [] });
  assert.equal(out.providerId, 'a');
  assert.equal(out.result.text, 'hello-from-a');
});

test('execute() falls over on transient and uses next provider', async () => {
  const providers = {
    a: makeProvider('a', [new ProviderError('boom', { status: 502, category: 'transient' })]),
    b: makeProvider('b', ['rescued']),
  };
  const cfg = {
    providers: [
      { id: 'a', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
      { id: 'b', enabled: true, models: [{ upstream_id: 'm', priority: 1, enabled: true }] },
    ],
    aliases: {}, global: {},
  };
  const router = buildRouter(providers, cfg);
  const out = await router.execute('m', { model: 'm', messages: [] });
  assert.equal(out.providerId, 'b');
  assert.equal(out.result.text, 'rescued');
});

test('execute() trips breaker on auth and falls over', async () => {
  const providers = {
    a: makeProvider('a', [new ProviderError('no key', { status: 401, category: 'auth' })]),
    b: makeProvider('b', ['ok-from-b']),
  };
  const cfg = {
    providers: [
      { id: 'a', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
      { id: 'b', enabled: true, models: [{ upstream_id: 'm', priority: 1, enabled: true }] },
    ],
    aliases: {}, global: {},
  };
  const router = buildRouter(providers, cfg);
  const out = await router.execute('m', { model: 'm', messages: [] });
  assert.equal(out.providerId, 'b');
  assert.equal(router.breakers.get('a').isOpen(), true);
});

test('execute() marks bad_model entry unavailable and falls over', async () => {
  const providers = {
    a: makeProvider('a', [new ProviderError('no model', { status: 404, category: 'bad_model' })]),
    b: makeProvider('b', ['ok-from-b']),
  };
  const cfg = {
    providers: [
      { id: 'a', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
      { id: 'b', enabled: true, models: [{ upstream_id: 'm', priority: 1, enabled: true }] },
    ],
    aliases: {}, global: {},
  };
  const router = buildRouter(providers, cfg);
  const out = await router.execute('m', { model: 'm', messages: [] });
  assert.equal(out.providerId, 'b');
  // Yeni resolve'ta a artık görünmemeli
  const entries = router.registry.resolve('m');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].providerId, 'b');
});

test('execute() rethrows client error fatally (no fallback)', async () => {
  const providers = {
    a: makeProvider('a', [new ProviderError('bad request', { status: 400, category: 'client' })]),
    b: makeProvider('b', ['unreached']),
  };
  const cfg = {
    providers: [
      { id: 'a', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
      { id: 'b', enabled: true, models: [{ upstream_id: 'm', priority: 1, enabled: true }] },
    ],
    aliases: {}, global: {},
  };
  const router = buildRouter(providers, cfg);
  await assert.rejects(
    () => router.execute('m', { model: 'm', messages: [] }),
    (err) => err instanceof ProviderError && err.category === 'client',
  );
});

test('execute() throws AllProvidersFailedError when all transient', async () => {
  const providers = {
    a: makeProvider('a', [new ProviderError('a', { status: 502, category: 'transient' })]),
    b: makeProvider('b', [new ProviderError('b', { status: 503, category: 'transient' })]),
  };
  const cfg = {
    providers: [
      { id: 'a', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
      { id: 'b', enabled: true, models: [{ upstream_id: 'm', priority: 1, enabled: true }] },
    ],
    aliases: {}, global: {},
  };
  const router = buildRouter(providers, cfg);
  await assert.rejects(
    () => router.execute('m', { model: 'm', messages: [] }),
    AllProvidersFailedError,
  );
});

test('execute() throws ModelNotFoundError when registry has no entry', async () => {
  const cfg = { providers: [], aliases: {}, global: {} };
  const router = buildRouter({}, cfg);
  await assert.rejects(
    () => router.execute('m', { model: 'm', messages: [] }),
    ModelNotFoundError,
  );
});

test('execute() skips providers with open breaker', async () => {
  const providers = {
    a: makeProvider('a', ['unreached-a']),
    b: makeProvider('b', ['ok-b']),
  };
  const cfg = {
    providers: [
      { id: 'a', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
      { id: 'b', enabled: true, models: [{ upstream_id: 'm', priority: 1, enabled: true }] },
    ],
    aliases: {}, global: {},
  };
  const router = buildRouter(providers, cfg);
  router.breakers.get('a').tripUntil(Date.now() + 60_000, 'manual');
  const out = await router.execute('m', { model: 'm', messages: [] });
  assert.equal(out.providerId, 'b');
});

test('execute() upstream body uses upstreamModelId, not presented modelId', async () => {
  let received;
  const provider = {
    id: 'or',
    chat: async (body) => {
      received = body;
      return { text: 'ok', usage: {}, finish_reason: 'stop', raw: { id: 'r', choices: [] } };
    },
  };
  const cfg = {
    providers: [{
      id: 'or', enabled: true,
      models: [{ upstream_id: 'z-ai/glm-4.6', priority: 0, enabled: true, presented_id: 'glm-4.6' }],
    }],
    aliases: {}, global: {},
  };
  const router = buildRouter({ or: provider }, cfg);
  await router.execute('glm-4.6', { model: 'glm-4.6', messages: [] });
  assert.equal(received.model, 'z-ai/glm-4.6');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test test/router.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`lib/router.js`:

```js
// Model id'sini provider listesine yönlendirir, transient hatalarda fallback yapar.

import { ProviderError } from './providers/base.js';
import { ModelNotFoundError } from './model-registry.js';

const AUTH_TRIP_MS = 5 * 60 * 1000;

export class AllProvidersFailedError extends Error {
  constructor(modelId, lastErr) {
    super(`all providers failed for model: ${modelId}`);
    this.name = 'AllProvidersFailedError';
    this.modelId = modelId;
    this.cause = lastErr;
    this.status = lastErr?.status || 502;
    this.category = 'transient';
  }
}

export class Router {
  constructor(registry, breakers) {
    this.registry = registry;
    this.breakers = breakers;
  }

  async execute(modelId, body, opts = {}) {
    const candidates = this.registry.resolve(modelId);
    if (!candidates.length) throw new ModelNotFoundError(modelId);

    let lastErr;
    for (const entry of candidates) {
      const provider = this.registry.providers.get(entry.providerId);
      if (!provider) { lastErr = new Error(`provider missing: ${entry.providerId}`); continue; }

      const breaker = this.breakers.get(entry.providerId);
      if (breaker.isOpen()) { lastErr = new Error(`breaker open: ${breaker.reason || ''}`); continue; }

      const upstreamBody = { ...body, model: entry.upstreamModelId };
      try {
        const result = await provider.chat(upstreamBody, opts);
        breaker.recordSuccess();
        entry.lastUsedAt = Date.now();
        return { result, providerId: entry.providerId, upstreamModelId: entry.upstreamModelId };
      } catch (err) {
        lastErr = err;
        const cat = (err instanceof ProviderError) ? err.category : 'transient';
        switch (cat) {
          case 'transient':
            breaker.recordFailure();
            continue;
          case 'auth':
            breaker.tripUntil(Date.now() + AUTH_TRIP_MS, 'auth error');
            continue;
          case 'bad_model':
            this.registry.markModelUnavailable(entry);
            continue;
          case 'client':
            throw err;
          default:
            continue;
        }
      }
    }
    throw new AllProvidersFailedError(modelId, lastErr);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test test/router.test.js
```

Expected: 9/9 PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/router.js test/router.test.js
git commit -m "feat(router): Router.execute with fallback + circuit breaker"
```

---

## Task 5: Per-provider rate-limit refactor

**Files:**
- Modify: `lib/rate-limit.js`

**Background:** Spec §5.5 — `getBucket(providerId)` per-provider Map. Mevcut tek-bucket API'si geriye uyumlu kalsın (`getBucket()` → `getBucket('default')`).

- [ ] **Step 1: Mevcut rate-limit.js'i oku**

```bash
cat lib/rate-limit.js
```

- [ ] **Step 2: Edit — Map<id, Bucket>'a geçir**

`lib/rate-limit.js`'i şununla değiştir (ENTIRE file):

```js
// Per-provider multiplier/RPM bucket.
// Phase 1'de tek bucket vardı; Phase 2'de Map<providerId, Bucket>.

import { config } from './config.js';
import { log } from './logger.js';
import { sleep } from './util.js';

class MultiplierBucket {
  constructor(id, capPerMinute) {
    this.id = id;
    this.cap = Math.max(1, capPerMinute);
    this.spent = 0;
    this.windowStart = Date.now();
  }

  reset() { this.spent = 0; this.windowStart = Date.now(); }

  async charge(amount, label = '') {
    const cost = Math.max(1, Number(amount) || 1);
    while (true) {
      const now = Date.now();
      if (now - this.windowStart >= 60_000) {
        this.windowStart = now;
        this.spent = 0;
      }
      if (this.spent + cost <= this.cap) {
        this.spent += cost;
        return;
      }
      const waitMs = 60_000 - (now - this.windowStart) + 200;
      log.info(`rate-limit[${this.id}]: bütçe doldu ${this.spent}/${this.cap}, ${(waitMs / 1000).toFixed(1)}s bekleniyor (${label}, cost=${cost})`);
      await sleep(waitMs);
    }
  }

  async cooldown60s(label = '') {
    log.warn(`rate-limit[${this.id}]: 429 cooldown 60s (${label})`);
    await sleep(60_000);
    this.reset();
  }

  snapshot() {
    return {
      id: this.id, cap: this.cap, spent: this.spent,
      remaining: Math.max(0, this.cap - this.spent),
      window_age_ms: Date.now() - this.windowStart,
    };
  }
}

const buckets = new Map();

export function getBucket(providerId = 'default') {
  if (!buckets.has(providerId)) {
    const cap = config.rateLimit.multPerMin;
    buckets.set(providerId, new MultiplierBucket(providerId, cap));
  }
  return buckets.get(providerId);
}

export function configureBucket(providerId, { mult_per_min, rpm } = {}) {
  // RPM ve multiplier şu an aynı sınıf üzerinden modellenir; bir istek = 1 cost.
  const cap = mult_per_min ?? rpm ?? config.rateLimit.multPerMin;
  buckets.set(providerId, new MultiplierBucket(providerId, cap));
  return buckets.get(providerId);
}

export function snapshotAll() {
  return Array.from(buckets.values()).map((b) => b.snapshot());
}

export function _resetForTests() { buckets.clear(); }
```

- [ ] **Step 3: Tüm testleri çalıştır (regression)**

```bash
npm test
```

Expected: 43/43 + Phase 2'de eklenenler PASS (rate-limit'in eski API'si geriye uyumlu, sadece adapter'lar etkilenmez).

- [ ] **Step 4: Commit**

```bash
git add lib/rate-limit.js
git commit -m "refactor(rate-limit): per-provider bucket Map"
```

---

## Task 6: factory.js → getRouter() (provider'ları config'den kur)

**Files:**
- Modify: `lib/providers/factory.js`

**Background:** Spec §5.6 hot-reload semantiği. Faz 2'de basit versiyon: boot'ta `data/providers.json`'dan tüm provider'ları kur, ModelRegistry'i doldur, Router'ı kur, cache'le. `_resetForTests` test için cache temizler.

- [ ] **Step 1: Edit — factory.js'i genişlet**

`lib/providers/factory.js`'i tamamen değiştir:

```js
// Faz 2: getRouter() — providers.json'dan yükler, hepsini başlatır,
// ModelRegistry + CircuitBreakerRegistry + Router döner.

import { OpenaiCompatProvider } from './openai-compat.js';
import { loadProvidersConfig, maybeMigrateLegacyEnv } from '../store.js';
import { ModelRegistry } from '../model-registry.js';
import { CircuitBreakerRegistry } from '../circuit-breaker.js';
import { Router } from '../router.js';
import { configureBucket } from '../rate-limit.js';
import { log } from '../logger.js';

const PROVIDER_TYPES = {
  'openai-compat': OpenaiCompatProvider,
};

let cachedRouter = null;

export function buildProviderInstance(providerCfg) {
  const Klass = PROVIDER_TYPES[providerCfg.type];
  if (!Klass) throw new Error(`unknown provider type: ${providerCfg.type}`);
  return new Klass(providerCfg);
}

export function buildRouter(providersCfg) {
  const instances = {};
  for (const p of providersCfg.providers || []) {
    if (!p.enabled) continue;
    instances[p.id] = buildProviderInstance(p);
    if (p.rate_limit) configureBucket(p.id, p.rate_limit);
  }
  const registry = new ModelRegistry();
  registry.load(providersCfg, instances);
  const cb = providersCfg.global?.circuit_breaker || {};
  const breakers = new CircuitBreakerRegistry({
    failThreshold: cb.fail_threshold ?? 3,
    openSeconds: cb.open_seconds ?? 60,
  });
  return new Router(registry, breakers);
}

export async function getRouter() {
  if (!cachedRouter) {
    maybeMigrateLegacyEnv(process.env);
    const cfg = loadProvidersConfig();
    if (!cfg) {
      throw new Error('data/providers.json yok ve AIRFORCE_API_KEY tanımlı değil — admin panel veya .env üzerinden bir provider ekle.');
    }
    cachedRouter = buildRouter(cfg);
    log.info(`router: ${(cfg.providers || []).filter((p) => p.enabled).length} provider yüklü`);
  }
  return cachedRouter;
}

export function _resetRouterForTests() { cachedRouter = null; }

// Phase 1 geriye uyumluluk: getDefaultProvider Phase 2'de kalkıyor.
// Adapter'lar artık getRouter() kullansın.
```

- [ ] **Step 2: factory test'i güncelle (mevcut testi koru, getRouter testi ekleme)**

`test/providers/factory.test.js`'in mevcut hali:
- `buildProviderFromEnvConfig` testleri vardı.
- Phase 2'de bu fonksiyon kalkıyor; testleri sil ve yeni `buildRouter` testi ekle.

`test/providers/factory.test.js`'i değiştir:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRouter, buildProviderInstance } from '../../lib/providers/factory.js';
import { OpenaiCompatProvider } from '../../lib/providers/openai-compat.js';

test('buildProviderInstance creates OpenaiCompatProvider for openai-compat type', () => {
  const inst = buildProviderInstance({
    id: 'a', type: 'openai-compat', base_url: 'https://x', api_key: 'k', enabled: true,
  });
  assert.ok(inst instanceof OpenaiCompatProvider);
});

test('buildProviderInstance throws for unknown type', () => {
  assert.throws(
    () => buildProviderInstance({ id: 'a', type: 'wat', base_url: 'https://x', api_key: 'k' }),
    /unknown provider type/,
  );
});

test('buildRouter wires providers + registry + breakers', () => {
  const cfg = {
    schema_version: 1,
    providers: [
      {
        id: 'a', type: 'openai-compat', base_url: 'https://a.example', api_key: 'k', enabled: true,
        models: [{ upstream_id: 'm1', priority: 0, enabled: true }],
      },
    ],
    aliases: {},
    global: { default_model: 'm1', circuit_breaker: { fail_threshold: 5, open_seconds: 30 } },
  };
  const router = buildRouter(cfg);
  assert.ok(router.registry);
  assert.ok(router.breakers);
  const entries = router.registry.resolve('m1');
  assert.equal(entries.length, 1);
  assert.equal(router.breakers.get('a').failThreshold, 5);
});
```

- [ ] **Step 3: Run tests**

```bash
node --test test/providers/factory.test.js
```

Expected: 3/3 PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/providers/factory.js test/providers/factory.test.js
git commit -m "feat(providers): getRouter() builds Router from providers.json"
```

---

## Task 7: adapters/openai.js → router.execute()

**Files:**
- Modify: `lib/adapters/openai.js`

**Background:** Faz 1'de `getDefaultProvider().chat()` kullanıyordu. Faz 2'de `(await getRouter()).execute(modelId, body)` kullanır.

- [ ] **Step 1: Edit**

`lib/adapters/openai.js`:

Eski import:
```js
import { getDefaultProvider } from '../providers/factory.js';
import { ProviderError } from '../providers/base.js';
```

Yeni:
```js
import { getRouter } from '../providers/factory.js';
import { ProviderError } from '../providers/base.js';
```

Eski upstream call:
```js
  let providerResult;
  try {
    const provider = await getDefaultProvider();
    providerResult = await provider.chat(upstreamBody);
  } catch (err) {
    const status = (err instanceof ProviderError) ? (err.status || 502) : 502;
    log.error('openai upstream error', { err: err.message, status, category: err?.category });
    return errorResponse(res, status, err.message || 'Upstream error');
  }

  const completion = providerResult.raw;
```

Yeni:
```js
  let providerResult;
  let routedProviderId;
  try {
    const router = await getRouter();
    const out = await router.execute(upstreamModel, upstreamBody);
    providerResult = out.result;
    routedProviderId = out.providerId;
  } catch (err) {
    const status = err?.status || 502;
    const category = err?.category || 'transient';
    log.error('openai router error', { err: err.message, status, category });
    return errorResponse(res, status, err.message || 'Upstream error');
  }

  const completion = providerResult.raw;
```

`log.info(...)` çağrısının yakınına `provider=${routedProviderId}` ekleyebilirsin (opsiyonel, gözlem için):
```js
  log.info(`openai → ${routedProviderId} model=${upstreamModel}`);
```

- [ ] **Step 2: Tüm testleri çalıştır**

```bash
npm test
```

Expected: hepsi PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/adapters/openai.js
git commit -m "feat(adapters): openai.js routes through Router"
```

---

## Task 8: adapters/anthropic.js — router uyumsuzluk yamasını koru

**Files:**
- Modify: `lib/adapters/anthropic.js`

**Background:** Anthropic adapter Faz 3'te tamamen değişecek. Faz 2'de `getDefaultProvider` kalktığı için kompile etmeyecek; geçici çare: registry'den airforce provider instance'ını al ve `provider.request()`'e devam et.

- [ ] **Step 1: Edit**

Eski import:
```js
import { getDefaultProvider } from '../providers/factory.js';
import { ProviderError } from '../providers/base.js';
```

Yeni:
```js
import { getRouter } from '../providers/factory.js';
import { ProviderError } from '../providers/base.js';
```

Eski upstream call:
```js
  try {
    const provider = await getDefaultProvider();
    const { json } = await provider.request('POST', '/v1/messages', upstreamBody);
    payload = json;
  } catch (err) { ... }
```

Yeni:
```js
  try {
    const router = await getRouter();
    // Phase 2 geçici köprü: anthropic adapter şu anlık herhangi bir
    // openai-compat provider'ın /v1/messages endpoint'ini kullanır.
    // Phase 3'te AnthropicNativeProvider gelecek.
    const provider = router.registry.providers.values().next().value;
    if (!provider || typeof provider.request !== 'function') {
      throw new Error('no provider with /v1/messages bridge available');
    }
    const { json } = await provider.request('POST', '/v1/messages', upstreamBody);
    payload = json;
  } catch (err) {
    const status = (err instanceof ProviderError) ? (err.status || 502) : 502;
    log.error('anthropic upstream error', { err: err.message, status, category: err?.category });
    return errorResponse(res, status, err.message || 'Upstream error');
  }
```

- [ ] **Step 2: Tüm testleri çalıştır**

```bash
npm test
```

Expected: hepsi PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/adapters/anthropic.js
git commit -m "refactor(adapters): anthropic uses router (temporary single-provider bridge)"
```

---

## Task 9: adapters/models.js — registry'den birleşik liste

**Files:**
- Modify: `lib/adapters/models.js`

**Background:** Spec §7.2 birleşik tablo. Faz 2'de `/v1/models` artık tüm provider'ların aktif modellerinin birleşimini döner.

- [ ] **Step 1: Edit**

`lib/adapters/models.js`'i tamamen değiştir:

```js
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

  // Birleşik liste — aynı presented_id farklı provider'larda olabilir; her birini ayrı entry olarak göster.
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
```

- [ ] **Step 2: Tüm testleri çalıştır**

```bash
npm test
```

Expected: hepsi PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/adapters/models.js
git commit -m "feat(adapters): models.js lists from registry (multi-provider)"
```

---

## Task 10: probe.js — registry'deki tüm (provider, model) çiftlerini gez

**Files:**
- Modify: `lib/probe.js`

**Background:** Spec §8 — multi-provider probe. Capability snapshot key formatı `${providerId}/${modelId}`.

- [ ] **Step 1: Edit**

`lib/probe.js`'i tamamen değiştir:

```js
// Multi-provider tool-capability probe.
// Her enabled (provider, model) çifti için:
//   1) XML inject testi
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
      native: null,    // Faz 5 doldurur
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
```

- [ ] **Step 2: Tüm testleri çalıştır**

```bash
npm test
```

Expected: hepsi PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/probe.js
git commit -m "feat(probe): multi-provider probe (capability key = providerId/modelId)"
```

---

## Task 11: capability.js — yeni key formatı

**Files:**
- Modify: `lib/capability.js`

**Background:** Eski snapshot tek-upstream'di (key = modelId). Yeni snapshot key = `${providerId}/${modelId}`. Adapter kodu bu modüle dokunmuyor ama `isToolCapable`/`listCapableModels` Faz 4'e kadar legacy kalır. Bu task'ta `resolveModel`'i kaldırıyoruz çünkü resolution registry'ye geçti.

- [ ] **Step 1: Edit**

`lib/capability.js`'i değiştir:

```js
// data/capability.json snapshot'ını okuma yardımcıları.
// Phase 2: key formatı `${providerId}/${modelId}`.

import { loadCapability } from './store.js';

export function getCapability() {
  return loadCapability();
}

export function isToolCapable(providerId, upstreamModelId) {
  const snap = loadCapability();
  const key = `${providerId}/${upstreamModelId}`;
  const m = snap.models?.[key];
  if (!m) return null;
  return m.status === 'ok' && Boolean(m.xml || m.native);
}

export function listCapableModels() {
  const snap = loadCapability();
  return Object.entries(snap.models || {})
    .filter(([, v]) => v.status === 'ok' && (v.xml || v.native))
    .map(([key, v]) => ({ key, ...v }));
}

// Phase 1 `resolveModel` Phase 2'de ModelRegistry tarafından sağlanıyor — bu fonksiyon kalktı.
// Adapter'larda body.model artık doğrudan registry.resolve()'a gidiyor.
```

- [ ] **Step 2: Adapter'larda `resolveModel` çağrılarını temizle**

`lib/adapters/openai.js`:

Eski:
```js
import { resolveModel, getCapability } from '../capability.js';
...
const upstreamModel = resolveModel(presentedModel);
```

Yeni:
```js
import { getCapability } from '../capability.js';
...
const upstreamModel = presentedModel;  // Registry artık kendi içinde resolve ediyor
```

`lib/adapters/anthropic.js`:

Aynı değişiklik (`resolveModel` import'unu sil, `upstreamModel = presentedModel`).

- [ ] **Step 3: Tüm testleri çalıştır**

```bash
npm test
```

Expected: hepsi PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/capability.js lib/adapters/openai.js lib/adapters/anthropic.js
git commit -m "refactor(capability): new key format providerId/modelId; resolveModel kaldırıldı"
```

---

## Task 12: Integration test — E2E fallback

**Files:**
- Create: `test/integration/e2e-fallback.test.js`
- Modify: `package.json` test script

**Background:** Spec §9 — gerçek HTTP server boot edip mock provider'larla iki provider arasında fallback'i doğrula.

- [ ] **Step 1: Failing test yaz**

`test/integration/e2e-fallback.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../../lib/router.js';
import { ModelRegistry } from '../../lib/model-registry.js';
import { CircuitBreakerRegistry } from '../../lib/circuit-breaker.js';
import { ProviderError } from '../../lib/providers/base.js';

test('end-to-end: priority 0 fails transient → priority 1 serves', async () => {
  let p0Calls = 0;
  let p1Calls = 0;

  const p0 = {
    id: 'p0',
    chat: async (body) => {
      p0Calls++;
      throw new ProviderError('upstream 502', { status: 502, category: 'transient' });
    },
  };
  const p1 = {
    id: 'p1',
    chat: async (body) => {
      p1Calls++;
      assert.equal(body.model, 'm-upstream-1');
      return {
        text: 'rescued',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
        raw: { id: 'r1', choices: [{ message: { content: 'rescued' } }] },
      };
    },
  };

  const cfg = {
    schema_version: 1,
    providers: [
      { id: 'p0', enabled: true, models: [{ upstream_id: 'm-upstream-0', priority: 0, enabled: true, presented_id: 'm' }] },
      { id: 'p1', enabled: true, models: [{ upstream_id: 'm-upstream-1', priority: 1, enabled: true, presented_id: 'm' }] },
    ],
    aliases: {},
    global: {},
  };

  const reg = new ModelRegistry();
  reg.load(cfg, { p0, p1 });
  const breakers = new CircuitBreakerRegistry();
  const router = new Router(reg, breakers);

  const out = await router.execute('m', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(p0Calls, 1);
  assert.equal(p1Calls, 1);
  assert.equal(out.providerId, 'p1');
  assert.equal(out.result.text, 'rescued');
});

test('end-to-end: explicit prefix locks provider, no fallback', async () => {
  const p0 = { id: 'p0', chat: async () => { throw new ProviderError('boom', { status: 502, category: 'transient' }); } };
  const p1 = { id: 'p1', chat: async () => ({ text: 'unreached', usage: {}, finish_reason: 'stop', raw: { id: 'r', choices: [] } }) };

  const cfg = {
    schema_version: 1,
    providers: [
      { id: 'p0', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
      { id: 'p1', enabled: true, models: [{ upstream_id: 'm', priority: 1, enabled: true }] },
    ],
    aliases: {}, global: {},
  };
  const reg = new ModelRegistry();
  reg.load(cfg, { p0, p1 });
  const breakers = new CircuitBreakerRegistry();
  const router = new Router(reg, breakers);

  await assert.rejects(
    () => router.execute('p0/m', { model: 'p0/m', messages: [] }),
    (err) => err.name === 'AllProvidersFailedError' || err.category === 'transient',
  );
});
```

- [ ] **Step 2: package.json güncelle**

`scripts.test`:
```json
"test": "node --test test/*.test.js test/providers/*.test.js test/integration/*.test.js"
```

- [ ] **Step 3: Run all**

```bash
npm test
```

Expected: tüm testler PASS.

- [ ] **Step 4: Commit**

```bash
git add test/integration/e2e-fallback.test.js package.json
git commit -m "test(integration): e2e fallback (transient → next provider; prefix locks)"
```

---

## Task 13: End-to-end smoke (lokal, gerçek api.airforce)

**Files:** _(none — runtime test)_

**Background:** Phase 1 smoke ile aynı, ama `data/providers.json` migration'ını doğrula. .env'den otomatik olarak airforce provider'ı oluşmalı.

- [ ] **Step 1: data/providers.json yoksa garanti et (clean state)**

```bash
cd ~/Desktop/llm-bridge
rm -f data/providers.json data/capability.json
ls data/ 2>/dev/null
```

- [ ] **Step 2: Server'ı başlat**

```bash
(node server.js > /tmp/llm-bridge-smoke2.log 2>&1 &)
sleep 3
```

- [ ] **Step 3: Migration kontrolü**

```bash
cat data/providers.json | head -30
```

Expected: tek airforce provider'ı görünmeli (auto-migrated).

- [ ] **Step 4: /healthz + /v1/models**

```bash
curl -s http://127.0.0.1:2399/healthz
echo
curl -s http://127.0.0.1:2399/v1/models -H "Authorization: Bearer test-key" | head -c 400
```

- [ ] **Step 5: Chat completion**

```bash
curl -s -X POST http://127.0.0.1:2399/v1/chat/completions \
  -H "Authorization: Bearer test-key" \
  -H "content-type: application/json" \
  -d '{"model":"glm-4.6","messages":[{"role":"user","content":"sadece tek kelime yaz: ping"}]}' \
  --max-time 60
```

Expected: `{"choices":[{"message":{"content":"ping",...}},...]}`.

- [ ] **Step 6: Server'ı durdur**

```bash
pkill -f "node server.js"
rm -f /tmp/llm-bridge-smoke2.log
```

- [ ] **Step 7: CHANGELOG güncelle**

`CHANGELOG.md`:

```markdown
## [Unreleased] — Phase 2: Router & Registry

- `lib/circuit-breaker.js` — per-provider state machine
- `lib/model-registry.js` — short/prefix/alias resolution + priority
- `lib/router.js` — `execute()` with fallback (transient/auth/bad_model → next; client → fatal)
- `lib/store.js` — `data/providers.json` schema + `.env` migration on first boot
- `lib/rate-limit.js` — per-provider Map<id, Bucket>
- `lib/providers/factory.js` — `getRouter()` builds Router from providers.json
- `lib/adapters/openai.js` — routes through Router
- `lib/adapters/models.js` — multi-provider unified listing
- `lib/probe.js` — gez registry'deki tüm (provider, model) çiftleri
- `lib/capability.js` — yeni key formatı `${providerId}/${modelId}`
- Anthropic adapter geçici köprüsünü tutuyor (Phase 3'te `AnthropicNativeProvider`)
```

`package.json`'da `version: "0.3.0"`.

```bash
git add CHANGELOG.md package.json
git commit -m "docs: changelog for phase 2"
```

---

## Task 14: PR develop → master + tag v0.3.0-phase2

**Files:** _(none — git only)_

- [ ] **Step 1: Push feat branch**

```bash
git push origin feat/02-router-registry
```

- [ ] **Step 2: PR feat → develop**

```bash
gh pr create --repo NeronSignal/llm-bridge --base develop --head feat/02-router-registry \
  --title "Phase 2: Router & Model Registry" \
  --body "$(cat <<'EOF'
## Summary
- `lib/circuit-breaker.js`, `lib/model-registry.js`, `lib/router.js` yeni dosyalar
- `data/providers.json` schema + `.env` migration
- Per-provider rate-limit
- Adapter'lar (`openai`, `models`) ve `probe.js` Router üzerinden çalışıyor
- Anthropic adapter geçici köprüsünü koruyor (Phase 3'te değişecek)
- Tool-engine modülleri **dokunulmadı**

## Test plan
- [x] CircuitBreaker tests PASS
- [x] ModelRegistry tests PASS
- [x] Router tests PASS
- [x] Store/migration tests PASS
- [x] Integration fallback test PASS
- [x] Phase 1 testleri kırılmadan PASS
- [x] Smoke: server boot + auto-migration + glm-4.6 chat completion OK
EOF
)"
```

- [ ] **Step 3: Merge feat→develop**

```bash
gh pr merge --repo NeronSignal/llm-bridge --squash --delete-branch
```

- [ ] **Step 4: develop → master release PR + merge + tag**

```bash
git checkout develop
git pull origin develop
gh pr create --repo NeronSignal/llm-bridge --base master --head develop \
  --title "Release: phase 2 (router + registry)" \
  --body "Phase 2 implementation merged from develop. See CHANGELOG.md."
gh pr merge --repo NeronSignal/llm-bridge --squash
git checkout master
git pull origin master
git tag v0.3.0-phase2
git push origin v0.3.0-phase2
```

---

## Self-Review

**Spec coverage:**
- §3.1 (klasör yapısı): Task 1, 3, 4 — yeni `lib/router.js`, `lib/model-registry.js`, `lib/circuit-breaker.js` ✓
- §3.2 (request flow): Task 7 — adapter router'a bağlandı ✓
- §4.4 (Hata kategorileri): Task 4 — Router'da switch ✓
- §5.1 (ModelRegistry): Task 3 ✓
- §5.2 (Resolution): Task 3 (kısa/prefix/alias) ✓
- §5.3 (Router.execute): Task 4 ✓
- §5.4 (Circuit Breaker): Task 1 ✓
- §5.5 (Per-provider rate-limit): Task 5 ✓
- §5.6 (Hot-reload): Faz 4'te admin endpoint'leriyle birlikte (basit cached-router şu an restart bekler).
- §6.1 (Schema): Task 2 ✓
- §6.2 (Atomic write): Task 2 ✓
- §6.3 (Migration): Task 2 ✓
- §7 (Admin Panel): Faz 4 ✓ (kapsam dışı)
- §8 (Probe): Task 10 — multi-provider gez ✓ (native test Faz 5)
- §9 (Testing): Task 1, 3, 4, 12 + olan (Faz 1) ✓
- §10 (Migration özeti): Task 2 + Task 13 (smoke) ✓

**Placeholder scan:** "TBD"/"TODO" yok. Kod blokları tam.

**Type consistency:**
- `ProviderEntry` shape (`providerId`, `upstreamModelId`, `priority`, `enabled`, `lastUsedAt`, `presented_id`, `_runtimeUnavailable`) — `model-registry.js` ve `router.js`'de tutarlı.
- `Router.execute(modelId, body, opts)` → `{ result, providerId, upstreamModelId }` — Task 4, 7'de tutarlı.
- `getRouter()` async → `await getRouter()` — Task 6, 7, 9, 10'da tutarlı.
- `getBucket(providerId)` — Task 5'te imza değişti; `lib/probe.js`'de `getBucket(m.provider_id)` (Task 10) tutarlı.

**Risks:**
- Task 11'de `resolveModel` siliniyor; mevcut testler/diğer modüller bu fonksiyonu kullanıyorsa kırılır. Önceden `grep -rn "resolveModel" lib/ test/`. (Phase 1 sonrası adapter'lar dışında kullanan yok.)
- Anthropic adapter Faz 2'de `provider.request()` köprüsünü router üzerinden alıyor (Task 8). Birden fazla provider varsa "ilk provider"e gidiyor — bu Faz 3'te düzelecek; yine de smoke test'te kullanıcı tek provider'la başladığı için sorun çıkmaz.
- `data/providers.json` `.env`'le ilk açılışta migrate olur; eğer kullanıcı `.env`'de key'i değiştirip restart ederse, JSON dosyası dokunulmaz (eski key'le çalışmaya devam eder). Bu beklenen davranış (admin panel ile yönetiyoruz). Kullanıcıya CHANGELOG'da hatırlatılır.
