import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry, ModelNotFoundError } from '../lib/model-registry.js';

function fakeProvider(id) { return { id, chat: async () => ({}) }; }

function buildRegistry() {
  const cfg = {
    schema_version: 1,
    providers: [
      {
        id: 'airforce', type: 'openai-compat', base_url: 'x', api_key: 'k', enabled: true,
        models: [
          { upstream_id: 'glm-4.6', priority: 0, enabled: true },
          { upstream_id: 'llama-4-scout', priority: 0, enabled: true },
        ],
      },
      {
        id: 'openrouter', type: 'openai-compat', base_url: 'y', api_key: 'k2', enabled: true,
        models: [
          { upstream_id: 'z-ai/glm-4.6', priority: 1, enabled: true, presented_id: 'glm-4.6' },
          { upstream_id: 'anthropic/claude-sonnet-4', priority: 1, enabled: true },
        ],
      },
    ],
    aliases: { 'glm-fast': 'glm-4.6' },
    global: { default_model: 'glm-4.6' },
  };
  const reg = new ModelRegistry();
  reg.load(cfg, {
    airforce: fakeProvider('airforce'),
    openrouter: fakeProvider('openrouter'),
  });
  return reg;
}

test('resolve: short id returns priority-ordered entries', () => {
  const reg = buildRegistry();
  const entries = reg.resolve('glm-4.6');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].providerId, 'airforce');
  assert.equal(entries[0].upstreamModelId, 'glm-4.6');
  assert.equal(entries[1].providerId, 'openrouter');
  assert.equal(entries[1].upstreamModelId, 'z-ai/glm-4.6');
});

test('resolve: prefix id returns single provider, no fallback', () => {
  const reg = buildRegistry();
  const entries = reg.resolve('openrouter/z-ai/glm-4.6');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].providerId, 'openrouter');
  assert.equal(entries[0].upstreamModelId, 'z-ai/glm-4.6');
});

test('resolve: alias resolves to target model', () => {
  const reg = buildRegistry();
  const entries = reg.resolve('glm-fast');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].providerId, 'airforce');
});

test('resolve: short id without prefix uses last segment for slashed upstream', () => {
  const reg = buildRegistry();
  const entries = reg.resolve('claude-sonnet-4');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].providerId, 'openrouter');
  assert.equal(entries[0].upstreamModelId, 'anthropic/claude-sonnet-4');
});

test('resolve: unknown model throws ModelNotFoundError', () => {
  const reg = buildRegistry();
  assert.throws(() => reg.resolve('nonexistent'), ModelNotFoundError);
});

test('resolve: presented_id override wins over slash-derived short id', () => {
  const reg = buildRegistry();
  const entries = reg.resolve('glm-4.6');
  assert.equal(entries.length, 2);
});

test('markModelUnavailable disables the entry from future resolves', () => {
  const reg = buildRegistry();
  const before = reg.resolve('glm-4.6');
  assert.equal(before.length, 2);
  reg.markModelUnavailable(before[0]);
  const after = reg.resolve('glm-4.6');
  assert.equal(after.length, 1);
  assert.equal(after[0].providerId, 'openrouter');
});

test('listAllModels returns flat catalog with presented_id, provider, priority', () => {
  const reg = buildRegistry();
  const all = reg.listAllModels();
  assert.equal(all.length, 4);
  const presentedIds = new Set(all.map((m) => m.presented_id));
  assert.ok(presentedIds.has('glm-4.6'));
  assert.ok(presentedIds.has('claude-sonnet-4'));
});

test('disabled provider entries are filtered out of resolves', () => {
  const cfg = {
    schema_version: 1,
    providers: [
      {
        id: 'airforce', type: 'openai-compat', base_url: 'x', api_key: 'k', enabled: false,
        models: [{ upstream_id: 'glm-4.6', priority: 0, enabled: true }],
      },
      {
        id: 'openrouter', type: 'openai-compat', base_url: 'y', api_key: 'k2', enabled: true,
        models: [{ upstream_id: 'z-ai/glm-4.6', priority: 1, enabled: true, presented_id: 'glm-4.6' }],
      },
    ],
    aliases: {}, global: { default_model: 'glm-4.6' },
  };
  const reg = new ModelRegistry();
  reg.load(cfg, {
    airforce: fakeProvider('airforce'),
    openrouter: fakeProvider('openrouter'),
  });
  const entries = reg.resolve('glm-4.6');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].providerId, 'openrouter');
});
