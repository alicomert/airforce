// System prompt injection: request upstream'e gitmeden once, client'in tool
// listesinden dinamik bir "tool usage contract" uretip system prompt'a ekler.
// Amac: zayif modelleri (glm-5 vb.) tool call protokol\u00fcne uygun davranmaya
// yoneltmek, text icinde kod basmak yerine Write tool'unu cagirmalarini saglamak.
//
// Kritik prensipler:
//   - Proje-agnostik: hicbir hardcoded yol, dil ornegi, framework ismi yok
//   - Client-agnostik: tool isimleri ve description'lar client'in kendi
//     schema'sindan alinir (Write/WriteFile/write_file hepsi destekli)
//   - Non-invasive: client'in kendi system prompt'unu EZMEZ, ona ekler
//   - Opt-out: INJECT_SYSTEM_PROMPT=0 ile kapatilabilir
//
// Enjekte edilen prompt sadece "bu tool'larin var, aksiyon varsa text yerine
// tool cagir" mesajini verir. Workflow kurallari, ornekler, OS ipuclari
// enjekte ETMEZ - bunlar modelin kendi muhakemesine birakilir.

import process from 'node:process';

export const SYSTEM_PROMPT_INJECTION_ENABLED = process.env.INJECT_SYSTEM_PROMPT !== '0';

// Injected prompt'u isaretlemek icin (debug + idempotency).
const MARKER_START = '<!-- airforce-proxy:tool-contract -->';
const MARKER_END = '<!-- /airforce-proxy:tool-contract -->';

function truncate(value, max) {
  const text = String(value ?? '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trim()}\u2026`;
}

// Tool'un client schema'sindan kisa bir imza uret.
// Ornegin: "Write(file_path, content) \u2014 Creates or overwrites a file"
function formatToolSignature(tool) {
  const name = typeof tool?.name === 'string' ? tool.name : tool?.function?.name;
  if (!name) return null;
  const schema = tool?.input_schema ?? tool?.function?.parameters ?? {};
  const description = typeof tool?.description === 'string'
    ? tool.description
    : typeof tool?.function?.description === 'string'
      ? tool.function.description
      : '';

  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema?.required) ? schema.required : [];

  // Required field'lari once, optional'lari sonra; max 5 field goster (token tasarrufu).
  const fieldNames = Object.keys(properties);
  const orderedFields = [
    ...required.filter((r) => fieldNames.includes(r)),
    ...fieldNames.filter((f) => !required.includes(f))
  ].slice(0, 5);

  const fieldsSignature = orderedFields
    .map((fieldName) => {
      const isRequired = required.includes(fieldName);
      return isRequired ? fieldName : `${fieldName}?`;
    })
    .join(', ');

  const truncatedDescription = description ? truncate(description, 160) : '';
  if (truncatedDescription) {
    return `- ${name}(${fieldsSignature}) \u2014 ${truncatedDescription}`;
  }
  return `- ${name}(${fieldsSignature})`;
}

// Request'in tool listesinden dinamik contract uret. Tool listesi bos ise null
// dondurur (enjekte edilecek bir sey yok).
export function buildToolContract(requestBody) {
  if (!SYSTEM_PROMPT_INJECTION_ENABLED) return null;

  const tools = Array.isArray(requestBody?.tools) ? requestBody.tools : [];
  if (tools.length === 0) return null;

  const signatures = tools
    .map(formatToolSignature)
    .filter(Boolean);

  if (signatures.length === 0) return null;

  // Not: metin MINIMAL tutuldu. Sadece tool listesini ve "aksiyon varsa tool cagir"
  // kuralini icerir. Hicbir sabit dil/OS/framework/kod-ornegi yok.
  const lines = [
    MARKER_START,
    'You have access to the following tools. When the user requests an action (creating or modifying files, running commands, exploring the project, searching, fetching web content, etc.), you MUST call the appropriate tool instead of only describing the action or pasting the result as plain text.',
    '',
    'Available tools:',
    ...signatures,
    '',
    'Rules:',
    '- If content needs to be written to a file, call the write/create tool with the exact file path and full content.',
    '- If you need to inspect the project, call the list/glob/read tools; do not guess.',
    '- Prefer relative paths. Do not invent absolute paths unless the user provided one.',
    '- Never stop a turn with only a "Let me check..." or "I\u2019ll start by..." text; always follow up with an actual tool call in the same turn.',
    MARKER_END
  ];

  return lines.join('\n');
}

