# AGENTS.md

## Key Commands

- Start server: `node server.js` (requires `PORT`, `UPSTREAM_BASE_URL`, `AIRFORCE_API_KEY`)
- Run all tests: `npm test` or `node --test`
- Run single test: `node --test test/normalizers.test.js`

## Architecture

- **Entry**: `server.js` - HTTP proxy server
- **lib/normalizers.js** - normalizes broken `<tool_call>` / `</think>` output to standard tool_call format
- **lib/sse.js** - SSE stream handling (converts non-stream upstream to SSE)
- **Port**: 2393 (configurable via PORT env var)

## Env Requirements

```bash
PORT=2393
UPSTREAM_BASE_URL=https://api.airforce
AIRFORCE_API_KEY=your_key_here
MODEL_ALIASES='{"claude-sonnet-4-20250514":"provider/actual-model-id"}'  # optional
```

## See Also

- `CLAUDE.md` - CLI-specific guidance