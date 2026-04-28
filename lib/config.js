// Ortam değişkenleri + opsiyonel config.json'u tek bir nesnede topla.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

function loadJsonConfig() {
  const candidates = ['config.json', 'config.example.json'];
  for (const name of candidates) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (err) {
        console.warn(`[config] ${name} parse hatası:`, err.message);
      }
    }
  }
  return {};
}

const json = loadJsonConfig();

function bool(v, def = false) {
  if (v == null) return def;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function int(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function csvList(v) {
  if (!v) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

export const ROOT_DIR = ROOT;
export const DATA_DIR = path.join(ROOT, 'data');

export const config = {
  port: int(process.env.PORT, 2393),
  host: process.env.HOST || '0.0.0.0',

  airforceApiKey: process.env.AIRFORCE_API_KEY || '',
  upstreamBaseUrl: (process.env.UPSTREAM_BASE_URL || 'https://api.airforce').replace(/\/+$/, ''),
  upstreamTimeoutMs: int(process.env.UPSTREAM_TIMEOUT_MS, 120_000),
  upstreamMaxAttempts: int(process.env.UPSTREAM_MAX_ATTEMPTS, 3),
  upstreamRetryBaseMs: int(process.env.UPSTREAM_RETRY_BASE_MS, 200),

  bridgeApiKeys: csvList(process.env.BRIDGE_API_KEYS),
  adminToken: process.env.ADMIN_TOKEN || '',
  adminUsername: process.env.ADMIN_USERNAME || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',

  toolEngine: {
    forceXml: bool(process.env.TOOL_ENGINE_FORCE_XML, json?.tool_engine?.force_xml ?? true),
    format: process.env.TOOL_ENGINE_FORMAT || json?.tool_engine?.format || 'canonical',
    systemPromptPosition: json?.tool_engine?.system_prompt_position || 'append',
  },

  probe: {
    intervalHours: int(process.env.PROBE_INTERVAL_HOURS, json?.probe?.interval_hours ?? 24),
    onBoot: bool(process.env.PROBE_ON_BOOT, true),
    timeoutMs: int(process.env.PROBE_TIMEOUT_MS, 20_000),
    skipSubstrings: json?.probe?.skip_models_with_substring ?? ['-p2g', '-rp', 'image', 'midjourney', 'suno'],
    includePayg: bool(process.env.PROBE_INCLUDE_PAYG, json?.probe?.include_payg ?? false),
  },

  modelAliases: json?.model_aliases || {},
  defaultModel: json?.default_model || 'glm-4.6',

  log: {
    level: process.env.LOG_LEVEL || 'info',
    ringSize: int(process.env.LOG_RING_SIZE, 500),
  },

  ui: {
    theme: json?.ui?.theme || 'dark',
    title: json?.ui?.title || 'Airforce Bridge',
  },
};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

export function summarize() {
  return {
    port: config.port,
    host: config.host,
    upstreamBaseUrl: config.upstreamBaseUrl,
    haveAirforceKey: Boolean(config.airforceApiKey),
    bridgeKeyCount: config.bridgeApiKeys.length,
    forceXml: config.toolEngine.forceXml,
    format: config.toolEngine.format,
    probeIntervalHours: config.probe.intervalHours,
  };
}
