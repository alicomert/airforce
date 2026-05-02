// Action tools — partial audit (only export_config audited).

import { triggerSafe, isRunning } from '../../scheduler.js';
import { getRouter, invalidateRouterCache } from '../../providers/factory.js';
import { loadProvidersConfig } from '../../store.js';

export const tools = {
  run_probe: {
    name: 'run_probe',
    description: 'Trigger capability probe across all enabled (provider, model) pairs.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      if (isRunning()) return { ok: false, message: 'already running' };
      triggerSafe('chatbot');
      return { ok: true, message: 'probe started' };
    },
  },

  reset_breaker: {
    name: 'reset_breaker',
    description: 'Reset a provider\'s circuit breaker to closed state.',
    parameters: {
      type: 'object',
      properties: { provider_id: { type: 'string' } },
      required: ['provider_id'],
    },
    handler: async ({ provider_id }) => {
      const router = await getRouter();
      router.breakers.reset(provider_id);
      return { ok: true };
    },
  },

  discover_models: {
    name: 'discover_models',
    description: 'Fetch /v1/models from a provider (does not save). Returns raw list.',
    parameters: {
      type: 'object',
      properties: { provider_id: { type: 'string' } },
      required: ['provider_id'],
    },
    handler: async ({ provider_id }) => {
      const router = await getRouter();
      const p = router.registry.providers.get(provider_id);
      if (!p) throw new Error(`unknown: ${provider_id}`);
      const models = await p.listModels();
      return { models };
    },
  },

  export_config: {
    name: 'export_config',
    description: 'Return full providers.json structure with API keys REDACTED.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const cfg = loadProvidersConfig();
      if (!cfg) throw new Error('no config');
      return {
        ...cfg,
        providers: (cfg.providers || []).map((p) => ({
          ...p,
          api_key: '<redacted>',
        })),
      };
    },
  },

  restart_router_cache: {
    name: 'restart_router_cache',
    description: 'Force router cache invalidation (config will be re-read on next request).',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      invalidateRouterCache();
      return { ok: true };
    },
  },
};
