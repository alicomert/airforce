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

// DEFAULT ACIK. Zayif modeller (glm-5 vb.) Write/Edit tool'unu istemeden
// text icinde cevap basiyorlar. System prompt contract bunu azaltir.
// Kapatmak icin: INJECT_SYSTEM_PROMPT=0
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

// Tool kategorilerini ayir: file-mutating (Write/Edit/Delete) vs. read-only
// (Read/Glob/Grep/Bash). Prompt metninde file-mutating'e ekstra vurgu yapilir
// cunku zayif modeller bunlari text icinde "yaptim" diye bastirma egiliminde.
function categorizeTools(tools) {
  const mutating = [];
  const readOnly = [];
  for (const tool of tools) {
    const name = typeof tool?.name === 'string' ? tool.name : tool?.function?.name;
    if (!name) continue;
    const lower = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (/^(write|writefile|createfile|savefile|edit|editfile|strreplace|multiedit|delete|deletefile|remove|rm|move|moverename)/.test(lower)) {
      mutating.push(tool);
    } else {
      readOnly.push(tool);
    }
  }
  return { mutating, readOnly };
}

// Session'daki asistant turlarini say (tool_use sayisi degil, assistant
// mesaj sayisi). Uzun session'larda model kafayi yiyiyor, ozet-devam hint'i
// eklenir.
function countAssistantTurns(requestBody) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  let count = 0;
  for (const msg of messages) {
    if (msg?.role === 'assistant') count += 1;
  }
  return count;
}

// Session'da kullanilan tool kategorilerini say. Model'e "su ana kadar X Read
// Y Bash yaptin" mesaji verecegiz ki neyi unuttuysa hatirlasin.
function summarizeToolHistory(requestBody) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  const counts = {};
  const readTargets = new Set();
  for (const msg of messages) {
    if (msg?.role !== 'assistant' || !Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== 'tool_use') continue;
      const name = String(block?.name ?? 'Unknown');
      counts[name] = (counts[name] ?? 0) + 1;
      // Read'leri de ayrica topla (cache referansi icin)
      if (/^(read|readfile)/i.test(name.replace(/[^a-z]/gi, ''))) {
        const path = block?.input?.file_path ?? block?.input?.filePath ?? block?.input?.path;
        if (typeof path === 'string') readTargets.add(path);
      }
    }
  }
  return { counts, readTargets: [...readTargets] };
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

  const { mutating } = categorizeTools(tools);
  const mutatingToolNames = mutating
    .map((t) => t?.name ?? t?.function?.name)
    .filter(Boolean);

  // Dil-bagimsiz, yapisal guidance. Amac: model "yaptim" diye duz
  // yazmak yerine TOOL CAGIRSIN. Ozellikle file mutation'da (Write/Edit).
  // Tonlama: "must" degil "required" - kafa karistirici degil ama net.
  const lines = [
    MARKER_START,
    'Tool usage contract (from airforce-compat-proxy):',
    '',
    'Available tools:',
    ...signatures,
    '',
    'Core rules:',
    '- For ANY action that changes the filesystem, you MUST invoke the corresponding tool. Announcing the action in plain text ("I will create", "Created", "Here is the file content in a code block") does NOT execute it - the tool call is the only way.',
    '- Never claim a file was created/modified unless you invoked a file-mutation tool in the SAME assistant turn.',
    '- Use relative paths unless the user gave an absolute one.',
    '- Match each tool\u2019s required schema fields exactly.',
    '- If you are genuinely unsure (missing info, ambiguous request), it is acceptable to ask one short clarifying question instead of guessing.'
  ];

  if (mutatingToolNames.length > 0) {
    lines.push('');
    lines.push(`File-mutation tools in this session: ${mutatingToolNames.join(', ')}. If the user asks to create, modify, generate, save, scaffold, or fix a file, you MUST call one of these tools. Do not respond with code fences instead.`);
  }

  // Session'da 8+ asistant turu gectiyse ozet-hint ekle. Weak modeller
  // (glm-5) uzun session'larda halusinasyon uretiyor: dosya adlari uyduruyor,
  // context'i karistiriyor. Bu hint modele "durum kontrolu yap" diyor.
  const turns = countAssistantTurns(requestBody);
  if (turns >= 8) {
    const { counts, readTargets } = summarizeToolHistory(requestBody);
    const countSummary = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, n]) => `${name}x${n}`)
      .join(', ');
    lines.push('');
    lines.push(`Session checkpoint (${turns} turns so far): you have already invoked [${countSummary}]. Before making another tool call:`);
    lines.push('1. DO NOT invent new filenames. Only reference files you already saw in tool_result blocks above.');
    lines.push('2. DO NOT repeat reads of files already read - their content is in your context above.');
    if (readTargets.length > 0) {
      lines.push(`3. Files already read in this session: ${readTargets.slice(0, 12).join(', ')}${readTargets.length > 12 ? ' (and more)' : ''}. Do not re-read these.`);
    }
    lines.push(`${readTargets.length > 0 ? 4 : 3}. If the user's request is satisfied, produce a short end_turn summary. Otherwise, call the next needed tool - but only using real filenames and valid schema fields.`);
  }

  lines.push(MARKER_END);
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
