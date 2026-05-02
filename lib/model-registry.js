// Model adı → provider entry[] çözümü.
// Kısa ad: priority-ordered, fallback'li liste.
// Prefix'li ad (provider/model): tek provider, fallback yok.
// Alias: hedef adı tek adımda çözer.

export class ModelNotFoundError extends Error {
  constructor(modelId) {
    super(`model not found: ${modelId}`);
    this.name = 'ModelNotFoundError';
    this.modelId = modelId;
    this.status = 404;
  }
}

function shortIdOf(entry) {
  if (entry.presented_id) return entry.presented_id;
  const u = entry.upstream_id;
  if (u.includes('/')) return u.split('/').pop();
  return u;
}

export class ModelRegistry {
  constructor() {
    this.providers = new Map();
    this._byShort = new Map();
    this._byKey = new Map();
    this.aliases = new Map();
  }

  load(providersCfg, providerInstances) {
    this.providers = new Map(Object.entries(providerInstances));
    this._byShort = new Map();
    this._byKey = new Map();
    this.aliases = new Map(Object.entries(providersCfg.aliases || {}));

    for (const p of providersCfg.providers || []) {
      if (!p.enabled) continue;
      for (const m of p.models || []) {
        if (!m.enabled) continue;
        const entry = {
          providerId: p.id,
          upstreamModelId: m.upstream_id,
          priority: Number(m.priority) || 0,
          enabled: true,
          presented_id: m.presented_id,
          lastUsedAt: 0,
          _runtimeUnavailable: false,
        };
        const key = `${p.id}/${m.upstream_id}`;
        this._byKey.set(key, entry);
        const shortId = shortIdOf(m);
        if (!this._byShort.has(shortId)) this._byShort.set(shortId, []);
        this._byShort.get(shortId).push(entry);
      }
    }
    for (const arr of this._byShort.values()) {
      arr.sort((a, b) => a.priority - b.priority || a.lastUsedAt - b.lastUsedAt);
    }
  }

  resolve(modelId) {
    if (!modelId) throw new ModelNotFoundError(modelId || '<empty>');

    if (this.aliases.has(modelId)) {
      const target = this.aliases.get(modelId);
      return this.resolve(target);
    }

    for (const pid of this.providers.keys()) {
      const prefix = pid + '/';
      if (modelId.startsWith(prefix)) {
        const upstreamId = modelId.slice(prefix.length);
        const key = `${pid}/${upstreamId}`;
        const entry = this._byKey.get(key);
        if (entry && entry.enabled && !entry._runtimeUnavailable) return [entry];
        throw new ModelNotFoundError(modelId);
      }
    }

    const arr = this._byShort.get(modelId);
    if (arr && arr.length) {
      const live = arr.filter((e) => e.enabled && !e._runtimeUnavailable);
      if (live.length) return live;
    }

    throw new ModelNotFoundError(modelId);
  }

  markModelUnavailable(entry) {
    if (!entry) return;
    entry._runtimeUnavailable = true;
  }

  resetUnavailable() {
    for (const e of this._byKey.values()) e._runtimeUnavailable = false;
  }

  listAllModels() {
    const out = [];
    for (const [key, entry] of this._byKey.entries()) {
      const shortId = (() => {
        if (entry.presented_id) return entry.presented_id;
        const slash = key.indexOf('/');
        const upstream = key.slice(slash + 1);
        return upstream.includes('/') ? upstream.split('/').pop() : upstream;
      })();
      out.push({
        provider_id: entry.providerId,
        upstream_id: entry.upstreamModelId,
        presented_id: shortId,
        priority: entry.priority,
        enabled: entry.enabled && !entry._runtimeUnavailable,
      });
    }
    return out;
  }
}
