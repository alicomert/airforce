# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands
- Start server: `PORT=2393 UPSTREAM_BASE_URL=https://api.airforce AIRFORCE_API_KEY=your_key_here node server.js`
- Run all tests: `npm test`
- Single test file: `node --test test/normalizers.test.js`
- Single test by name: `node --test --test-name-pattern="extractPseudoToolCalls parses" test/normalizers.test.js`
- Health check: `GET /health` (returns configured upstream, port, aliases)
- Model alias mapping: `MODEL_ALIASES='{"claude-sonnet-4-20250514":"provider/actual-model-id"}' node server.js`

## Stack
Pure ESM Node.js (`"type": "module"`). Zero runtime dependencies — anything new must use `node:` built-ins. No TypeScript, no bundler, no linter, no formatter.

## Core Principle
**The proxy never replaces the model's actual text output with a synthetic error or summary.** It may sanitize XML-like reasoning artifacts, synthesize missing `tool_use` blocks, or drop demonstrably broken tool calls — but it will not overwrite a user-facing text answer. Violations of this were real shipped bugs (`hasMalformedFinalText`, removed) that false-positived on legitimate summary replies.

## Architecture

### Request Flow
1. Client sends request to `/anthropic/*` or `/v1/*` (everything else returns 404)
2. `/anthropic` prefix is stripped before forwarding (`mapUpstreamPath`)
3. Client auth is always replaced — `authorization` and `x-api-key` are dropped; `AIRFORCE_API_KEY` is injected as both `Bearer` and `x-api-key`
4. If `stream: true`, proxy calls upstream with `stream: false`, normalizes the full JSON, then re-emits as SSE via `lib/sse.js`. Response carries `x-airforce-proxy-stream: synthetic`. Any new streaming path needs `shouldHandleSyntheticStream` in `server.js` AND the correct encoder branch
5. Non-JSON upstream responses pass through untouched. Normalization only runs when `content-type` contains `application/json`

### Source Files
- **`server.js`** — HTTP server, routing, upstream retry with exponential backoff + jitter, keep-alive (`keepAliveTimeout: 30s`, `headersTimeout: 35s`)
- **`lib/normalizers.js`** (~2200 lines, the bulk of the logic) — tool-call / chain-of-thought / XML-ish text normalization. Entry points: `normalizeJsonPayload(pathname, payload, requestBody)`, `normalizeRequestMessages`, `normalizeRequestTools`, `maybeRewriteModel`, `restorePresentedModel`
- **`lib/intent-synthesis.js`** — when upstream answers with plain text instead of `tool_use`, synthesizes a tool call from deterministic signals (tool history, fenced block structure, render containers, explicit filenames, slash-commands). No hardcoded natural-language phrases
- **`lib/system-prompt-injection.js`** — default ON (`INJECT_SYSTEM_PROMPT=0` to opt out). Injects a dynamic tool contract into the system prompt. Trade-off: a few weak models emit OpenAI-style JSON after seeing signatures → disable via env if hit
- **`lib/sse.js`** — synthesizes Anthropic & OpenAI SSE streams from a single non-stream upstream JSON reply

### Model Aliasing (Two-Way)
`maybeRewriteModel` swaps client → upstream model on request; `restorePresentedModel` puts the client's name back on response. `/models` also injects alias IDs via `appendAliasModels`. Keep both sides in sync.

### Upstream Retry & Empty-Response Handling
`fetchUpstreamWithRetry` retries on network errors, timeouts, 408/425/429, and 5xx. Separately, if normalize returns an "effectively empty" payload, the proxy re-calls upstream with a **nudge-augmented request body** — a temporary `system` hint that escalates across retries. Conversation state (messages history) is never mutated; the nudge only lives in the retry's request body.

`isNoProgressAssistantTurn` is language-agnostic and structural. Triggers retry in four cases: (1) completely empty payload; (2) only the proxy's own empty-response fallback text; (3) first-turn reply with user message + no prior tool_use + text-only; (4) mid-session text-only reply where the session has only exploration tools (Read/Glob/Grep/Bash) — NO mutation (Write/Edit/Delete) yet. Counter-case: if the last assistant tool_use was a mutation, text-only response IS legitimate and is NOT retried.

Defaults from `FAST_MODE` (default ON):
- `FAST_MODE=1`: 3 per-call attempts, 150ms base, 1.5s max, 120s per-call timeout, 10-retry/60s empty-retry budget
- `FAST_MODE=0`: 4 / 300ms / 3s / 180s / 10-retry/120s budget
- Override individually: `UPSTREAM_MAX_ATTEMPTS`, `UPSTREAM_RETRY_BASE_MS`, `UPSTREAM_RETRY_MAX_MS`, `UPSTREAM_TIMEOUT_MS`, `EMPTY_RESPONSE_MAX_RETRIES`, `EMPTY_RESPONSE_BUDGET_MS`, `RETRY_ON_EMPTY_RESPONSE=0` to disable

## Normalization Layer Details

