# Multi-Provider Bridge — Design Spec

- **Date:** 2026-04-28
- **Author:** Halil Bilik (NeronSignal)
- **Source repo (fork base):** `alicomert/airforce` @ master
- **Target repo:** `NeronSignal/llm-bridge`
- **Status:** Draft, awaiting user review

## 1. Motivation

`alicomert/airforce` (airforce-bridge), `api.airforce` gateway'inin önüne kurulan, OpenAI ve Anthropic uyumlu istemcilere tek bir API yüzeyi sunan bir köprüdür. Bridge, native tool calling desteklemeyen modeller için system prompt'a XML şema enjekte ederek tool-call özelliğini "yapay" olarak kazandırır.

Mevcut tasarımda **tek upstream** (api.airforce) varsayımı koddan kazınmış durumdadır: `lib/upstream.js` global `airforceApiKey` ve tek `upstreamBaseUrl` kullanır.

Hedef: Kullanıcının birden fazla LLM aboneliğini (OpenRouter, Groq, Together, Anthropic direkt, OpenAI direkt, Fireworks, DeepInfra, lokal Ollama, vb.) **tek bir bridge** üzerinde birleştirmesi. İstemci tek bir API key ve tek bir base URL kullanır; bridge isteği uygun provider'a yönlendirir, başarısızsa fallback yapar. Tool calling kararı her `(provider, model)` çifti için ayrı verilir: native varsa native kullanılır, yoksa XML inject edilir.

## 2. Scope

**Kapsam içi:**
- Multi-provider gateway: provider plugin sistemi
- İki provider tipi: `openai-compat` ve `anthropic-native`
- Routing: kısa ad (priority+fallback) + prefix'li ad (explicit, fallback yok) + alias
- Circuit breaker: provider başına failure threshold ile geçici devre dışı bırakma
- Per-provider rate limiting (multiplier veya RPM)
- Auto-discover model listesi + admin panel'de checkbox onay akışı
- Capability probe: per-(provider, model) native/XML testi; on-add + daily + manual
- Migration: mevcut `.env` (AIRFORCE_API_KEY) → `data/providers.json`
- Admin panel'de tüm provider/model/key yönetimi (key dahil panelden girilir)

**Kapsam dışı (v2):**
- Cost & token usage tracking ve panel görüntüleme
- Native streaming (provider → istemciye gerçek zamanlı SSE; mevcut "non-stream upstream + synthetic SSE" davranışı korunur)
- Image/document content blocks (Anthropic) — ilk sürümde reddedilir
- Provider başına idempotency key kullanımı
- Otomatik latency-based veya cost-based routing (manuel priority yeterli)

## 3. Architecture

### 3.1 Yeni klasör yapısı

```
lib/
├── providers/                  ← YENİ
│   ├── base.js                  (BaseProvider; ortak yardımcılar; hata sınıflandırma)
│   ├── openai-compat.js         (POST /v1/chat/completions tipi)
│   └── anthropic-native.js      (POST /v1/messages tipi)
├── router.js                   ← YENİ (priority + failover + circuit-breaker)
├── model-registry.js           ← YENİ (resolve/index)
├── circuit-breaker.js          ← YENİ
├── adapters/
│   ├── openai.js                (mevcut — Router.execute() kullanır)
│   ├── anthropic.js             (mevcut — Router.execute() kullanır)
│   └── models.js                (mevcut — registry'den listeler)
├── tool-engine/                 (DOKUNULMUYOR)
│   ├── inject.js
│   ├── parse.js
│   ├── translate.js
│   ├── serialize-history.js
│   └── anti-leak.js
├── upstream.js                  ← SİLİNİR (mantık providers/'a taşınır)
├── config.js                    (multi-provider schema'ya yükseltilir)
├── store.js                     (data/providers.json + capability snapshot atomic write)
├── probe.js                     (multi-provider gez)
├── rate-limit.js                (per-provider Map<id, Bucket>)
├── capability.js                (snapshot okuma; key formatı `${providerId}/${modelId}`)
├── auth.js                      (mevcut)
├── admin-router.js              (yeni endpoint'ler: /admin/api/providers, /admin/api/discover, ...)
├── logger.js                    (mevcut)
└── tier.js                      (mevcut, ama sadece api.airforce provider'ı için anlamlı)
data/
├── providers.json               ← YENİ (provider config; admin panel yazar; mode 600)
└── capability.json              (mevcut, key formatı değişti)
test/
├── parse.test.js, inject.test.js, serialize-history.test.js, tier.test.js  (mevcut, dokunma)
├── providers/
│   ├── openai-compat.test.js    (YENİ)
│   └── anthropic-native.test.js (YENİ)
├── router.test.js               (YENİ)
├── model-registry.test.js       (YENİ)
├── store.test.js                (YENİ)
└── integration/
    └── e2e-fallback.test.js     (YENİ)
web/                              (admin panel — sekmeli yapıya çıkar)
├── index.html
├── app.js
└── styles.css
```

