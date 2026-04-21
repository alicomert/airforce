// Intent synthesis: zayif upstream modelleri (tool_use cagri uretmeyen ama
// niyetini text icinde belli eden) Claude Code / OpenCode / OpenAI SDK gibi
// istemcilerde calisir hale getirir.
//
// Felsefe (v2 - dile bagimsiz):
//   - Proje-agnostik: asla hardcoded yol (/workspace, /root, /tmp) uretme
//   - Cross-platform: find/ls gibi Linux-only komutlar uretme; relative path ve
//     glob pattern'lari (**/*) kullan
//   - Istemci-agnostik: tool isimleri istemciden gelen listede ne varsa ona gore
//   - **DIL-AGNOSTIK**: Asla "let me read", "olustur", "yaz" gibi kelime
//     regex'leri kullanma. Cince, Almanca, Rusca, Farsca fark etmez. Niyet
//     tahmini DETERMINISTIK sinyallerle yapilir:
//       1. Onceki asistant turunda hangi tool'lar kullanildi? (history)
//       2. Conversation'in hangi asamasindayiz? (ilk tur / stall tur / tool-result)
//       3. Fenced code block'un YAPISI (dosya listesi mi, gercek icerik mi)
//       4. Render container (<details>, <summary>) icindeki block'lar
//       5. Istemciden gelen dosya adi / path ipuclari
//   - Az riskli: belirsizse sentez YAPMA
//   - Opt-out: SYNTHESIZE_INTENT=0 ile kapatilabilir

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
      return stripInstrumentationTags(flattenBlockText(msg.content));
    }
  }
  return '';
}

// Istemci-enjekte edilen instrumentation tag'lerini text'ten cikar.
// Bu tag'lerin ICINDE genelde tool manifest'leri, skill aciklamalari, dosya
// adlari bulunur. Kullanicinin GERCEK niyetini analiz ederken bu bloklari
// yok saymamiz gerek - aksi halde instrumentation icindeki '.claude/settings.
// local.json' gibi path'leri kullanicinin niyeti sanip yanlis karar veriyoruz.
//
// IKI KATEGORI VAR:
//   - Tamamen silinenler (tag + icerik): <system-reminder>, <tool-output>,
//     <claude-instructions>, <local-command-stdout/stderr>. Bunlar sadece
//     context, kullanicinin niyeti degil.
//   - Sadece tag silinip icerik korunanlar: <command-name>, <command-args>,
//     <command-message>. Bunlarin ICINDE kullanicinin GERCEK komutu var
//     (ornek: <command-name>/init</command-name>). Icerik korunmali.
function stripInstrumentationTags(text) {
  if (typeof text !== 'string' || !text) return text;
  // Block silinen kategori
  let out = text
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<local-command(?:-std(?:out|err))?\b[^>]*>[\s\S]*?<\/local-command(?:-std(?:out|err))?>/gi, '')
    .replace(/<assistant-message\b[^>]*>[\s\S]*?<\/assistant-message>/gi, '')
    .replace(/<tool-output\b[^>]*>[\s\S]*?<\/tool-output>/gi, '')
    .replace(/<claude-instructions\b[^>]*>[\s\S]*?<\/claude-instructions>/gi, '');
  // Icerik korunan kategori: tag'leri soy, icerigi birak
  out = out.replace(/<\/?(?:command-name|command-args|command-message|user-message)\b[^>]*>/gi, ' ');
  // Kapanisi eksik sarkan system-reminder: '<system-reminder>...' (trailing)
  out = out.replace(/<system-reminder\b[^>]*>[\s\S]*$/i, '');
  return out.replace(/\s+/g, ' ').trim();
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

