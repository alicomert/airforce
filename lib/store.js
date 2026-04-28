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
