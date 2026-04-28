# Airforce Bridge

`api.airforce` üzerine kurulu, **tool call destekli** OpenAI + Anthropic uyumlu köprü sunucu.

**Önemli**: `api.airforce` gateway'i resmi olarak hiçbir model için tool calling desteklemez (panel'deki "Function Calling" filtresi 0 model döndürür). Tool call sistemini tamamen bu köprü kuruyor:

- Bazı upstream provider modelleri (GLM, Llama, GPT-OSS, vb.) **kendi yetenekleriyle** `tool_calls` field'ini doğal olarak doldurur ve gateway transparent geçirir → biz buna **passthrough** diyoruz.
- Diğer modeller hiçbir tool field'i dönmez → bu durumda system-prompt'a `<tool_calls>` XML şeması enjekte edip, model çıktısındaki XML'i parse edip OpenAI/Anthropic native formatına çeviriyoruz.

Her iki yolda da fiili tool-call mantığı bu köprüde yaşar. Ek olarak, **günde bir kere** tüm modelleri probe eder; passthrough vs XML desteğini ölçer; sadece capable modelleri `/v1/models`'da sunar.

## Hızlı başlangıç

```bash
cp .env.example .env
# .env'de AIRFORCE_API_KEY ve BRIDGE_API_KEYS / ADMIN_TOKEN düzenle
npm start
```

Sunucu varsayılan `http://0.0.0.0:2393` üzerinde dinler.

- **Panel**: `http://localhost:2393/admin`
- **Health**: `http://localhost:2393/healthz`

## Endpoint'ler

İstemcide Bearer veya `x-api-key` olarak `BRIDGE_API_KEYS`'ten birini gönder.

```bash
# OpenAI uyumlu
curl http://localhost:2393/v1/chat/completions \
  -H "Authorization: Bearer $BRIDGE_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"glm-4.6","messages":[...],"tools":[...]}'

# Anthropic uyumlu
curl http://localhost:2393/v1/messages \
  -H "x-api-key: $BRIDGE_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"glm-4.6","max_tokens":1024,"messages":[...],"tools":[...]}'

# Models (sadece tool-capable olanlar)
curl http://localhost:2393/v1/models -H "Authorization: Bearer $BRIDGE_KEY"
```

## İstemci entegrasyonları

**Codex CLI / OpenAI SDK**: `OPENAI_BASE_URL=http://localhost:2393/v1` ve `OPENAI_API_KEY=$BRIDGE_KEY` ayarla.

**Claude Code / Anthropic SDK**: `ANTHROPIC_BASE_URL=http://localhost:2393` ve `ANTHROPIC_API_KEY=$BRIDGE_KEY`. (Claude Code, `/v1/messages` path'ini kendi ekliyor.)

## Mimari

```
İstemci → /v1/chat/completions   ──▶ OpenAI adapter
                                    │
İstemci → /v1/messages           ──▶ Anthropic adapter
                                    │
                                    ▼
                            tool-engine/inject.js
                                    │  (system'e XML şema)
                                    ▼
                            tool-engine/serialize-history.js
                                    │  (önceki tool_calls/result'ları XML'e indir)
                                    ▼
                            upstream.js (api.airforce, non-stream)
                                    │
                                    ▼
                            tool-engine/parse.js + anti-leak.js
                                    │  (text'ten <tool_calls> çıkar)
                                    ▼
                            tool-engine/translate.js
                                    │  (OpenAI/Anthropic native formata çevir)
                                    ▼
                            sse.js (stream istendiyse synthetic SSE)
                                    │
                                    ▼
                                 İstemci
```

Yan akışta:
- `probe.js` → her chat-supports model için native + XML tool testi → `data/tool_capability.json`
- `scheduler.js` → `PROBE_INTERVAL_HOURS` (default 24) periyoduyla otomatik
- `admin-router.js` → panel API'leri (key yönetimi, log akışı, manuel probe)

## Geliştirme

```bash
npm test            # node:test ile tüm unit testler
npm run dev         # --watch mode
npm run probe       # tek seferlik probe
```

## Konfigürasyon

`.env` (öncelikli) ve `config.json` (opsiyonel) iki kaynak var. Önemli alanlar:

| Env | Default | Açıklama |
|---|---|---|
| `AIRFORCE_API_KEY` | – | Upstream key (zorunlu) |
| `PORT` | 2393 | – |
| `BRIDGE_API_KEYS` | (boş) | Virgüllü liste; boşsa sadece localhost'a izin |
| `ADMIN_TOKEN` | (boş) | Panel girişi; boşsa BRIDGE_API_KEYS'in ilki |
| `TOOL_ENGINE_FORCE_XML` | 1 | Native tool_calls'u baskıla, hep XML kullan |
| `TOOL_ENGINE_FORMAT` | canonical | `canonical` veya `dsml` |
| `PROBE_INTERVAL_HOURS` | 24 | Probe tekrar süresi |
| `PROBE_ON_BOOT` | 1 | Boot'ta da probe çalıştır |

Model alias'ları `config.json` içinde tanımlanır:

```json
{ "model_aliases": { "claude-sonnet-4-20250514": "glm-4.6" } }
```

## Tool-call XML formatı

Default canonical format:

```xml
<tool_calls>
  <invoke name="get_weather">
    <parameter name="city">Istanbul</parameter>
    <parameter name="unit">c</parameter>
  </invoke>
</tool_calls>
```

Anti-leak: code-block (`` ``` ``) içindeki XML görmezden gelinir.
JSON-tipli parametreler için değer JSON olarak yazılır:

```xml
<parameter name="filter">{"status":"open","limit":10}</parameter>
```

## Lisans
MIT.
