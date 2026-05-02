// Model id'sini provider listesine yönlendirir, transient hatalarda fallback yapar.

import { ProviderError } from './providers/base.js';
import { ModelNotFoundError } from './model-registry.js';

const AUTH_TRIP_MS = 5 * 60 * 1000;

export class AllProvidersFailedError extends Error {
  constructor(modelId, lastErr) {
    super(`all providers failed for model: ${modelId}`);
    this.name = 'AllProvidersFailedError';
    this.modelId = modelId;
    this.cause = lastErr;
    this.status = lastErr?.status || 502;
    this.category = 'transient';
  }
}

export class Router {
  constructor(registry, breakers) {
    this.registry = registry;
    this.breakers = breakers;
  }

  async execute(modelId, body, opts = {}) {
    const candidates = this.registry.resolve(modelId);
    if (!candidates.length) throw new ModelNotFoundError(modelId);

    let lastErr;
    for (const entry of candidates) {
      const provider = this.registry.providers.get(entry.providerId);
      if (!provider) { lastErr = new Error(`provider missing: ${entry.providerId}`); continue; }

      const breaker = this.breakers.get(entry.providerId);
      if (breaker.isOpen()) { lastErr = new Error(`breaker open: ${breaker.reason || ''}`); continue; }

      const upstreamBody = { ...body, model: entry.upstreamModelId };
      try {
        const result = await provider.chat(upstreamBody, opts);
        breaker.recordSuccess();
        entry.lastUsedAt = Date.now();
        return { result, providerId: entry.providerId, upstreamModelId: entry.upstreamModelId };
      } catch (err) {
        lastErr = err;
        const cat = (err instanceof ProviderError) ? err.category : 'transient';
        switch (cat) {
          case 'transient':
            breaker.recordFailure();
            continue;
          case 'auth':
            breaker.tripUntil(Date.now() + AUTH_TRIP_MS, 'auth error');
            continue;
          case 'bad_model':
            this.registry.markModelUnavailable(entry);
            continue;
          case 'client':
            throw err;
          default:
            continue;
        }
      }
    }
    throw new AllProvidersFailedError(modelId, lastErr);
  }
}