// Check: contract zaten enjekte edilmis mi? Ayni istek retry edildiginde
// duplicate enjekte etmemek icin.
function alreadyInjected(text) {
  return typeof text === 'string' && text.includes(MARKER_START);
}

// ---- Anthropic system prompt handling ----

// Anthropic format'inda 'system' ya string ya da [{type: 'text', text: '...'}]
// array olabilir. Her iki durumda da contract'i EKLERIZ, ezmeyiz.
export function injectAnthropicSystemPrompt(requestBody) {
  const contract = buildToolContract(requestBody);
  if (!contract) return requestBody;
  if (!requestBody || typeof requestBody !== 'object') return requestBody;

  const existing = requestBody.system;

  // Zaten enjekte edilmisse dokunma
  if (typeof existing === 'string' && alreadyInjected(existing)) return requestBody;
  if (Array.isArray(existing) && existing.some((b) => typeof b?.text === 'string' && alreadyInjected(b.text))) return requestBody;

  let newSystem;
  if (existing == null || existing === '') {
    newSystem = contract;
  } else if (typeof existing === 'string') {
    newSystem = `${existing}\n\n${contract}`;
  } else if (Array.isArray(existing)) {
    newSystem = [
      ...existing,
      { type: 'text', text: contract }
    ];
  } else {
    // Bilinmeyen sekil - dokunma
    return requestBody;
  }

  return { ...requestBody, system: newSystem };
}

// ---- OpenAI chat/completions system prompt handling ----

// OpenAI format'inda system mesaji messages[0]'da gelir (role: 'system').
// Birden fazla olabilir. Biz varolan ilk system mesajina EKLERIZ veya yeni bir
// tane basa koyariz.
export function injectOpenAiSystemPrompt(requestBody) {
  const contract = buildToolContract(requestBody);
  if (!contract) return requestBody;
  if (!requestBody || typeof requestBody !== 'object') return requestBody;

  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];

  // Zaten enjekte edilmisse dokunma
  const already = messages.some((msg) => {
    if (msg?.role !== 'system') return false;
    if (typeof msg.content === 'string') return alreadyInjected(msg.content);
    if (Array.isArray(msg.content)) return msg.content.some((b) => typeof b?.text === 'string' && alreadyInjected(b.text));
    return false;
  });
  if (already) return requestBody;

  const firstSystemIdx = messages.findIndex((msg) => msg?.role === 'system');
  let newMessages;
  if (firstSystemIdx === -1) {
    newMessages = [
      { role: 'system', content: contract },
      ...messages
    ];
  } else {
    newMessages = messages.slice();
    const original = newMessages[firstSystemIdx];
    if (typeof original.content === 'string') {
      newMessages[firstSystemIdx] = {
        ...original,
        content: `${original.content}\n\n${contract}`
      };
    } else if (Array.isArray(original.content)) {
      newMessages[firstSystemIdx] = {
        ...original,
        content: [...original.content, { type: 'text', text: contract }]
      };
    } else {
      // Bilinmeyen sekil - basa yeni system mesaji ekle
      newMessages = [
        { role: 'system', content: contract },
        ...messages
      ];
    }
  }

  return { ...requestBody, messages: newMessages };
}

// Path'e gore dogru enjeksiyon fonksiyonunu uygular.
export function injectSystemPromptForPath(pathname, requestBody) {
  if (!requestBody || typeof requestBody !== 'object') return requestBody;

  if (pathname.includes('/anthropic/') || pathname === '/v1/messages') {
    return injectAnthropicSystemPrompt(requestBody);
  }
  if (pathname.endsWith('/chat/completions') || pathname.endsWith('/responses')) {
    return injectOpenAiSystemPrompt(requestBody);
  }
  return requestBody;
}
