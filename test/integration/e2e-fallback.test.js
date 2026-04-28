import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../../lib/router.js';
import { ModelRegistry } from '../../lib/model-registry.js';
import { CircuitBreakerRegistry } from '../../lib/circuit-breaker.js';
import { ProviderError } from '../../lib/providers/base.js';

test('end-to-end: priority 0 fails transient → priority 1 serves', async () => {
  let p0Calls = 0;
  let p1Calls = 0;

  const p0 = {
    id: 'p0',
    chat: async () => {
      p0Calls++;
      throw new ProviderError('upstream 502', { status: 502, category: 'transient' });
    },
  };
  const p1 = {
    id: 'p1',
    chat: async (body) => {
      p1Calls++;
      assert.equal(body.model, 'm-upstream-1');
      return {
        text: 'rescued',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        finish_reason: 'stop',
        raw: { id: 'r1', choices: [{ message: { content: 'rescued' } }] },
      };
    },
  };

  const cfg = {
    schema_version: 1,
    providers: [
      { id: 'p0', enabled: true, models: [{ upstream_id: 'm-upstream-0', priority: 0, enabled: true, presented_id: 'm' }] },
      { id: 'p1', enabled: true, models: [{ upstream_id: 'm-upstream-1', priority: 1, enabled: true, presented_id: 'm' }] },
    ],
    aliases: {},
    global: {},
  };

  const reg = new ModelRegistry();
  reg.load(cfg, { p0, p1 });
  const breakers = new CircuitBreakerRegistry();
  const router = new Router(reg, breakers);

  const out = await router.execute('m', { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(p0Calls, 1);
  assert.equal(p1Calls, 1);
  assert.equal(out.providerId, 'p1');
  assert.equal(out.result.text, 'rescued');
});

test('end-to-end: explicit prefix locks provider, no fallback', async () => {
  const p0 = { id: 'p0', chat: async () => { throw new ProviderError('boom', { status: 502, category: 'transient' }); } };
  const p1 = { id: 'p1', chat: async () => ({ text: 'unreached', usage: {}, finish_reason: 'stop', raw: { id: 'r', choices: [] } }) };

  const cfg = {
    schema_version: 1,
    providers: [
      { id: 'p0', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
      { id: 'p1', enabled: true, models: [{ upstream_id: 'm', priority: 1, enabled: true }] },
    ],
    aliases: {}, global: {},
  };
  const reg = new ModelRegistry();
  reg.load(cfg, { p0, p1 });
  const breakers = new CircuitBreakerRegistry();
  const router = new Router(reg, breakers);

  await assert.rejects(
    () => router.execute('p0/m', { model: 'p0/m', messages: [] }),
    (err) => err.name === 'AllProvidersFailedError' || err.category === 'transient',
  );
});
