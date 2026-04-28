// Append-only NDJSON audit log for chatbot mutations.
// Key/secret fields are redacted before write.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

const FILE = 'audit-log.json';

function pathOf() { return path.join(DATA_DIR, FILE); }

function redactKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactKeys);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/api_key|secret|token|password/i.test(k)) out[k] = '<redacted>';
    else out[k] = redactKeys(v);
  }
  return out;
}

export async function appendAudit(entry) {
  const p = pathOf();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    tool: entry.tool,
    args: redactKeys(entry.args),
    session: entry.session || null,
  }) + '\n';
  fs.appendFileSync(p, line, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch {}
}
