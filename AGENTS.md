# AGENTS.md

Compact guide for working in this repo. See `README.md` and `CLAUDE.md` for user-facing docs; this file captures things an agent would otherwise miss.

## Stack

- Pure ESM Node.js project (`"type": "module"` in `package.json`). No TypeScript, no bundler, no linter, no formatter. Zero runtime dependencies.
- Source files:
  - `server.js` — HTTP server + routing + upstream retry + keep-alive
  - `lib/normalizers.js` — all the weird tool-call / `<think>` / XML-ish text normalization (~1700 lines; this is the bulk of the logic)
  - `lib/intent-synthesis.js` — when upstream model answers with plain text instead of tool_use blocks, this module synthesizes the right tool_use from the model's intent (write/read/list/etc). Cross-platform, project-agnostic, **language-agnostic** (v2: no hardcoded "let me read" / "olustur" regexes — decisions use deterministic signals: tool history, fenced block structure, render containers, explicit filenames, slash-commands). Uses the client's own tool names.
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
- `sanitizeCommand` strips several classes of upstream garbage from bash commands: (1) trailing XML/markdown tag artifacts, (2) trailing UI-render labels like `(fetching file listing)` / `(running command)` via `UI_LABEL_SUFFIX_RE`, (3) Claude Code / OpenCode instrumentation tags — both underscore (`<command_message>`) and dash (`<command-message>`) variants of `command[_-]message`, `system[_-]reminder`, `local[_-]command(-std(out|err))?`, `user[_-]message`, `assistant[_-]message`, `tool[_-]output`, `claude[_-]instructions` (`INSTRUMENTATION_TAG_RE`, `INSTRUMENTATION_BLOCK_RE`), (4) erroneous leading single-dash prefix (`-find .` → `find .`) that upstream models sometimes produce. Preserve all of these; every one traces back to a real broken log.
- `sanitizeToolText` also strips stray multi-line `tool_use>` tokens that weak models emit as plain text (e.g. `"tool_use>\n\ntool_use>\n\ntool_use>"`). The regex uses a multi-occurrence matcher so both single-line and multi-line runs get collapsed.
- **Read loop suppression across ALL prior turns** (`suppressRepeatedReadToolCalls`). Previously this only checked the immediately previous assistant message for Read targets. Weak models (glm-5) keep emitting `Read AGENTS.md` in turn 1, 3, 5, 7 thinking the file was empty each time, loop-locking the agent. `collectAllPreviousReadTargets` now scans the entire message history; any Read of a file already read in ANY prior turn is dropped, forcing intent synthesis to pick a different file from the tool_result context (respecting the same "already-read" blocklist, so progress is always made).
- `sanitizeToolInputString` runs the same cleanup for non-command string fields. `coerceToolInput` applies it to a whitelist of path-like fields (`file_path`, `filePath`, `path`, `pattern`, `file`, `filename`, `source`, `destination`, `old_string`, `new_string`, `search`, `find`, `replace`, `replacement`). **Never sanitize `content` / `text` / `body` / `query` / `description`** — these legitimately contain XML/HTML or free-form text. The whitelist is explicit in `normalizers.js`; add new fields only after verifying they can't contain user content.
- **Schema shape sync for read/write/edit.** `coerceToolInput` always fills every path field name synonymously: if upstream sent `file_path`, the proxy also populates `filePath` and `path` (and vice versa) with the same value. Different clients validate different naming conventions — OpenCode's Zod schema requires `filePath` (camelCase), Claude Code uses `file_path` (snake_case). Without this sync the proxy would pass `Invalid input: expected string, received undefined` errors into the client and the assistant would loop. Same treatment is applied to `write`/`edit`. The only field that is NOT synced this way is `content` for `write` (it is the file body, not a path).
- **Structured OpenAI `tool_calls` are canonicalized on response.** When upstream already emits a `tool_calls` array (not text-embedded), proxy parses each `tool_calls[].function.arguments`, runs them through `canonicalizeToolCalls` (same path as text-embedded tool calls), and re-stringifies. This applies schema sync (`file_path` ↔ `filePath`) and sanitization to pre-structured tool calls — making the proxy OpenCode-compatible for weak models that send structured JSON instead of tool_use blocks.
- **Empty tool_use drops (value-level, not key-level).** Weak upstream models (glm-5) frequently emit `{type:'tool_use', name:'Read', input:{}}` or similar broken blocks with no actual arguments. `coerceToolInput` fills synonym fields with `undefined`, so the older `Object.keys(input).length === 0` check let these through (keys existed, values didn't). `hasAnyDefinedValue` now inspects values and drops broken calls. Per-tool path/pattern validation follows: read/write/edit require a non-empty path, glob requires a pattern, grep requires a pattern. When all tool_use blocks get dropped this way, `applyAnthropicNormalization` hands off to intent synthesis (which can pick a file from prior `tool_result` context) instead of propagating an empty tool_use that would trigger client-side Zod validation errors and kill the session.
- **Bogus bash command filter.** `isBogusBashCommand` drops bash calls whose `command` is just a tool name (`bash`, `read`, `context`, `message`, `parameters`, …) or an orphan CLI flag (`:message=...`, `-message=...`, `--param=...`). These are traces of the model whispering to itself rather than real shell commands; executing them produces `exit 127 command not found` which breaks the agent loop with no useful output.
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