// Genel dosya adi pattern'i: Unicode letter/number + uzanti.
// Uzantilar alternation'da UZUN olandan KISA'ya siralanmali ki
// 'package.json' 'package.js' diye kesilmesin.
const FILENAME_IN_TEXT_RE = /(?:^|[\s`'"()\\/])([\p{L}\p{N}][\p{L}\p{N}_.\-]*?\.(?:markdown|html?|jsx|tsx|mjs|cjs|json|yaml|yml|bash|toml|conf|java|cpp|hpp|sql|rs|go|kt|rb|php|css|ts|js|py|md|xml|sh|cs|cc|c|h|ini|env|txt))(?:$|[\s`'",?!;:])/ui;

export function extractFilenameFromText(text) {
  if (typeof text !== 'string' || !text) return null;
  const match = text.match(FILENAME_IN_TEXT_RE);
  if (match) {
    return match[1].trim();
  }
  return null;
}

// Fenced code block'u bul, dil + icerik dondur. Birden fazla varsa hepsini.
const FENCED_CODE_RE = /```([a-zA-Z0-9_+#-]*)\s*\n([\s\S]*?)```/;
const FENCED_CODE_GLOBAL_RE = /```([a-zA-Z0-9_+#-]*)\s*\n([\s\S]*?)```/g;

export function extractFencedCodeBlock(text) {
  if (typeof text !== 'string' || !text) return null;
  const match = text.match(FENCED_CODE_RE);
  if (!match) return null;
  const lang = (match[1] || '').toLowerCase().trim();
  const content = match[2] ?? '';
  return { lang, content };
}

function extractAllFencedBlocks(text) {
  if (typeof text !== 'string' || !text) return [];
  const blocks = [];
  let match;
  FENCED_CODE_GLOBAL_RE.lastIndex = 0;
  while ((match = FENCED_CODE_GLOBAL_RE.exec(text)) !== null) {
    blocks.push({
      raw: match[0],
      lang: (match[1] || '').toLowerCase().trim(),
      content: match[2] ?? '',
      index: match.index ?? 0
    });
    if (FENCED_CODE_GLOBAL_RE.lastIndex === match.index) FENCED_CODE_GLOBAL_RE.lastIndex += 1;
  }
  return blocks;
}

// --- Deterministik fenced-block yapi analizi (dile bagimsiz) ---

// Blok sadece dosya yolu listesi mi? (bash ls/find output)
function isFilePathListing(content) {
  if (typeof content !== 'string') return false;
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const pathLike = lines.filter((line) => {
    if (/^[./~]/.test(line)) return true;
    if (/^[A-Za-z]:[\\/]/.test(line)) return true;
    if (/^[\w.-]+(?:[\\/][\w.-]+)+$/.test(line)) return true;
    if (/^[\w.-]+\.[A-Za-z0-9]{1,12}$/.test(line)) return true;
    return false;
  });
  return pathLike.length / lines.length >= 0.8;
}

// Shell output gibi mi?
function looksLikeShellOutput(content) {
  if (typeof content !== 'string') return false;
  if (/^\s*(?:Exit code|exit code|\$\s|>\s|PID\s+\w)/m.test(content)) return true;
  if (isFilePathListing(content)) return true;
  return false;
}

// Blok bir <details>/<summary> gibi render container icinde mi?
// Eger oyleyse bu muhtemelen bir "tool output goster" blok'dur, yazilacak
// dosya icerigi degil.
function isFencedBlockInsideRenderContainer(modelText, blockIndex) {
  if (typeof modelText !== 'string' || blockIndex < 0) return false;
  const before = modelText.slice(0, blockIndex);
  const after = modelText.slice(blockIndex);
  // <details> / <summary> container
  const openDetails = (before.match(/<details[^>]*>/gi) || []).length;
  const closeDetails = (before.match(/<\/details>/gi) || []).length;
  if (openDetails > closeDetails) {
    // Acik container icindeyiz
    if (after.toLowerCase().includes('</details>')) return true;
  }
  // <summary> tek satir ama genelde block'u hemen oncesinde konumlandirir
  const sixtyBefore = before.slice(-80);
  if (/<\/?(?:summary|figure|figcaption|aside|nav|footer)\b/i.test(sixtyBefore)) {
    return true;
  }
  return false;
}

// --- Tool history analizi (dile bagimsiz) ---

function getAllAssistantMessages(requestBody) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  return messages.filter((msg) => msg?.role === 'assistant' && Array.isArray(msg?.content));
}

function getLastAssistantMessage(requestBody) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'assistant') return messages[i];
  }
  return null;
}

