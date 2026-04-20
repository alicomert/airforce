# Airforce Compatibility Proxy

`api.airforce` icin local compatibility proxy.

Amac:

- `2393` portunda dinlemek
- `/anthropic/*` ve `/v1/*` isteklerini upstream'e forward etmek
- Bozuk `<think>` ve `<tool_call>` ciktilarini standard tool-call formatina cevirmek
- `stream: true` isteklerinde upstream'i non-stream cagirip valid SSE stream donmek
- Gerekirse model alias kullanip client tarafinda resmi model adlarini korumak

## Calistirma

```bash
PORT=2393 \
UPSTREAM_BASE_URL=https://api.airforce \
AIRFORCE_API_KEY=your_key_here \
node server.js
```

## Model alias

Opsiyoneldir. `MODEL_ALIASES` vermezsen proxy istemciden gelen model adini aynen upstream'e yollar.

Claude Code gibi istemciler model adina gore capability kontrolu yapiyorsa localde resmi model adini kullanip upstream'de farkli modele map edebilirsin:

```bash
MODEL_ALIASES='{"claude-sonnet-4-20250514":"provider/actual-model-id"}' node server.js
```

Bu durumda istemci `claude-sonnet-4-20250514` gonderir, proxy upstream'e `provider/actual-model-id` yollar, response'ta tekrar istemcinin orijinal model adini gosterir.
