// System prompt builder — bridge'in self-awareness'ı.
// Her chat için yeniden inşa edilir (runtime snapshot güncel kalır).

import { getRouter } from '../providers/factory.js';
import { getCapability } from '../capability.js';
import { recentLogs } from '../logger.js';
import { listToolDefs } from './tool-dispatcher.js';

const ARCH_SUMMARY = `
You are llm-bridge's built-in admin assistant. You operate inside the admin panel
of a multi-provider LLM gateway. Be concise, technical, and assume the user is the
system admin.

## Architecture
- Multi-provider LLM gateway (Node.js >=20 ESM, native fetch + node:test, no external deps).
- Provider plugins: openai-compat (api.airforce, OpenRouter, Groq, Together, etc.) and anthropic-native (api.anthropic.com).
- lib/router.js: priority-based routing + automatic fallback (transient/auth/bad_model → next; client → fatal).
- lib/circuit-breaker.js: per-provider state machine (3 fails in 10s → 60s open).
- lib/tool-engine/{inject,parse,translate,serialize-history,anti-leak}.js: XML inject/parse for non-native tool support.
- data/providers.json: admin-managed config (atomic write, mode 600).
- data/capability.json: per-(provider, model) probe results.
- data/audit-log.json: NDJSON record of mutating tool calls (api_key fields redacted).

## Behavior
- For "how does X work" → call read_repo_file before answering.
- For runtime state → call appropriate get_* tool.
- After mutations → briefly summarize what changed.
- Do NOT mention .env or attempt to access credentials in responses.
- After 3 consecutive tool errors, stop and ask the user for guidance.
- Prefer concise, technical answers. Show short code snippets when relevant.
`.trim();

export async function buildSystemPrompt() {
  const sections = [ARCH_SUMMARY];

  let snapshot = '## Current state (snapshot)\n';
  try {
    const router = await getRouter();
    const providers = [];
    for (const [id, p] of router.registry.providers.entries()) {
      const cfg = p.config || {};
      providers.push(`  - ${id} (${cfg.type}, ${(cfg.models || []).length} models, ${cfg.enabled === false ? 'disabled' : 'enabled'})`);
    }
    snapshot += `Providers (${providers.length}):\n${providers.join('\n') || '  <none>'}\n`;
  } catch (err) {
    snapshot += `Providers: <unavailable: ${err.message}>\n`;
  }
  try {
    const cap = getCapability();
    if (cap?.last_run_iso) snapshot += `Last probe: ${cap.last_run_iso}\n`;
    if (cap?.models) {
      const okCount = Object.values(cap.models).filter((m) => m.status === 'ok').length;
      snapshot += `Capable models: ${okCount}/${Object.keys(cap.models).length}\n`;
    }
  } catch {}
  try {
    const logs = recentLogs(5);
    if (logs?.length) {
      const lines = logs.map((l) => typeof l === 'string' ? l : (l?.message || JSON.stringify(l)));
      snapshot += `Recent logs (last 5):\n${lines.map((s) => `  ${String(s).slice(0, 160)}`).join('\n')}\n`;
    }
  } catch {}
  sections.push(snapshot);

  const tools = listToolDefs();
  const toolList = `## Tools available (${tools.length}, FULL admin capability)\n` +
    tools.map((t) => `- ${t.function.name}: ${t.function.description}`).join('\n');
  sections.push(toolList);

  return sections.join('\n\n');
}
