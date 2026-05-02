// Model and alias mutation tools — audited.

import { loadProvidersConfig, saveProvidersConfig } from '../../store.js';
import { invalidateRouterCache } from '../../providers/factory.js';

function findProvider(cfg, providerId) {
  if (!cfg) throw new Error('no config');
  const p = (cfg.providers || []).find((x) => x.id === providerId);
  if (!p) throw new Error(`unknown provider: ${providerId}`);
  return p;
}

export const tools = {
  add_model: {
    name: 'add_model',
    description: 'Add a model entry to a provider.',
    parameters: {
      type: 'object',
      properties: {
        provider_id: { type: 'string' },
        upstream_id: { type: 'string' },
        priority: { type: 'number' },
        presented_id: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['provider_id', 'upstream_id'],
    },
    handler: async ({ provider_id, upstream_id, priority = 0, presented_id, enabled = true }) => {
      const cfg = loadProvidersConfig();
      const p = findProvider(cfg, provider_id);
      p.models = p.models || [];
      if (p.models.some((m) => m.upstream_id === upstream_id)) {
        throw new Error(`model already exists: ${upstream_id}`);
      }
      const entry = { upstream_id, priority, enabled };
      if (presented_id) entry.presented_id = presented_id;
      p.models.push(entry);
      saveProvidersConfig(cfg);
      invalidateRouterCache();
      return { ok: true };
    },
  },

  remove_model: {
    name: 'remove_model',
    description: 'Remove a model entry from a provider.',
    parameters: {
      type: 'object',
      properties: { provider_id: { type: 'string' }, upstream_id: { type: 'string' } },
      required: ['provider_id', 'upstream_id'],
    },
    handler: async ({ provider_id, upstream_id }) => {
      const cfg = loadProvidersConfig();
      const p = findProvider(cfg, provider_id);
      const before = (p.models || []).length;
      p.models = (p.models || []).filter((m) => m.upstream_id !== upstream_id);
      if (p.models.length === before) throw new Error(`unknown model: ${upstream_id}`);
      saveProvidersConfig(cfg);
      invalidateRouterCache();
      return { ok: true };
    },
  },

  toggle_model: {
    name: 'toggle_model',
    description: 'Enable or disable a model entry.',
    parameters: {
      type: 'object',
      properties: {
        provider_id: { type: 'string' }, upstream_id: { type: 'string' }, enabled: { type: 'boolean' },
      },
      required: ['provider_id', 'upstream_id', 'enabled'],
    },
    handler: async ({ provider_id, upstream_id, enabled }) => {
      const cfg = loadProvidersConfig();
      const p = findProvider(cfg, provider_id);
      const m = (p.models || []).find((x) => x.upstream_id === upstream_id);
      if (!m) throw new Error(`unknown model: ${upstream_id}`);
      m.enabled = Boolean(enabled);
      saveProvidersConfig(cfg);
      invalidateRouterCache();
      return { ok: true };
    },
  },

  set_priority: {
    name: 'set_priority',
    description: 'Set priority of a model entry (lower = preferred).',
    parameters: {
      type: 'object',
      properties: {
        provider_id: { type: 'string' }, upstream_id: { type: 'string' }, priority: { type: 'number' },
      },
      required: ['provider_id', 'upstream_id', 'priority'],
    },
    handler: async ({ provider_id, upstream_id, priority }) => {
      const cfg = loadProvidersConfig();
      const p = findProvider(cfg, provider_id);
      const m = (p.models || []).find((x) => x.upstream_id === upstream_id);
      if (!m) throw new Error(`unknown model: ${upstream_id}`);
      m.priority = Number(priority);
      saveProvidersConfig(cfg);
      invalidateRouterCache();
      return { ok: true };
    },
  },

  set_alias: {
    name: 'set_alias',
    description: 'Add or update an alias mapping (alias → target model id).',
    parameters: {
      type: 'object',
      properties: { alias: { type: 'string' }, target: { type: 'string' } },
      required: ['alias', 'target'],
    },
    handler: async ({ alias, target }) => {
      const cfg = loadProvidersConfig();
      if (!cfg) throw new Error('no config');
      cfg.aliases = cfg.aliases || {};
      cfg.aliases[alias] = target;
      saveProvidersConfig(cfg);
      invalidateRouterCache();
      return { ok: true };
    },
  },

  remove_alias: {
    name: 'remove_alias',
    description: 'Remove an alias mapping.',
    parameters: {
      type: 'object',
      properties: { alias: { type: 'string' } },
      required: ['alias'],
    },
    handler: async ({ alias }) => {
      const cfg = loadProvidersConfig();
      if (!cfg) throw new Error('no config');
      if (!cfg.aliases || !(alias in cfg.aliases)) throw new Error(`unknown alias: ${alias}`);
      delete cfg.aliases[alias];
      saveProvidersConfig(cfg);
      invalidateRouterCache();
      return { ok: true };
    },
  },
};
