import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setDataDirForTests, resetDataDirForTests, saveProvidersConfig } from '../../lib/store.js';
import { getRouter, invalidateRouterCache } from '../../lib/providers/factory.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-hot-'));
  setDataDirForTests(tmpDir);
  invalidateRouterCache();
});

afterEach(() => {
  invalidateRouterCache();
  resetDataDirForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('mutation + invalidateRouterCache → next getRouter sees new state', async () => {
  saveProvidersConfig({
    schema_version: 1,
    providers: [{ id: 'a', type: 'openai-compat', base_url: 'https://a.x', api_key: 'k1', enabled: true, models: [] }],
    aliases: {}, global: {},
  });
  const r1 = await getRouter();
  assert.equal(r1.registry.providers.size, 1);

  saveProvidersConfig({
    schema_version: 1,
    providers: [
      { id: 'a', type: 'openai-compat', base_url: 'https://a.x', api_key: 'k1', enabled: true, models: [] },
      { id: 'b', type: 'openai-compat', base_url: 'https://b.x', api_key: 'k2', enabled: true, models: [] },
    ],
    aliases: {}, global: {},
  });

  // Henüz invalidate yok — eski instance dönmeli (cached).
  const r2 = await getRouter();
  assert.equal(r2, r1);

  invalidateRouterCache();
  const r3 = await getRouter();
  assert.notEqual(r3, r1);
  assert.equal(r3.registry.providers.size, 2);
});
