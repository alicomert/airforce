# LLM Bridge

Kisisel kullanim icin tasarlanmis, OpenAI ve Anthropic uyumlu coklu LLM API koprusu.

Bu proje farkli LLM servislerini tek bir API catisi altinda toplar. Amac; OpenAI uyumlu istemciler, Anthropic uyumlu istemciler, agent araclari ve tool/function calling kullanan uygulamalar icin tek bir yerel endpoint saglamaktir.

## Ne Ise Yarar?

- Birden fazla upstream provider'i tek API uzerinden kullanma
- OpenAI uyumlu `/v1/chat/completions`, `/v1/responses`, `/v1/models` endpointleri
- Anthropic uyumlu `/v1/messages` endpointi
- Tool/function calling destegi
- Native tool-call donen modellerde passthrough
- Native tool-call desteklemeyen modellerde XML tabanli tool-call parse/translate katmani
- Model alias, provider onceligi ve fallback
- Provider hata izolasyonu icin circuit breaker
- Basit rate limit ve probe altyapisi
- Admin paneli ile model, provider, log ve probe takibi
- Stream isteyen istemciler icin synthetic SSE cikisi

## Temel Fikir

LLM Bridge istemciler ile upstream LLM servisleri arasinda duran kisisel bir gateway'dir.

```text
Client / Agent / SDK
        |
        v
LLM Bridge
  - auth
  - routing
  - model aliases
  - tool-call engine
  - provider fallback
        |
        v
OpenAI-compatible or Anthropic-compatible providers
```

Istemci tarafinda tek bir `base_url` ve tek bir API key kullanilir. Bridge, istegi uygun provider'a yonlendirir, gerekirse tool-call formatini donusturur ve cevabi istemcinin bekledigi OpenAI veya Anthropic formatinda dondurur.

## Desteklenen Arayuzler

| Arayuz | Endpoint | Aciklama |
|---|---|---|
| Health | `GET /healthz` | Servis durumu |
| Models | `GET /v1/models` | Bridge tarafindan sunulan modeller |
| OpenAI Chat | `POST /v1/chat/completions` | OpenAI uyumlu chat completions |
| OpenAI Responses | `POST /v1/responses` | OpenAI Responses uyumlu endpoint |
| Anthropic Messages | `POST /v1/messages` | Anthropic Messages uyumlu endpoint |
| Admin UI | `GET /admin` | Web panel |
| Admin API | `/admin/api/*` | Panel ve yonetim API'leri |

## Kurulum

Gereksinim: Node.js 20 veya uzeri.

```bash
npm install
npm start
```

Varsayilan adres:

```text
http://0.0.0.0:2393
```

Lokal test:

```bash
curl http://localhost:2393/healthz
```

## Ortam Degiskenleri

Asgari olarak bridge icin bir istemci anahtari ve en az bir provider konfiguru gerekir.

`.env` dosyasi ornegi:

```env
PORT=2393
HOST=0.0.0.0

BRIDGE_API_KEYS=sk-local-example
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me

TOOL_ENGINE_FORCE_XML=1
TOOL_ENGINE_FORMAT=canonical

PROBE_INTERVAL_HOURS=24
PROBE_ON_BOOT=1
RATE_LIMIT_MULT_PER_MIN=10
LOG_LEVEL=info
```

Notlar:

- `BRIDGE_API_KEYS`, istemcilerin `Authorization: Bearer ...` veya `x-api-key` ile kullanacagi bridge anahtarlaridir.
- `ADMIN_USERNAME` ve `ADMIN_PASSWORD`, web panel girisi icindir.
- `TOOL_ENGINE_FORCE_XML=1`, tum modellerde bridge'in kendi XML tool-call akisini kullanmasini saglar.
- `TOOL_ENGINE_FORCE_XML=0`, native tool-call destekleyen modellerde passthrough davranisini tercih eder.

## Provider Konfigurasyonu

Provider'lar `data/providers.json` icinden okunur. Iki provider tipi desteklenir:

- `openai-compat`: OpenAI uyumlu `/v1/chat/completions` ve `/v1/models` sunan servisler
- `anthropic-native`: Anthropic uyumlu Messages API sunan servisler

Ornek:

