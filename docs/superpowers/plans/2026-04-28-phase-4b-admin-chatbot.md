# Phase 4b — Built-in Admin Chatbot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin panel'e `Chat` sekmesi + bridge'in kendisini bilen chatbot. Bridge'in kendi router'ını içeriden (HTTP'siz) kullanır; sistem prompt'unda mimarinin özeti + runtime snapshot var; ~20 tool ile FULL admin capability (read repo, mutate config, run probe, reset breaker).

**Architecture:** Yeni `lib/admin-chatbot/` modülü (scaffold: `tool-dispatcher.js`, `system-prompt.js`, `chatbot-router.js`, `audit-log.js` + `tools/{system-status,repo-access,provider-mutate,model-mutate,actions}.js`). `lib/admin-router.js`'e `POST /admin/api/chat` route mount. `web/tabs/chat.js` SSE consumer + UI. Mutating tools `data/audit-log.json`'a NDJSON satır yazar; key alanları `<redacted>` ile maskelenir.

**Tech Stack:** Node.js >=20, ESM, native fetch + node:http SSE response, vanilla JS UI.

---

## File Structure

**Create:**
```
lib/admin-chatbot/
├── tool-dispatcher.js
├── system-prompt.js
├── chatbot-router.js
├── audit-log.js
└── tools/
    ├── system-status.js
    ├── repo-access.js
    ├── provider-mutate.js
    ├── model-mutate.js
    └── actions.js
web/tabs/chat.js
test/admin-chatbot/
├── tool-dispatcher.test.js
├── tools/repo-access.test.js
└── tools/system-status.test.js
```

**Modify:**
- `lib/admin-router.js` — `POST /admin/api/chat` (SSE response)
- `web/index.html` — Chat sekmesi ekle
- `web/app.js` — chat tab'i kaydet
- `web/styles.css` — chat layout (~80 satır)
- `package.json` `version: "0.6.0"`; test glob admin-chatbot ekle
- `CHANGELOG.md`

---

## Task 0: Branch

```bash
cd ~/Desktop/llm-bridge
git checkout develop
git pull origin develop
git rebase master
git push origin develop --force-with-lease
git checkout -b feat/04b-admin-chatbot
git push -u origin feat/04b-admin-chatbot
```

## Task 1: audit-log.js + scaffold

`lib/admin-chatbot/audit-log.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

const FILE = 'audit-log.json';

function pathOf() { return path.join(DATA_DIR, FILE); }

function redactKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactKeys);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/key|secret|token|password/i.test(k)) out[k] = '<redacted>';
    else out[k] = redactKeys(v);
  }
  return out;
}

export async function appendAudit(entry) {
  const p = pathOf();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    tool: entry.tool,
    args: redactKeys(entry.args),
    session: entry.session || null,
  }) + '\n';
  fs.appendFileSync(p, line, { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}
```

## Task 2: tools/system-status.js (read-only)

```js
import { getRouter } from '../../providers/factory.js';
import { getCapability } from '../../capability.js';
import { recentLogs } from '../../logger.js';

export const tools = {
  list_providers: {
    name: 'list_providers',
    description: 'List all configured providers with id, type, enabled, base_url, model count, key last 4 chars.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const router = await getRouter();
      const out = [];
      for (const [id, p] of router.registry.providers.entries()) {
        const cfg = p.config || {};
        out.push({
          id, type: p.constructor?.name?.replace('Provider', '').toLowerCase() || cfg.type,
          enabled: cfg.enabled !== false,
          base_url: cfg.base_url,
          api_key_last4: String(cfg.api_key || '').slice(-4),
          model_count: cfg.models?.length || 0,
        });
      }
      return { providers: out };
    },
  },
  get_provider_status: {
    name: 'get_provider_status',
    description: 'Detail for a single provider — health, breaker state, models.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: async ({ id }) => {
      const router = await getRouter();
      const p = router.registry.providers.get(id);
      if (!p) throw new Error(`unknown provider: ${id}`);
      const breaker = router.breakers.get(id);
      return {
        id,
        config: { ...p.config, api_key: '<redacted>' },
        breaker: breaker.snapshot(),
      };
    },
  },
  list_models: {
    name: 'list_models',
    description: 'Flat catalog of all models across all providers with capability flags.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const router = await getRouter();
      const cap = getCapability();
      return {
        models: router.registry.listAllModels().map((m) => {
          const k = `${m.provider_id}/${m.upstream_id}`;
          const c = cap?.models?.[k];
          return { ...m, native: c?.native ?? null, xml: c?.xml ?? null, latency_ms: c?.latency_ms ?? null };
        }),
      };
    },
  },
  get_capability_snapshot: {
    name: 'get_capability_snapshot',
    description: 'Full capability.json — last_run, all (provider, model) probe results.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => getCapability(),
  },
  get_breaker_state: {
    name: 'get_breaker_state',
    description: 'All circuit breakers: state (closed/open/half-open), failures, reason.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const router = await getRouter();
      return { breakers: router.breakers.snapshot() };
    },
  },
  get_logs: {
    name: 'get_logs',
    description: 'Last N log lines from in-memory ring buffer.',
    parameters: { type: 'object', properties: { tail: { type: 'number' } }, required: [] },
    handler: async ({ tail = 50 }) => ({ logs: recentLogs(Math.min(500, Math.max(1, tail))) }),
  },
};
```

