# AGENTS.md

Compact guide for working in this repo. See `README.md` and `CLAUDE.md` for user-facing docs; this file captures things an agent would otherwise miss.

## Stack

- Pure ESM Node.js project (`"type": "module"` in `package.json`). No TypeScript, no bundler, no linter, no formatter. Zero runtime dependencies.
- Source files:
  - `server.js` — HTTP server + routing + upstream retry + keep-alive
  - `lib/normalizers.js` — all the weird tool-call / `<think>` / XML-ish text normalization (~1700 lines; this is the bulk of the logic)
  - `lib/intent-synthesis.js` — when upstream model answers with plain text instead of tool_use blocks, this module synthesizes the right tool_use from the model's intent (write/read/list/etc). Cross-platform, project-agnostic, uses the client's own tool names.
  - `lib/system-prompt-injection.js` — **default OFF** (`INJECT_SYSTEM_PROMPT=1` to opt in). When enabled, proxy injects a soft "tool usage guidance" block into the system prompt built from the client's own tool list + schemas. Non-forcing — uses "prefer tool calls" rather than "MUST call". Known trade-off: some weaker models see the suggested signatures like `Write(file_path, content)` and emit OpenAI-style JSON (`{"name":"Read",…}`) instead of native Anthropic `tool_use` blocks, producing `No such tool available` errors in Claude Code. That's why it is opt-in. Intent synthesis below is the safer path for most deployments.
  - `lib/sse.js` — synthesizes Anthropic & OpenAI streaming responses from a single non-stream upstream JSON reply
- Tests: `node:test` under `test/`, fixtures under `testdata/`.

## Commands

- Run everything: `npm test` (equivalent to `node --test`). Runs both test files; fast, no services needed.
- Run one file: `node --test test/normalizers.test.js`
- Run one test by name: `node --test --test-name-pattern="extractPseudoToolCalls parses" test/normalizers.test.js`
- Start server: `PORT=2393 UPSTREAM_BASE_URL=https://api.airforce AIRFORCE_API_KEY=... node server.js`
- Health check: `GET /health` returns configured upstream, port, and aliases.

There is no lint/typecheck step. Just run tests.

## Non-obvious behavior to preserve

- **Only `/anthropic/*` and `/v1/*` are proxied.** Anything else returns 404. `/anthropic` prefix is stripped before forwarding (`mapUpstreamPath`).
- **Inbound auth is always replaced.** `authorization` and `x-api-key` headers from the client are dropped; if `AIRFORCE_API_KEY` is set it is injected as both `Bearer` and `x-api-key`. Don't "pass through" client credentials.
- **Synthetic streaming.** When the client sends `stream: true` on `/anthropic/*`, `/v1/messages`, or `*/chat/completions`, the proxy calls upstream with `stream: false`, normalizes the full JSON, then re-emits it as SSE via `lib/sse.js`. Response carries `x-airforce-proxy-stream: synthetic`. If you add a new streaming path, update both `shouldHandleSyntheticStream` (server.js) and the branch picking the SSE encoder.
- **Upstream retry is automatic.** `fetchUpstreamWithRetry` retries on network errors, timeouts, 408/425/429, and 5xx with exponential backoff + jitter. On top of that, if normalize leaves the payload "effectively empty" (no text, no tool_use, no thinking), the proxy re-calls upstream up to 3 times (`RETRY_ON_EMPTY_RESPONSE`). This implements the "API should not stop until end_turn" requirement. Knobs (all optional env): `UPSTREAM_MAX_ATTEMPTS`, `UPSTREAM_RETRY_BASE_MS`, `UPSTREAM_RETRY_MAX_MS`, `UPSTREAM_TIMEOUT_MS`, `RETRY_ON_EMPTY_RESPONSE=0` to disable.
- **Model aliasing is two-way.** `maybeRewriteModel` swaps client model → upstream model on the way out; `restorePresentedModel` puts the client's original model name back on the response. On `/models` endpoints, `appendAliasModels` also injects alias ids so clients see them in the list. Keep both directions consistent when touching alias logic.
- **Non-JSON upstream responses are passed through untouched** (status, content-type, body) — normalization only runs when `content-type` contains `application/json`.
- **`DEBUG_LOGS` is on by default.** Set `DEBUG_LOGS=0` to silence. Logs are verbose and include truncated message/tool summaries; keep them terse if you add more.

## Normalization layer (`lib/normalizers.js`)

This is the hard-earned core. Before editing:

