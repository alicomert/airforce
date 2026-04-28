// Read-only tools: provider/model/breaker/log/capability inspection.

import { getRouter } from '../../providers/factory.js';
import { getCapability } from '../../capability.js';
import { recentLogs } from '../../logger.js';

export const tools = {
  list_providers: {
    name: 'list_providers',
    description: 'List all configured providers with id, type, enabled, base_url, model count, key last 4 chars.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const router = await getRouter();
      const out = [];
      for (const [id, p] of router.registry.providers.entries()) {
        const cfg = p.config || {};
        out.push({
          id,
          type: cfg.type,
          enabled: cfg.enabled !== false,
          base_url: cfg.base_url,
          api_key_last4: String(cfg.api_key || '').slice(-4),
          model_count: cfg.models?.length || 0,
        });
      }
      return { providers: out };
    },
  },

  get_provider_status: {
    name: 'get_provider_status',
    description: 'Detail for a single provider — config (with redacted key), breaker state.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: async ({ id }) => {
      const router = await getRouter();
      const p = router.registry.providers.get(id);
      if (!p) throw new Error(`unknown provider: ${id}`);
      const breaker = router.breakers.get(id);
      return {
        id,
        config: { ...p.config, api_key: '<redacted>' },
        breaker: breaker.snapshot(),
      };
    },
  },

  list_models: {
    name: 'list_models',
    description: 'Flat catalog of all models across providers with capability flags.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const router = await getRouter();
      const cap = getCapability();
      return {
        models: router.registry.listAllModels().map((m) => {
          const k = `${m.provider_id}/${m.upstream_id}`;
          const c = cap?.models?.[k];
          return {
            ...m,
            native: c?.native ?? null,
            xml: c?.xml ?? null,
            latency_ms: c?.latency_ms ?? null,
            status: c?.status ?? null,
          };
        }),
      };
    },
  },

  get_capability_snapshot: {
    name: 'get_capability_snapshot',
    description: 'Full capability.json — last_run, all (provider, model) probe results.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => getCapability(),
  },

  get_breaker_state: {
    name: 'get_breaker_state',
    description: 'All circuit breakers: state (closed/open/half-open), failures, reason, open_until.',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const router = await getRouter();
      return { breakers: router.breakers.snapshot() };
    },
  },

  get_logs: {
    name: 'get_logs',
    description: 'Last N log lines from in-memory ring buffer (default 50, max 500).',
    parameters: {
      type: 'object',
      properties: { tail: { type: 'number' } },
      required: [],
    },
    handler: async ({ tail = 50 }) => ({
      logs: recentLogs(Math.min(500, Math.max(1, Number(tail) || 50))),
    }),
  },
};
