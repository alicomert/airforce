// Intent synthesis: zayif upstream modelleri (tool_use cagri uretmeyen ama
// niyetini text icinde belli eden) Claude Code / OpenCode / OpenAI SDK gibi
// istemcilerde calisir hale getirir.
//
// Felsefe:
//   - Proje-agnostik: asla hardcoded yol (/workspace, /root, /tmp) uretme
//   - Cross-platform: find/ls gibi Linux-only komutlar uretme; relative path ve
//     glob pattern'lari (**/*) kullan
//   - Istemci-agnostik: tool isimleri (Write/WriteFile/write_file/create_file)
//     istemciden gelen listede ne varsa ona goere secilir
//   - Az riskli: net bir niyet goremezse sentez YAPMA, text'i oldugu gibi birak
//   - Opt-out: SYNTHESIZE_INTENT=0 ile kapatilabilir
//
// Bu modulun kullanildigi tek nokta: applyAnthropicNormalization ve
// applyOpenAiChatNormalization, hic tool_call yoksa cagirir.

import crypto from 'node:crypto';
import process from 'node:process';

export const INTENT_SYNTHESIS_ENABLED = process.env.SYNTHESIZE_INTENT !== '0';

// Istemciden gelen tool listesinden bizim bildigimiz kategorilere mapping.
// Her kategori icin olasi isim aliases'lari ve schema'daki kritik field'lar.
const TOOL_CATEGORIES = {
  write: {
    nameAliases: ['write', 'writefile', 'write_file', 'create', 'createfile', 'create_file', 'savefile', 'save_file', 'newfile'],
    pathFields: ['file_path', 'filePath', 'path', 'file', 'filename'],
    contentFields: ['content', 'text', 'body', 'data']
  },
  read: {
    nameAliases: ['read', 'readfile', 'read_file', 'openfile', 'open_file', 'catfile', 'getfile', 'get_file', 'viewfile', 'view_file'],
    pathFields: ['file_path', 'filePath', 'path', 'file', 'filename']
  },
  list: {
    // Glob/ListDirectory/list_directory - dizin icerigini listele
    nameAliases: ['glob', 'listdirectory', 'list_directory', 'listdir', 'list_dir', 'ls', 'findfiles', 'find_files'],
    patternFields: ['pattern', 'glob', 'query'],
    pathFields: ['path', 'directory', 'dir']
  },
  edit: {
    nameAliases: ['edit', 'editfile', 'edit_file', 'strreplace', 'str_replace', 'replace', 'updatefile', 'update_file', 'multiedit', 'multi_edit'],
    pathFields: ['file_path', 'filePath', 'path', 'file'],
    oldFields: ['old_string', 'oldString', 'old_str', 'find', 'search'],
    newFields: ['new_string', 'newString', 'new_str', 'replace', 'replacement']
  },
  grep: {
    nameAliases: ['grep', 'search', 'searchfiles', 'search_files', 'ripgrep', 'contentsearch'],
    patternFields: ['pattern', 'query', 'regex']
  },
  bash: {
    nameAliases: ['bash', 'shell', 'exec', 'command', 'runcommand', 'run_command', 'terminal'],
    commandFields: ['command', 'cmd', 'script']
  }
};

function normalizeName(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Istemciden gelen tool listesi icinde kategorideki isimle uyumlu olan tool'u bul.
// Returns { name, schema } or null.
export function findToolInRegistry(toolRegistry, category) {
  const meta = TOOL_CATEGORIES[category];
  if (!meta) {
    return null;
  }
  const aliases = meta.nameAliases;
  // Once tam eslesme (normalized)
  for (const [toolName, entry] of toolRegistry.entries()) {
    const normalized = entry.normalized;
    if (aliases.includes(normalized)) {
      return { name: toolName, schema: entry.schema ?? {} };
    }
  }
  // Sonra prefix/suffix eslesmesi
  for (const [toolName, entry] of toolRegistry.entries()) {
    const normalized = entry.normalized;
    for (const alias of aliases) {
      if (normalized.startsWith(alias) || normalized.endsWith(alias) || alias.startsWith(normalized)) {
        return { name: toolName, schema: entry.schema ?? {} };
      }
    }
  }
  return null;
}

// Schema'daki required field ile pathFields eslestirip input'u olustur.
// Boylece Write tool'unun file_path mi filePath mi path mi istedigini
// dinamik olarak dogru alan uzerine yazariz.
function pickSchemaFieldName(schema, candidates, fallback) {
  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  for (const candidate of candidates) {
    if (properties[candidate] !== undefined) {
      return candidate;
    }
  }
  // Schema yoksa ilk candidate'i kullan
  return fallback ?? candidates[0];
}

// --- Text analiz helpers ---

function flattenBlockText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (typeof block?.text === 'string') return block.text;
      if (typeof block?.content === 'string') return block.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function getLastUserText(requestBody) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === 'user') {
      return flattenBlockText(msg.content);
    }
  }
  return '';
}