// Onceki asistant turlarinda kullanilan tool kategorilerini bul.
// Returns Set<category> (e.g. {'bash', 'read', 'glob'}).
function getPreviousToolCategories(requestBody) {
  const categories = new Set();
  const assistants = getAllAssistantMessages(requestBody);
  for (const msg of assistants) {
    for (const block of msg.content) {
      if (block?.type !== 'tool_use') continue;
      const normalized = normalizeName(block?.name);
      for (const [category, meta] of Object.entries(TOOL_CATEGORIES)) {
        if (meta.nameAliases.includes(normalized)) {
          categories.add(category);
          break;
        }
      }
    }
  }
  return categories;
}

// Istemcinin BU session'da son asistant turunda ne tool kullandi?
function getLastAssistantToolCategories(requestBody) {
  const last = getLastAssistantMessage(requestBody);
  const categories = new Set();
  if (!last) return categories;
  for (const block of last.content || []) {
    if (block?.type !== 'tool_use') continue;
    const normalized = normalizeName(block?.name);
    for (const [category, meta] of Object.entries(TOOL_CATEGORIES)) {
      if (meta.nameAliases.includes(normalized)) {
        categories.add(category);
        break;
      }
    }
  }
  return categories;
}

// Conversation kac tur (assistant turnu) gectigini say.
function countAssistantTurns(requestBody) {
  return getAllAssistantMessages(requestBody).length;
}

// En son tool_result'tan bir bash/glob/grep ile KESIF sonucu geldi mi?
// Bu durumda fenced block'lar muhtemelen o tool'un ciktisidir.
function lastTurnWasExplorationTool(requestBody) {
  const lastAssistantCategories = getLastAssistantToolCategories(requestBody);
  return lastAssistantCategories.has('bash') ||
         lastAssistantCategories.has('list') ||
         lastAssistantCategories.has('grep');
}

// --- Ana entrypoint ---

