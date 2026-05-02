import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRouter, buildProviderInstance } from '../../lib/providers/factory.js';
import { OpenaiCompatProvider } from '../../lib/providers/openai-compat.js';

test('buildProviderInstance creates OpenaiCompatProvider for openai-compat type', () => {
  const inst = buildProviderInstance({
    id: 'a', type: 'openai-compat', base_url: 'https://x', api_key: 'k', enabled: true,
  });
  assert.ok(inst instanceof OpenaiCompatProvider);
});

test('buildProviderInstance throws for unknown type', () => {
  assert.throws(
    () => buildProviderInstance({ id: 'a', type: 'wat', base_url: 'https://x', api_key: 'k' }),
    /unknown provider type/,
  );
});

test('buildRouter wires providers + registry + breakers', () => {
  const cfg = {
    schema_version: 1,
    providers: [
      {
        id: 'a', type: 'openai-compat', base_url: 'https://a.example', api_key: 'k', enabled: true,
        models: [{ upstream_id: 'm1', priority: 0, enabled: true }],
      },
    ],
    aliases: {},
    global: { default_model: 'm1', circuit_breaker: { fail_threshold: 5, open_seconds: 30 } },
  };
  const router = buildRouter(cfg);
  assert.ok(router.registry);
  assert.ok(router.breakers);
  const entries = router.registry.resolve('m1');
  assert.equal(entries.length, 1);
  assert.equal(router.breakers.get('a').failThreshold, 5);
});
