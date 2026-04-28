// data/capability.json snapshot'ını okuma yardımcıları.
// Phase 2: key formatı `${providerId}/${upstreamModelId}`.

import { loadCapability } from './store.js';

export function getCapability() {
  return loadCapability();
}

export function isToolCapable(providerId, upstreamModelId) {
  const snap = loadCapability();
  const key = `${providerId}/${upstreamModelId}`;
  const m = snap.models?.[key];
  if (!m) return null;
  return m.status === 'ok' && Boolean(m.xml || m.native);
}

export function listCapableModels() {
  const snap = loadCapability();
  return Object.entries(snap.models || {})
    .filter(([, v]) => v.status === 'ok' && (v.xml || v.native))
    .map(([key, v]) => ({ key, ...v }));
}

// Phase 1 `resolveModel` Phase 2'de ModelRegistry tarafından sağlanıyor — bu fonksiyon kalktı.