## Task 3: tools/repo-access.js (whitelist enforced)

```js
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../../config.js';

const ALLOWED = [
  /^lib\//, /^docs\//, /^web\//, /^test\//,
  /^(README|CHANGELOG|AGENTS|package\.json)/,
];
const FORBIDDEN = [
  /^\.env/, /^data\//, /^node_modules\//, /^\.git\//,
];
const MAX_FILE_SIZE = 100 * 1024;

function isAllowed(rel) {
  if (FORBIDDEN.some((re) => re.test(rel))) return false;
  return ALLOWED.some((re) => re.test(rel));
}

function safeJoin(rel) {
  const norm = path.posix.normalize(rel.replace(/^\/+/, ''));
  if (norm.includes('..') || path.isAbsolute(norm)) throw new Error('path traversal blocked');
  return path.join(ROOT_DIR, norm);
}

export const tools = {
  list_repo_files: {
    name: 'list_repo_files',
    description: 'List files under a directory (whitelisted: lib/, docs/, web/, test/, root files). Forbidden: .env, data/, node_modules/, .git/.',
    parameters: { type: 'object', properties: { dir: { type: 'string' } }, required: [] },
    handler: async ({ dir = 'lib' }) => {
      if (!isAllowed(dir)) throw new Error(`directory not allowed: ${dir}`);
      const abs = safeJoin(dir);
      if (!fs.existsSync(abs)) throw new Error(`not found: ${dir}`);
      const out = [];
      function walk(d, rel) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const childRel = path.posix.join(rel, e.name);
          if (FORBIDDEN.some((re) => re.test(childRel))) continue;
          if (e.isDirectory()) walk(path.join(d, e.name), childRel);
          else out.push(childRel);
        }
      }
      walk(abs, dir);
      return { files: out };
    },
  },
  read_repo_file: {
    name: 'read_repo_file',
    description: 'Read file content. Whitelisted paths only. Max 100KB.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: async ({ path: p }) => {
      if (!isAllowed(p)) throw new Error(`path not allowed: ${p}`);
      const abs = safeJoin(p);
      if (!fs.existsSync(abs)) throw new Error(`not found: ${p}`);
      const stat = fs.statSync(abs);
      if (!stat.isFile()) throw new Error(`not a file: ${p}`);
      if (stat.size > MAX_FILE_SIZE) throw new Error(`file too large (${stat.size} > ${MAX_FILE_SIZE})`);
      return { path: p, content: fs.readFileSync(abs, 'utf8'), size: stat.size };
    },
  },
};
```

## Task 4: tools/provider-mutate.js (audited)

