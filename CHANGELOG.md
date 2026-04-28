# Changelog

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
