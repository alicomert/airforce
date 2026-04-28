// Probe'u N saatte bir tetikler. Tek bir global timer kullanır.

import { config } from './config.js';
import { log } from './logger.js';
import { runProbe } from './probe.js';

let timer = null;
let running = false;

export function start() {
  if (config.probe.onBoot) {
    setTimeout(() => triggerSafe('boot'), 4_000);
  }
  const ms = Math.max(1, config.probe.intervalHours) * 3600_000;
  timer = setInterval(() => triggerSafe('interval'), ms);
  log.info(`scheduler: probe every ${config.probe.intervalHours}h, on_boot=${config.probe.onBoot}`);
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function triggerSafe(reason) {
  if (running) {
    log.warn(`scheduler: probe already running, skipping (reason=${reason})`);
    return null;
  }
  running = true;
  try {
    const snap = await runProbe();
    return snap;
  } catch (err) {
    log.error('scheduler: probe failed', { err: err.message });
    return null;
  } finally {
    running = false;
  }
}

export function isRunning() {
  return running;
}
