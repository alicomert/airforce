# AGENTS.md

Compact guide for working in this repo. See `README.md` and `CLAUDE.md` for user-facing docs; this file captures things an agent would otherwise miss.

## Stack

- Pure ESM Node.js project (`"type": "module"` in `package.json`). No TypeScript, no bundler, no linter, no formatter. Zero runtime dependencies.
- Two source files do all the work:
  - `server.js` — HTTP server + request/response routing
  - `lib/normalizers.js` — all the weird tool-call / `<think>` / XML-ish text normalization (~1400 lines; this is the bulk of the logic)
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
- **Synthetic streaming.** When the client sends `stream: true` on `/anthropic/*`, `/v1/messages`, or `*/chat/completions`, the proxy calls upstream with `stream: false`, normalizes the full JSON, then re-emits it as SSE via `lib/sse.js`. Response carries `x-airforce-proxy-stream: synthetic`. If you add a new streaming path, update both `shouldHandleSyntheticStream` (server.js:109) and the branch picking the SSE encoder (server.js:274).
- **Model aliasing is two-way.** `maybeRewriteModel` swaps client model → upstream model on the way out; `restorePresentedModel` puts the client's original model name back on the response. On `/models` endpoints, `appendAliasModels` also injects alias ids so clients see them in the list. Keep both directions consistent when touching alias logic.
- **Non-JSON upstream responses are passed through untouched** (status, content-type, body) — normalization only runs when `content-type` contains `application/json`.
- **`DEBUG_LOGS` is on by default.** Set `DEBUG_LOGS=0` to silence. Logs are verbose and include truncated message/tool summaries; keep them terse if you add more.

## Normalization layer (`lib/normalizers.js`)

This is the hard-earned core. Before editing:

- Entry points used by the server: `normalizeJsonPayload(pathname, payload, requestBody)`, `maybeRewriteModel`, `restorePresentedModel`. Internally it dispatches to `applyAnthropicNormalization`, `applyOpenAiChatNormalization`, `applyOpenAiResponsesNormalization` based on path.
- `extractPseudoToolCalls` is the text → tool_use extractor. It handles `<think>`, `<tool_call>`, `<tool_use>`, `<arg_key>/<arg_value>`, fenced `json`/`bash`, `<file://…>` write blocks, and various XML-ish variants. Many tests assert exact text trimming — if you change whitespace handling, expect snapshot-like failures in `test/normalizers.test.js`.
- Tool-name aliasing (`TOOL_NAME_ALIASES`, `ARG_SYNONYMS`, `SHELL_COMMAND_ALIASES`) is how upstream's weird tool emissions get mapped back to the client's declared tool schema. New aliases go there, not in call sites.
- When the normalizer empties `content` that originally had blocks, `server.js` logs `normalization_emptied_content` with truncated raw blocks. That log is a canary — if you see it firing in a new test, the normalizer is eating legitimate output.

## Testing conventions

- `test/server.test.js` sets `process.env.AIRFORCE_API_KEY` **before** importing `server.js` (top-level `await import`). Preserve that pattern if adding tests that read env at module load.
- No mocking framework; tests are pure `node:assert/strict`. Don't add a test runner dependency.
- `test/normalizers.test.js` is ~1500 lines of table-like cases. Add new scenarios alongside the closest existing block rather than a new file.

## Deployment

- `deploy/airforce-compat-proxy.service` is a real systemd unit assuming `/root/airforce` + `/etc/airforce-compat-proxy.env`. Update both if you move paths.

## Style

- Match existing code: ES modules, single quotes, 2-space indent, no semicolons omitted, named exports. No Prettier config — follow the surrounding file.
- Keep runtime dependency-free. Anything new should use `node:` built-ins.