### 3.2 Request flow

```
İstemci POST /v1/chat/completions { model: "glm-4.6", messages, tools? }
        │
        ▼
adapters/openai.js
  - normalizeOpenaiMessages (mevcut serialize-history.js)
  - injectIntoOpenaiBody (mevcut inject.js, tools varsa XML inject)
        │
        ▼
router.js
  - registry.resolve("glm-4.6") → [airforce(p:0), openrouter(p:1)]
  - capability snapshot → adapter "prefer_native" mı "prefer_xml" mi karar verir
  - fallback loop:
      for entry in candidates:
          breaker open? skip
          try provider.chat(body)
              ok       → return
              transient → next
              auth     → tripUntil(+5m), next
              bad_model → registry.markUnavailable, next
              client   → throw (fatal)
        │
        ▼
providers/openai-compat.js  veya  providers/anthropic-native.js
  - format dönüşümü (Anthropic plugin: OpenAI-shape → Anthropic-shape ve geri)
  - HTTPS POST + retry (timeout, 5xx, 429)
  - sonuç provider-agnostic shape: { text, native_tool_calls?, usage, finish_reason, raw }
        │
        ▼
router → adapter
        │
        ▼
adapters/openai.js (devam)
  - native_tool_calls geldi ve native tercih ediliyorsa → translate.js (Anthropic→OpenAI tool format)
  - aksi halde → extractToolCalls(text) (mevcut XML parse)
  - buildOpenaiAssistantMessage
  - SSE veya JSON yanıt
        │
        ▼
İstemci
```

**Kritik prensipler:**
- Tool-engine modülleri (inject, parse, translate, serialize-history, anti-leak) **dokunulmaz**.
- Provider plugin'leri tool-call mantığını **bilmez**, saf "format + HTTP" katmanıdır.
- "Bu model native tool kullanabilir mi?" sorusunun cevabı capability snapshot'tan gelir, router buna göre adapter'a sinyal verir.

## 4. Provider Interface (IProvider)

### 4.1 BaseProvider sözleşmesi

```js
// lib/providers/base.js
export class BaseProvider {
  constructor(config) {
    // config: { id, type, base_url, api_key, headers?, timeout_ms?, ... }
    this.id = config.id;
    this.config = config;
  }

  // Provider-agnostic OpenAI-shape body al, normalize edilmiş sonuç döndür.
  // Dönüş: { text, native_tool_calls?, usage, finish_reason, raw }
  async chat(body, opts = {}) { throw new Error('not implemented'); }

  // Modellerin string id listesini çek. Endpoint yoksa boş array dön.
  async listModels() { throw new Error('not implemented'); }

  // Cheap test (tek token, no tools). { ok: bool, latency_ms, error? }
  async healthCheck() { throw new Error('not implemented'); }

  // Provider tipi native tool calling iddia ediyor mu? (Tip seviyesi.)
  supportsNativeTools() { return false; }
}
```

### 4.2 OpenaiCompatProvider

**Kapsam:** api.airforce, OpenRouter, Groq, Together, Fireworks, DeepInfra, OpenAI direkt, Ollama, LM Studio, kendi vLLM/TGI dağıtımları, OpenAI-compat olan herhangi bir endpoint.

- `chat(body)`:
  - Body olduğu gibi gönder (`{model, messages, tools?, max_tokens, temperature, ...}`)
  - URL: `{base_url}/v1/chat/completions`
  - Header'lar: `Authorization: Bearer ${api_key}` + `content-type: application/json` + opsiyonel `headers` (örn: OpenRouter'ın `HTTP-Referer`, `X-Title`)
  - Yanıt normalize: `text = choice.message.content`, `native_tool_calls = choice.message.tool_calls` (varsa), `usage = response.usage`, `finish_reason = choice.finish_reason`.
