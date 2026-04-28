// Dakika bazlı multiplier bütçesi (token-bucket benzeri).
// Her isteğin maliyeti modelin multiplier'ı kadar (free=1, premium=2..10, p2g>10).
// Bütçe dolduğunda dakikanın bitmesine kadar bekler.

import { config } from './config.js';
import { log } from './logger.js';
import { sleep } from './util.js';

class MultiplierBucket {
  constructor(capPerMinute) {
    this.cap = Math.max(1, capPerMinute);
    this.spent = 0;
    this.windowStart = Date.now();
  }

  reset() {
    this.spent = 0;
    this.windowStart = Date.now();
  }

  // amount kadar bütçe çek; gerekirse pencere bitene kadar bekle.
  async charge(amount, label = '') {
    const cost = Math.max(1, Number(amount) || 1);
    while (true) {
      const now = Date.now();
      if (now - this.windowStart >= 60_000) {
        // Yeni dakika penceresi
        this.windowStart = now;
        this.spent = 0;
      }
      if (this.spent + cost <= this.cap) {
        this.spent += cost;
        return;
      }
      const waitMs = 60_000 - (now - this.windowStart) + 200;
      log.info(`rate-limit: bütçe doldu ${this.spent}/${this.cap}, ${(waitMs / 1000).toFixed(1)}s bekleniyor (${label}, cost=${cost})`);
      await sleep(waitMs);
    }
  }

  // External: rate-limit hatası alındığında bir dakika bekle.
  async cooldown60s(label = '') {
    log.warn(`rate-limit: 429 cooldown 60s (${label})`);
    await sleep(60_000);
    this.reset();
  }

  snapshot() {
    return {
      cap: this.cap,
      spent: this.spent,
      remaining: Math.max(0, this.cap - this.spent),
      window_age_ms: Date.now() - this.windowStart,
    };
  }
}

// Tek shared bucket (probe + adapters birlikte kullansın).
const bucket = new MultiplierBucket(config.rateLimit.multPerMin);
export default bucket;

export function getBucket() { return bucket; }
