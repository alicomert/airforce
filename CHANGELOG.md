# Changelog

## [Unreleased] — Phase 1: Provider Base

- Provider plugin abstraction (`lib/providers/base.js`, `lib/providers/openai-compat.js`, `lib/providers/factory.js`)
- `lib/upstream.js` removed; replaced by `OpenaiCompatProvider`
- Adapter'lar (`openai`, `anthropic`, `models`) ve `probe.js` artık provider üzerinden çalışıyor
- Tool-engine modülleri değişmedi (`inject`, `parse`, `translate`, `serialize-history`, `anti-leak`)
- Anthropic adapter geçici olarak `provider.request('POST', '/v1/messages', body)` köprüsü kullanıyor; Phase 3'te `AnthropicNativeProvider` ile değişecek
- Yeni testler: `test/providers/base.test.js` (8), `test/providers/openai-compat.test.js` (9), `test/providers/factory.test.js` (2)
- `package.json` test script'i `test/*.test.js test/providers/*.test.js` glob'una geçti
- Toplam test: 24 (mevcut) + 19 (yeni) = 43, hepsi PASS