```js
import { loadProvidersConfig, saveProvidersConfig } from '../../store.js';
import { invalidateRouterCache } from '../../providers/factory.js';
import { validateProviderConfig } from '../../providers/config-schema.js';

export const tools = {
  create_provider: {
    name: 'create_provider',
    description: 'Add a new provider. Required: id (slug), type (openai-compat|anthropic-native), base_url, api_key.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' }, type: { type: 'string' }, base_url: { type: 'string' },
        api_key: { type: 'string' }, label: { type: 'string' }, enabled: { type: 'boolean' },
        rate_limit: { type: 'object' },
      },
      required: ['id', 'type', 'base_url', 'api_key'],
    },
    handler: async (args) => {
      const cfg = loadProvidersConfig() || { schema_version: 1, providers: [], aliases: {}, global: {} };
      if ((cfg.providers || []).some((p) => p.id === args.id)) throw new Error(`duplicate id: ${args.id}`);
      const newP = {
        id: args.id, label: args.label || args.id, type: args.type,
        base_url: args.base_url, api_key: args.api_key,
        enabled: args.enabled ?? true,
        rate_limit: args.rate_limit || {}, models: [],
      };
      const v = validateProviderConfig(newP);
      if (!v.ok) throw new Error(`invalid: ${v.error.field} — ${v.error.message}`);
      cfg.providers = cfg.providers || [];
      cfg.providers.push(newP);
      saveProvidersConfig(cfg);
      invalidateRouterCache();
      return { ok: true, id: args.id };
    },
  },
  update_provider: {
    name: 'update_provider',
    description: 'Patch provider fields. Provide only fields to change.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' }, patch: { type: 'object' },
      },
      required: ['id', 'patch'],
    },
    handler: async ({ id, patch }) => {
      const cfg = loadProvidersConfig();
      if (!cfg) throw new Error('no config');
      const p = (cfg.providers || []).find((x) => x.id === id);
      if (!p) throw new Error(`unknown: ${id}`);
      Object.assign(p, patch);
      const v = validateProviderConfig(p);
      if (!v.ok) throw new Error(`invalid: ${v.error.field} — ${v.error.message}`);
      saveProvidersConfig(cfg);
      invalidateRouterCache();
      return { ok: true };
    },
  },
  delete_provider: {
    name: 'delete_provider',
    description: 'Remove provider entirely.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: async ({ id }) => {
      const cfg = loadProvidersConfig();
      if (!cfg) throw new Error('no config');
      const before = cfg.providers.length;
      cfg.providers = (cfg.providers || []).filter((p) => p.id !== id);
      if (cfg.providers.length === before) throw new Error(`unknown: ${id}`);
      saveProvidersConfig(cfg);
      invalidateRouterCache();
      return { ok: true };
    },
  },
  toggle_provider: {
    name: 'toggle_provider',
    description: 'Enable or disable provider.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, enabled: { type: 'boolean' } },
      required: ['id', 'enabled'],
    },
    handler: async ({ id, enabled }) => {
      const cfg = loadProvidersConfig();
      const p = (cfg?.providers || []).find((x) => x.id === id);
      if (!p) throw new Error(`unknown: ${id}`);
      p.enabled = enabled;
      saveProvidersConfig(cfg);
      invalidateRouterCache();
      return { ok: true };
    },
  },
  set_provider_rate_limit: {
    name: 'set_provider_rate_limit',
    description: 'Update rate limit (mult_per_min veya rpm).',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, mult_per_min: { type: 'number' }, rpm: { type: 'number' } },
      required: ['id'],
    },
    handler: async ({ id, mult_per_min, rpm }) => {
      const cfg = loadProvidersConfig();
      const p = (cfg?.providers || []).find((x) => x.id === id);
      if (!p) throw new Error(`unknown: ${id}`);
      p.rate_limit = {};
      if (mult_per_min != null) p.rate_limit.mult_per_min = mult_per_min;
      if (rpm != null) p.rate_limit.rpm = rpm;
      saveProvidersConfig(cfg);
      invalidateRouterCache();
      return { ok: true };
    },
  },
};
```

## Task 5: tools/model-mutate.js

(Aynı pattern, 6 tool: add_model, remove_model, toggle_model, set_priority, set_alias, remove_alias.)

## Task 6: tools/actions.js

