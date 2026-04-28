// Modelin text çıktısı içindeki <tool_calls> XML'ini parse eder.
// Hem canonical (<tool_calls><invoke name="...">) hem DSML (<|DSML|...|>) formatlarını destekler.
// Anti-leak: code-block içindeki bloklar atlanır.

import { maskedRanges, isInsideMasked } from './anti-leak.js';
import { safeJsonParse } from '../util.js';

// Canonical block matcher (greedy single block; we iterate to catch all).
// We don't rely on a real XML parser because models often miss closing tags
// or insert stray whitespace. The grammar we support is intentionally narrow.

const CANONICAL_OPEN = /<\s*tool_calls\s*>/g;
const CANONICAL_CLOSE_RE = /<\s*\/\s*tool_calls\s*>/;
const CANONICAL_INVOKE_OPEN = /<\s*invoke\s+name\s*=\s*("([^"]*)"|'([^']*)')\s*>/g;
const CANONICAL_INVOKE_CLOSE_RE = /<\s*\/\s*invoke\s*>/;
const CANONICAL_PARAM_OPEN = /<\s*parameter\s+name\s*=\s*("([^"]*)"|'([^']*)')\s*>/g;
const CANONICAL_PARAM_CLOSE_RE = /<\s*\/\s*parameter\s*>/;

const DSML_OPEN = /<\|DSML\|tool_calls\s*>/g;
const DSML_CLOSE_RE = /<\/\|DSML\|tool_calls\s*>|<\s*\/\s*\|DSML\|tool_calls\s*>/;
const DSML_INVOKE_OPEN = /<\|DSML\|invoke\s+name\s*=\s*("([^"]*)"|'([^']*)')\s*>/g;
const DSML_INVOKE_CLOSE_RE = /<\/\|DSML\|invoke\s*>|<\s*\/\s*\|DSML\|invoke\s*>/;
const DSML_PARAM_OPEN = /<\|DSML\|parameter\s+name\s*=\s*("([^"]*)"|'([^']*)')\s*>/g;
const DSML_PARAM_CLOSE_RE = /<\/\|DSML\|parameter\s*>|<\s*\/\s*\|DSML\|parameter\s*>/;

// Yapı: { calls: [{ name, args: object }], blockRanges: [[start,end], ...] }
export function extractToolCalls(text) {
  if (!text || typeof text !== 'string') {
    return { calls: [], blockRanges: [], textWithoutBlocks: text || '' };
  }

  const masked = maskedRanges(text);
  const found = [];
  const blockRanges = [];

  // Canonical pass
  scanFormat(text, masked, {
    openRe: CANONICAL_OPEN,
    closeRe: CANONICAL_CLOSE_RE,
    invokeOpen: CANONICAL_INVOKE_OPEN,
    invokeClose: CANONICAL_INVOKE_CLOSE_RE,
    paramOpen: CANONICAL_PARAM_OPEN,
    paramClose: CANONICAL_PARAM_CLOSE_RE,
  }, found, blockRanges);

  // DSML pass
  scanFormat(text, masked, {
    openRe: DSML_OPEN,
    closeRe: DSML_CLOSE_RE,
    invokeOpen: DSML_INVOKE_OPEN,
    invokeClose: DSML_INVOKE_CLOSE_RE,
    paramOpen: DSML_PARAM_OPEN,
    paramClose: DSML_PARAM_CLOSE_RE,
  }, found, blockRanges);

  // Tek standalone <invoke ...> bloklarını da yakala (modeller bazen üst sarmalı atlıyor).
  scanLooseInvokes(text, masked, found, blockRanges);

  // Dedup blockRanges and sort
  blockRanges.sort((a, b) => a[0] - b[0]);

  const textWithoutBlocks = stripRanges(text, blockRanges).replace(/\n{3,}/g, '\n\n').trim();

  return { calls: found, blockRanges, textWithoutBlocks };
}

