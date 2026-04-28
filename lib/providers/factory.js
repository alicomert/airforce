// Tek-provider factory (Faz 1).
// Faz 2'de ModelRegistry bu modülü replace edecek.

import { OpenaiCompatProvider } from './openai-compat.js';

let cached = null;

export function buildProviderFromEnvConfig(cfg) {
  if (!cfg.airforceApiKey) {
    throw new Error('AIRFORCE_API_KEY tanımlı değil — .env dosyasını kontrol et (api key zorunlu)');
  }
  return new OpenaiCompatProvider({
    id: 'airforce',
    base_url: cfg.upstreamBaseUrl || 'https://api.airforce',
    api_key: cfg.airforceApiKey,
    timeout_ms: cfg.upstreamTimeoutMs,
    max_attempts: cfg.upstreamMaxAttempts,
    retry_base_ms: cfg.upstreamRetryBaseMs,
  });
}

export async function getDefaultProvider() {
  if (!cached) {
    const { config } = await import('../config.js');
    cached = buildProviderFromEnvConfig(config);
  }
  return cached;
}

// Test/admin reload için.
export function _resetDefaultProvider() { cached = null; }