- Entry points used by the server: `normalizeJsonPayload(pathname, payload, requestBody)`, `normalizeRequestMessages`, `normalizeRequestTools`, `maybeRewriteModel`, `restorePresentedModel`. Internally it dispatches to `applyAnthropicNormalization`, `applyOpenAiChatNormalization`, `applyOpenAiResponsesNormalization` based on path.
- `extractPseudoToolCalls` is the text → tool_use extractor. It handles `<think>`, `<tool_call>`, `<tool_use>`, `<arg_key>/<arg_value>`, fenced `json`/`bash`, `<file://…>` write blocks, and various XML-ish variants. Many tests assert exact text trimming — if you change whitespace handling, expect snapshot-like failures in `test/normalizers.test.js`.
- Tool-name aliasing (`TOOL_NAME_ALIASES`, `ARG_SYNONYMS`, `SHELL_COMMAND_ALIASES`) is how upstream's weird tool emissions get mapped back to the client's declared tool schema. New aliases go there, not in call sites.
- `sanitizeCommand` strips **two** classes of upstream garbage from bash commands: (1) trailing XML/markdown tag artifacts, (2) trailing UI-render labels like `(fetching file listing)` / `(running command)` via `UI_LABEL_SUFFIX_RE`. Without this, upstream pastes UI metadata into commands and bash exits with `syntax error near unexpected token '('`. Preserve both behaviors.
- **Parallel tool-call collapse.** Upstream sometimes emits 5-6 bash calls in one turn; Anthropic clients run them in parallel and if any one fails, the remainder is cancelled with "parallel tool call errored" and the whole session locks up. `collapseParallelToolCalls` keeps only the first call per STATEFUL tool per turn (bash, delete, write, edit). Stateless tools (read, glob, grep, webfetch, task) are NOT collapsed — multiple reads in one turn are fine. Command content is never modified, only duplicate stateful calls are dropped. Disable via `COLLAPSE_PARALLEL_TOOL_CALLS=0`. Applies to all three normalizers (Anthropic, OpenAI chat, OpenAI responses).
- **Intent synthesis** (`lib/intent-synthesis.js`). Weak upstream models (glm-5 and similar) sometimes produce plain text responses even when a tool call is warranted — they emit HTML in a fenced block instead of calling `Write`, or say "Let me first check the repo" without any `Glob`/`Read` call. The intent synthesizer looks at the model's text + the last user message, and if a clear intent is visible, manufactures the right tool call **using the client's own tool list**. Three heuristics: (1) fenced code block + filename mentioned in user or model text → `Write`-like tool (`Write`/`write_file`/`WriteFile` etc.); (2) exploratory stall like "Let me check" + user said `/init` / "analyze" / "incele" → `Glob`-like tool with `pattern: '**/*'` (cross-platform, relative); (3) "let me read X.md" with a single file → `Read`-like tool. Must stay project-agnostic: no hardcoded paths (`/workspace`, `/root`), no Linux-only commands (`find .`). Schema field names are picked dynamically from the client's declared tool schema (`file_path` vs `filePath` vs `path`). Disable via `SYNTHESIZE_INTENT=0`.
- When the normalizer empties `content` that originally had blocks, `server.js` logs `normalization_emptied_content` with truncated raw blocks. That log is a canary — if you see it firing in a new test, the normalizer is eating legitimate output.
- If upstream returned `stop_reason: "tool_use"` but the normalizer dropped all tool_use blocks (broken/empty), `applyAnthropicNormalization` downgrades `stop_reason` to `end_turn` so Anthropic clients don't lock up with "parallel tool error".

## Testing conventions

- `test/server.test.js` sets `process.env.AIRFORCE_API_KEY` **before** importing `server.js` (top-level `await import`). Preserve that pattern if adding tests that read env at module load.
- No mocking framework; tests are pure `node:assert/strict`. Don't add a test runner dependency.
- `test/normalizers.test.js` has ~50 cases; add new scenarios alongside the closest existing block rather than a new file.

## Deployment

- `deploy/airforce-compat-proxy.service` is an example systemd unit assuming `/root/airforce` + `/etc/airforce-compat-proxy.env`. It's a template — adjust paths for your server. Runtime code itself has no hardcoded paths.

## Style

- Match existing code: ES modules, single quotes, 2-space indent, named exports. No Prettier config — follow the surrounding file.
- Keep runtime dependency-free. Anything new should use `node:` built-ins.