- `listModels()` → `GET {base_url}/v1/models` → `data[].id`.
- `healthCheck()` → `chat({model: <ilk model>, messages: [{role:'user', content:'hi'}], max_tokens: 1})`.
- `supportsNativeTools()` → `true`.

### 4.3 AnthropicNativeProvider

**Kapsam:** `api.anthropic.com` (resmi Anthropic native API).

Bu plugin **format çevirici** rolü oynar — adapter ona OpenAI-shape gönderir, plugin Anthropic-shape'e çevirip POST eder, dönüşü yine OpenAI-shape'e geri çevirip döner.

- `chat(body)`:
  1. `messages`'tan `system` rolündekileri ayır → Anthropic body'sinde top-level `system` field (string concat).
  2. Kalan `messages`'ı Anthropic content blocks'a çevir:
     - `role: 'user'`, `content: string` → `{role:'user', content:[{type:'text', text:...}]}`
     - `role: 'assistant'`, `tool_calls: [...]` → `content: [{type:'tool_use', id, name, input}]`
     - `role: 'tool'`, `tool_call_id`, `content` → `{role:'user', content:[{type:'tool_result', tool_use_id, content}]}`
  3. `tools` (OpenAI format) → Anthropic format: `[{name, description, input_schema: parameters}]`.
  4. `POST {base_url}/v1/messages` headers: `x-api-key: ${api_key}`, `anthropic-version: 2023-06-01`, `content-type: application/json`.
  5. Yanıt:
     - `content[]` block'ları gez
     - `text` blocks → text accumulate
     - `tool_use` blocks → `native_tool_calls.push({id, type:'function', function: {name, arguments: JSON.stringify(input)}})`
  6. `usage.input_tokens / output_tokens` → OpenAI `prompt_tokens / completion_tokens`.