export function synthesizeToolCallsFromIntent(normalizedText, requestBody, extractedToolCalls, upstreamStopReason) {
  if (!INTENT_SYNTHESIS_ENABLED) return [];
  if (Array.isArray(extractedToolCalls) && extractedToolCalls.length > 0) return [];

  const toolRegistry = buildRegistryFromRequestBody(requestBody);
  if (toolRegistry.size === 0) return [];

  const modelText = typeof normalizedText === 'string' ? normalizedText : '';
  const userText = getLastUserText(requestBody);

  // Sentez sirasi (agresiften koruyucuya, sonra fallback'e):
  //
  // 1. Tool-result continuation: onceki turda bash/glob/grep ile kesif
  //    yapildi, bu turda tool_use uretilemedi -> tool_result'ta gordugumuz
  //    dosya listelerinden bir ONEMLI dosyayi Read et.
  //    (EN GUVENLI secenek: Read stateless, history'de daha once okunmayan
  //     dosya secer, loop olmaz.)
  const followupReadSynth = trySynthesizeReadFromToolResult(requestBody, toolRegistry);
  if (followupReadSynth.length > 0) return followupReadSynth;

  // 2. Write sentezi: cok sikica kontrollu, sadece kullanicinin metninde ACIK
  //    dosya adi + gercek kod blogu oldugunda. Dile bagimsiz.
  const writeSynth = trySynthesizeWrite(modelText, userText, toolRegistry, requestBody);
  if (writeSynth.length > 0) return writeSynth;

  // 3. Read sentezi: modelin metninde bariz 1 dosya adi geciyor ve daha once
  //    okunmamis. Dile bagimsiz (sadece dosya adi + tool history'ye bakar).
  const readSynth = trySynthesizeRead(modelText, requestBody, toolRegistry);
  if (readSynth.length > 0) return readSynth;

  // 4. List/Glob sentezi: sadece slash-command (/init, /analyze) veya upstream
  //    bir tool cagirmaya CALISTI (stop_reason:'tool_use') ama yapamadi
  //    durumunda. Dile bagimsiz.
  const listSynth = trySynthesizeList(requestBody, toolRegistry, upstreamStopReason);
  if (listSynth.length > 0) return listSynth;

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

// ---- Write sentezi (dile bagimsiz) ----
//
// Kabul kurallari (DETERMINISTIK):
//   (A) Mutlaka dosya adi belli olmali: kullanicinin metninde ACIK bir dosya
//       adi gecmeli (ornek: "index.html", "config.json"). Bu dil-bagimsizdir:
//       hangi dilde yazarsa yazsin "index.html" ifadesi degismez.
//   (B) Fenced code block gercek dosya icerigi gibi olmali:
//       - Path listesi DEGIL
//       - Shell output DEGIL
//       - <details>/<summary> gibi render container icinde DEGIL
//   (C) Onceki asistant turunda bash/glob/grep calistirilmis ise, bu turdaki
//       fenced block MUHTEMELEN o tool'un output'udur. Bu durumda Write
//       sentezlemeyiz -- kullanicinin yeni bir Write istegi yoksa.
//       Istisna: kullanicinin son mesajinda acik bir dosya adi varsa ve
//       fenced block path-listing olmadigi gibi shell-output da degilse,
//       bu kullanicinin (tool sonrasi) yeni bir create talebi olabilir.

function trySynthesizeWrite(modelText, userText, toolRegistry, requestBody) {
  const allBlocks = extractAllFencedBlocks(modelText);
  if (allBlocks.length === 0) return [];

  // Render container icinde OLMAYAN ve shell/listing OLMAYAN ilk block'u bul.
  const candidateBlock = allBlocks.find((block) =>
    !isFencedBlockInsideRenderContainer(modelText, block.index) &&
    !looksLikeShellOutput(block.content) &&
    block.content.trim().length > 0
  );
  if (!candidateBlock) return [];

  const writeTool = findToolInRegistry(toolRegistry, 'write');
  if (!writeTool) return [];

  // Kullanicinin mesajinda ACIK bir dosya adi var mi?
  // Bu dil-bagimsiz: "oluştur index.html" veya "make index.html" veya
  // "生成 index.html" hepsi icin "index.html" match eder.
  const userFilename = extractFilenameFromText(userText);

  // Onceki turda kesif tool'u kullanildi mi?
  const priorExploration = lastTurnWasExplorationTool(requestBody);

  // Kullanicinin acik dosya adi YOK ve model yeni bir Write tool_use
  // uretmediyse: bu muhtemelen bir yazma talebi degildir. BLOK.
  if (!userFilename) {
    // Model metninde (block dışında) dosya adi varsa belki modelin "dosya X'i
    // yaziyorum" niyeti vardir. Ancak bu da bir yazma niyeti garantisi degil.
    // GUVENLI davranis: sentez yapma.
    // ISTISNA: ilk tur ve upstream modelden hic history yok (pure tek-sefer
    // generation) ise ve kullanicinin metninde bir dosya adi varsa, buradaki
    // fenced block gercekten content olabilir. Ama o durumda zaten userFilename
    // match edecegi icin bu dal devreye girmez.
    return [];
  }

  // Kesif sonrasi turda ve kullanicinin yeni bir yazma talebi YOK (yani bu
  // kullanicinin son mesaji "incele X" / "analyze X" turunden olabilir, dosya
  // adi X geciyor ama write istemedi). Risk: yanlis uzerine yazma. Dile
  // bagimsiz sekilde bunu tespit edemeyiz, o yuzden:
  //   - Eger kullanicinin son mesaji kisaysa (< 120 char) ve sadece dosya adi
  //     + birkaç kelimeyse, muhtemelen "bu dosyayi olustur" olabilir: geç.
  //   - Kesif sonrasi ise ve userText uzunsa (query body), yanlis pozitif
  //     riski yuksek: sentezleme.
  if (priorExploration && userText.length > 200) {
    return [];
  }

  // Dosya adi: userText'teki asil, yoksa model metninin kod blogu DISINDAKI
  // kismindan, yoksa dil tahmin'den.
  let filename = userFilename;
  if (!filename) {
    const textBeforeCode = modelText.split('```')[0] ?? '';
    const textAfterCode = modelText.split('```').slice(2).join('```') ?? '';
    filename = extractFilenameFromText(textBeforeCode) ?? extractFilenameFromText(textAfterCode);
  }
  if (!filename) {
    const ext = LANG_TO_EXTENSION[candidateBlock.lang];
    if (!ext) return [];
    if (ext === 'html') filename = 'index.html';
    else if (ext === 'css') filename = 'styles.css';
    else if (ext === 'js') filename = 'index.js';
    else if (ext === 'py') filename = 'main.py';
    else if (ext === 'md') filename = 'README.md';
    else filename = `file.${ext}`;
  }

  const pathField = pickSchemaFieldName(writeTool.schema, ['file_path', 'filePath', 'path', 'file', 'filename'], 'file_path');
  const contentField = pickSchemaFieldName(writeTool.schema, ['content', 'text', 'body', 'data'], 'content');

  return [{
    id: makeToolId(),
    name: writeTool.name,
    input: {
      [pathField]: filename,
      [contentField]: candidateBlock.content
    }
  }];
}

// ---- Read sentezi (dile bagimsiz) ----
//
// Kabul kurallari:
//   (A) Model metninde EN FAZLA 1 farkli dosya adi geciyor (birden fazla
//       olunca niyet belirsiz, glob sentezine birak)
//   (B) Bu dosya adi onceki turlarda OKUNMAMIS olmali (loop koruma)
//   (C) Model bu turda zaten bir tool_use uretmemis (entrypoint garantili)

function trySynthesizeRead(modelText, requestBody, toolRegistry) {
  const readTool = findToolInRegistry(toolRegistry, 'read');
  if (!readTool) return [];

  const filenames = [...new Set(extractAllFilenamesFromText(modelText))];
  if (filenames.length !== 1) return [];

  const target = filenames[0];
  const previousReadTargets = collectPreviouslyReadTargets(requestBody);
  if (previousReadTargets.has(target.toLowerCase())) return [];

  const pathField = pickSchemaFieldName(readTool.schema, ['file_path', 'filePath', 'path', 'file', 'filename'], 'file_path');
  return [{
    id: makeToolId(),
    name: readTool.name,
    input: { [pathField]: target }
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

function assistantReadTargets(message) {
  if (!message || !Array.isArray(message?.content)) {
    return [];
  }
  return message.content
    .filter((block) => block?.type === 'tool_use' && normalizeName(block?.name) === 'read')
    .map((block) => block?.input?.file_path ?? block?.input?.filePath ?? block?.input?.path ?? block?.input?.file ?? block?.input?.filename)
    .filter((value) => typeof value === 'string' && value.trim());
}

function collectPreviouslyReadTargets(requestBody) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  const targets = new Set();
  for (const msg of messages) {
    if (msg?.role !== 'assistant') continue;
    for (const value of assistantReadTargets(msg)) {
      targets.add(String(value).trim().toLowerCase());
    }
  }
  return targets;
}

function findRecentExplorationToolResult(requestBody) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== 'user' || !Array.isArray(msg?.content)) {
      continue;
    }
    const toolResultBlocks = msg.content.filter((block) => block?.type === 'tool_result');
    if (toolResultBlocks.length === 0) {
      continue;
    }
    let previousAssistant = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (messages[j]?.role === 'assistant') {
        previousAssistant = messages[j];
        break;
      }
    }
    const toolResultText = toolResultBlocks
      .map((block) => flattenBlockText(block.content))
      .filter(Boolean)
      .join('\n');
    const categoriesInPrev = new Set();
    for (const block of previousAssistant?.content || []) {
      if (block?.type !== 'tool_use') continue;
      const norm = normalizeName(block?.name);
      for (const [cat, meta] of Object.entries(TOOL_CATEGORIES)) {
        if (meta.nameAliases.includes(norm)) categoriesInPrev.add(cat);
      }
    }
    const cameFromExplorationTool =
      categoriesInPrev.has('list') ||
      categoriesInPrev.has('bash') ||
      categoriesInPrev.has('grep') ||
      previousAssistant === null;
    if (!cameFromExplorationTool) {
      continue;
    }
    if (extractAllFilenamesFromText(toolResultText).length === 0) {
      continue;
    }
    return { toolResultText, previousAssistant };
  }
  return null;
}

