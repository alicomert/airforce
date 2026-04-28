import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProviderFromEnvConfig } from '../../lib/providers/factory.js';
import { OpenaiCompatProvider } from '../../lib/providers/openai-compat.js';

test('buildProviderFromEnvConfig creates OpenaiCompatProvider with api.airforce defaults', () => {
  const cfg = {
    airforceApiKey: 'sk-air-test',
    upstreamBaseUrl: 'https://api.airforce',
    upstreamTimeoutMs: 90000,
    upstreamMaxAttempts: 2,
    upstreamRetryBaseMs: 100,
  };
  const p = buildProviderFromEnvConfig(cfg);
  assert.ok(p instanceof OpenaiCompatProvider);
  assert.equal(p.id, 'airforce');
  assert.equal(p.baseUrl, 'https://api.airforce');
  assert.equal(p.apiKey, 'sk-air-test');
  assert.equal(p.timeoutMs, 90000);
});

test('buildProviderFromEnvConfig throws when api key missing', () => {
  assert.throws(
    () => buildProviderFromEnvConfig({ airforceApiKey: '', upstreamBaseUrl: 'x' }),
    /api key/i,
  );
});