- `listModels()` → `GET {base_url}/v1/models` (Anthropic'in `data[].id` formatı).
- `healthCheck()` → minimal `{model, max_tokens: 1, messages: [{role:'user', content:'hi'}]}`.
- `supportsNativeTools()` → `true`.

**v1 limiti:** Image / document / multi-part content block'lar reddedilir (`client` kategori hata; istemciye 400 döner). Sadece text + tool_use + tool_result destekleniyor.

### 4.4 Hata sınıflandırması

`BaseProvider.classifyError(httpStatus, body)` HTTP yanıtlarını şu kategorilere döker:

| Kategori | HTTP / koşul | Router davranışı |
|---|---|---|
| `transient` | 408, 425, 429, 500, 502, 503, 504, network error, timeout | failover yap |
| `auth` | 401, 403 | 5dk circuit-breaker tripUntil, failover yap |
| `bad_model` | 404 model_not_found, 400 ile body'de "model" hatası | registry'den entry'yi geçici çıkar, failover yap |
| `client` | Diğer 4xx (bad request, content policy, unsupported feature) | fatal — istemciye doğrudan dön |
| `ok` | 2xx | başarı |

Provider plugin kendi yanıtını kategorize eder; router sadece kategoriyi okur.

### 4.5 Native tool calling sinyali

Provider tipi `supportsNativeTools() === true` dese bile, gerçek native işleyiş model bazında değişir. Karar capability snapshot'tan gelir (`data/capability.json`):

```json
{
  "schema_version": 2,
  "models": {
    "airforce/glm-4.6":         { "native": false, "xml": true,  "latency_ms": 274 },
    "groq/llama-3.1-70b":       { "native": true,  "xml": true,  "latency_ms": 130 },
    "anthropic/claude-sonnet-4":{ "native": true,  "xml": true,  "latency_ms": 980 }
  }
}
```

Adapter çağrı yapacağı zaman:
- `native: true` → router'a `prefer_native: true` der → provider'a tools field gider → dönüşte `native_tool_calls` kullanılır.
- `native: false` (veya snapshot yok) → router'a `prefer_xml: true` der → tools field gönderilmez → `injectIntoOpenaiBody` ile system prompt'a XML şema eklenir → dönüş text'i `extractToolCalls`'tan geçer.

## 5. Router & Model Registry

### 5.1 ModelRegistry

```
ModelRegistry
├── providers: Map<providerId, ProviderInstance>
└── modelIndex: Map<shortId, ProviderEntry[]>     // priority order
```

`ProviderEntry`:
```js
{
  providerId: "airforce",
  upstreamModelId: "glm-4.6",   // provider'a gönderilen ad
  priority: 0,                   // 0 = en yüksek
  enabled: true                  // breaker tripped ise router skip eder
}
```

### 5.2 Resolution

Üç giriş biçimi:

| Giriş | Algoritma |
|---|---|
| `glm-4.6` (kısa) | `modelIndex.get("glm-4.6")` → priority order'da `enabled` olanları döndür |
| `airforce/glm-4.6` (prefix) | Sadece o entry; tek elemanlı liste; **fallback yok** |
| `glm-fast` (alias) | `aliases["glm-fast"]` → hedef adı çöz, sonra resolution'a recurse |

`resolve()` her zaman `ProviderEntry[]` döner; boşsa `ModelNotFoundError` (404).

**Short id türetme:** `upstreamModelId` slash içeriyorsa son segment kısa id olur (`anthropic/claude-sonnet-4` → `claude-sonnet-4`). Override için entry'de `presented_id` field'ı varsa o kullanılır.

**Tie-breaker:** Aynı priority değerine sahip çoklu entry'ler `lastUsedAt` eski olan önce (basit round-robin). v2'de latency-based değiştirilebilir.

### 5.3 Router.execute

```js
async execute(modelId, body, opts) {
  const candidates = registry.resolve(modelId);
  if (!candidates.length) throw new ModelNotFoundError(modelId);

  let lastErr;
  for (const entry of candidates) {
    if (!entry.enabled) continue;
    const provider = registry.providers.get(entry.providerId);
    const breaker = circuitBreaker.get(entry.providerId);
    if (breaker.isOpen()) { lastErr = breaker.reason; continue; }

    try {
      const upstreamBody = { ...body, model: entry.upstreamModelId };
      const result = await provider.chat(upstreamBody, opts);
      breaker.recordSuccess();
      entry.lastUsedAt = Date.now();
      return { result, providerId: entry.providerId, upstreamModelId: entry.upstreamModelId };
    } catch (err) {
      lastErr = err;
      switch (err.category) {
        case 'transient':  breaker.recordFailure(); continue;
        case 'auth':       breaker.tripUntil(Date.now() + 5*60_000); continue;
        case 'bad_model':  registry.markModelUnavailable(entry); continue;
        case 'client':     throw err;
        default:           continue;
      }
    }
  }

  throw new AllProvidersFailedError(modelId, lastErr);
}
```

### 5.4 Circuit Breaker (lib/circuit-breaker.js)

State: `closed | open | half-open`.

- 10s pencere içinde **3 ardışık** transient failure → `open`, 60s sonra `half-open`.
- `half-open`'da bir başarı → `closed`; başarısızlık → tekrar `open`.
- `tripUntil(timestamp)` → manuel uzun açık (auth hatası).
- Admin panel'de "Reset breaker" → `closed`'a zorla.

Eşikler config'de (`global.circuit_breaker.fail_threshold`, `open_seconds`).

### 5.5 Per-provider rate limit

`lib/rate-limit.js` Map<providerId, Bucket>. Bucket tipleri:
- `multiplier` (api.airforce gibi): `mult_per_min` budget.
- `rpm` (genel): `requests_per_minute` budget; her istek 1 düşer.

Provider config'inde `rate_limit: { mult_per_min: N }` veya `rate_limit: { rpm: N }`. Router fallback'ten önce bucket dolu mu kontrolü yapar — doluysa `transient` muamelesi.

### 5.6 Hot-reload semantiği

Admin panel provider eklediği/değiştirdiğinde:
1. Yeni `ProviderInstance` ve yeni `Map`'ler yaratılır.
2. Atomik referans swap.
3. Devam eden istekler eski instance'a referansları üzerinden devam eder (in-flight korunur).
4. Yeni gelen istekler yeni state'i görür.
5. Eski instance GC'lenir.

systemd restart gerekmez.

## 6. Config Schema

### 6.1 `data/providers.json`

```json
{
  "schema_version": 1,
  "providers": [
    {
      "id": "airforce",
      "label": "api.airforce",
      "type": "openai-compat",
      "base_url": "https://api.airforce",
      "api_key": "sk-air-...",
      "headers": {},
      "timeout_ms": 180000,
      "enabled": true,
      "rate_limit": { "mult_per_min": 10 },
      "models": [
        { "upstream_id": "glm-4.6", "priority": 0, "enabled": true },
        { "upstream_id": "llama-4-scout", "priority": 0, "enabled": true }
      ]
    },
    {
      "id": "anthropic",
      "label": "Anthropic Direct",
      "type": "anthropic-native",
      "base_url": "https://api.anthropic.com",
      "api_key": "sk-ant-...",
      "headers": { "anthropic-version": "2023-06-01" },
      "timeout_ms": 180000,
      "enabled": true,
      "rate_limit": { "rpm": 50 },
      "models": [
        { "upstream_id": "claude-sonnet-4", "priority": 0, "enabled": true },
        { "upstream_id": "claude-opus-4", "priority": 0, "enabled": true }
      ]
    },
    {
      "id": "openrouter",
      "label": "OpenRouter",
      "type": "openai-compat",
      "base_url": "https://openrouter.ai/api",
      "api_key": "sk-or-...",
      "headers": { "HTTP-Referer": "https://localhost", "X-Title": "llm-bridge" },
      "enabled": true,
      "rate_limit": { "rpm": 200 },
      "models": [
        { "upstream_id": "anthropic/claude-sonnet-4", "priority": 1, "enabled": true },
        { "upstream_id": "z-ai/glm-4.6", "priority": 1, "enabled": true, "presented_id": "glm-4.6" }
      ]
    }
  ],
  "aliases": {
    "default": "glm-4.6"
  },
  "global": {
    "default_model": "glm-4.6",
    "circuit_breaker": { "fail_threshold": 3, "open_seconds": 60 }
  }
}
```

`global.default_model` istemci `body.model` field'ını boş/eksik gönderdiğinde kullanılır (şimdiki davranışla aynı). `aliases` map'i resolution algoritmasında kontrol edilir; alias'ın hedef adı tekrar çözümlenir (alias → alias zincirine izin verilmez, tek adımda).

### 6.2 Atomic write

`lib/store.js` write akışı:
1. JSON serialize.
2. `data/providers.json.tmp` yaz, `fsync`.
3. `rename(tmp, providers.json)` (atomik POSIX op).
4. mode 600, owner droidian.

Read sırasında schema_version kontrol; eski schema görülürse migration prosedürü çağrılır.

### 6.3 Migration: `.env` → `providers.json`

Boot zamanında `lib/store.js`:
```js
if (!fs.existsSync('data/providers.json') && process.env.AIRFORCE_API_KEY) {
  writeJson('data/providers.json', {
    schema_version: 1,
    providers: [{
      id: 'airforce',
      label: 'api.airforce',
      type: 'openai-compat',
      base_url: process.env.UPSTREAM_BASE_URL || 'https://api.airforce',
      api_key: process.env.AIRFORCE_API_KEY,
      enabled: true,
      rate_limit: { mult_per_min: Number(process.env.RATE_LIMIT_MULT_PER_MIN) || 10 },
      models: []
    }],
    aliases: {},
    global: { default_model: process.env.DEFAULT_MODEL || 'glm-4.6' }
  });
  log.info('migrated AIRFORCE_API_KEY → data/providers.json');
}
```

Migration sonrası model listesi boş; admin panel'den "Discover" tetiklenir veya eski `data/tool_capability.json` varsa modeller oradan import edilir (best-effort).

`.env`'de `AIRFORCE_API_KEY` artık opsiyonel. Yeni kullanıcı sadece admin panel'den ekler.

## 7. Admin Panel UI

Mevcut tek-sayfa panel üç sekmeye çıkar:

```
[Providers]  [Models]  [Logs / System]
```

### 7.1 Sekme 1: Providers

Provider kartları listesi, her biri açılıp kapanır.

```
┌─ ✅ airforce            (openai-compat)         [...]  [Disable]
│  Base URL: https://api.airforce
│  Key: sk-air-•••••••CGmi (24 chars)              [Reveal] [Edit]
│  Models: 12 enabled / 12 total
│  Health: ok (last check 2m ago)                   [Test now]
│  Rate limit: 10 mult/min  | RPM kullanılan: 3/10
└────────────────────────────────────────────────────────
```

**+ Add Provider** modal:

```
Type:       ◉ OpenAI-compatible    ○ Anthropic-native
ID:         [groq___________]   (slug, lowercase, unique)
Label:      [Groq___________]
Base URL:   [https://api.groq.com/openai_]
API Key:    [••••••••_______________]
Headers:    [+ add header]   (key/value table, optional)
Timeout:    [180000] ms
Rate limit: [rpm: 200]

[Test connection]   [Save]
```

`Test connection` `provider.healthCheck()` çağırır; başarısızsa Save butonu disabled kalır.

### 7.2 Sekme 2: Models

Her provider kartının altında **Discover Models** butonu. Tıklanınca provider'ın `/v1/models` endpoint'ine vurulur, sonuç checkbox listesinde gösterilir:

```
Discovering models from "openrouter"...

Found 142 models. Filter:
Exclude patterns: image, audio, embedding, tts, midjourney
─────────────────────────────────────────────
☐ Select all   ☐ Select tool-capable only (probe gerekir)
─────────────────────────────────────────────
☑ anthropic/claude-sonnet-4         priority [1]
☑ z-ai/glm-4.6                       priority [1]
☐ openai/gpt-4o
☐ google/gemini-2.5-flash
☐ x-ai/grok-4
☐ meta-llama/llama-4-scout
... (filtered: 27 model gizlendi)

[Cancel]                               [Add Selected (2)]
```

`Add Selected` → `data/providers.json` güncellenir, hot-reload, eklenen modeller probe kuyruğuna alınır (background).

**Birleşik tablo** (tüm provider'ların tüm modelleri):

```
Model                  Provider     Type   Native  XML   Priority  Enabled  Latency
glm-4.6                airforce     openai  ❌    ✅       0         ✅       274ms
glm-4.6                openrouter   openai  ✅    ✅       1         ✅       890ms
claude-sonnet-4        anthropic    anth.   ✅    ✅       0         ✅       1100ms
claude-sonnet-4        openrouter   openai  ✅    ✅       1         ✅       1320ms
```

Priority `[0][1][2]` input ile editlenebilir. Drag-drop v2.

### 7.3 Sekme 3: Logs / System

Mevcut log akışı + circuit breaker durumu (provider başına `closed/open/half-open`) + "Probe Now" + "Reset Breaker" butonları.

### 7.4 Yeni admin endpoint'leri

```
GET    /admin/api/providers                  → list
POST   /admin/api/providers                  → create
PUT    /admin/api/providers/:id              → update (key dahil)
DELETE /admin/api/providers/:id              → remove
POST   /admin/api/providers/:id/test         → healthCheck
POST   /admin/api/providers/:id/discover     → /v1/models proxy
POST   /admin/api/providers/:id/models       → bulk add (selected list)
PUT    /admin/api/providers/:id/models/:mid  → toggle/priority
DELETE /admin/api/providers/:id/models/:mid  → remove
POST   /admin/api/providers/:id/breaker/reset → reset breaker
GET    /admin/api/aliases                    → list
PUT    /admin/api/aliases                    → bulk update
GET    /admin/api/export                     → download JSON (key dahil)
POST   /admin/api/import                     → upload JSON
```

Mevcut `/admin/api/keys` endpoint'leri bridge API key'leri için; provider key'leri ayrı endpoint'lerde.

### 7.5 Güvenlik notları

- `data/providers.json` mode 600, owner droidian.
- Panel'de listelenirken key son 4 hane (`sk-air-•••CGmi`); `Reveal` butonu ile açıkça gösterilir.
- Public Funnel admin panel session token gereksinimini koruyor (zaten var).
- Export/import: kullanıcıya "key'ler dahil" uyarısı.

## 8. Probe (multi-provider)

### 8.1 Tetikleyiciler

1. **On-add probe** — admin panel'de yeni model eklendiğinde, sadece o `(provider, upstream_id)` çiftini probe et (background queue).
2. **Daily probe** — `PROBE_INTERVAL_HOURS` (default 24); registry'deki tüm `enabled` model entry'lerini gez.
3. **Manual probe** — admin panel'deki "Probe Now" butonu (provider veya global).

### 8.2 Akış (her `(provider, upstream_id)` çifti için)

```
1. Native test:
   provider.chat({tools: [TEST_TOOL], messages: [test], stream: false})
   → cevapta native_tool_calls geldi ve well-formed mı?
   → evet → native: true
   → hayır veya hata → native: false

2. XML test (her durumda):
   inject XML schema in system prompt + tools field kaldır
   provider.chat(...)
   → text'te <tool_calls> bloğu var ve extractToolCalls başarılı mı?
   → evet → xml: true
   → hayır → xml: false (model bridge için kullanılamaz)

3. Snapshot:
   { native, xml, latency_ms, last_probed_at, error?, ... }
```

### 8.3 Probe budget koruması

Her provider kendi rate-limit bucket'ını kullanır. Probe scheduler bucket capacity'sinin %50'sini geçmemeye çalışır (runtime istekleri için yer bırak). Bucket dolu olduğunda probe iş kuyrukta bekler.

### 8.4 Tier filtreleme

Mevcut `PROBE_TIER` (free/premium/all) mantığı sadece api.airforce ve "multiplier" kavramı olan provider'lar için anlamlı. Provider config'inde `probe_tier` field'ı opsiyonel; yoksa "all" varsayılır. Anthropic/OpenAI direkt provider'larda multiplier yok → tier göz ardı edilir, hepsi probe edilir.

## 9. Testing Strategy

Mevcut testler korunur, sadece import path'leri güncellenir. Yeni testler:

```
test/
├── parse.test.js                 (mevcut, korunur)
├── inject.test.js                (mevcut, korunur)
├── serialize-history.test.js     (mevcut, korunur)
├── tier.test.js                  (mevcut, korunur)
├── providers/
│   ├── openai-compat.test.js     (YENİ)
│   └── anthropic-native.test.js  (YENİ)
├── router.test.js                (YENİ)
├── model-registry.test.js        (YENİ)
├── store.test.js                 (YENİ)
└── integration/
    └── e2e-fallback.test.js      (YENİ)
```

**TDD prensibi:** her yeni dosya için önce test (red), sonra implement (green), sonra refactor.

**Mock strateji:** Provider testleri için fetch mock (gerçek upstream'e vurmadan). Router testleri için mock provider sınıfı (gerekirse `transient`/`auth`/`client` fırlatan).

**E2E:** `RUN_E2E=1` env flag'i ile gerçek provider'a vurup smoke testi (CI'da default kapalı). En az iki provider config'i ile fallback flow'u doğrula: birinci provider 5xx döndürür (mock), ikinci 200 döner — sonuç istemciye doğru ulaşmalı.

**Test komutu güncellemesi (`package.json`):**
```json
"test": "node --test test/*.test.js test/providers/*.test.js test/integration/*.test.js"
```

## 10. Migration Özeti

### 10.1 Mevcut sistem (airforce-bridge)

- `.env`'de `AIRFORCE_API_KEY` zorunlu.
- `data/tool_capability.json`: tek-upstream model listesi.
- Tek admin panel sayfası.

### 10.2 Yeni sistem (llm-bridge)

- Boot'ta `data/providers.json` yoksa **ve** `AIRFORCE_API_KEY` env'de varsa → otomatik tek-provider config'e migrate.
- `data/tool_capability.json` (eski format) varsa boot'ta okunur; her entry için key `<oldId>` → `airforce/<oldId>` olarak yeniden yazılır ve `data/capability.json` (schema_version: 2) olarak kaydedilir; eski dosya `.bak` uzantısıyla saklanır. İşlem otomatik ve tek seferlik.
- Admin panel sekmeli yapıya geçer; eski URL'ler 200 döner ama yeni UI gösterir.

### 10.3 Backward compatibility

- `.env`'deki `AIRFORCE_API_KEY` opsiyonel olur (set'liyse boot migration tetikler).
- `BRIDGE_API_KEYS`, `ADMIN_*`, `PORT`, `HOST` değişiklik yok.
- Probe-related env'ler (`PROBE_INTERVAL_HOURS`, `PROBE_TIER`, `PROBE_TIMEOUT_MS`, `PROBE_ON_BOOT`) korunur — sadece artık global default'tur, provider override'lar config'den gelir.
- Mevcut `/v1/chat/completions`, `/v1/messages`, `/v1/models`, `/healthz` endpoint'leri **aynı semantik**. Sadece `/v1/models` artık tüm provider'lardaki modelleri birleşik listeler.

## 11. Repo & Branch Stratejisi

- **Fork:** `NeronSignal/llm-bridge` (alicomert/airforce'tan fork).
- **upstream remote:** `https://github.com/alicomert/airforce.git` — orijinalden cherry-pick için.
- **`master`** her zaman çalışır durumda. Yeni release tag'leri (`v0.2.0`, ...) buradan kesilir.
- **`develop`** entegrasyon dalı. Implementation faz'ları develop'a PR'lanır, yeşilse master'a release PR.

**Implementation faz'ları (writing-plans skill'i bunu detaylandıracak):**
- `feat/01-provider-base` — `providers/base.js`, hata kategorileri, `OpenaiCompatProvider`. Mevcut adapter'ları yeni provider üzerinden çalıştır (router yok, tek provider varsayımı yumuşatılmış).
- `feat/02-router-registry` — `router.js`, `model-registry.js`, `circuit-breaker.js`. Çoklu provider config'le routing.
- `feat/03-anthropic-provider` — `AnthropicNativeProvider` + format dönüşümü (her iki yön).
- `feat/04-admin-panel-multi` — Sekmeli UI, CRUD endpoint'leri, discover akışı, migration.
- `feat/05-probe-multi` — Multi-provider probe, on-add tetikleyici, capability.json formatı.

Her faz develop'a PR; develop yeşilken master'a release PR.

## 12. Risk & Bilinmeyenler

1. **Anthropic format dönüşümü kompleksliği**: tool_use ve tool_result block'larının çoklu round-trip'leri (tool çağrı → result → tekrar çağrı) `serialize-history.js`'in mevcut yapısıyla nasıl etkileşeceği test edilmeli. v1 sadece text + tool_use + tool_result destekleniyor; image/document reddedilir (`client` hata).
2. **Streaming**: Mevcut bridge non-stream upstream + synthetic SSE yapıyor. Her iki provider tipi de v1'de non-stream'de tutulur (mevcut davranış); native streaming v2.
3. **Cost & token tracking**: Spec dışı. Logs'ta görülebilir; v2 feature.
4. **Otomatik retry idempotency**: Failover sadece **stream başlamadan** önce çalışır, yani provider çift bill etmez. Stream başladıktan sonra hata varsa retry yok (response yarısı zaten gitti).
5. **Probe maliyet patlaması**: 10 provider × 50 model = 500 probe = upstream rate limit yer. Provider başına bucket %50 cap koruması bunu sınırlar; ama yine de büyük kurulumda manuel probe tercih edilebilir (daily kapatılabilir).
6. **Model adı çakışmaları**: `gpt-4o` hem OpenAI direkt'te hem OpenRouter'da hem Together'da olabilir. Hibrit routing (kısa ad + priority) bunu yönetir; explicit prefix de her zaman alternatif.

## 13. Definition of Done

Bu spec'in implementation'ı, aşağıdaki kabul kriterleri sağlandığında tamamlanmış sayılır:

- Tüm mevcut testler (`parse`, `inject`, `serialize-history`, `tier`) yeşil.
- Yeni testler yazıldı ve yeşil: `router`, `model-registry`, `store`, `providers/openai-compat`, `providers/anthropic-native`, `integration/e2e-fallback`.
- Mevcut `airforce` config tek provider olarak migrate ediliyor; eski `/v1/chat/completions` istekleri kırılmadan çalışmaya devam ediyor.
- Admin panel'den yeni provider eklenip (örn: gerçek bir Anthropic key ile), `claude-sonnet-4` modeli ile çağrı yapılabiliyor.
- Failover senaryosu çalışıyor: priority 0 provider'a 502 döndürüldüğünde priority 1 provider'a düşüyor, istemciye 200 dönüyor.
- Discover akışı çalışıyor: yeni provider eklendiğinde `/v1/models` çekilip checkbox UI'da gösteriliyor; seçim sonrası eklenen modeller probe kuyruğuna giriyor.
- Capability snapshot multi-provider key formatına geçti; admin panel'de native/XML kolonu doğru gösteriyor.
- README güncel: yeni özellikler, provider tipleri, migration notları.
- `package.json` `name`, `description` güncel; `version: 0.2.0`.