```json
{
  "schema_version": 1,
  "global": {
    "circuit_breaker": {
      "fail_threshold": 3,
      "open_seconds": 60
    }
  },
  "aliases": {
    "fast": "provider-a/model-small",
    "smart": [
      "provider-b/model-large",
      "provider-a/model-large"
    ]
  },
  "providers": [
    {
      "id": "provider-a",
      "type": "openai-compat",
      "enabled": true,
      "base_url": "https://example-openai-compatible.local/v1",
      "api_key": "sk-provider-key",
      "models": [
        {
          "upstream_id": "model-small",
          "presented_id": "fast-model",
          "enabled": true,
          "priority": 10
        }
      ]
    },
    {
      "id": "provider-b",
      "type": "anthropic-native",
      "enabled": true,
      "base_url": "https://example-anthropic-compatible.local",
      "api_key": "sk-provider-key",
      "models": [
        {
          "upstream_id": "model-large",
          "presented_id": "smart-model",
          "enabled": true,
          "priority": 20
        }
      ]
    }
  ]
}
```

Model cagirma sekilleri:

- Kisa ad: `fast-model`
- Alias: `fast`
- Provider prefix'i ile kesin hedef: `provider-a/model-small`

Birden fazla provider ayni model adini sunuyorsa bridge `priority` degerine gore siralar ve hata halinde uygun fallback adayina gecer.

## Istemci Entegrasyonu

OpenAI uyumlu istemciler:

```bash
export OPENAI_BASE_URL=http://localhost:2393/v1
export OPENAI_API_KEY=sk-local-example
```

Anthropic uyumlu istemciler:

```bash
export ANTHROPIC_BASE_URL=http://localhost:2393
export ANTHROPIC_API_KEY=sk-local-example
```

## Ornek Istekler

OpenAI Chat Completions:

```bash
curl http://localhost:2393/v1/chat/completions \
  -H "Authorization: Bearer $BRIDGE_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "fast",
    "messages": [
      { "role": "user", "content": "Merhaba" }
    ]
  }'
```

Anthropic Messages:

```bash
curl http://localhost:2393/v1/messages \
  -H "x-api-key: $BRIDGE_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{
    "model": "smart",
    "max_tokens": 1024,
    "messages": [
      { "role": "user", "content": "Merhaba" }
    ]
  }'
```

Model listesi:

```bash
curl http://localhost:2393/v1/models \
  -H "Authorization: Bearer $BRIDGE_KEY"
```

## Tool Calling

Bridge iki farkli yolu destekler:

1. Native passthrough: Upstream model zaten tool-call alanlari donduruyorsa bu bilgiler korunur.
2. XML inject/parse: Native tool-call desteklemeyen modeller icin bridge system prompt'a XML semasi ekler, model cevabindaki XML'i parse eder ve sonucu OpenAI/Anthropic native tool-call formatina cevirir.

Varsayilan canonical XML formati:

```xml
<tool_calls>
  <invoke name="get_weather">
    <parameter name="city">Istanbul</parameter>
    <parameter name="unit">c</parameter>
  </invoke>
</tool_calls>
```

JSON tipli parametreler de parametre degeri olarak yazilabilir:

```xml
<parameter name="filter">{"status":"open","limit":10}</parameter>
```

Bridge, code block icindeki XML'i tool-call olarak yorumlamamaya calisir. Bu sayede modelin ornek olarak yazdigi XML ile gercek tool-call niyeti birbirinden ayrilir.

## Admin Paneli

Panel:

```text
http://localhost:2393/admin
```

Panel uzerinden:

- Provider ve model durumlari gorulebilir
- Alias ve model yonlendirmeleri takip edilebilir
- Log ring buffer incelenebilir
- Manuel probe tetiklenebilir
- Admin API uzerinden konfigurasyon islemleri yapilabilir

## Gelistirme

```bash
npm run dev
npm test
npm run probe
```

Komutlar:

- `npm run dev`: Node watch mode ile calistirir
- `npm test`: `node:test` tabanli testleri calistirir
- `npm run probe`: Tool-call capability probe'unu tek seferlik calistirir

## Operasyon Notlari

- Bridge'i internete acacaksaniz mutlaka guclu `BRIDGE_API_KEYS` kullanin.
- Admin panelini public acmayin veya ters proxy seviyesinde ek auth kullanin.
- Provider API key'lerini repoya commit etmeyin.
- `data/providers.json` icinde gercek key tutulacaksa dosya izinlerini sinirlayin.
- Public deployment'ta loglarda prompt veya tool sonucu gibi hassas veri olabilecegini hesaba katin.

## Lisans

MIT.