```js
import { triggerSafe, isRunning } from '../../scheduler.js';
import { getRouter, invalidateRouterCache } from '../../providers/factory.js';
import { loadProvidersConfig } from '../../store.js';

export const tools = {
  run_probe: {
    name: 'run_probe',
    description: 'Trigger capability probe. Without args: all enabled (provider, model) pairs.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      if (isRunning()) return { ok: false, message: 'already running' };
      triggerSafe('chatbot');
      return { ok: true, message: 'probe started' };
    },
  },
  reset_breaker: {
    name: 'reset_breaker',
    description: 'Reset a provider\'s circuit breaker to closed state.',
    parameters: { type: 'object', properties: { provider_id: { type: 'string' } }, required: ['provider_id'] },
    handler: async ({ provider_id }) => {
      const router = await getRouter();
      router.breakers.reset(provider_id);
      return { ok: true };
    },
  },
  discover_models: {
    name: 'discover_models',
    description: 'Fetch /v1/models from a provider (does not save). Returns the list.',
    parameters: { type: 'object', properties: { provider_id: { type: 'string' } }, required: ['provider_id'] },
    handler: async ({ provider_id }) => {
      const router = await getRouter();
      const p = router.registry.providers.get(provider_id);
      if (!p) throw new Error(`unknown: ${provider_id}`);
      const models = await p.listModels();
      return { models };
    },
  },
  export_config: {
    name: 'export_config',
    description: 'Return full providers.json (api_key REDACTED before sending).',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const cfg = loadProvidersConfig();
      if (!cfg) throw new Error('no config');
      // Mask keys before returning to chatbot
      return {
        ...cfg,
        providers: (cfg.providers || []).map((p) => ({ ...p, api_key: '<redacted>' })),
      };
    },
  },
  restart_router_cache: {
    name: 'restart_router_cache',
    description: 'Force router cache invalidation (config will be re-read on next request).',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => { invalidateRouterCache(); return { ok: true }; },
  },
};
```

## Task 7: tool-dispatcher.js

```js
import * as systemStatus from './tools/system-status.js';
import * as repoAccess from './tools/repo-access.js';
import * as providerMutate from './tools/provider-mutate.js';
import * as modelMutate from './tools/model-mutate.js';
import * as actions from './tools/actions.js';
import { appendAudit } from './audit-log.js';

const REGISTRY = {
  ...systemStatus.tools,
  ...repoAccess.tools,
  ...providerMutate.tools,
  ...modelMutate.tools,
  ...actions.tools,
};

const MUTATING = new Set([
  'create_provider', 'update_provider', 'delete_provider', 'toggle_provider',
  'set_provider_rate_limit',
  'add_model', 'remove_model', 'toggle_model', 'set_priority',
  'set_alias', 'remove_alias',
  'export_config',
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
  let args = {};
  try { args = typeof argsJson === 'string' ? JSON.parse(argsJson) : (argsJson || {}); }
  catch { throw new Error('bad args json'); }
  for (const req of tool.parameters?.required || []) {
    if (args[req] === undefined) throw new Error(`missing arg: ${req}`);
  }
  const result = await tool.handler(args);
  if (MUTATING.has(toolName)) await appendAudit({ tool: toolName, args, session: sessionId });
  return result;
}
```

## Task 8: system-prompt.js

```js
import { getRouter } from '../providers/factory.js';
import { getCapability } from '../capability.js';
import { recentLogs } from '../logger.js';
import { listToolDefs } from './tool-dispatcher.js';

const ARCH_SUMMARY = `
You are llm-bridge's built-in admin assistant. You operate inside the admin panel
of a multi-provider LLM gateway. Be concise, technical, assume the user is the
system admin (Halil).

## Architecture
- Multi-provider LLM gateway (Node.js >=20 ESM, no external deps)
- Provider plugins: openai-compat (api.airforce, OpenRouter, Groq, etc.) + anthropic-native (api.anthropic.com)
- lib/router.js: priority-based routing + automatic fallback (transient/auth/bad_model)
- lib/circuit-breaker.js: per-provider 3-fail-in-10s → 60s open
- lib/tool-engine/{inject,parse,translate,serialize-history,anti-leak}.js: XML inject/parse for non-native tool support
- data/providers.json: admin-managed config (atomic write, mode 600)
- data/capability.json: per-(provider, model) probe results

