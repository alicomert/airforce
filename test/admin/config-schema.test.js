import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProviderConfig, validateModelConfig, validateProvidersFile } from '../../lib/providers/config-schema.js';

test('validateProviderConfig: valid openai-compat passes', () => {
  const r = validateProviderConfig({
    id: 'airforce', type: 'openai-compat', base_url: 'https://api.airforce', api_key: 'sk-x',
    enabled: true, models: [],
  });
  assert.equal(r.ok, true);
});

test('validateProviderConfig: invalid id rejected', () => {
  const r = validateProviderConfig({ id: 'AirForce!', type: 'openai-compat', base_url: 'x', api_key: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.error.field, 'id');
});

test('validateProviderConfig: missing base_url rejected', () => {
  const r = validateProviderConfig({ id: 'a', type: 'openai-compat', api_key: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.error.field, 'base_url');
});

test('validateProviderConfig: bad type rejected', () => {
  const r = validateProviderConfig({ id: 'a', type: 'wat', base_url: 'x', api_key: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.error.field, 'type');
});

test('validateProviderConfig: invalid url rejected', () => {
  const r = validateProviderConfig({ id: 'a', type: 'openai-compat', base_url: 'not a url', api_key: 'k' });
  assert.equal(r.ok, false);
  assert.equal(r.error.field, 'base_url');
});

test('validateModelConfig: requires upstream_id', () => {
  assert.equal(validateModelConfig({ priority: 0 }).ok, false);
  assert.equal(validateModelConfig({ upstream_id: 'glm-4.6' }).ok, true);
});

test('validateProvidersFile: catches duplicate ids', () => {
  const r = validateProvidersFile({
    schema_version: 1,
    providers: [
      { id: 'x', type: 'openai-compat', base_url: 'https://a', api_key: 'k', enabled: true, models: [] },
      { id: 'x', type: 'openai-compat', base_url: 'https://b', api_key: 'k', enabled: true, models: [] },
    ],
    aliases: {}, global: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /duplicate/i);
});

test('validateProvidersFile: ok on healthy config', () => {
  const r = validateProvidersFile({
    schema_version: 1,
    providers: [
      { id: 'x', type: 'openai-compat', base_url: 'https://api.x', api_key: 'k', enabled: true, models: [{ upstream_id: 'm', priority: 0, enabled: true }] },
    ],
    aliases: {}, global: {},
  });
  assert.equal(r.ok, true);
});
