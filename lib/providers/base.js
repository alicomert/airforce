// lib/providers/base.js
// Provider plugin sözleşmesi + hata sınıflandırma.

const TRANSIENT_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

export class ProviderError extends Error {
  constructor(message, { status = 0, body = null, category = 'transient', cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ProviderError';
    this.status = status;
    this.body = body;
    this.category = category;
    if (cause === null) this.cause = null;  // preserve explicit-null contract
  }
}

// HTTP status + response body'den kategori türet.
// Kategoriler: 'ok' | 'transient' | 'auth' | 'bad_model' | 'client'
export function classifyError(status, body) {
  if (status >= 200 && status < 300) return 'ok';
  if (TRANSIENT_STATUSES.has(status)) return 'transient';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'bad_model';
  if (status === 400) {
    const text = String(body || '');
    if (/model_not_found|unknown model|model.*not.*found/i.test(text)) {
      return 'bad_model';
    }
    return 'client';
  }
  if (status >= 400 && status < 500) return 'client';
  return 'transient';
}

// BaseProvider — alt sınıflar override eder.
export class BaseProvider {
  constructor(config) {
    if (!config || !config.id) throw new Error('BaseProvider: config.id zorunlu');
    this.id = config.id;
    this.config = config;
  }

  async chat(_body, _opts = {}) {
    throw new Error(`${this.constructor.name}.chat not implemented`);
  }

  async listModels() {
    throw new Error(`${this.constructor.name}.listModels not implemented`);
  }

  async healthCheck() {
    throw new Error(`${this.constructor.name}.healthCheck not implemented`);
  }

  supportsNativeTools() { return false; }
}