function scanFormat(text, masked, R, found, blockRanges) {
  R.openRe.lastIndex = 0;
  let openMatch;
  while ((openMatch = R.openRe.exec(text)) !== null) {
    const blockStart = openMatch.index;
    if (isInsideMasked(blockStart, masked)) continue;

    const afterOpen = R.openRe.lastIndex;
    const closeMatch = R.closeRe.exec(text.slice(afterOpen));
    if (!closeMatch) continue;
    const closeAt = afterOpen + closeMatch.index;
    const blockEnd = closeAt + closeMatch[0].length;

    const inner = text.slice(afterOpen, closeAt);
    const calls = parseInvokes(inner, R);
    if (calls.length) {
      found.push(...calls);
      blockRanges.push([blockStart, blockEnd]);
    }
  }
}

function parseInvokes(inner, R) {
  const out = [];
  R.invokeOpen.lastIndex = 0;
  let m;
  while ((m = R.invokeOpen.exec(inner)) !== null) {
    const name = m[2] || m[3] || '';
    const afterOpen = R.invokeOpen.lastIndex;
    const closeMatch = R.invokeClose.exec(inner.slice(afterOpen));
    const invokeBody = closeMatch ? inner.slice(afterOpen, afterOpen + closeMatch.index) : inner.slice(afterOpen);
    const args = parseParams(invokeBody, R);
    out.push({ name: name.trim(), args });
    if (!closeMatch) break;
    R.invokeOpen.lastIndex = afterOpen + closeMatch.index + closeMatch[0].length;
  }
  return out;
}

function parseParams(body, R) {
  const obj = {};
  R.paramOpen.lastIndex = 0;
  let m;
  while ((m = R.paramOpen.exec(body)) !== null) {
    const name = (m[2] || m[3] || '').trim();
    const afterOpen = R.paramOpen.lastIndex;
    const closeMatch = R.paramClose.exec(body.slice(afterOpen));
    let raw;
    if (closeMatch) {
      raw = body.slice(afterOpen, afterOpen + closeMatch.index);
      R.paramOpen.lastIndex = afterOpen + closeMatch.index + closeMatch[0].length;
    } else {
      raw = body.slice(afterOpen);
      R.paramOpen.lastIndex = body.length;
    }
    obj[name] = coerceValue(raw);
    if (!closeMatch) break;
  }
  return obj;
}

function coerceValue(raw) {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return '';

  // JSON object / array
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    const j = safeJsonParse(trimmed, undefined);
    if (j !== undefined) return j;
  }

  // Booleans
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  if (/^null$/i.test(trimmed)) return null;

  // Number (avoid converting things like "1.0.0")
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }

  // Single- or double-quoted string
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

// Yalnız <invoke name="..."> ... </invoke> blokları (üst sarmal yok).
function scanLooseInvokes(text, masked, found, blockRanges) {
  // Eğer canonical ya da DSML zaten yakaladıysa, blockRanges'in içine düşenleri atla.
  const taken = (pos) => blockRanges.some(([a, b]) => pos >= a && pos < b);
  const re = /<\s*invoke\s+name\s*=\s*("([^"]*)"|'([^']*)')\s*>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    if (isInsideMasked(start, masked)) continue;
    if (taken(start)) continue;
    const afterOpen = re.lastIndex;
    const closeMatch = /<\s*\/\s*invoke\s*>/.exec(text.slice(afterOpen));
    if (!closeMatch) continue;
    const closeAt = afterOpen + closeMatch.index;
    const blockEnd = closeAt + closeMatch[0].length;
    const inner = text.slice(afterOpen, closeAt);
    const args = parseParams(inner, {
      paramOpen: /<\s*parameter\s+name\s*=\s*("([^"]*)"|'([^']*)')\s*>/g,
      paramClose: /<\s*\/\s*parameter\s*>/,
    });
    const name = (m[2] || m[3] || '').trim();
    found.push({ name, args });
    blockRanges.push([start, blockEnd]);
  }
}

function stripRanges(text, ranges) {
  if (!ranges.length) return text;
  let out = '';
  let cursor = 0;
  for (const [a, b] of ranges) {
    if (a < cursor) continue;
    out += text.slice(cursor, a);
    cursor = b;
  }
  out += text.slice(cursor);
  return out;
}
