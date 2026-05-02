import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadProvidersConfig,
  saveProvidersConfig,
  maybeMigrateLegacyEnv,
  setDataDirForTests,
  resetDataDirForTests,
} from '../lib/store.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-bridge-test-'));
  setDataDirForTests(tmpDir);
});

afterEach(() => {
  resetDataDirForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('loadProvidersConfig returns null when file missing', () => {
  assert.equal(loadProvidersConfig(), null);
});

test('saveProvidersConfig writes mode 600 atomic', () => {
  const cfg = {
    schema_version: 1,
    providers: [{ id: 'a', label: 'A', type: 'openai-compat', base_url: 'x', api_key: 'k', enabled: true, models: [] }],
    aliases: {},
    global: { default_model: 'a' },
  };
  saveProvidersConfig(cfg);
  const p = path.join(tmpDir, 'providers.json');
  assert.ok(fs.existsSync(p));
  const stat = fs.statSync(p);
  assert.equal(stat.mode & 0o777, 0o600);
  const out = loadProvidersConfig();
  assert.deepEqual(out, cfg);
});

test('saveProvidersConfig is atomic (no .tmp left over)', () => {
  saveProvidersConfig({
    schema_version: 1, providers: [], aliases: {}, global: { default_model: 'x' },
  });
  const tmp = path.join(tmpDir, 'providers.json.tmp');
  assert.equal(fs.existsSync(tmp), false);
});

test('maybeMigrateLegacyEnv writes single-provider config from env', () => {
  const env = {
    AIRFORCE_API_KEY: 'sk-air-test',
    UPSTREAM_BASE_URL: 'https://api.airforce',
    RATE_LIMIT_MULT_PER_MIN: '15',
  };
  const migrated = maybeMigrateLegacyEnv(env);
  assert.equal(migrated, true);
  const cfg = loadProvidersConfig();
  assert.equal(cfg.schema_version, 1);
  assert.equal(cfg.providers.length, 1);
  const p = cfg.providers[0];
  assert.equal(p.id, 'airforce');
  assert.equal(p.type, 'openai-compat');
  assert.equal(p.base_url, 'https://api.airforce');
  assert.equal(p.api_key, 'sk-air-test');
  assert.equal(p.enabled, true);
  assert.equal(p.rate_limit.mult_per_min, 15);
  assert.equal(p.models.length, 1);
  assert.equal(p.models[0].upstream_id, 'glm-4.6');
  assert.equal(p.models[0].enabled, true);
});

test('maybeMigrateLegacyEnv is no-op when providers.json exists', () => {
  saveProvidersConfig({
    schema_version: 1,
    providers: [{ id: 'manual', type: 'openai-compat', base_url: 'x', api_key: 'k', enabled: true, models: [] }],
    aliases: {}, global: { default_model: 'manual' },
  });
  const migrated = maybeMigrateLegacyEnv({ AIRFORCE_API_KEY: 'sk-air-other' });
  assert.equal(migrated, false);
  assert.equal(loadProvidersConfig().providers[0].id, 'manual');
});

test('maybeMigrateLegacyEnv is no-op when env has no key', () => {
  const migrated = maybeMigrateLegacyEnv({});
  assert.equal(migrated, false);
  assert.equal(loadProvidersConfig(), null);
});