### Model-Agnostic Reasoning Cleanup
`LEGIT_HTML_TAG_NAMES` is a whitelist of standard HTML/XML elements. Any non-whitelist tag (` MaybeThinking`, `<thinking>`, `<reasoning>`, whatever future model emits) is treated as reasoning artifact. `stripNonHtmlStructuredBlocks` removes balanced `` blocks where `X` is not legit HTML. This keeps the proxy working for any model without code changes.

### Tool-Name Aliasing
`TOOL_NAME_ALIASES`, `ARG_SYNONYMS`, `SHELL_COMMAND_ALIASES` in `lib/normalizers.js`. New aliases go here, not in call sites.

### Broken Tool-Call Filtering
- **Empty value check**: `hasAnyDefinedValue` rejects tool_use blocks whose input values are all undefined/null/empty-string, even when keys exist. Per-tool path/pattern validation follows
- **`isBogusBashCommand`**: drops Bash calls whose command is just a tool name or orphan CLI flag (produces `exit 127`)
- **`isContentFilenameMismatch`**: drops Write calls where content's first-line filename heading refers to a different file than `file_path` (prevents catastrophic overwrites)
- **Empty content Write**: dropped (would truncate file to zero bytes)
- **Write enforcement** (`enforceWriteFromFencedContent`): if a turn has a substantial fenced block (≥50 chars) that is NOT path-listing/shell-output/render container, AND no Write tool_use present, AND no prior Write on the same target → synthesize Write tool_use
- **Schema shape sync** (`coerceToolInput`): populates every synonym of a path field (`file_path`, `filePath`, `path`). Different clients validate differently — OpenCode Zod wants `filePath`, Claude Code uses `file_path`. Exception: `content` for Write is the file body, not a path
- **Parallel tool-call collapse**: `collapseParallelToolCalls` keeps only the first call per STATEFUL tool per turn (bash, delete, write, edit). Stateless tools (read, glob, grep, webfetch, task) preserved. Disable via `COLLAPSE_PARALLEL_TOOL_CALLS=0`
- **Read loop suppression** (`suppressRepeatedReadToolCalls`): scans whole history; any Read of a file already read in any earlier turn is dropped. Guarantees at least one tool_use remains (keeps first original Read to avoid empty-retry loop)
- **`Bash(cat X)` / `head` / `less` / `type` / `Get-Content` → Read rewrite**: detects simple single-file read commands (no pipe/redirect) and rewrites to Read tool. Skipped if file was already read in a prior turn (would get double-dropped)
- **`normalizePathForTool`**: strips leading `./` or `.\\`, balanced surrounding quotes/backticks, Windows double-backslash escapes, and trailing `</...>` close tags. Applied to path fields only — `pattern` (glob) and `search`/`find` (grep) are NOT normalized since `./` has different meaning in patterns

### Intent Synthesis (`lib/intent-synthesis.js`)
Runs only when upstream produced zero tool_use blocks. Deterministic, language-agnostic. Order (first hit wins):
1. **Tool-result continuation** — prior turn had Bash/Glob/Grep output containing filenames; pick highest-priority unread file and Read it
2. **Write** — user message has explicit filename AND a fenced code block that is NOT path-listing/shell-output/render container
3. **Read** — model text mentions exactly ONE filename not yet read
4. **List/Glob fallback** — no prior tool_use, user text non-trivial (>2 chars), no explicit filename → synthesize `Glob('**/*')`

Schema field names are picked from the client's declared tool schema. Disable via `SYNTHESIZE_INTENT=0`. Instrumentation tags in user messages (`<system-reminder>`, `<tool-output>`, etc.) are stripped before intent analysis.

### Misc Normalization Behaviors
- **Post-Write duplicate suppression**: if previous turn did `Write(X, content)` and current turn's text contains the same content in a fenced block, it's stripped
- If upstream returned `stop_reason: "tool_use"` but normalizer dropped all tool_use blocks, `stop_reason` is downgraded to `end_turn` to avoid Anthropic "parallel tool error" loops
- When normalizer empties `content` that originally had blocks, `server.js` logs `normalization_emptied_content` — canary for eating legitimate output
- `DEBUG_LOGS=1` by default (very verbose, `util.inspect(depth:5)`). Set `DEBUG_LOGS=0` to silence

## Testing Conventions
- `node:test` under `test/`, fixtures under `testdata/`. ~120 cases in `normalizers.test.js` alone
- `test/server.test.js` sets `process.env.AIRFORCE_API_KEY` **before** `await import('...server.js')` — preserve that pattern for any test that reads env at module load
- No mocking framework; pure `node:assert/strict`. Don't add a test runner dependency
- Add new test scenarios alongside the closest existing block rather than starting a new file
- Many tests assert exact text content/trimming — changing whitespace in normalization breaks them like snapshots

## Style
- Match existing code: ES modules, single quotes, 2-space indent, named exports
- Keep runtime dependency-free. Anything new uses `node:` built-ins
- Comments in `lib/` are often Turkish (original author). Not a policy — write English or Turkish, match the surrounding file
