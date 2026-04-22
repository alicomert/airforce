# AGENTS.md

Compact guide for working in this repo. See `README.md` and `CLAUDE.md` for user-facing docs; this file captures things an agent would otherwise miss.

## Stack

- Pure ESM Node.js project (`"type": "module"`). No TypeScript, no bundler, no linter, no formatter. Zero runtime dependencies — anything new must use `node:` built-ins.
- Source files:
  - `server.js` — HTTP server + routing + upstream retry + keep-alive
  - `lib/normalizers.js` — tool-call / chain-of-thought / XML-ish text normalization (~2700 lines; the bulk of the logic)
  - `lib/intent-synthesis.js` — when upstream answers with plain text instead of `tool_use`, synthesizes a tool call from deterministic signals (tool history, fenced block structure, render containers, explicit filenames, slash-commands). No hardcoded natural-language phrases. Uses the client's declared tool names.
  - `lib/auto-recovery.js` — **default ON** (`AUTO_RECOVERY=0` to opt out). Handles the "upstream returned completely empty payload" case: synthesizes a deterministic tool_use from history or, if impossible, returns a minimal `.` text so the session keeps moving. Replaces the old "The upstream model returned an empty response..." user-facing error text — that string is **never shown to end users anymore**.
  - `lib/system-prompt-injection.js` — **default ON** (`INJECT_SYSTEM_PROMPT=0` to opt out). Injects a dynamic tool contract (built from the client's tool list + schemas) into the system prompt to nudge weaker models toward calling tools instead of replying in text. Known trade-off: a few weak models emit OpenAI-style `{"name":"X",…}` JSON after seeing signatures, which surfaces as `No such tool available` in Claude Code — disable via env if you hit this.
  - `lib/sse.js` — synthesizes Anthropic & OpenAI SSE streams from a single non-stream upstream JSON reply
- Tests: `node:test` under `test/`, fixtures under `testdata/`. ~150 cases in `normalizers.test.js`; separate `system-prompt-injection.test.js`, `server.test.js`, and `auto-recovery.test.js` suites.

## Commands

- `npm test` — runs all tests via `node --test`. No services needed.
- Single file: `node --test test/normalizers.test.js`
- Single test: `node --test --test-name-pattern="extractPseudoToolCalls parses" test/normalizers.test.js`
- Start server: `PORT=2393 HOST=127.0.0.1 UPSTREAM_BASE_URL=https://api.airforce AIRFORCE_API_KEY=... node server.js` (HOST defaults to `0.0.0.0`)
- Model aliasing: `MODEL_ALIASES='{"claude-sonnet-4-20250514":"provider/actual-model-id"}'`
- Health: `GET /health` returns configured upstream, port, aliases.

No lint or typecheck. Run tests.

## Core principle

**The proxy never replaces the model's actual text output with a synthetic error or summary.** It may sanitize XML-like reasoning artifacts, synthesize missing `tool_use` blocks, or drop demonstrably broken tool calls — but it will not overwrite a user-facing text answer. Violations of this were real shipped bugs (`hasMalformedFinalText`, removed) that false-positived on legitimate summary replies. If you're tempted to add "if text looks wrong, swap it for our message", resist.

## Non-obvious server behavior

- **Only `/anthropic/*` and `/v1/*` are proxied.** Everything else returns 404. `/anthropic` prefix is stripped before forwarding (`mapUpstreamPath`).
- **Inbound auth is always replaced.** Client `authorization` and `x-api-key` are dropped; if `AIRFORCE_API_KEY` is set it's injected as both `Bearer` and `x-api-key`. Do not pass through client credentials.
- **Synthetic streaming.** When `stream: true` hits `/anthropic/*`, `/v1/messages`, or `*/chat/completions`, the proxy calls upstream with `stream: false`, normalizes the full JSON, then re-emits it as SSE via `lib/sse.js`. Response carries `x-airforce-proxy-stream: synthetic`. Any new streaming path needs `shouldHandleSyntheticStream` in `server.js` AND the correct encoder branch.
- **Upstream retry is automatic.** `fetchUpstreamWithRetry` retries on network errors, timeouts, 408/425/429, and 5xx with exponential backoff + jitter. Separately, if normalize returns an "effectively empty" payload, the proxy re-calls upstream with a **nudge-augmented request body** — a temporary `system` hint that escalates across retries (level 1: gentle reminder; level 2: "you MUST produce tool_use or text"; level 3+: "pick between tool_use or a clarifying text"). Conversation state (messages history) is never mutated; the nudge only lives in the retry's request body. Loop continues until the empty-retry **budget** (`EMPTY_RESPONSE_BUDGET_MS`, default 60s in FAST_MODE, 120s otherwise) is exhausted or the hard-limit `EMPTY_RESPONSE_MAX_RETRIES` (default 10) is hit. Defaults from `FAST_MODE` (default ON):
  - `FAST_MODE=1`: 3 per-call attempts, 150ms base, 1.5s max (per-call network retry)
  - `FAST_MODE=0`: 4 per-call attempts, 300ms base, 3s max
  - `UPSTREAM_TIMEOUT_MS` is **180s in both modes** (large-file Read + generation can exceed 2 min)
  - Empty-payload retry: **3 retries / 15s budget** (both modes). Defaults were previously 10 retries / 60-120s — too long; users saw "retry forever then fail" instead of a quick failure they could react to.
  - **Skip empty-retry when the last tool_result is an error.** `isLastToolResultAnError` checks the most recent `role: 'tool'` (OpenAI) or `tool_result` block (Anthropic) for `is_error: true` or text patterns (`File not found`, `permission denied`, `ENOENT`, `Error:`, `Cannot read/write/...`, etc.). If matched, empty-retry is skipped entirely and the fallback text is returned immediately. Rationale: upstream that sees `File not found` in history rarely recovers via retry — it keeps returning empty payloads on the same error context; looping is pure user-wait. The proxy hands control back to the client (OpenCode/Claude Code), which re-prompts with a corrected path. File contents legitimately containing the word "error" are guarded by a `>2000 char` length cutoff. Disable via `SKIP_EMPTY_RETRY_ON_TOOL_ERROR=0`.
  - Override individually: `UPSTREAM_MAX_ATTEMPTS`, `UPSTREAM_RETRY_BASE_MS`, `UPSTREAM_RETRY_MAX_MS`, `UPSTREAM_TIMEOUT_MS`, `EMPTY_RESPONSE_MAX_RETRIES`, `EMPTY_RESPONSE_BUDGET_MS`, `RETRY_ON_EMPTY_RESPONSE=0` to disable, `SKIP_EMPTY_RETRY_ON_TOOL_ERROR=0` to retry through tool errors anyway.
  - `isNoProgressAssistantTurn` is language-agnostic and structural. Triggers retry in four cases: (1) completely empty payload; (2) only the proxy's own empty-response fallback text; (3) first-turn reply with user message + no prior tool_use + text-only (the "I'll start by exploring" stall); (4) **mid-session text-only reply where the session has only exploration tools (Read/Glob/Grep/Bash) — NO mutation (Write/Edit/Delete) yet**. Case 4 catches "Let me try a different approach:" / "Done!" style stalls where the model abandoned the task before actually producing the file change. Counter-case: if the last assistant tool_use was a mutation (Write/Edit/Delete), text-only response IS legitimate summary and is NOT retried. An earlier version regexed "Let me check..."-style text, which was language-biased and caused redundant retries.
  - Nudge text itself is language-agnostic: structural (`"Your previous response had no tool_use block and no text content. Do ONE of..."`). Context-aware — if prior tool_use history shows exploration without mutation, nudge mentions "you likely have enough context to invoke write/edit now".
- **Model aliasing is two-way.** `maybeRewriteModel` swaps client → upstream model on request; `restorePresentedModel` puts the client's name back on response. `/models` also injects alias IDs via `appendAliasModels`. Keep both sides in sync.
- **Non-JSON upstream responses pass through untouched** (status, content-type, body). Normalization only runs when `content-type` contains `application/json`.
- **`DEBUG_LOGS=1` by default**, very verbose. Uses `util.inspect(depth:5)` so tool_use input is visible (older version showed `[Object]`). Set `DEBUG_LOGS=0` to silence.
- HTTP server `keepAliveTimeout: 30s` and `headersTimeout: 35s` for ardisik tool-call turns (client-side TCP reuse).

## Normalization layer (`lib/normalizers.js`)

This is the hard-earned core. Before editing:

- **Entry points:** `normalizeJsonPayload(pathname, payload, requestBody)`, `normalizeRequestMessages`, `normalizeRequestTools`, `maybeRewriteModel`, `restorePresentedModel`. Internally dispatches to `applyAnthropicNormalization`, `applyOpenAiChatNormalization`, `applyOpenAiResponsesNormalization` based on path.
- **`extractPseudoToolCalls`** is the text → tool_use extractor. Handles `<tool_call>`, `<tool_use>`, `<arg_key>/<arg_value>`, fenced `json`/`bash`, `<file://…>` write blocks, and various XML-ish variants. Many tests assert exact text trimming — changing whitespace handling breaks snapshots.
- **Tool-name aliasing** lives in `TOOL_NAME_ALIASES`, `ARG_SYNONYMS`, `SHELL_COMMAND_ALIASES`. New aliases go here, not in call sites.

### Model-agnostic reasoning cleanup

- **No hardcoded reasoning tag lists.** `LEGIT_HTML_TAG_NAMES` is a whitelist of standard HTML/XML elements. Any non-whitelist tag (`<think>`, `<thinking>`, `<reasoning>`, `<scratchpad>`, `<planning>`, `<rationale>`, whatever future model emits) is treated as reasoning/generator artifact. This keeps the proxy working for GPT-3.5, Llama, Mistral, DeepSeek, Gemini, and anything not-yet-released without code changes.
- **`stripNonHtmlStructuredBlocks`** (in `cleanText`): any balanced `<X>…</X>` block where `X` is not a legit HTML tag gets removed with its inner content. So chain-of-thought is hidden from users.
- **`sanitizeCommand`** uses the same whitelist for trailing close-tag removal on bash commands (non-HTML `</X>...` suffix is stripped; legit HTML close tags are preserved). Also strips trailing UI labels (`(fetching file listing)` etc. via `UI_LABEL_SUFFIX_RE`), Claude Code / OpenCode instrumentation tags — underscore and dash variants of `command[_-]message`, `system[_-]reminder`, `local[_-]command(-std(out|err))?`, `user[_-]message`, `assistant[_-]message`, `tool[_-]output`, `claude[_-]instructions` — and fixes erroneous leading `-cmd` prefixes.
- **`sanitizeToolText`** strips stray multi-line `tool_use>` runs that weak models emit as plain text, loose `<content>` tag leaks, and structured tool-call debug dumps like `ToolCall inputs: {...}` / `Function call: {...}` / `Invoke arguments: {...}` (any `(tool|function|invoke|action)[_ -]?(inputs|arguments|params|args): {...}` pattern, model-agnostic).
- **`normalizePathForTool`** runs on `file_path` / `filePath` / `path` / `file` / `filename` / `source` / `destination` after sanitization: strips leading `./` or `.\\`, balanced surrounding quotes/backticks, and Windows double-backslash escapes. Needed because OpenCode's Zod validator rejects `./CLAUDE.md` with "Write failed" even though bash would accept it. `pattern` (glob) and `search`/`find` (grep) are **not** normalized since `./` has different meaning in patterns.

### Broken tool-call filtering

- **Empty tool_use value check.** `hasAnyDefinedValue` rejects tool_use blocks whose input values are all `undefined`/null/empty-string, even when keys exist (`coerceToolInput` fills synonym keys with `undefined`). Per-tool path/pattern validation follows: read/write/edit require a non-empty path; glob/grep require a pattern. Dropped broken blocks hand off to intent synthesis, which can pick a file from prior `tool_result` context instead of propagating a Zod-validation failure into the client.
- **`isBogusBashCommand`** drops Bash calls whose command is just a tool name (`bash`, `read`, `context`, `timeout`, `xargs`, `sudo`, `env`, `exec`, `source`, `message`, `parameters`, …) or an orphan CLI flag (`:message=...`, `-message=...`, `--param=...`). These produce `exit 127` / `missing operand` and break the agent loop.
- **`isContentFilenameMismatch`** drops Write calls where the content's first-line filename heading (`# FILENAME.ext`, HTML comment, JS/C comment) refers to a different file than `file_path`. This prevents catastrophic overwrites (e.g., model emitting `Write(manifest.json, '# CLAUDE.md\n...')`).
- **Empty `content` Write** is also dropped — it would otherwise truncate an existing file to zero bytes.
- **Write enforcement** (`enforceWriteFromFencedContent`). Weak models sometimes emit a markdown fenced block (the file contents) alongside unrelated tool_use calls (e.g. `Bash(npx serve)`) without producing the actual `Write` tool call. Deterministic, language-agnostic rule: if a turn has a substantial fenced block (≥50 chars) that is NOT path-listing / shell-output / render container, AND no Write tool_use is present this turn, AND no prior Write on the same target file in history → synthesize the Write tool_use with filename picked from (1) markdown heading inside the block like `# FILENAME.ext`, (2) filename mention before/after the block, or (3) user message filename. The synthesized Write is prepended to the tool_use list; existing calls (Bash etc.) are preserved. The source fenced block is stripped from user-visible text to avoid UI duplication.
- **Schema shape sync for read/write/edit.** `coerceToolInput` populates every synonym of a path field (`file_path`, `filePath`, `path`). Different clients validate differently — OpenCode Zod wants `filePath`, Claude Code uses `file_path`. Without sync the assistant loops on validation errors. The sole exception is `content` for Write — that's the file body, not a path.
- **Structured OpenAI `tool_calls`** are parsed, canonicalized (same path as text-embedded calls — field sync, sanitization), and re-stringified. This lets weak models emit structured JSON and still be OpenCode-compatible.
- **Parallel tool-call collapse.** `collapseParallelToolCalls` keeps only the first call per STATEFUL tool per turn (bash, delete, write, edit). Stateless tools (read, glob, grep, webfetch, task) are preserved. Also collapses duplicate `Glob`/`Grep` calls with identical pattern. Disable via `COLLAPSE_PARALLEL_TOOL_CALLS=0`.
- **Read loop suppression across ALL prior turns** (`suppressRepeatedReadToolCalls`). Weak models sometimes re-emit `Read AGENTS.md` in turns 1, 3, 5, 7 thinking the file came back empty each time. `collectAllPreviousReadTargets` scans the whole history; any Read of a file already read in any earlier turn is dropped so intent synthesis has to pick a different file.
- **`Bash(cat X)` / `head` / `less` / `more` / `type` / `Get-Content` → Read rewrite.** `extractPathFromReadLikeCommand` detects a simple single-file read command (no pipe, redirect, or extra operators) and rewrites it to the client's Read tool, avoiding `stdout` truncation on large files. Pipes or redirects (`cat X | head`) are left alone. **Important exception:** if `X` was already read in a prior turn, the rewrite is skipped and the Bash call is preserved as-is. Otherwise the proxy would convert it, `suppressRepeatedReadToolCalls` would then drop it (already read), and the turn would become tool_use-empty → empty-retry loop.
- **`suppressRepeatedReadToolCalls` non-empty guarantee.** If all Reads in a turn target already-read files, dropping them all would leave zero tool_use and trigger an empty-retry loop. The function now keeps the first original Read so the turn always has at least one tool_use — session progresses, client re-executes, model moves on.
- **`normalizePathForTool` trailing artifact stripping.** Weak models sometimes emit `file_path='manifest.json</Read>'` with the tool-frame close tag leaked into the path value. The normalizer strips any trailing `</...>` close tag and stray `<`/`>` characters from path fields before the client sees them.
- **Leading stray prefixes** in bash (`_ cat x`, `. foo`, `: foo`) are stripped; parenthesized wrappers (`(cat x)`) are unwrapped when balanced.

### Intent synthesis (`lib/intent-synthesis.js`)

Deterministic, language-agnostic. Runs only when upstream produced zero tool_use blocks. Order (first hit wins):

1. **Tool-result continuation** (`trySynthesizeReadFromToolResult`) — prior turn had Bash/Glob/Grep output containing filenames; pick the highest-priority unread file (scored via `KEY_FILE_PRIORITY`) and Read it. This is the safest synthesis since Read is stateless.
2. **Write** — requires (a) the user message has an explicit filename (`index.html`, `config.json`) and (b) a fenced code block that is NOT a path listing, NOT shell output, NOT inside a `<details>`/`<summary>` render container. Any of those → skip synthesis. This guards against turning `ls` output into file content.
3. **Read** — model text mentions exactly ONE filename, not yet read in any prior turn.
4. **List/Glob fallback** — session has no prior tool_use yet, user text is non-trivial (>2 chars), no explicit filename in user text. Then synthesize `Glob('**/*')`. This prevents stalls when the model replies with text only on the first turn. Slash-commands like `/init`, `/explore`, `/analyze` (even wrapped in `<command-name>`) match here.

Schema field names are picked from the client's declared tool schema (`file_path` vs `filePath` vs `path`). Disable everything via `SYNTHESIZE_INTENT=0`.

**OpenAI Chat history awareness.** History inspection (`getAssistantToolUses`, `collectPreviouslyReadTargets`, `findRecentExplorationToolResult`) understands BOTH message shapes: Anthropic (`assistant.content[]` with `tool_use` blocks) AND OpenAI Chat Completions (`assistant.content: null` + `tool_calls: [{ function: { name, arguments: '<json>' } }]` plus separate `role: 'tool'` result messages). An earlier version only parsed Anthropic shape, so on the OpenAI-compat path `priorCategories` always came back empty and `trySynthesizeList` re-emitted `Glob('**/*')` **every single turn**, producing the `✱ Glob "**/*"` loop. `trySynthesizeList` also has an explicit cross-turn guard: if any prior turn already used a list/glob tool (client-direct OR proxy-synthesized), the proxy refuses to synthesize again — loop is structurally impossible.

Instrumentation tags in the user message (`<system-reminder>`, `<tool-output>`, `<claude-instructions>`, `<local-command-std*>`) are stripped before intent analysis so that filenames mentioned inside tool manifests don't poison the "user mentioned a specific file" heuristic. Tags that carry the user's real command (`<command-name>`, `<command-args>`, `<command-message>`) have their tag wrapper stripped but inner content kept.

### Misc

- **Post-Write duplicate suppression** — if the previous assistant turn did `Write(X, content)` and the current turn's text contains the same content in a fenced block, it's stripped (model restating what it already wrote causes UIs to render the file body twice).
- When the normalizer empties `content` that originally had blocks, `server.js` logs `normalization_emptied_content` with truncated raw blocks. Canary — if it fires in a new test, the normalizer is eating legitimate output.
- If upstream returned `stop_reason: "tool_use"` but normalizer dropped all tool_use blocks, `applyAnthropicNormalization` downgrades stop_reason to `end_turn` to avoid Anthropic "parallel tool error" loops.

## Testing conventions

- `test/server.test.js` sets `process.env.AIRFORCE_API_KEY` **before** `await import('...server.js')`. Preserve that pattern for any test that reads env at module load.
- No mocking framework; pure `node:assert/strict`. Don't add a test runner dependency.
- ~150 cases in `test/normalizers.test.js`. Add new scenarios alongside the closest existing block rather than starting a new file.
- Many tests assert exact text content/trimming — changing whitespace in normalization breaks them like snapshots.

## Deployment

`deploy/airforce-compat-proxy.service` is an example systemd unit assuming `/root/airforce` + `/etc/airforce-compat-proxy.env`. Template — adjust for your server. Runtime code has no hardcoded paths.

## Style

- Match existing code: ES modules, single quotes, 2-space indent, named exports. No Prettier config — follow the surrounding file.
- Keep runtime dependency-free. Anything new uses `node:` built-ins.
- Comments in `lib/` are often Turkish (original author). Not a policy — write English or Turkish, match the surrounding file.
