# Phase 4a — Admin Panel Core Design Spec

- **Date:** 2026-04-28
- **Repo:** `NeronSignal/llm-bridge`
- **Builds on:** Phase 1 (provider abstraction), Phase 2 (router + registry), Phase 3 (anthropic-native)
- **Status:** Draft, awaiting review

## 1. Motivation

Bridge mevcut admin panel'i tek sayfa, küçük (key listesi, log tail, manual probe). Multi-provider sistemde kullanıcının ihtiyaçları büyüdü: provider eklemek, model listelerini keşfetmek, hangi modelin hangi provider'da olduğunu görmek, breaker'ları sıfırlamak. Phase 4a bu ihtiyaçların **UI ve endpoint** tarafını kuruyor. Built-in chatbot Phase 4b'de eklenir.

## 2. Scope

**In:**
- Sekmeli yapıya geçiş: `Providers` / `Models` / `Logs`
- Provider CRUD (create/read/update/delete; key dahil tüm config panelden)
- Provider için "Test connection" (`healthCheck()`) — kaydetmeden önce zorunlu
- Model auto-discover (`provider.listModels()`) → checkbox UI ile seçim → bulk add
- Models birleşik tablosu (provider × model, native/xml/priority/enabled/latency)
- Manual probe (provider başına veya tümü)
- Breaker reset (provider başına; "Reset breaker" butonu)
- Export/import providers.json (key dahil, panel uyarısıyla)
- Hot-reload: panelden değişiklik → router cache invalidate → yeni state

**Out (Phase 4b):**
- Chat sekmesi
- Built-in chatbot endpoint
- Tool catalog ve dispatcher

**Out (Phase 5):**
- Native tool capability detayı (probe iki-adımlı)
- On-add automatic probe queue

## 3. UI Architecture

```
┌─ llm-bridge admin ──────────────────────────────────┐
│ [Providers]  [Models]  [Logs]                       │
│                                                      │
│ <selected tab content>                               │
│                                                      │
└──────────────────────────────────────────────────────┘
```

`web/index.html` tek sayfa, `web/app.js` tab router'ı (DOM mutation, no framework). Her sekme bir component fonksiyonu.

### 3.1 Providers tab

Provider kartları (her biri açılır panel). Header: enabled checkbox, label, type badge, "test now" + "edit" + "delete" butonları. Detay: base_url, key (mask + reveal), model count, last health check, rate-limit kullanımı.

`+ Add Provider` modal:
- Type radio (`openai-compat` / `anthropic-native`)
- ID slug (lowercase, unique validation)
- Label (display)
- Base URL
- API Key (password input)
- Headers (key/value tablosu, opsiyonel)
- Timeout, rate_limit
- `Test connection` butonu (zorunlu — başarılı olmadan Save disabled)

### 3.2 Models tab

Her provider'ın altında `Discover Models` butonu. Modal:
- "Discovering from <provider>..." spinner
- Sonuç listesi: 50+ model olabilir. Filter input + exclude pattern listesi (default: `image, audio, embedding, tts, midjourney, suno`)
- Checkbox seçimi (Select all, Select tool-capable only — capability snapshot varsa)
- Per-row priority input (default 0)
- `Add Selected (N)` butonu

Birleşik tablo (tüm provider × model):
| Model | Provider | Type | Native | XML | Priority | Enabled | Latency |
Sıralama: priority asc, sonra provider id asc.

Inline edit: priority numeric input, enabled toggle. Değişiklik → debounced save (1s).

### 3.3 Logs tab

- Live tail (mevcut log ring + SSE; `/admin/api/logs` zaten var)
- Breaker durumları (her provider için state + reason + last fail timestamp + `Reset` butonu)
- Manual probe paneli: provider seçimi + `Run probe` (background; progress events SSE)
- Export/import: `Export config` (download JSON), `Import config` (file picker, confirm overwrite)

## 4. New endpoints