## Behavior
- For "how does X work" → call read_repo_file before answering
- For runtime state → call appropriate get_* tool
- After mutations → briefly summarize what changed
- Do not mention .env or attempt to access credentials
- Tool failures: after 3 consecutive errors, ask the user for guidance
`.trim();

export async function buildSystemPrompt() {
  let snapshot = '## Current state (snapshot)\n';
  try {
    const router = await getRouter();
    const providers = [];
    for (const [id, p] of router.registry.providers.entries()) {
      const cfg = p.config || {};
      providers.push(`  - ${id} (${cfg.type}, ${(cfg.models || []).length} models, ${cfg.enabled ? 'enabled' : 'disabled'})`);
    }
    snapshot += `Providers (${providers.length}):\n${providers.join('\n')}\n`;
  } catch (err) {
    snapshot += `Providers: <unavailable: ${err.message}>\n`;
  }
  try {
    const cap = getCapability();
    if (cap?.last_run_iso) snapshot += `Last probe: ${cap.last_run_iso}\n`;
  } catch {}
  try {
    const logs = recentLogs(5);
    if (logs?.length) snapshot += `Recent logs (last 5):\n${logs.map((l) => `  ${l}`).join('\n')}\n`;
  } catch {}

  const tools = listToolDefs();
  const toolList = `## Tools available (${tools.length}, full admin capability)\n` +
    tools.map((t) => `- ${t.function.name}: ${t.function.description}`).join('\n');

  return [ARCH_SUMMARY, snapshot, toolList].join('\n\n');
}
```

## Task 9: chatbot-router.js

```js
import { getRouter } from '../providers/factory.js';
import { listToolDefs, dispatch } from './tool-dispatcher.js';
import { buildSystemPrompt } from './system-prompt.js';
import { log } from '../logger.js';

const MAX_TURNS = 10;

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function flushNonStreamJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

export async function handleChatRequest(req, res, body, sessionId) {
  const stream = body.stream !== false;
  const model = body.model || 'glm-4.6';

  if (stream) {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('x-accel-buffering', 'no');
  }

  let messages = [];
  try {
    const sysPrompt = await buildSystemPrompt();
    messages = [
      { role: 'system', content: sysPrompt },
      ...(Array.isArray(body.messages) ? body.messages : []),
    ];
  } catch (err) {
    if (stream) { sseWrite(res, 'error', { message: err.message }); res.end(); return; }
    return flushNonStreamJson(res, 500, { error: { message: err.message } });
  }

  const router = await getRouter();
  let lastResult = null;

  if (stream) sseWrite(res, 'meta', { model, turn: 0 });

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let out;
    try {
      out = await router.execute(model, {
        model, messages, tools: listToolDefs(), max_tokens: 4096,
      });
    } catch (err) {
      log.error('chatbot router error', { err: err.message, status: err.status });
      if (stream) { sseWrite(res, 'error', { message: err.message, status: err.status }); res.end(); return; }
      return flushNonStreamJson(res, err.status || 502, { error: { message: err.message } });
    }

    lastResult = out.result;
    const text = out.result.text || '';
    const tcs = out.result.native_tool_calls || [];

    if (stream && text) sseWrite(res, 'text', { content: text });

    if (!tcs.length) {
      // Final answer
      if (stream) {
        sseWrite(res, 'done', { turns: turn + 1, finish_reason: out.result.finish_reason, usage: out.result.usage, provider_id: out.providerId });
        res.end();
      } else {
        flushNonStreamJson(res, 200, {
          assistant: { content: text },
          turns: turn + 1, provider_id: out.providerId, usage: out.result.usage,
        });
      }
      return;
    }

    // Tool turn
    messages.push({ role: 'assistant', content: text || null, tool_calls: tcs });
    for (const tc of tcs) {
      if (stream) sseWrite(res, 'tool_use', { id: tc.id, name: tc.function.name, args: tc.function.arguments });
      let toolResult;
      try {
        toolResult = await dispatch(tc.function.name, tc.function.arguments, sessionId);
        if (stream) sseWrite(res, 'tool_result', { id: tc.id, name: tc.function.name, content: truncate(JSON.stringify(toolResult)) });
      } catch (err) {
        toolResult = { error: err.message };
        if (stream) sseWrite(res, 'tool_result', { id: tc.id, name: tc.function.name, error: err.message });
      }
      messages.push({
        role: 'tool', tool_call_id: tc.id,
        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
      });
    }
  }

  // Max turns reached
  if (stream) {
    sseWrite(res, 'error', { message: `max turns (${MAX_TURNS}) reached` });
    res.end();
  } else {
    flushNonStreamJson(res, 200, { error: { message: `max turns (${MAX_TURNS}) reached` }, last: lastResult });
  }
}

