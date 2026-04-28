import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router, AllProvidersFailedError } from '../lib/router.js';
import { ProviderError } from '../lib/providers/base.js';
import { ModelRegistry, ModelNotFoundError } from '../lib/model-registry.js';
import { CircuitBreakerRegistry } from '../lib/circuit-breaker.js';

function makeProvider(id, behavior) {
  let i = 0;
  return {
    id,
    chat: async (body) => {
      const next = behavior[i++] || behavior[behavior.length - 1];
      if (next instanceof Error) throw next;
      return { text: next, usage: {}, finish_reason: 'stop', raw: { id: 'r', choices: [] } };
    },
  };
}

function buildRouter(providers, registryConfig) {
  const reg = new ModelRegistry();
  reg.load(registryConfig, providers);
  const breakers = new CircuitBreakerRegistry();
  return new Router(reg, breakers);
}

test('execute() returns first provider success', async () => {
  const providers = {
    a: makeProvider('a', ['hello-from-a']),
    b: makeProvider('b', ['hello-from-b']),
  };
  const cfg = {
    providers: [
      { id: 'a', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
      { id: 'b', enabled: true, models: [{ upstream_id: 'm', priority: 1, enabled: true }] },
    ],
    aliases: {}, global: {},
  };
  const router = buildRouter(providers, cfg);
  const out = await router.execute('m', { model: 'm', messages: [] });
  assert.equal(out.providerId, 'a');
  assert.equal(out.result.text, 'hello-from-a');
});

test('execute() falls over on transient and uses next provider', async () => {
  const providers = {
    a: makeProvider('a', [new ProviderError('boom', { status: 502, category: 'transient' })]),
    b: makeProvider('b', ['rescued']),
  };
  const cfg = {
    providers: [
      { id: 'a', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
      { id: 'b', enabled: true, models: [{ upstream_id: 'm', priority: 1, enabled: true }] },
    ],
    aliases: {}, global: {},
  };
  const router = buildRouter(providers, cfg);
  const out = await router.execute('m', { model: 'm', messages: [] });
  assert.equal(out.providerId, 'b');
  assert.equal(out.result.text, 'rescued');
});

test('execute() trips breaker on auth and falls over', async () => {
  const providers = {
    a: makeProvider('a', [new ProviderError('no key', { status: 401, category: 'auth' })]),
    b: makeProvider('b', ['ok-from-b']),
  };
  const cfg = {
    providers: [
      { id: 'a', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
      { id: 'b', enabled: true, models: [{ upstream_id: 'm', priority: 1, enabled: true }] },
    ],
    aliases: {}, global: {},
  };
  const router = buildRouter(providers, cfg);
  const out = await router.execute('m', { model: 'm', messages: [] });
  assert.equal(out.providerId, 'b');
  assert.equal(router.breakers.get('a').isOpen(), true);
});

test('execute() marks bad_model entry unavailable and falls over', async () => {
  const providers = {
    a: makeProvider('a', [new ProviderError('no model', { status: 404, category: 'bad_model' })]),
    b: makeProvider('b', ['ok-from-b']),
  };
  const cfg = {
    providers: [
      { id: 'a', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
      { id: 'b', enabled: true, models: [{ upstream_id: 'm', priority: 1, enabled: true }] },
    ],
    aliases: {}, global: {},
  };
  const router = buildRouter(providers, cfg);
  const out = await router.execute('m', { model: 'm', messages: [] });
  assert.equal(out.providerId, 'b');
  const entries = router.registry.resolve('m');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].providerId, 'b');
});

test('execute() rethrows client error fatally (no fallback)', async () => {
  const providers = {
    a: makeProvider('a', [new ProviderError('bad request', { status: 400, category: 'client' })]),
    b: makeProvider('b', ['unreached']),
  };
  const cfg = {
    providers: [
      { id: 'a', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
      { id: 'b', enabled: true, models: [{ upstream_id: 'm', priority: 1, enabled: true }] },
    ],
    aliases: {}, global: {},
  };
  const router = buildRouter(providers, cfg);
  await assert.rejects(
    () => router.execute('m', { model: 'm', messages: [] }),
    (err) => err instanceof ProviderError && err.category === 'client',
  );
});

test('execute() throws AllProvidersFailedError when all transient', async () => {
  const providers = {
    a: makeProvider('a', [new ProviderError('a', { status: 502, category: 'transient' })]),
    b: makeProvider('b', [new ProviderError('b', { status: 503, category: 'transient' })]),
  };
  const cfg = {
    providers: [
      { id: 'a', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
      { id: 'b', enabled: true, models: [{ upstream_id: 'm', priority: 1, enabled: true }] },
    ],
    aliases: {}, global: {},
  };
  const router = buildRouter(providers, cfg);
  await assert.rejects(
    () => router.execute('m', { model: 'm', messages: [] }),
    AllProvidersFailedError,
  );
});

test('execute() throws ModelNotFoundError when registry has no entry', async () => {
  const cfg = { providers: [], aliases: {}, global: {} };
  const router = buildRouter({}, cfg);
  await assert.rejects(
    () => router.execute('m', { model: 'm', messages: [] }),
    ModelNotFoundError,
  );
});

test('execute() skips providers with open breaker', async () => {
  const providers = {
    a: makeProvider('a', ['unreached-a']),
    b: makeProvider('b', ['ok-b']),
  };
  const cfg = {
    providers: [
      { id: 'a', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
      { id: 'b', enabled: true, models: [{ upstream_id: 'm', priority: 1, enabled: true }] },
    ],
    aliases: {}, global: {},
  };
  const router = buildRouter(providers, cfg);
  router.breakers.get('a').tripUntil(Date.now() + 60_000, 'manual');
  const out = await router.execute('m', { model: 'm', messages: [] });
  assert.equal(out.providerId, 'b');
});

test('execute() upstream body uses upstreamModelId, not presented modelId', async () => {
  let received;
  const provider = {
    id: 'or',
    chat: async (body) => {
      received = body;
      return { text: 'ok', usage: {}, finish_reason: 'stop', raw: { id: 'r', choices: [] } };
    },
  };
  const cfg = {
    providers: [{
      id: 'or', enabled: true,
      models: [{ upstream_id: 'z-ai/glm-4.6', priority: 0, enabled: true, presented_id: 'glm-4.6' }],
    }],
    aliases: {}, global: {},
  };
  const router = buildRouter({ or: provider }, cfg);
  await router.execute('glm-4.6', { model: 'glm-4.6', messages: [] });
  assert.equal(received.model, 'z-ai/glm-4.6');
});
