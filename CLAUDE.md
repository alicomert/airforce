```
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
```

## Commands
- Start server: `PORT=2393 UPSTREAM_BASE_URL=https://api.airforce AIRFORCE_API_KEY=your_key_here node server.js`
- Run all tests: `npm test`
- Model alias mapping: `MODEL_ALIASES='{"claude-sonnet-4-20250514":"provider/actual-model-id"}' node server.js`

## High-Level Architecture
- Core proxy (server.js) runs on port 2393, forwards `/anthropic/*` and `/v1/*` requests to upstream
- Normalization layer (lib/normalizers.js) converts malformed tool calls to standard formats for Anthropic/OpenAI
- Handles streaming requests by converting upstream non-stream responses to valid SSE streams
- Supports model alias mapping to preserve client-side official model names