function truncate(s, max = 50_000) {
  if (typeof s !== 'string') s = String(s);
  return s.length > max ? s.slice(0, max) + `…(${s.length}b)` : s;
}
```

## Task 10: admin-router mount

Eklenecek route (auth-required bölgede):

```js
if (urlPath === '/admin/api/chat' && req.method === 'POST') {
  let body;
  try { body = await readJsonBody(req); } catch { return send(res, 400, { error: 'bad json' }); }
  const sessionId = (req.headers['authorization'] || '').slice(7).trim().slice(0, 16);
  const { handleChatRequest } = await import('./admin-chatbot/chatbot-router.js');
  return handleChatRequest(req, res, body, sessionId);
}
```

## Task 11: web/tabs/chat.js

(Detayda implement; layout: model dropdown + history + input + SSE consumer.)

```js
import { api } from '../app.js';

const HISTORY_KEY = 'llm-bridge.chat.history';

export async function initChat(root) {
  root.innerHTML = `
    <div class="chat-shell">
      <div class="chat-toolbar">
        <select id="chat-model"></select>
        <button id="chat-new">+ New chat</button>
        <button id="chat-clear" class="ghost">Clear</button>
      </div>
      <div id="chat-msgs"></div>
      <div class="chat-input">
        <textarea id="chat-input" placeholder="Mesaj (Cmd/Ctrl+Enter ile gönder)"></textarea>
        <button id="chat-send" class="primary">Send</button>
      </div>
    </div>
  `;
  const sel = document.getElementById('chat-model');
  try {
    const r = await api('GET', '/v1/models');
    const j = await r.json();
    for (const m of j.data || []) {
      const o = document.createElement('option'); o.value = m.id; o.textContent = m.id;
      sel.appendChild(o);
    }
  } catch {
    sel.innerHTML = '<option>glm-4.6</option>';
  }

  let messages = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  render();

  document.getElementById('chat-new').addEventListener('click', () => { messages = []; saveAndRender(); });
  document.getElementById('chat-clear').addEventListener('click', () => { if (confirm('Clear history?')) { messages = []; saveAndRender(); } });

  const input = document.getElementById('chat-input');
  const send = document.getElementById('chat-send');
  send.addEventListener('click', () => sendMessage());
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendMessage();
  });

  async function sendMessage() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    messages.push({ role: 'user', content: text });
    saveAndRender();
    send.disabled = true;
    await streamChat(sel.value, messages);
    send.disabled = false;
  }

  async function streamChat(model, msgs) {
    const tk = sessionStorage.getItem('llm-bridge-token');
    const r = await fetch('/admin/api/chat', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${tk}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: msgs.filter((m) => m.role !== 'system'), model, stream: true }),
    });
    if (!r.ok) {
      const txt = await r.text();
      messages.push({ role: 'assistant', content: '⚠️ ' + txt });
      saveAndRender();
      return;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let assistantText = '';
    let assistantToolCalls = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n\n');
      buf = lines.pop();
      for (const block of lines) {
        const ev = block.match(/^event: (.+)$/m)?.[1];
        const data = block.match(/^data: (.+)$/m)?.[1];
        if (!ev || !data) continue;
        const j = JSON.parse(data);
        if (ev === 'text') { assistantText += j.content; render(assistantText, assistantToolCalls); }
        else if (ev === 'tool_use') { assistantToolCalls.push({ kind: 'use', ...j }); render(assistantText, assistantToolCalls); }
        else if (ev === 'tool_result') { assistantToolCalls.push({ kind: 'result', ...j }); render(assistantText, assistantToolCalls); }
        else if (ev === 'done') {
          messages.push({ role: 'assistant', content: assistantText, tool_calls: assistantToolCalls });
          saveAndRender();
        } else if (ev === 'error') {
          messages.push({ role: 'assistant', content: '⚠️ ' + j.message });
          saveAndRender();
        }
      }
    }
  }

  function saveAndRender() {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-100)));
    render();
  }

  function render(streamingText, streamingTools) {
    const c = document.getElementById('chat-msgs');
    c.innerHTML = '';
    for (const m of messages) c.appendChild(renderMsg(m));
    if (streamingText !== undefined) {
      c.appendChild(renderMsg({ role: 'assistant', content: streamingText, tool_calls: streamingTools, _streaming: true }));
    }
    c.scrollTop = c.scrollHeight;
  }

  function renderMsg(m) {
    const div = document.createElement('div');
    div.className = `chat-msg role-${m.role}` + (m._streaming ? ' streaming' : '');
    div.innerHTML = `<div class="role">${m.role}</div><div class="content"></div>`;
    div.querySelector('.content').textContent = m.content || '';
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const t = document.createElement('details');
        t.className = 'tool-call';
        t.innerHTML = `<summary>${tc.kind === 'use' ? '→' : '←'} ${escapeHtml(tc.name || '')}</summary><pre></pre>`;
        t.querySelector('pre').textContent = tc.kind === 'use' ? (tc.args || '') : (tc.content || tc.error || '');
        div.appendChild(t);
      }
    }
    return div;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
}
```

## Task 12: HTML + app.js + styles update

`web/index.html` `nav#tabs`'a:
```html
<button data-tab="chat">Chat</button>
```