function getLastToolResultContext(requestBody) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== 'user' || !Array.isArray(msg?.content)) {
      continue;
    }
    const toolResultBlock = msg.content.find((block) => block?.type === 'tool_result');
    if (!toolResultBlock) {
      continue;
    }
    let previousAssistant = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (messages[j]?.role === 'assistant') {
        previousAssistant = messages[j];
        break;
      }
    }
    return {
      toolResultText: flattenBlockText(toolResultBlock.content),
      previousAssistant
    };
  }
  return null;
}

// Kod blogu dil -> default dosya uzantisi. Sadece dosya adi hic bulunamazsa
// fallback olarak kullanilir.
const LANG_TO_EXTENSION = {
  html: 'html',
  htm: 'html',
  css: 'css',
  js: 'js',
  javascript: 'js',
  jsx: 'jsx',
  ts: 'ts',
  tsx: 'tsx',
  typescript: 'ts',
  py: 'py',
  python: 'py',
  md: 'md',
  markdown: 'md',
  json: 'json',
  yaml: 'yaml',
  yml: 'yml',
  xml: 'xml',
  sh: 'sh',
  bash: 'sh',
  go: 'go',
  rs: 'rs',
  rust: 'rs',
  java: 'java',
  kt: 'kt',
  rb: 'rb',
  php: 'php',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cs: 'cs',
  sql: 'sql'
};

