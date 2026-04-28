# Changelog

## [0.7.0] — Phase 5: Multi-provider Probe (native + xml)

- `lib/probe.js` — her `(provider, model)` çifti için **iki test**: native tool calling (provider'a `tools` field gider; cevapta `native_tool_calls` well-formed mi) + XML inject (mevcut). Capability snapshot: `native: bool`, `xml: bool`, `latency_ms` (öncelik native'in latency'si).
- Native test sadece `supportsNativeTools()` true dönen provider'larda çalışır (openai-compat, anthropic-native).
- Bucket charge per test (rate limit korunur).

## [0.6.0] — Phase 4b: Built-in Admin Chatbot

- `lib/admin-chatbot/{tool-dispatcher,system-prompt,chatbot-router,audit-log}.js`
- `lib/admin-chatbot/tools/{system-status,repo-access,provider-mutate,model-mutate,actions}.js` — 24 tool toplam
- `POST /admin/api/chat` — SSE streaming (events: `meta`, `text`, `tool_use`, `tool_result`, `done`, `error`)
- `web/tabs/chat.js` — vanilla JS chat UI; localStorage history; model picker (`/v1/models`'tan beslenir)
- `data/audit-log.json` — NDJSON; sadece mutating tool çağrıları; api_key/secret alanları `<redacted>`
- Multi-turn loop max 10 turn; tool result max 50KB
- Repo erişimi whitelist'le sınırlı (`lib/`, `docs/`, `web/`, `test/`, root files); `.env`, `data/`, `node_modules/` yasak
- System prompt runtime context içerir (provider listesi, son probe, son 5 log satırı)

## [0.5.0] — Phase 4a: Admin Panel Core

- Sekmeli admin panel (Providers / Models / Logs)
- `lib/providers/config-schema.js` — provider/model/file validation
- `lib/admin-router.js` — ~15 yeni endpoint (provider CRUD, models bulk, discover, breaker reset, breakers list, aliases, export/import)
- `lib/providers/factory.js` — `invalidateRouterCache()` public (admin mutations sonrası çağrılır)
- `web/index.html` + `web/app.js` — yeniden yazıldı, basit login + tab router
- `web/tabs/{providers,models,logs}.js` — yeni vanilla JS modülleri (no framework)
- `web/styles.css` — palette korundu, sade ve tutarlı sekmeli yapı
- Hot-reload: panelden provider/model değişikliği → cache invalidate → sonraki istek yeni state
- 9 yeni test (config-schema 8 + hot-reload 1; HTTP integration test'leri smoke ile doğrulandı)

## [0.4.0] — Phase 3: Anthropic Native Provider

- `lib/providers/anthropic-native.js` — `AnthropicNativeProvider` plugin (api.anthropic.com)
- `lib/providers/format-conversion.js` — OpenAI ↔ Anthropic body/response converters (system extract, tool_use blocks, tools→input_schema, stop_reason map, usage map)
- `lib/providers/factory.js` — `'anthropic-native'` tipi register
- `lib/adapters/anthropic.js` — anthropic-native provider'ı önce dener; yoksa openai-compat'a fallback (api.airforce gibi)
- v1 limit: text + tool_use + tool_result content blocks (image/document v2)
- 15 yeni test (format-conversion 9 + anthropic-native 6 → toplam 93/93 PASS)

## [0.3.0] — Phase 2: Router & Registry

- `lib/circuit-breaker.js` — `CircuitBreaker` (closed/open/half-open state machine) + `CircuitBreakerRegistry`
- `lib/model-registry.js` — short/prefix/alias resolution, `markModelUnavailable`, priority-ordered fallback list
- `lib/router.js` — `Router.execute()` provider listesini gez; transient/auth/bad_model → next; client → fatal; `AllProvidersFailedError`
- `lib/store.js` — `data/providers.json` schema (atomic write, mode 600) + boot-time migration (`AIRFORCE_API_KEY` → providers.json)
- `lib/rate-limit.js` — per-provider Map<id, Bucket>; `getBucket(providerId)`, `configureBucket`
- `lib/providers/factory.js` — `getRouter()` builds Router from providers.json; `buildProviderInstance` + `buildRouter` (test)
- `lib/adapters/openai.js` — routes through Router (`router.execute(modelId, body)`)
- `lib/adapters/models.js` — multi-provider unified listing (`registry.listAllModels()`)
- `lib/probe.js` — gez registry'deki tüm `(provider, model)` çiftleri; capability key formatı `${providerId}/${modelId}`
- `lib/capability.js` — yeni key formatı; `resolveModel` kalktı (registry resolution kullanılıyor)
- Anthropic adapter geçici köprüsünü tutuyor; Phase 3'te `AnthropicNativeProvider` ile değişecek
- 35 yeni test (circuit-breaker 8, store 6, model-registry 9, router 9, integration 2, factory 3 — toplam 78/78 PASS)

## [0.2.0] — Phase 1: Provider Base (released as v0.2.0-phase1)

- Provider plugin abstraction (`lib/providers/base.js`, `lib/providers/openai-compat.js`, `lib/providers/factory.js`)
- `lib/upstream.js` removed; replaced by `OpenaiCompatProvider`
- Adapter'lar (`openai`, `anthropic`, `models`) ve `probe.js` artık provider üzerinden çalışıyor
- Tool-engine modülleri değişmedi (`inject`, `parse`, `translate`, `serialize-history`, `anti-leak`)
- Anthropic adapter geçici olarak `provider.request('POST', '/v1/messages', body)` köprüsü kullanıyor; Phase 3'te `AnthropicNativeProvider` ile değişecek
- Yeni testler: `test/providers/base.test.js` (8), `test/providers/openai-compat.test.js` (9), `test/providers/factory.test.js` (2)
- `package.json` test script'i `test/*.test.js test/providers/*.test.js` glob'una geçti
- Toplam test: 24 (mevcut) + 19 (yeni) = 43, hepsi PASS
