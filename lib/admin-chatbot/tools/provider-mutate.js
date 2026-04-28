// Provider mutation tools — audited.

import { loadProvidersConfig, saveProvidersConfig } from '../../store.js';
import { invalidateRouterCache } from '../../providers/factory.js';
import { validateProviderConfig } from '../../providers/config-schema.js';

function loadOrInit() {
  return loadProvidersConfig() || { schema_version: 1, providers: [], aliases: {}, global: {} };
}

export const tools = {
  create_provider: {
    name: 'create_provider',
    description: 'Add a new provider. id is a lowercase slug; type is openai-compat or anthropic-native.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        type: { type: 'string' },
        base_url: { type: 'string' },
        api_key: { type: 'string' },
        label: { type: 'string' },
        enabled: { type: 'boolean' },
        rate_limit: { type: 'object' },
        headers: { type: 'object' },
      },
      required: ['id', 'type', 'base_url', 'api_key'],
    },
    handler: async (args) => {
      const cfg = loadOrInit();
      if ((cfg.providers || []).some((p) => p.id === args.id)) {
        throw new Error(`duplicate id: ${args.id}`);
      }
      const newP = {
        id: args.id,
        label: args.label || args.id,
        type: args.type,
        base_url: args.base_url,
        api_key: args.api_key,
        enabled: args.enabled ?? true,
        headers: args.headers || {},
        rate_limit: args.rate_limit || {},
        models: [],
      };
      const v = validateProviderConfig(newP);
      if (!v.ok) throw new Error(`invalid: ${v.error.field} — ${v.error.message}`);
      cfg.providers = cfg.providers || [];
      cfg.providers.push(newP);
      saveProvidersConfig(cfg);
      invalidateRouterCache();
      return { ok: true, id: args.id };
    },
  },

  update_provider: {
    name: 'update_provider',
    description: 'Patch provider fields. Provide only fields to change.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, patch: { type: 'object' } },
      required: ['id', 'patch'],
    },
    handler: async ({ id, patch }) => {
      const cfg = loadProvidersConfig();
      if (!cfg) throw new Error('no config');
      const p = (cfg.providers || []).find((x) => x.id === id);
      if (!p) throw new Error(`unknown: ${id}`);
      Object.assign(p, patch);
      const v = validateProviderConfig(p);
      if (!v.ok) throw new Error(`invalid: ${v.error.field} — ${v.error.message}`);
      saveProvidersConfig(cfg);
      invalidateRouterCache();
      return { ok: true };
    },
  },

  delete_provider: {
    name: 'delete_provider',
    description: 'Remove provider entirely.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: async ({ id }) => {
      const cfg = loadProvidersConfig();
      if (!cfg) throw new Error('no config');
      const before = (cfg.providers || []).length;
      cfg.providers = (cfg.providers || []).filter((p) => p.id !== id);
      if (cfg.providers.length === before) throw new Error(`unknown: ${id}`);
      saveProvidersConfig(cfg);
      invalidateRouterCache();
      return { ok: true };
    },
  },

  toggle_provider: {
    name: 'toggle_provider',
    description: 'Enable or disable a provider.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, enabled: { type: 'boolean' } },
      required: ['id', 'enabled'],
    },
    handler: async ({ id, enabled }) => {
      const cfg = loadProvidersConfig();
      const p = (cfg?.providers || []).find((x) => x.id === id);
      if (!p) throw new Error(`unknown: ${id}`);
      p.enabled = Boolean(enabled);
      saveProvidersConfig(cfg);
      invalidateRouterCache();
      return { ok: true };
    },
  },

  set_provider_rate_limit: {
    name: 'set_provider_rate_limit',
    description: 'Update rate limit (mult_per_min for multiplier-based providers, rpm for general).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        mult_per_min: { type: 'number' },
        rpm: { type: 'number' },
      },
      required: ['id'],
    },
    handler: async ({ id, mult_per_min, rpm }) => {
      const cfg = loadProvidersConfig();
      const p = (cfg?.providers || []).find((x) => x.id === id);
      if (!p) throw new Error(`unknown: ${id}`);
      p.rate_limit = {};
      if (mult_per_min != null) p.rate_limit.mult_per_min = Number(mult_per_min);
      if (rpm != null) p.rate_limit.rpm = Number(rpm);
      saveProvidersConfig(cfg);
      invalidateRouterCache();
      return { ok: true };
    },
  },
};
