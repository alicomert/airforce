// tool_capability.json snapshot'ını okuma yardımcıları.
// Probe runner'ı yazar, adapter'lar okur.

import { loadCapability } from './store.js';
import { config } from './config.js';

export function getCapability() {
  return loadCapability();
}

export function isToolCapable(model) {
  const snap = loadCapability();
  const m = snap.models?.[model];
  if (!m) return null; // unknown
  return m.status === 'ok' && Boolean(m.xml);
}

export function listCapableModels() {
  const snap = loadCapability();
  return Object.entries(snap.models || {})
    .filter(([, v]) => v.status === 'ok' && v.xml)
    .map(([id, v]) => ({ id, ...v }));
}

// Resolve client model name → upstream model:
// 1) explicit alias from config
// 2) if client model isn't capable but its alias is, route via alias
export function resolveModel(clientModel) {
  const aliases = config.modelAliases || {};
  const direct = aliases[clientModel];
  if (direct) return direct;
  return clientModel;
}
