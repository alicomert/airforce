// Provider başına failure window + open/half-open/closed state machine.
// Usage:
//   const b = new CircuitBreaker('airforce', { failThreshold: 3, openSeconds: 60, windowSeconds: 10 });
//   if (b.isOpen()) skip;
//   try { await provider.chat(...); b.recordSuccess(); }
//   catch (err) { b.recordFailure(); throw; }

const DEFAULTS = {
  failThreshold: 3,
  openSeconds: 60,
  windowSeconds: 10,
};

export class CircuitBreaker {
  constructor(id, opts = {}) {
    this.id = id;
    this.failThreshold = opts.failThreshold ?? DEFAULTS.failThreshold;
    this.openSeconds = opts.openSeconds ?? DEFAULTS.openSeconds;
    this.windowSeconds = opts.windowSeconds ?? DEFAULTS.windowSeconds;
    this._now = opts.now || (() => Date.now());

    this.state = 'closed';
    this.failures = [];
    this.openedAt = null;
    this.openUntil = null;
    this.reason = null;
  }

  isOpen() {
    const now = this._now();
    if (this.state === 'open') {
      const limit = this.openUntil ?? (this.openedAt + this.openSeconds * 1000);
      if (now >= limit) {
        this.state = 'half-open';
        this.failures = [];
        return false;
      }
      return true;
    }
    return false;
  }

  recordFailure() {
    const now = this._now();
    if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAt = now;
      this.openUntil = null;
      this.reason = 'half-open probe failed';
      this.failures = [];
      return;
    }
    const cutoff = now - this.windowSeconds * 1000;
    this.failures = this.failures.filter((t) => t >= cutoff);
    this.failures.push(now);
    if (this.failures.length >= this.failThreshold) {
      this.state = 'open';
      this.openedAt = now;
      this.openUntil = null;
      this.reason = `${this.failures.length} failures in ${this.windowSeconds}s`;
      this.failures = [];
    }
  }

  recordSuccess() {
    if (this.state === 'half-open') {
      this.state = 'closed';
      this.failures = [];
      this.reason = null;
      return;
    }
    this.failures = [];
  }

  tripUntil(timestamp, reason = 'tripped') {
    this.state = 'open';
    this.openedAt = this._now();
    this.openUntil = timestamp;
    this.reason = reason;
    this.failures = [];
  }

  reset() {
    this.state = 'closed';
    this.failures = [];
    this.openedAt = null;
    this.openUntil = null;
    this.reason = null;
  }

  snapshot() {
    return {
      id: this.id,
      state: this.state,
      failures: this.failures.length,
      reason: this.reason,
      open_until: this.openUntil,
    };
  }
}

export class CircuitBreakerRegistry {
  constructor(opts = {}) {
    this.opts = opts;
    this._map = new Map();
  }

  get(providerId) {
    if (!this._map.has(providerId)) {
      this._map.set(providerId, new CircuitBreaker(providerId, this.opts));
    }
    return this._map.get(providerId);
  }

  reset(providerId) {
    const b = this._map.get(providerId);
    if (b) b.reset();
  }

  snapshot() {
    return Array.from(this._map.values()).map((b) => b.snapshot());
  }
}