// ---- List/Glob sentezi (dile bagimsiz, konservatif) ----
//
// Dile bagimsiz DETERMINISTIK kurallar. Slash-command'a bagimli degil; asil
// hedef: kullanici bir sey sordu, model sadece text donup durdu -> Glob ile
// baslayip kesif yapilsin ki client stall olmasin.
//
// Sentez tetiklenir EGER (hepsi TRUE):
//   (A) Session'in ilk veya ikinci asistant turundayiz (turns <= 1)
//   (B) Onceki turlarda hic keşif/islem yapilmadi (priorCategories bos)
//   (C) Kullanicinin (instrumentation cikariimis) metni gercekten bir niyet
//       belirtiyor (uzunluk > 2, sadece bos/whitespace degil)
//   (D) Kullanicinin metninde ACIK bir dosya adi YOK (eger var olsaydi
//       trySynthesizeRead devralirdi ya da kullanici belirli bir dosya
//       istedi, glob yerine ona yonelelim)
//   (E) Model bu turda tool_use uretmedi (zaten entrypoint garantili)
//
// Bu kadar. Slash-command veya "explore" kelimesi aramiyoruz - hepsi dile
// bagli sinyaller. Yapisal sinyal yeterli.

function trySynthesizeList(requestBody, toolRegistry, upstreamStopReason) {
  void upstreamStopReason; // kullanilmiyor; genisletilmis kural artik gerektirmiyor

  const turns = countAssistantTurns(requestBody);
  if (turns > 1) return [];

  const priorCategories = getPreviousToolCategories(requestBody);
  if (priorCategories.size > 0) return [];

  const userText = getLastUserText(requestBody);
  // Kullanicinin gercek sorusu/talebi yok? (bos ya da cok kisa)
  if (!userText || userText.trim().length < 2) return [];

  // Kullanici spesifik bir dosyadan bahsediyorsa, keşif fallback'i yanlis.
  // Read sentezi zaten bir once calisacak.
  if (extractFilenameFromText(userText)) return [];

  const listTool = findToolInRegistry(toolRegistry, 'list');
  if (!listTool) return [];

  const patternField = pickSchemaFieldName(listTool.schema, ['pattern', 'glob', 'query'], 'pattern');
  const pathField = pickSchemaFieldName(listTool.schema, ['path', 'directory', 'dir'], null);

  const input = {};
  input[patternField] = '**/*';
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

// ---- Read from tool_result (dile bagimsiz) ----
//
// Kabul kurallari:
//   (A) Yakin zamanda exploration tool_result'i var (bash/glob/grep)
//   (B) Tool_result'ta dosya adlari geciyor
//   (C) Onceki turlarda okunmamis bir dosya var
//   (D) KEY_FILE_PRIORITY'ye gore en oncelikli dosyayi sec

function trySynthesizeReadFromToolResult(requestBody, toolRegistry) {
  const readTool = findToolInRegistry(toolRegistry, 'read');
  if (!readTool) return [];

  const context = findRecentExplorationToolResult(requestBody) ?? getLastToolResultContext(requestBody);
  if (!context?.toolResultText) return [];

  const previousReadTargets = collectPreviouslyReadTargets(requestBody);
  const candidates = [...new Set(extractAllFilenamesFromText(context.toolResultText))]
    .sort((a, b) => scoreCandidateFile(b) - scoreCandidateFile(a));
  const candidate = candidates.find((value) => !previousReadTargets.has(String(value).trim().toLowerCase())) ?? null;
  if (!candidate) {
    return [];
  }

  const pathField = pickSchemaFieldName(readTool.schema, ['file_path', 'filePath', 'path', 'file', 'filename'], 'file_path');
  return [{
    id: makeToolId(),
    name: readTool.name,
    input: { [pathField]: candidate }
  }];
}