// Genel dosya adi pattern'i: alphanumeric[-_.]? + extension
// Turkce karakterler de dahil ([\p{L}] Unicode letters)
// ONEMLI: uzantilar alternation'da UZUN olandan KISA'ya siralanmali ki
// 'package.json' 'package.js' diye kesilmesin. Regex ilk eslesen alternatif
// ile durur, o yuzden 'json' 'js'den once gelmeli, 'markdown' 'md'den once.
// Dosya adi icinde bosluk OLMAMALI; boyle olursa kelime kelime greedy yutup
// 'senden istedigim index.html' -> 'senden istedigim index.html' gibi hatali
// eslesmeler verir. Izin verilen karakterler: Unicode letter/number, _, -, .
const FILENAME_IN_TEXT_RE = /(?:^|[\s`'"()\\/])([\p{L}\p{N}][\p{L}\p{N}_.\-]*?\.(?:markdown|html?|jsx|tsx|mjs|cjs|json|yaml|yml|bash|toml|conf|java|cpp|hpp|sql|rs|go|kt|rb|php|css|ts|js|py|md|xml|sh|cs|cc|c|h|ini|env|txt))(?:$|[\s`'",?!;:])/ui;

export function extractFilenameFromText(text) {
  if (typeof text !== 'string' || !text) return null;
  // Windows mutlak yollari (C:\...) veya absolute unix (/foo/bar) varsa son segmenti al
  // Ama cogunlukla "index.html olustur" gibi basit ifadeler olacak.
  const match = text.match(FILENAME_IN_TEXT_RE);
  if (match) {
    return match[1].trim();
  }
  return null;
}

// Fenced code block'u bul, dil + icerik dondur.
const FENCED_CODE_RE = /```([a-zA-Z0-9_+#-]*)\s*\n([\s\S]*?)```/;

export function extractFencedCodeBlock(text) {
  if (typeof text !== 'string' || !text) return null;
  const match = text.match(FENCED_CODE_RE);
  if (!match) return null;
  const lang = (match[1] || '').toLowerCase().trim();
  const content = match[2] ?? '';
  return { lang, content };
}

// Kullanici "oku/incele/listele/analyze" tarzi exploratory niyet gostermis mi?
// Bu regex hem Turkce hem Ingilizce temel fiillerini yakalar.
const EXPLORE_INTENT_RE = /\b(init|analyze|analyse|explore|inspect|review|understand|overview|architecture|codebase|structure|repo|repository|organize|walkthrough|incele|incelemek|anla|anlamak|bak|bakmak|kesfet|listele|ara\u015ft\u0131r|analiz|ozetle|oku\s+(?:projeyi|repoyu|dosyalari))\b/i;

// Model cevabinda "Let me check", "I'll look", "\u015eimdi bakiyorum" vb. stalling var mi?
const STALLING_TEXT_RE = /\b(let me (?:first |quickly )?(?:check|see|look|explore|analyze|examine|understand|read|review|inspect)|first[,\s]+(?:i['’]ll|i will|let me)|i['’]ll (?:start|begin|first|now) (?:by |with )?(?:checking|looking|exploring|analyzing|examining|reading|reviewing|inspecting)|going to (?:check|look|explore|analyze|examine|read|review|inspect)|once dosyalara? bak|once (?:repo|klasor|dizin).*?bak|bakmam (?:laz\u0131m|gerek)|ilk olarak.*?bak|\u015fimdi.*?(?:bakiyorum|inceliyorum|oku|analiz))\b/i;

// ---- Ana entrypoint ----

export function synthesizeToolCallsFromIntent(normalizedText, requestBody, extractedToolCalls) {
  if (!INTENT_SYNTHESIS_ENABLED) return [];
  // Model zaten tool_call uretmisse sentez yapma
  if (Array.isArray(extractedToolCalls) && extractedToolCalls.length > 0) return [];

  const toolRegistry = buildRegistryFromRequestBody(requestBody);
  if (toolRegistry.size === 0) return [];

  const modelText = typeof normalizedText === 'string' ? normalizedText : '';
  const userText = getLastUserText(requestBody);

  // 1. Write sentezi: kod blogu + dosya adi
  const writeSynth = trySynthesizeWrite(modelText, userText, toolRegistry);
  if (writeSynth.length > 0) return writeSynth;

  // 2. Read sentezi: model 'let me read FILE' dedi ve FILE net
  const readSynth = trySynthesizeRead(modelText, userText, toolRegistry);
  if (readSynth.length > 0) return readSynth;

  // 3. List/Glob sentezi: model stalling + kullanici exploratory niyet
  const listSynth = trySynthesizeList(modelText, userText, toolRegistry);
  if (listSynth.length > 0) return listSynth;

  // 4. Tool-result continuation: model bash/glob ile kesif yapti, sonraki turda
  // bos/stall dondu. Bu durumda tool_result'taki anahtar dosyalardan birini Read et.
  const followupReadSynth = trySynthesizeReadFromToolResult(requestBody, toolRegistry);
  if (followupReadSynth.length > 0) return followupReadSynth;

  return [];
}

function buildRegistryFromRequestBody(requestBody) {
  const registry = new Map();
  const rawTools = Array.isArray(requestBody?.tools) ? requestBody.tools : [];
  for (const tool of rawTools) {
    const name = typeof tool?.name === 'string' ? tool.name : tool?.function?.name;
    if (!name) continue;
    const schema = tool?.input_schema ?? tool?.function?.parameters ?? {};
    registry.set(name, {
      name,
      normalized: normalizeName(name),
      schema: schema && typeof schema === 'object' ? schema : {}
    });
  }
  return registry;
}

function makeToolId() {
  return `toolu_${crypto.randomUUID().replace(/-/g, '')}`;
}

// ---- Write sentezi ----

function trySynthesizeWrite(modelText, userText, toolRegistry) {
  const codeBlock = extractFencedCodeBlock(modelText);
  if (!codeBlock || !codeBlock.content.trim()) return [];

  const writeTool = findToolInRegistry(toolRegistry, 'write');
  if (!writeTool) return [];

  // Dosya adini bulmak icin oncelik sirasi:
  //   1. Kullanicinin son mesajinda acik dosya adi ("index.html olustur")
  //   2. Model cevabinin DISINDAKI text'te dosya adi (ornek: "Dosyayi index.html olarak kaydet")
  //   3. Kod blogunun dilinden tahmin ('html' -> 'index.html')
  let filename = extractFilenameFromText(userText);
  if (!filename) {
    // Model cevabindan - ama kod blogu DISINDAKI
    const textBeforeCode = modelText.split('```')[0] ?? '';
    const textAfterCode = modelText.split('```').slice(2).join('```') ?? '';
    filename = extractFilenameFromText(textBeforeCode) ?? extractFilenameFromText(textAfterCode);
  }
  if (!filename) {
    const ext = LANG_TO_EXTENSION[codeBlock.lang];
    if (!ext) return []; // Guvenli: dil bilinmiyorsa sentez yapma
    // Standart default: index.<ext> (en yaygin kariyer/web senaryosu)
    if (ext === 'html') filename = 'index.html';
    else if (ext === 'css') filename = 'styles.css';
    else if (ext === 'js') filename = 'index.js';
    else if (ext === 'py') filename = 'main.py';
    else if (ext === 'md') filename = 'README.md';
    else filename = `file.${ext}`;
  }

  // Schema'ya gore dogru field adlarini sec
  const pathField = pickSchemaFieldName(writeTool.schema, ['file_path', 'filePath', 'path', 'file', 'filename'], 'file_path');
  const contentField = pickSchemaFieldName(writeTool.schema, ['content', 'text', 'body', 'data'], 'content');

  const input = {
    [pathField]: filename,
    [contentField]: codeBlock.content
  };

  return [{
    id: makeToolId(),
    name: writeTool.name,
    input
  }];
}

// ---- Read sentezi ----

// "Let me read FILE" / "I'll check FILE" / "\u015eimdi FILE dosyasini okuyorum" gibi
// model metninde FILE (dosya adi) varsa Read sentezi.
const READ_FILE_INTENT_RE = /\b(?:let me (?:read|check|look at|see|view|examine)|i['’]ll (?:read|check|look at|see|view|examine)|going to (?:read|check|look at|view)|i (?:will|can) (?:read|check|view)|reading|checking|viewing|oku(?:yorum|yacagim|mak icin)?|inceleyecegim|bakacagim|gozatiyorum)\b[\s\S]{0,80}?([\p{L}\p{N}][\p{L}\p{N}_.\-\/\\]*?\.(?:markdown|html?|jsx|tsx|mjs|cjs|json|yaml|yml|bash|toml|conf|java|cpp|hpp|sql|rs|go|kt|rb|php|css|ts|js|py|md|xml|sh|cs|cc|c|h|ini|env|txt))/ui;

function trySynthesizeRead(modelText, userText, toolRegistry) {
  const readTool = findToolInRegistry(toolRegistry, 'read');
  if (!readTool) return [];

  const match = modelText.match(READ_FILE_INTENT_RE);
  if (!match) return [];
  const filename = match[1]?.trim();
  if (!filename) return [];

  // Eger metinde 1'den fazla ayri dosya adi geciyorsa niyet belirsiz
  // ('Let me check A.md and B.md'). Bu durumda Read sentezi yapma, daha uygun
  // olan Glob/List sentezine birak.
  const allFilenames = extractAllFilenamesFromText(modelText);
  const uniqueFilenames = new Set(allFilenames);
  if (uniqueFilenames.size > 1) return [];

  const pathField = pickSchemaFieldName(readTool.schema, ['file_path', 'filePath', 'path', 'file', 'filename'], 'file_path');
  return [{
    id: makeToolId(),
    name: readTool.name,
    input: { [pathField]: filename }
  }];
}

function extractAllFilenamesFromText(text) {
  if (typeof text !== 'string' || !text) return [];
  const globalRe = new RegExp(FILENAME_IN_TEXT_RE.source, 'gui');
  const results = [];
  let match;
  while ((match = globalRe.exec(text)) !== null) {
    if (match[1]) results.push(match[1].trim());
    if (globalRe.lastIndex === match.index) globalRe.lastIndex += 1;
  }
  return results;
}

const KEY_FILE_PRIORITY = [
  'agents.md',
  'claude.md',
  'readme.md',
  'package.json',
  'pyproject.toml',
  'cargo.toml',
  'go.mod',
  'composer.json',
  'requirements.txt',
  'makefile'
];

function scoreCandidateFile(filePath) {
  const normalized = String(filePath ?? '').trim().replace(/\\/g, '/');
  if (!normalized) return -1;
  const basename = normalized.split('/').filter(Boolean).pop()?.toLowerCase() ?? normalized.toLowerCase();
  const priorityIndex = KEY_FILE_PRIORITY.indexOf(basename);
  if (priorityIndex !== -1) {
    return 1000 - priorityIndex;
  }
  if (/\.(md|json|toml|ya?ml|ini|env|txt)$/i.test(basename)) {
    return 200;
  }
  return 0;
}

function pickBestReadCandidate(text) {
  const filenames = extractAllFilenamesFromText(text);
  if (filenames.length === 0) {
    return null;
  }
  const unique = [...new Set(filenames)];
  unique.sort((a, b) => scoreCandidateFile(b) - scoreCandidateFile(a));
  return unique[0] ?? null;
}

function assistantUsedTool(message, category) {
  if (!message || !Array.isArray(message?.content)) {
    return false;
  }
  const categoryMeta = TOOL_CATEGORIES[category];
  if (!categoryMeta) {
    return false;
  }
  const aliases = new Set(categoryMeta.nameAliases);
  return message.content.some((block) => block?.type === 'tool_use' && aliases.has(normalizeName(block?.name)));
}

function assistantReadTargets(message) {
  if (!message || !Array.isArray(message?.content)) {
    return [];
  }
  return message.content
    .filter((block) => block?.type === 'tool_use' && normalizeName(block?.name) === 'read')
    .map((block) => block?.input?.file_path ?? block?.input?.filePath ?? block?.input?.path ?? block?.input?.file ?? block?.input?.filename)
    .filter((value) => typeof value === 'string' && value.trim());
}

// ---- List/Glob sentezi ----

function trySynthesizeList(modelText, userText, toolRegistry) {
  // Sadece SU durumda sentezle:
  //   (1) Model cevabinda stalling text ('Let me check...') var
  //   (2) Kullanici exploratory niyet gostermis (init/analyze/incele vb.)
  //   Bu ikisinden biri bile yoksa sentez yapma (cok agresif olur).
  const hasStalling = STALLING_TEXT_RE.test(modelText);
  const hasExploreIntent = EXPLORE_INTENT_RE.test(userText) || EXPLORE_INTENT_RE.test(modelText);
  if (!hasStalling && !hasExploreIntent) return [];

  const listTool = findToolInRegistry(toolRegistry, 'list');
  if (!listTool) return [];

  const patternField = pickSchemaFieldName(listTool.schema, ['pattern', 'glob', 'query'], 'pattern');
  const pathField = pickSchemaFieldName(listTool.schema, ['path', 'directory', 'dir'], null);

  const input = {};
  // Cross-platform: **/* tum dosyalari relative olarak listeler
  input[patternField] = '**/*';
  // Eger schema path da istiyorsa (required olabilir) relative current dir
  if (pathField) {
    const properties = listTool.schema?.properties && typeof listTool.schema.properties === 'object' ? listTool.schema.properties : {};
    const required = Array.isArray(listTool.schema?.required) ? listTool.schema.required : [];
    if (required.includes(pathField) && properties[pathField]) {
      input[pathField] = '.';
    }
  }

  return [{
    id: makeToolId(),
    name: listTool.name,
    input
  }];
}

function trySynthesizeReadFromToolResult(requestBody, toolRegistry) {
  const readTool = findToolInRegistry(toolRegistry, 'read');
  if (!readTool) return [];

  const context = getLastToolResultContext(requestBody);
  if (!context?.toolResultText) return [];

  const cameFromExplorationTool =
    assistantUsedTool(context.previousAssistant, 'list') ||
    assistantUsedTool(context.previousAssistant, 'bash');
  if (!cameFromExplorationTool) return [];

  const candidate = pickBestReadCandidate(context.toolResultText);
  if (!candidate) return [];

  const previousReadTargets = new Set(assistantReadTargets(context.previousAssistant).map((value) => String(value).trim().toLowerCase()));
  if (previousReadTargets.has(String(candidate).trim().toLowerCase())) {
    return [];
  }

  const pathField = pickSchemaFieldName(readTool.schema, ['file_path', 'filePath', 'path', 'file', 'filename'], 'file_path');
  return [{
    id: makeToolId(),
    name: readTool.name,
    input: { [pathField]: candidate }
  }];
}
