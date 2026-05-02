// Per-provider multiplier/RPM bucket.
// Phase 1'de tek bucket vardı; Phase 2'de Map<providerId, Bucket>.

import { config } from './config.js';
import { log } from './logger.js';
import { sleep } from './util.js';

class MultiplierBucket {
  constructor(id, capPerMinute) {
    this.id = id;
    this.cap = Math.max(1, capPerMinute);
    this.spent = 0;
    this.windowStart = Date.now();
  }

  reset() { this.spent = 0; this.windowStart = Date.now(); }

  async charge(amount, label = '') {
    const cost = Math.max(1, Number(amount) || 1);
    while (true) {
      const now = Date.now();
      if (now - this.windowStart >= 60_000) {
        this.windowStart = now;
        this.spent = 0;
      }
      if (this.spent + cost <= this.cap) {
        this.spent += cost;
        return;
      }
      const waitMs = 60_000 - (now - this.windowStart) + 200;
      log.info(`rate-limit[${this.id}]: bütçe doldu ${this.spent}/${this.cap}, ${(waitMs / 1000).toFixed(1)}s bekleniyor (${label}, cost=${cost})`);
      await sleep(waitMs);
    }
  }

  async cooldown60s(label = '') {
    log.warn(`rate-limit[${this.id}]: 429 cooldown 60s (${label})`);
    await sleep(60_000);
    this.reset();
  }

  snapshot() {
    return {
      id: this.id, cap: this.cap, spent: this.spent,
      remaining: Math.max(0, this.cap - this.spent),
      window_age_ms: Date.now() - this.windowStart,
    };
  }
}

const buckets = new Map();

export function getBucket(providerId = 'default') {
  if (!buckets.has(providerId)) {
    const cap = config.rateLimit.multPerMin;
    buckets.set(providerId, new MultiplierBucket(providerId, cap));
  }
  return buckets.get(providerId);
}

export function configureBucket(providerId, { mult_per_min, rpm } = {}) {
  const cap = mult_per_min ?? rpm ?? config.rateLimit.multPerMin;
  buckets.set(providerId, new MultiplierBucket(providerId, cap));
  return buckets.get(providerId);
}

export function snapshotAll() {
  return Array.from(buckets.values()).map((b) => b.snapshot());
}

export function _resetForTests() { buckets.clear(); }
