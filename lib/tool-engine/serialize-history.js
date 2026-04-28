// Konuşma geçmişindeki "tool_calls" / "tool_result" yapılarını upstream'in görebileceği
// XML/text formatına serialize eder. Böylece model, önceki turn'lerinde yaptığı tool
// çağrılarını ve dönen sonuçları okuyabilir.

const TOOL_RESULT_HEADER = '<tool_results>';
const TOOL_RESULT_FOOTER = '</tool_results>';

function fmtToolCallsXml(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return '';
  const parts = ['<tool_calls>'];
  for (const tc of toolCalls) {
    const name = tc?.function?.name || tc?.name || 'unknown';
    let args = tc?.function?.arguments;
    if (typeof args === 'string') {
      // already JSON string; keep
    } else if (args && typeof args === 'object') {
      args = JSON.stringify(args);
    } else {
      args = '{}';
    }
    let parsed;
    try {
      parsed = JSON.parse(args || '{}');
    } catch {
      parsed = {};
    }
    parts.push(`  <invoke name="${escapeAttr(name)}">`);
    for (const [k, v] of Object.entries(parsed || {})) {
      parts.push(`    <parameter name="${escapeAttr(k)}">${formatValue(v)}</parameter>`);
    }
    parts.push('  </invoke>');
  }
  parts.push('</tool_calls>');
  return parts.join('\n');
}

function fmtToolResultXml(toolCallId, content) {
  const safeId = escapeAttr(String(toolCallId || ''));
  const body = stringifyContent(content);
  return [
    `${TOOL_RESULT_HEADER}`,
    `  <result tool_call_id="${safeId}">${body}</result>`,
    `${TOOL_RESULT_FOOTER}`,
  ].join('\n');
}

function stringifyContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return escapeText(content);
  if (Array.isArray(content)) {
    return escapeText(content.map(itemToText).filter(Boolean).join('\n'));
  }
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return escapeText(content.text);
    return escapeText(JSON.stringify(content));
  }
  return escapeText(String(content));
}

function itemToText(c) {
  if (!c) return '';
  if (typeof c === 'string') return c;
  if (typeof c.text === 'string') return c.text;
  if (typeof c.content === 'string') return c.content;
  return JSON.stringify(c);
}

function formatValue(v) {
  if (v == null) return '';
  if (typeof v === 'string') return escapeText(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return escapeText(JSON.stringify(v));
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escapeText(s) {
  // İçeride markdown/text duracak; sadece XML-tehlikeli karakterleri minimal escape edelim.
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

// --- OpenAI history normalizer ---

export function normalizeOpenaiMessages(messages) {
  const out = [];
  for (const msg of messages || []) {
    if (!msg || typeof msg !== 'object') continue;

    if (msg.role === 'tool') {
      // OpenAI tool result → Bizim XML'e çevir, user mesajı olarak ekle.
      const xml = fmtToolResultXml(msg.tool_call_id || '', msg.content);
      out.push({ role: 'user', content: xml });
      continue;
    }

    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const text = typeof msg.content === 'string' ? msg.content : flatten(msg.content);
      const xml = fmtToolCallsXml(msg.tool_calls);
      const merged = [text || '', xml].filter(Boolean).join('\n\n');
      out.push({ role: 'assistant', content: merged });
      continue;
    }

    // Diğer her şey için content'i string'e indir.
    if (msg.content != null && typeof msg.content !== 'string') {
      out.push({ ...msg, content: flatten(msg.content) });
    } else {
      out.push(msg);
    }
  }
  return out;
}

// --- Anthropic history normalizer ---

export function normalizeAnthropicMessages(messages) {
  const out = [];
  for (const msg of messages || []) {
    if (!msg || typeof msg !== 'object') continue;

    if (Array.isArray(msg.content)) {
      const textParts = [];
      const toolCalls = [];
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
          });
        } else if (block.type === 'tool_result') {
          textParts.push(fmtToolResultXml(block.tool_use_id, block.content));
        } else if (block.type === 'image') {
          textParts.push('[image attachment omitted]');
        }
      }
      const xml = toolCalls.length ? fmtToolCallsXml(toolCalls) : '';
      const merged = [textParts.join('\n'), xml].filter(Boolean).join('\n\n');
      out.push({ role: msg.role || 'user', content: merged });
    } else {
      out.push(msg);
    }
  }
  return out;
}

function flatten(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : (c?.text ?? '')))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : String(content);
}