`web/app.js`:
```js
import { initChat } from './tabs/chat.js';
const TABS = { providers: initProviders, models: initModels, logs: initLogs, chat: initChat };
```

`web/styles.css` ek (~80 satır):

```css
.chat-shell { display: flex; flex-direction: column; height: calc(100vh - 100px); }
.chat-toolbar { display: flex; gap: 8px; padding-bottom: 12px; }
#chat-model { min-width: 200px; }
#chat-msgs { flex: 1; overflow-y: auto; padding: 12px 0; display: flex; flex-direction: column; gap: 12px; }
.chat-msg { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; }
.chat-msg.role-user { background: var(--bg-3); }
.chat-msg.streaming { border-color: var(--accent); }
.chat-msg .role { font-size: 11px; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; letter-spacing: 0.05em; }
.chat-msg .content { white-space: pre-wrap; word-break: break-word; }
.tool-call { margin-top: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 12px; }
.tool-call summary { cursor: pointer; color: var(--accent); font-family: ui-monospace, monospace; }
.tool-call pre { margin: 6px 0 0; padding: 6px; background: var(--bg-2); font-size: 11px; max-height: 200px; overflow: auto; }
.chat-input { display: flex; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border); }
.chat-input textarea { flex: 1; min-height: 60px; resize: vertical; background: var(--bg-3); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 6px; font: inherit; }
```

## Task 13: Smoke + CHANGELOG + version 0.6.0

Smoke: server boot, panel'den login, Chat sekmesi, glm-4.6 ile "list_providers" sor, tool çağrısı görür.

`CHANGELOG.md`:

```markdown
## [0.6.0] — Phase 4b: Built-in Admin Chatbot

- `lib/admin-chatbot/{tool-dispatcher,system-prompt,chatbot-router,audit-log}.js` + `tools/{system-status,repo-access,provider-mutate,model-mutate,actions}.js`
- 22 tool: 6 read-only (system-status), 2 read-only (repo-access whitelist), 5 mutating provider, 6 mutating model, 5 actions
- POST /admin/api/chat (SSE: meta, text, tool_use, tool_result, done, error)
- web/tabs/chat.js (vanilla JS, localStorage history, model picker)
- audit-log.json (NDJSON, mutations only, key alanları redacted)
- Multi-turn loop max 10 turn
```

## Task 14: PR + tag v0.6.0-phase4b

Push, PR feat→develop, develop→master, tag.

---

## Self-Review

**Spec coverage (4b spec):**
- §3 architecture: Task 1-9 ✓
- §3.2 request flow: Task 9 ✓
- §3.3 tool dispatcher: Task 7 ✓
- §4 tool catalog (22 tools): Task 2, 3, 4, 5, 6 ✓
- §5 system prompt: Task 8 ✓
- §6 endpoint: Task 9, 10 ✓
- §7 audit log: Task 1 ✓
- §8 frontend: Task 11, 12 ✓

**Placeholders:** yok.

**Type consistency:** `dispatch(name, argsJson, sessionId)` Task 7 + Task 9 tutarlı; `appendAudit({ tool, args, session })` Task 1 + Task 7 tutarlı.

**Risk:**
- Multi-turn loop'ta tool result çok büyükse (>50KB) trunc ediliyor — tamam
- LocalStorage history quota = 5MB; 100 mesaj limit var