```
GET    /admin/api/providers                      → list (with masked keys)
POST   /admin/api/providers                      → create
PUT    /admin/api/providers/:id                  → update
DELETE /admin/api/providers/:id                  → remove
POST   /admin/api/providers/:id/test             → healthCheck
POST   /admin/api/providers/:id/discover         → /v1/models proxy
POST   /admin/api/providers/:id/models           → bulk add (selected)
PUT    /admin/api/providers/:id/models/:upstream → toggle/priority
DELETE /admin/api/providers/:id/models/:upstream → remove
POST   /admin/api/providers/:id/breaker/reset    → reset breaker
POST   /admin/api/probe/run                      → trigger probe (body: {provider_id?})
GET    /admin/api/aliases                        → list
PUT    /admin/api/aliases                        → bulk update
GET    /admin/api/export                         → download JSON
POST   /admin/api/import                         → upload JSON (validate schema first)
```

Auth: mevcut admin session token. CSRF: yok (Tailscale Funnel zaten public ama session zorunlu, yeterli güvence).

## 5. Hot-reload mechanics

`lib/providers/factory.js`'in `cachedRouter`'ı her mutation sonrası invalidate. Akış:

1. `PUT /admin/api/providers/:id` → `lib/store.js` `saveProvidersConfig(cfg)` (atomic)
2. `factory._resetRouterForTests()` (ad değiştir → `_invalidateCache()`)
3. Sonraki `getRouter()` çağrısı yeni config'i okur ve yeni instance'ları kurar
4. In-flight istekler eski instance'ları kullanmaya devam eder (referans tutuldu)
5. Eski instance'lar GC'lenir

**Restart gerek yok.**

## 6. Validation

`lib/providers/config-schema.js` (yeni):
- Required fields per type (openai-compat, anthropic-native)
- ID slug format (`/^[a-z0-9_-]+$/`)
- URL format check
- model.upstream_id non-empty
- priority numeric
- Duplicate ID check across providers

Hata response shape: `{ error: { field: 'base_url', message: 'invalid URL' } }`.

## 7. Frontend implementation notes

- Vanilla JS (`web/app.js`), no framework. Mevcut tek-sayfa pattern korunur.
- Komponent dosya yapısı:
  ```
  web/
  ├── index.html
  ├── app.js              (entry, tab router, session)
  ├── tabs/
  │   ├── providers.js    (~300 satır)
  │   ├── models.js       (~250 satır)
  │   └── logs.js         (~200 satır)
  ├── components/
  │   ├── modal.js
  │   ├── card.js
  │   └── table.js
  └── styles.css          (mevcut + ek 200 satır)
  ```
- ESM (`<script type="module" src="/admin/static/app.js">`).
- Static handler `server.js`'de zaten var; sadece klasör derinliğine izin ver.

## 8. Testing

- `test/admin/providers-api.test.js` — endpoint integration (mock fetch, in-memory store override)
- `test/admin/config-schema.test.js` — validation rules
- `test/admin/hot-reload.test.js` — mutation → cache invalidate → next call sees new config
- Frontend testleri yok (vanilla JS, manual smoke yeterli)

## 9. Migration

- `data/providers.json` schema_version 1 (Phase 2'den beri var) — değişmiyor.
- Mevcut admin panel HTML'i tamamen yeniden yazılır (sekmeli yapı).
- Eski `/admin/api/keys` endpoint'leri (bridge API key yönetimi) korunur — yeni `Logs` tab'ında veya ayrı bir `Settings` mini sekmesinde gösterilir. Şimdilik aynı log sekmesinde "Bridge API Keys" bölümü.

## 10. Definition of Done

- 3 sekme açılıp çalışıyor (no console errors)
- Provider CRUD end-to-end (test'le doğrulanmış)
- Discover akışı: gerçek provider'a vurmadan mock fetch ile çalışan integration test
- Hot-reload: mutation sonrası router cache invalidate, sonraki istek yeni state'i görür
- Tüm Phase 1-3 testleri yeşil
- Smoke test: lokal server boot + panel'den yeni provider ekle (örn. ikinci api.airforce key'iyle) + chat completion başarılı

## 11. Risks & Open Questions

- **API key panel'de düz JSON**: `data/providers.json` mode 600 ama disk encryption kullanıcı sistemine bağlı. Phase 4b'de chatbot da aynı key'lere erişebilecek (audit log var). Not: mevcut tasarımda kabul edildi (D seçeneği §6.1 brainstorm).
- **Model listesi büyük olabilir**: 50+ model — UI virtualization gerek mi? v1 değil; tabular DOM yeterli.
- **Concurrent mutations**: aynı admin sekmeden iki tab → aynı kaynağı edit. Lock yok, last-write-wins. v1 kabul.
