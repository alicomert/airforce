// Modelden gelen text içinde, code-block veya alıntı içine düşmüş <tool_calls>
// bloklarını "leak" sayar ve parse aşamasında elenecek konumları işaretler.
// Hedefimiz: kullanıcıya örnek olarak gösterilen XML'i yanlışlıkla tool-call diye yorumlamamak.

// Returns array of [start, end) ranges that are inside a code fence or inline code.
export function maskedRanges(text) {
  const out = [];
  if (!text || typeof text !== 'string') return out;

  // 1. Triple-backtick fenced blocks (```lang ... ```)
  const fenceRe = /```[^\n]*\n[\s\S]*?```/g;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    out.push([m.index, m.index + m[0].length]);
  }

  // 2. Tilde-fenced blocks (~~~ ... ~~~)
  const tildeRe = /~~~[^\n]*\n[\s\S]*?~~~/g;
  while ((m = tildeRe.exec(text)) !== null) {
    out.push([m.index, m.index + m[0].length]);
  }

  // 3. Indented code blocks (4+ spaces at line start, multi-line)
  // Bunu agresif yapmıyoruz; basit gevşek heuristik:
  // 4 boşlukla başlayan ardışık satırlar.
  const indentRe = /(?:^|\n)((?: {4,}|\t)[^\n]*(?:\n(?: {4,}|\t)[^\n]*)+)/g;
  while ((m = indentRe.exec(text)) !== null) {
    out.push([m.index + (m[0].startsWith('\n') ? 1 : 0), m.index + m[0].length]);
  }

  // 4. Inline code spans `...`
  const inlineRe = /`[^`\n]+`/g;
  while ((m = inlineRe.exec(text)) !== null) {
    out.push([m.index, m.index + m[0].length]);
  }

  // Dedup overlapping ranges
  out.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of out) {
    if (merged.length && r[0] <= merged[merged.length - 1][1]) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  return merged;
}

export function isInsideMasked(pos, ranges) {
  for (const [a, b] of ranges) {
    if (pos >= a && pos < b) return true;
    if (pos < a) return false;
  }
  return false;
}

// Replace masked-and-target ranges with empty so that downstream parsers don't
// trip over the same text twice. Used to strip the parsed <tool_calls> block
// from the assistant's text content.
export function spliceOut(text, ranges) {
  if (!ranges.length) return text;
  ranges.sort((a, b) => a[0] - b[0]);
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
