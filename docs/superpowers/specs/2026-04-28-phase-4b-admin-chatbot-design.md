# Phase 4b — Built-in Admin Chatbot Design Spec

- **Date:** 2026-04-28
- **Repo:** `NeronSignal/llm-bridge`
- **Builds on:** Phase 4a (admin panel core sekmeli yapısı)
- **Status:** Draft, awaiting review

## 1. Motivation

Bridge yöneticisi (kullanıcı: Halil) bridge'i tanımak, test etmek ve hızlı admin işleri için bir yardımcıya ihtiyaç duyuyor. Phase 4b admin panele **bridge'in kendisini bilen** bir chatbot ekler: panel açılır, sağ üstte `Chat` sekmesi, model seçilir, sohbet edilir. Chatbot kendi sistem prompt'u sayesinde mimari, dosya yapısı, mevcut tool listesi vs. konularda doğrudan cevap verebilir; tool calling ile gerçek zamanlı sistem durumunu sorgulayabilir ve config'i değiştirebilir.

## 2. Scope

**In:**
- `Chat` sekmesi (Phase 4a'nın 4. sekmesi olarak eklenir)
- `POST /admin/api/chat` endpoint'i (auth: admin session)
- Tool catalog: ~20 tool (sistem durumu, repo erişimi, config mutation, action'lar)
- Tool dispatcher (name → handler mapping, schema validation)
- System prompt (chatbot self-awareness)
- Audit log (`data/audit-log.json`) — tüm mutating tool'lar
- Streaming UI (SSE: `event: tool_use`, `event: tool_result`, `event: text`)
- Browser localStorage history (sonra silinebilir; server-side persistence v2)

**Out (v2):**
- Multi-session history server-side
- Tool confirmation UI ("are you sure?" dialog)
- Multi-modal (image attachments)

## 3. Architecture

### 3.1 Yeni dosyalar

```
lib/admin-chatbot/
├── chatbot-router.js         (POST /admin/api/chat handler + multi-turn loop)
├── tool-dispatcher.js        (name → handler; schema validation; audit hook)
├── system-prompt.js          (build prompt with runtime context)
├── tools/
│   ├── system-status.js      (list_providers, get_provider_status, list_models,
│   │                          get_capability_snapshot, get_breaker_state, get_logs)
│   ├── repo-access.js        (read_repo_file, list_repo_files; whitelist enforcement)
│   ├── provider-mutate.js    (create_provider, update_provider, delete_provider,
│   │                          toggle_provider, set_provider_rate_limit)
│   ├── model-mutate.js       (add_model, remove_model, toggle_model, set_priority,
│   │                          set_alias, remove_alias)
│   └── actions.js            (run_probe, reset_breaker, discover_models,
│                              export_config, restart_router_cache)
└── audit-log.js              (append-only NDJSON; rotates at 10MB)

web/tabs/chat.js              (~400 satır; UI logic)
test/admin-chatbot/
├── tool-dispatcher.test.js
├── tools/repo-access.test.js (whitelist enforcement)
├── tools/system-status.test.js
└── tools/provider-mutate.test.js
```

### 3.2 Request flow

```
İstemci (Chat sekmesi UI) → POST /admin/api/chat
        body: { messages, model: "glm-4.6", stream: true }
        │
        ▼
chatbot-router.js
  - sistem prompt'u messages başına ekle (eğer henüz eklenmediyse)
  - tool catalog'u body'ye ekle (tools field)
  - getRouter().execute(model, body) çağır (bridge kendi router'ına HTTP'siz erişir)
        │
        ▼
Router → uygun provider → response
        │
        ├─ native_tool_calls var mı?
        │   ├─ var → tool-dispatcher.js her tool'u çağır
        │   │       sonuçları tool message olarak history'ye ekle
        │   │       loop: tekrar router.execute (max 10 turn)
        │   └─ yok → final assistant message
        │
        ▼
SSE stream:
  event: tool_use   data: { name, args }
  event: tool_result data: { name, result }
  event: text       data: token
  event: done       data: { stop_reason, total_turns }
```

### 3.3 Tool dispatcher

```js
// lib/admin-chatbot/tool-dispatcher.js
import * as systemStatus from './tools/system-status.js';
import * as repoAccess from './tools/repo-access.js';
import * as providerMutate from './tools/provider-mutate.js';
import * as modelMutate from './tools/model-mutate.js';
import * as actions from './tools/actions.js';
import { auditLog } from './audit-log.js';

const REGISTRY = {
  ...systemStatus.tools,
  ...repoAccess.tools,
  ...providerMutate.tools,
  ...modelMutate.tools,
  ...actions.tools,
};

const MUTATING_TOOLS = new Set([
  'create_provider', 'update_provider', 'delete_provider', 'toggle_provider',
  'set_provider_rate_limit', 'add_model', 'remove_model', 'toggle_model',
  'set_priority', 'set_alias', 'remove_alias', 'export_config',
]);

export function listToolDefs() {
  return Object.values(REGISTRY).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export async function dispatch(toolName, argsJson, sessionId) {
  const tool = REGISTRY[toolName];
  if (!tool) throw new Error(`unknown tool: ${toolName}`);
  const args = safeJsonParse(argsJson, {});
  // Validation: required field check (basit; AJV gerek yok)
  for (const req of tool.parameters?.required || []) {
    if (args[req] === undefined) throw new Error(`missing arg: ${req}`);
  }
  const result = await tool.handler(args);
  if (MUTATING_TOOLS.has(toolName)) {
    await auditLog({ tool: toolName, args, session: sessionId });
  }
  return result;
}
```

## 4. Tool catalog (detail)

### 4.1 system-status (read-only, no audit)

| name | desc | args |
|---|---|---|
| `list_providers` | All providers with id, type, enabled, base_url, model count, key (last 4 chars only) | — |
| `get_provider_status` | Detail: health, last_check, breaker state, rate_limit usage | `{ id }` |
| `list_models` | Flat catalog: provider × model with capability flags | — |
| `get_capability_snapshot` | Full `data/capability.json` content (last_run, all entries) | — |
| `get_breaker_state` | All breakers: state, failures, openUntil, reason | — |
| `get_logs` | Last N log lines (in-memory ring buffer) | `{ tail = 50 }` |

### 4.2 repo-access (read-only, no audit)

Whitelist (`lib/admin-chatbot/tools/repo-access.js`):
```js
const ALLOWED = [
  /^lib\//, /^docs\//, /^web\//, /^test\//,
  /^(README|CHANGELOG|AGENTS|package\.json)$/,
];
const FORBIDDEN = [
  /^\.env/, /^data\//, /^node_modules\//, /^\.git\//,
];
```

| name | desc | args |
|---|---|---|
| `list_repo_files` | List files under given dir (whitelist enforced) | `{ dir = "lib" }` |
| `read_repo_file` | Read file content (whitelist enforced; max 100KB) | `{ path }` |

### 4.3 provider-mutate (audited)

| name | desc | args |
|---|---|---|
| `create_provider` | Yeni provider ekle | `{ id, type, base_url, api_key, label?, ... }` |
| `update_provider` | Mevcut provider'ı güncelle (kısmi merge) | `{ id, patch }` |
| `delete_provider` | Provider'ı sil | `{ id }` |
| `toggle_provider` | enabled true/false | `{ id, enabled }` |
| `set_provider_rate_limit` | Rate limit güncelle | `{ id, mult_per_min?, rpm? }` |

Her mutation sonrası `factory._invalidateCache()` çağrılır → sonraki request yeni config'i görür.

### 4.4 model-mutate (audited)

| name | desc | args |
|---|---|---|
| `add_model` | Provider'a model ekle | `{ provider_id, upstream_id, priority?, presented_id? }` |
| `remove_model` | Model entry'sini kaldır | `{ provider_id, upstream_id }` |
| `toggle_model` | Enable/disable | `{ provider_id, upstream_id, enabled }` |
| `set_priority` | Priority değiştir | `{ provider_id, upstream_id, priority }` |
| `set_alias` | Alias ekle/güncelle | `{ alias, target }` |
| `remove_alias` | Alias sil | `{ alias }` |

### 4.5 actions (read-only ama side-effect; partial audit)

| name | desc | args | audit |
|---|---|---|---|
| `run_probe` | Probe tetikle (provider veya tümü) | `{ provider_id? }` | hayır |
| `reset_breaker` | Breaker'ı sıfırla | `{ provider_id }` | hayır |
| `discover_models` | Provider'ın `/v1/models`'ından çek (DB'ye yazmaz, sadece döner) | `{ provider_id }` | hayır |
| `export_config` | Tam providers.json içeriği (key dahil) | — | **evet** (sızıntı riski) |
| `restart_router_cache` | `factory._invalidateCache()` çağır | — | hayır |

## 5. System prompt

`lib/admin-chatbot/system-prompt.js` build fonksiyonu:

```
You are llm-bridge's built-in admin assistant. You operate inside the admin panel
of a multi-provider LLM gateway. Be concise, technical, and assume the user is
the system admin (Halil).

## What is llm-bridge?
A Node.js >=20 ESM service that fronts multiple LLM providers...
[arch summary; ~30 satır]

## Tool catalog
You have FULL ADMIN CAPABILITY through these tools: [auto-generated list with
brief descriptions, dispatcher.listToolDefs() output].

## Behavior
- When user asks "how does X work" → call read_repo_file before answering.
- When user asks runtime state → call appropriate get_* tool.
- After mutations → briefly summarize what changed.
- Do not mention .env or attempt to access credentials in responses.
- After 3 consecutive tool errors, stop and ask the user for guidance.

## Current state (snapshot at <ISO timestamp>)
- Phase: 3 stable; 4a in progress; you are running on 4b code.
- Bridge version: 0.6.0
- Providers: <list_providers result, abbreviated>
- Last probe: <get_capability_snapshot.last_run_iso>
- Recent logs (last 5): <get_logs result, abbreviated>
```

System prompt **her chat session'ı için yeniden inşa edilir** (runtime snapshot güncel kalır).

## 6. Endpoint detail

```
POST /admin/api/chat
auth: admin session token
body: {
  messages: [{role, content, ...}],   // user'ın history'si
  model: "glm-4.6",                    // hangi modelle konuşacak
  stream: true,                        // varsayılan
}

response (SSE):
  event: meta       data: { chat_id, model_resolved: "airforce/glm-4.6" }
  event: tool_use   data: { id, name, args }
  event: tool_result data: { id, content }
  event: text       data: "token piece"
  event: done       data: { turns, finish_reason, usage }
```

Hata durumlarında:
```
event: error      data: { type, message }
```

## 7. Audit log

`data/audit-log.json` — append-only NDJSON (her satır bir JSON):

```ndjson
{"ts":"2026-04-28T13:00:01.123Z","tool":"create_provider","args":{"id":"groq","type":"openai-compat","base_url":"https://api.groq.com/openai","api_key":"<redacted>"},"session":"admin-..."}
{"ts":"2026-04-28T13:00:15.456Z","tool":"add_model","args":{"provider_id":"groq","upstream_id":"llama-3.1-70b"},"session":"admin-..."}
```

API key'ler `<redacted>` ile maskelenir (audit log dosyada açık görünmez). Boyutu 10MB'a ulaşırsa `audit-log.json.1`'e döndürülür (log rotation).

`get_audit_log` tool'u **eklenmiyor** (chatbot kendi audit log'unu okuyamaz — bu istismar açar).

## 8. Frontend (Chat tab)

`web/tabs/chat.js`:
- Top bar: model dropdown (`/v1/models` + admin auth), `+ New chat`, `Clear`
- Mesaj listesi (kaydırma, en alta otomatik scroll)
- Tool çağrıları collapsed JSON (tıkla → açıl)
- Streaming text token-by-token render
- Input: textarea (Cmd/Ctrl+Enter ile gönder), disabled while streaming
- LocalStorage: `llm-bridge.chat.history` key, [{messages, model, ts}] dizisi (son 20 chat)
- Reconnect logic yok (SSE drop'ta error gösterip kullanıcıya manual retry)

CSS: ~150 satır, mevcut palette (dark, monospace) kullanır.

## 9. Testing

```
test/admin-chatbot/
├── tool-dispatcher.test.js    (registry, validation, audit hook)
├── tools/
│   ├── repo-access.test.js    (whitelist passes/blocks, file size limit)
│   ├── system-status.test.js  (mock router, capability snapshot)
│   └── provider-mutate.test.js (in-memory store; mutation + cache invalidate)
└── system-prompt.test.js      (snapshot context build)
```

E2E: `test/integration/chatbot-e2e.test.js` — mock provider, simulated user message, verify multi-turn loop with at least one tool_use round.

## 10. Security & risk

- **Full admin capability**: kullanıcı bilinçli olarak C seçti. Risk minimize için:
  - Audit log her mutation'a yazılıyor
  - `.env` ve `data/` whitelist dışı
  - API key'ler audit log'da maskelenmiş
  - LLM hallucinasyon olarak yanlış bir mutation yapsa bile audit log'tan görülebilir
- **Prompt injection**: chatbot kullanıcının kendi mesajlarını işliyor; admin oturumu olmayan biri eline geçirirse devre dışı bırakılır (admin session zorunlu)
- **Resource exhaustion**: max 10 tool turn; LLM context max 100K token; her tool result max 50KB

## 11. Definition of Done

- Chat sekmesi açılır, model seçilir, mesaj gönderilir, yanıt akar
- Tool çağrıları render edilir (UI'da görünür)
- En az bir read-only tool (örn. `list_providers`) ve bir mutating tool (örn. `add_model`) gerçek bridge state üzerinde başarıyla çalışır
- Audit log dosyası mutation'lar için satır yazıyor
- Repo-access whitelist .env'i red ediyor (test ile doğrulanmış)
- Phase 1-4a testleri yeşil; chatbot testleri yeşil
- Smoke: chat sekmesinden "providers list" sor, doğru cevap alınır

## 12. Open questions (Phase 4b sonrasında ele alınacak)

- Tool confirmation dialog (destructive için)
- Multi-session sync (browser tab'lar arası)
- Cost & token tracking per chat
- Voice input (chrome speech-to-text API)
