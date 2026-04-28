// Faz 2: getRouter() — providers.json'dan yükler, hepsini başlatır,
// ModelRegistry + CircuitBreakerRegistry + Router döner.

import { OpenaiCompatProvider } from './openai-compat.js';
import { loadProvidersConfig, maybeMigrateLegacyEnv } from '../store.js';
import { ModelRegistry } from '../model-registry.js';
import { CircuitBreakerRegistry } from '../circuit-breaker.js';
import { Router } from '../router.js';
import { configureBucket } from '../rate-limit.js';
import { log } from '../logger.js';

const PROVIDER_TYPES = {
  'openai-compat': OpenaiCompatProvider,
};

let cachedRouter = null;

export function buildProviderInstance(providerCfg) {
  const Klass = PROVIDER_TYPES[providerCfg.type];
  if (!Klass) throw new Error(`unknown provider type: ${providerCfg.type}`);
  return new Klass(providerCfg);
}

export function buildRouter(providersCfg) {
  const instances = {};
  for (const p of providersCfg.providers || []) {
    if (!p.enabled) continue;
    instances[p.id] = buildProviderInstance(p);
    if (p.rate_limit) configureBucket(p.id, p.rate_limit);
  }
  const registry = new ModelRegistry();
  registry.load(providersCfg, instances);
  const cb = providersCfg.global?.circuit_breaker || {};
  const breakers = new CircuitBreakerRegistry({
    failThreshold: cb.fail_threshold ?? 3,
    openSeconds: cb.open_seconds ?? 60,
  });
  return new Router(registry, breakers);
}

export async function getRouter() {
  if (!cachedRouter) {
    maybeMigrateLegacyEnv(process.env);
    const cfg = loadProvidersConfig();
    if (!cfg) {
      throw new Error('data/providers.json yok ve AIRFORCE_API_KEY tanımlı değil — admin panel veya .env üzerinden bir provider ekle.');
    }
    cachedRouter = buildRouter(cfg);
    log.info(`router: ${(cfg.providers || []).filter((p) => p.enabled).length} provider yüklü`);
  }
  return cachedRouter;
}

export function _resetRouterForTests() { cachedRouter = null; }
