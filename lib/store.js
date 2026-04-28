// data/ klasöründe basit JSON dosyalarına state persist eder.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { log } from './logger.js';

function pathOf(name) {
  return path.join(DATA_DIR, name);
}

function readJson(name, fallback) {
  const p = pathOf(name);
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    log.warn(`store: ${name} parse hatası, fallback dönüldü`, { err: err.message });
    return fallback;
  }
}

function writeJson(name, value) {
  const p = pathOf(name);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, p);
}

// --- Tool capability snapshot ---
// Şekil:
// { last_run_iso: "...", duration_ms: 0, models: { "glm-4.6": { native: true, xml: true, status: "ok", checked_at: "..." }, ... } }

const TOOL_CAP_FILE = 'tool_capability.json';

export function loadCapability() {
  return readJson(TOOL_CAP_FILE, { last_run_iso: null, duration_ms: 0, models: {} });
}

export function saveCapability(snapshot) {
  writeJson(TOOL_CAP_FILE, snapshot);
}

// --- Bridge API keys ---
// Şekil: { keys: [{ id, label, key, created_iso, last_used_iso }] }

const KEYS_FILE = 'api_keys.json';

export function loadKeys() {
  return readJson(KEYS_FILE, { keys: [] });
}

export function saveKeys(state) {
  writeJson(KEYS_FILE, state);
}

// --- Providers config (Phase 2) ---

const PROVIDERS_FILE = 'providers.json';

let _dataDirOverride = null;

export function setDataDirForTests(dir) {
  _dataDirOverride = dir;
}

export function resetDataDirForTests() {
  _dataDirOverride = null;
}

function providersPath() {
  return _dataDirOverride
    ? path.join(_dataDirOverride, PROVIDERS_FILE)
    : pathOf(PROVIDERS_FILE);
}

export function loadProvidersConfig() {
  const p = providersPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    log.warn(`store: providers.json parse hatası`, { err: err.message });
    return null;
  }
}

export function saveProvidersConfig(cfg) {
  const p = providersPath();
  const tmp = p + '.tmp';
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
  fs.chmodSync(p, 0o600);
}

export function maybeMigrateLegacyEnv(env = process.env) {
  if (loadProvidersConfig()) return false;
  if (!env.AIRFORCE_API_KEY) return false;
  const cfg = {
    schema_version: 1,
    providers: [{
      id: 'airforce',
      label: 'api.airforce',
      type: 'openai-compat',
      base_url: env.UPSTREAM_BASE_URL || 'https://api.airforce',
      api_key: env.AIRFORCE_API_KEY,
      headers: {},
      timeout_ms: Number(env.UPSTREAM_TIMEOUT_MS) || 180000,
      enabled: true,
      rate_limit: { mult_per_min: Number(env.RATE_LIMIT_MULT_PER_MIN) || 10 },
      models: [
        { upstream_id: env.DEFAULT_MODEL || 'glm-4.6', priority: 0, enabled: true },
      ],
    }],
    aliases: {},
    global: {
      default_model: env.DEFAULT_MODEL || 'glm-4.6',
      circuit_breaker: { fail_threshold: 3, open_seconds: 60 },
    },
  };
  saveProvidersConfig(cfg);
  log.info('migrated AIRFORCE_API_KEY → data/providers.json');
  return true;
}
