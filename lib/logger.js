// Hem stdout hem ring-buffer'a yazan basit logger.

import { config } from './config.js';
import { nowIso } from './util.js';

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const minLevel = LEVELS[config.log.level?.toLowerCase()] ?? LEVELS.info;

const ring = [];
const ringMax = Math.max(50, config.log.ringSize);

function push(entry) {
  ring.push(entry);
  if (ring.length > ringMax) ring.splice(0, ring.length - ringMax);
}

function emit(level, msg, fields) {
  const lvlNum = LEVELS[level] ?? LEVELS.info;
  if (lvlNum < minLevel) return;

  const ts = nowIso();
  const entry = { ts, level, msg: String(msg), ...(fields || {}) };
  push(entry);

  const tag = level.toUpperCase().padEnd(5);
  const fieldsStr = fields ? ' ' + safeFmt(fields) : '';
  const out = `${ts} ${tag} ${msg}${fieldsStr}`;
  if (lvlNum >= LEVELS.error) console.error(out);
  else console.log(out);
}

function safeFmt(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

export const log = {
  trace: (m, f) => emit('trace', m, f),
  debug: (m, f) => emit('debug', m, f),
  info:  (m, f) => emit('info', m, f),
  warn:  (m, f) => emit('warn', m, f),
  error: (m, f) => emit('error', m, f),
};

export function recentLogs(n = 100) {
  return ring.slice(Math.max(0, ring.length - n));
}

export function clearLogs() {
  ring.length = 0;
}
