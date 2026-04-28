// data/providers.json + tek provider kayıtları için validation.
// OK döner: { ok: true } | { ok: false, error: { field, message } }

const SLUG_RE = /^[a-z0-9_-]+$/;
const VALID_TYPES = new Set(['openai-compat', 'anthropic-native']);

function err(field, message) { return { ok: false, error: { field, message } }; }
function ok() { return { ok: true }; }

function isValidUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateProviderConfig(p) {
  if (!p || typeof p !== 'object') return err('', 'provider must be object');
  if (!p.id) return err('id', 'id required');
  if (!SLUG_RE.test(p.id)) return err('id', 'id must match /^[a-z0-9_-]+$/');
  if (!p.type) return err('type', 'type required');
  if (!VALID_TYPES.has(p.type)) return err('type', `type must be one of ${[...VALID_TYPES].join(', ')}`);
  if (!p.base_url) return err('base_url', 'base_url required');
  if (!isValidUrl(p.base_url)) return err('base_url', 'base_url must be http(s) URL');
  if (!p.api_key) return err('api_key', 'api_key required');
  if (p.models != null && !Array.isArray(p.models)) return err('models', 'models must be array');
  if (Array.isArray(p.models)) {
    for (let i = 0; i < p.models.length; i++) {
      const r = validateModelConfig(p.models[i]);
      if (!r.ok) return { ok: false, error: { field: `models[${i}].${r.error.field}`, message: r.error.message } };
    }
  }
  return ok();
}

export function validateModelConfig(m) {
  if (!m || typeof m !== 'object') return err('', 'model must be object');
  if (!m.upstream_id) return err('upstream_id', 'upstream_id required');
  if (typeof m.upstream_id !== 'string') return err('upstream_id', 'upstream_id must be string');
  if (m.priority != null && typeof m.priority !== 'number') return err('priority', 'priority must be number');
  return ok();
}

export function validateProvidersFile(cfg) {
  if (!cfg || typeof cfg !== 'object') return err('', 'config must be object');
  if (cfg.schema_version !== 1) return err('schema_version', 'schema_version must be 1');
  if (!Array.isArray(cfg.providers)) return err('providers', 'providers must be array');
  const seen = new Set();
  for (let i = 0; i < cfg.providers.length; i++) {
    const p = cfg.providers[i];
    const r = validateProviderConfig(p);
    if (!r.ok) return { ok: false, error: { field: `providers[${i}].${r.error.field}`, message: r.error.message } };
    if (seen.has(p.id)) return err(`providers[${i}].id`, `duplicate id: ${p.id}`);
    seen.add(p.id);
  }
  return ok();
}
