import crypto from 'node:crypto';
import process from 'node:process';

import { synthesizeToolCallsFromIntent } from './intent-synthesis.js';

// Parallel tool call collapse:
// Upstream modeller bazen tek turda 5-6 benzer bash tool_use'u birden atiyor.
// Anthropic istemcileri bunlari paralel calistirir; biri fail ederse digerleri
// "parallel tool call errored" ile iptal olur ve sistem kilitlenir. Default olarak
// proxy ayni turda ayni tool'a birden fazla call geldiyse sadece ilkini birakir.
// Modelin komutlarinin icerigi HIC degisitirilmez; sadece paralellik kaldirilir.
// Kapatmak icin: COLLAPSE_PARALLEL_TOOL_CALLS=0
const COLLAPSE_PARALLEL_TOOL_CALLS = process.env.COLLAPSE_PARALLEL_TOOL_CALLS !== '0';

// Model-agnostik chain-of-thought temizligi icin hardcoded regex yok.
// stripNonHtmlStructuredBlocks butun bilinmeyen XML-like tag bloklarini
// temizler (think/thinking/reasoning/scratchpad/planning/rationale/...).
// <details>...</details> - HTML collapsible container. Modeller bazen kendi
// "explore ediyorum / dosyayi okuyorum" narration'ini bunun icine gomuyor.
// Eger icerik sadece duz metin (kod, tablo, liste degil) ise proxy temizler.
const TOOL_BLOCK_RE = /<tool_call>([\s\S]*?)(?=(?:<tool_call>|$))/gi;
const ARG_VALUE_RE = /<arg_value>([\s\S]*?)(?=<\/arg_value>|$)/gi;
const ARG_KEY_RE = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>/i;
const ATTR_RE = /([A-Za-z_][\w-]*)="([^"]*)"/g;
const FENCED_JSON_RE = /```json\s*([\s\S]*?)```/gi;
const FENCED_CODE_BLOCK_RE = /```([a-zA-Z0-9_+#-]*)\s*\n([\s\S]*?)```/i;
const FENCED_BASH_RE = /```bash\s*([\s\S]*?)```/gi;
const FILE_WRITE_BLOCK_RE = /<file:\/\/([^>\n]+)>\s*```[a-zA-Z0-9_-]*\s*([\s\S]*?)```[\s\S]*?<\/file-to-write>/gi;
const XML_TOOL_NAME_RE = /<tool_name>\s*([\s\S]*?)\s*<\/tool_name>/i;
const XML_ARGUMENTS_RE = /<arguments>\s*([\s\S]*?)\s*<\/arguments>/i;
const XML_PARAMETERS_RE = /<parameters>\s*([\s\S]*?)\s*<\/parameters>/i;
const XML_SERVER_NAME_RE = /<server_name>\s*([\s\S]*?)\s*<\/server_name>/i;
const ANGLE_TOOL_LINE_RE = /^([A-Za-z_][\w-]*)>([\s\S]+?)(?:<\/\1>)?$/;
const TOOL_NAME_ALIASES = {
  bash: ['bash', 'runcommand', 'command', 'shell', 'terminal', 'exec', 'ls', 'pwd', 'find', 'head', 'tail', 'sed', 'awk', 'wc', 'sort', 'uniq', 'echo'],
  read: ['read', 'readfile', 'readfilecontents', 'read_file', 'read_file_contents', 'openfile', 'cat'],
  write: ['write', 'writefile', 'writefilecontents', 'createfile', 'savefile'],
  delete: ['delete', 'deletefile', 'delete_file', 'removefile', 'unlink'],
  edit: ['edit', 'editfile', 'updatefile', 'replaceinfile', 'applypatch', 'multiedit'],
  glob: ['glob', 'findfiles', 'searchfilesbyname', 'listdirectory', 'list_directory'],
  grep: ['grep', 'search', 'contentsearch', 'ripgrep'],
  webfetch: ['webfetch', 'fetchurl', 'fetchwebpage'],
  task: ['task', 'subagent', 'delegate'],
  question: ['question', 'askuser'],
  skill: ['skill', 'loadskill'],
  todowrite: ['todowrite', 'updatetodo'],
  todoread: ['todoread', 'readtodo']
};
const META_TOOL_TOKENS = new Set(['tooluse', 'tooluseinput', 'toolcall', 'functioncall', 'function', 'plaintext']);
const SHELL_COMMAND_ALIASES = new Set([
  'ls',
  'cat',
  'pwd',
  'find',
  'head',
  'tail',
  'sed',
  'awk',
  'wc',
  'sort',
  'uniq',
  'echo'
]);
const ARG_SYNONYMS = {
  command: ['cmd', 'script', 'shell_command', 'shellCommand', 'bash'],
  description: ['desc', 'summary', 'purpose', 'reason'],
  prompt: ['instruction', 'query', 'task', 'message'],
  subagent_type: ['subagent', 'subagentType', 'agent', 'agent_type', 'type'],
  file_path: ['filePath', 'path', 'file', 'filename', 'filepath', 'absolutePath'],
  filePath: ['path', 'file', 'filename', 'filepath', 'absolutePath'],
  old_string: ['oldString', 'old', 'find', 'search', 'oldText', 'searchText'],
  oldString: ['old', 'find', 'search', 'oldText', 'searchText'],
  new_string: ['newString', 'new', 'replace', 'replacement', 'newText', 'replaceText'],
  newString: ['new', 'replace', 'replacement', 'newText', 'replaceText'],
  content: ['text', 'data', 'body', 'newContent'],
  pattern: ['glob', 'query', 'regex'],
  include: ['filePattern', 'files'],
  offset: ['line', 'startLine'],
  limit: ['count', 'maxLines']
};

function parseJsonSafe(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeName(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isMetaToolToken(value) {
  return META_TOOL_TOKENS.has(normalizeName(value));
}

function splitConcatenatedToolToken(rawToken) {
  const token = String(rawToken ?? '').trim();
  if (!token) {
    return null;
  }
  const bashMatch = token.match(/^(bash)(.+)$/i);
  if (!bashMatch) {
    return null;
  }
  const remainder = bashMatch[2]?.trim();
  if (!remainder) {
    return null;
  }
  return {
    name: 'bash',
    remainder
  };
}

function buildToolRegistry(requestBody) {
  const registry = new Map();
  const rawTools = Array.isArray(requestBody?.tools) ? requestBody.tools : [];

  for (const tool of rawTools) {
    const anthropicName = tool?.name;
    const openAiName = tool?.function?.name;
    const name = typeof anthropicName === 'string' ? anthropicName : openAiName;
    if (!name) {
      continue;
    }

    const anthropicSchema = tool?.input_schema;
    const openAiSchema = tool?.function?.parameters;
    const schema = anthropicSchema && typeof anthropicSchema === 'object' ? anthropicSchema : openAiSchema;
    registry.set(name, {
      name,
      normalized: normalizeName(name),
      schema: schema && typeof schema === 'object' ? schema : {}
    });
  }

  return registry;
}

function findPropertyValue(input, propName) {
  if (input[propName] !== undefined) {
    return input[propName];
  }
  for (const alias of ARG_SYNONYMS[propName] ?? []) {
    if (input[alias] !== undefined) {
      return input[alias];
    }
  }
  return undefined;
}

function synthesizeDescription(command) {
  const clean = String(command ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) {
    return undefined;
  }
  const truncated = clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
  return `Runs command: ${truncated}`;
}

function normalizeEscapedPath(value) {
  if (typeof value !== 'string') {
    return value;
  }
  return /^[A-Za-z]:\\\\/.test(value) ? value.replace(/\\\\/g, '\\') : value;
}

function looksLikePath(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return /^[./~]/.test(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed) || /^\\\\/.test(trimmed);
}

function looksLikeFileReference(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return looksLikePath(trimmed) || /^(?:[\w.-]+[\\/])*[\w.-]+\.[A-Za-z0-9]{1,12}$/.test(trimmed);
}

// Upstream modeller bazen UI render artefact'larini (Claude Code, ChatGPT gibi
// istemcilerin gosterdigi label'lari) komutun icine yapistiriyor. Ornek:
//   "find . -type f | head -50(fetching file listing)"
//   "ls -la(running command)"
// Bu bash tarafinda syntax error (exit 2) uretir ve tool loop'unu oldurur.
// Asagidaki UI_LABEL_SUFFIX_RE komutun en sonundaki bu tarz parantezli label'lari
// agresif sekilde temizler. Legitimate $(subshell) veya komut gruplari etkilenmez:
//   - sadece komut SONUNDA
//   - parantez icinde whitespace'li ingilizce kelime(ler) olan
//   - ve icinde shell meta karakter ($,`,;,&,|,>,<) GECMEYEN bloklari keser.
const UI_LABEL_SUFFIX_RE = /\s*\((?:fetching|running|reading|writing|listing|searching|executing|loading|processing|analyzing|generating|creating|updating|deleting|editing|saving|opening|closing|finding|parsing|scanning|downloading|uploading|checking|installing|building|compiling|testing|runs|view|edit|write|read|fetch)\b[^()$`;&|<>]*\)\s*$/i;
const INSTRUMENTATION_TAG_RE = /<\/?(?:command[_-]message|system[_-]reminder|local[_-]command(?:[_-]std(?:out|err))?|command[_-]std(?:out|err)|user[_-]message|assistant[_-]message|tool[_-]output|claude[_-]instructions)[^>]*>/gi;
const INSTRUMENTATION_BLOCK_RE = /\n?\s*<(?:command[_-]message|system[_-]reminder|local[_-]command(?:[_-]std(?:out|err))?|command[_-]std(?:out|err)|user[_-]message|assistant[_-]message|tool[_-]output|claude[_-]instructions)[^>]*>[\s\S]*$/i;
const GENERIC_COMMAND_TAG_RE = /<\/?command[^>]*>/gi;
const LEADING_SINGLE_DASH_CMD_RE = /^-([A-Za-z][\w.-]*)(\s|$)/;
// Bazi zayif modeller komutun basina anlamsiz karakter bastiriyor:
//   '_ cat index.html'  -> bash: _: command not found
//   '. cat index.html'  -> bash: '.cat': ... (source benzeri)
//   ': cat index.html'  -> : komutu shell'de no-op ama args degerlendirilmez
// Bu prefix'leri temizle. Hedef karakterler: _, :, ., -, # (shell'de anlamsiz
// veya yanlis sonuc uretenler). Sadece SONRASINDA whitespace + harf geliyorsa
// eshlesir (ornek: '_ cat' eslesir, '_foo' eslesmez - _foo legitimate olabilir).

// Upstream bazen komutun ONUNE de UI dump'ini yapistiriyor:
//   "Bash Runs command: ls -la\nIN\nls -la\nOUT\nExit code 2\n..."
// Bu bloklari parse edip gercek komutu cikartmak yerine, tanidik
// "IN\n" / "> " gibi UI prefix'lerini temizle; ilk satir komut degilse
// son "IN" bloku sonrasini komut olarak kabul et.
function stripCommandUiWrapping(value) {
  if (typeof value !== 'string' || !value) {
    return value;
  }
  let text = value;
  // "Bash Runs command: ..." / "Runs command: ..." prefix
  text = text.replace(/^(?:Bash\s+)?Runs?\s+command:\s*/i, '');
  // "IN\n<command>\nOUT\n..." -> sadece IN ile OUT arasini al
  const inOutMatch = text.match(/(?:^|\n)IN\s*\n([\s\S]*?)(?:\n(?:OUT|Exit code|\$)\b|$)/i);
  if (inOutMatch && inOutMatch[1]) {
    text = inOutMatch[1];
  }
  // Baslangictaki "> " prompt isaretleri
  text = text.replace(/^\s*\$\s+/, '').replace(/^\s*>\s+/, '');
  return text;
}

function sanitizeCommand(value) {
  if (typeof value !== 'string') {
    return value;
  }
  let out = stripCommandUiWrapping(value)
    .replace(/[^\x09\x0A\x0D\x20-\x7E]+/g, '')
    .replace(INSTRUMENTATION_BLOCK_RE, '')
    .replace(INSTRUMENTATION_TAG_RE, '')
    .replace(GENERIC_COMMAND_TAG_RE, '')
    // Model-agnostik: HERHANGI bir non-HTML kapanis tag'i (</think>,
    // </reasoning>, </bash>, </tool_use>, ...) ve sonrasini sil - bunlar
    // komut degil, generator frame artifact'i.
    .replace(/<\/([a-zA-Z_][\w-]*)>[\s\S]*$/, (match, tagName) => {
      return isLegitimateCloseTag(tagName) ? match : '';
    })
    // Ayni sekilde proxy'nin kendi tool-call parse artifactleri
    .replace(/<\/?parameter>/gi, '')
    .replace(/<\/?arg_value>/gi, '')
    .replace(/<\/?tool_call>/gi, '')
    .replace(/<\/[A-Za-z_][\w-]*>$/g, '')
    .replace(/<\/$/g, '')
    .replace(/[A-Za-z][A-Za-z0-9_-]*>$/g, '')
    .replace(/^>\s*/, '');
  // UI label suffix temizligi: birden fazla kez gelebilir ("... | head -50(fetching file listing)(running)")
  let prev;
  do {
    prev = out;
    out = out.replace(UI_LABEL_SUFFIX_RE, '');
  } while (out !== prev);
  out = out.replace(LEADING_SINGLE_DASH_CMD_RE, '$1$2');
  // Leading stray prefix temizligi: '_ cat x' -> 'cat x', '. foo' -> 'foo'
  out = out.replace(/^[_:.#]\s+(?=[A-Za-z])/, '');
  // Leading fake prompt prefix: 'wise> cat x', 'bash> ls', 'shell> foo',
  // 'prompt> ...' seklinde model'in hayali shell prompt'u bashe karismasin.
  // Pattern: tek kelimelik ad + '>' + bosluk + gercek komut. Gercek komut
  // adlari whitelist: 'cat', 'ls', 'find', 'grep', 'head', 'tail', 'echo',
  // 'pwd', 'cd', 'mv', 'cp', 'rm', 'mkdir', 'which', 'git', 'node', 'npm',
  // 'npx', 'python', 'wget', 'curl'... whitelisted tanidik komutlar.
  const promptPrefixMatch = out.match(/^[A-Za-z][\w-]*>\s+((?:cat|ls|find|grep|rg|head|tail|echo|pwd|cd|mv|cp|rm|mkdir|which|git|node|npm|npx|yarn|pnpm|python|python3|pip|wget|curl|sed|awk|jq|xargs|tree|file|stat|du|df|env|export|source|type|less|more|bat|nl|view)\b[\s\S]*)$/i);
  if (promptPrefixMatch) {
    out = promptPrefixMatch[1];
  }
  // Parantezli grup commands: '(cat x.html)' -> 'cat x.html'; sadece tam
  // dis parantez'e sarmalanmissa ve icinde dengesiz paranteze yol acmayacaksa.
  const parenMatch = out.match(/^\((.+)\)$/);
  if (parenMatch && !/[()]/.test(parenMatch[1])) {
    out = parenMatch[1];
  }
  return out.trim();
}

function sanitizeToolInputString(value) {
  if (typeof value !== 'string') {
    return value;
  }
  return sanitizeCommand(value)
    .replace(/<\/[A-Za-z_][\w-]*>$/g, '')
    .replace(/<\/$/g, '')
    .trim();
}

// Path field'ler icin: leading `./` ve `.\\` kaldir, trailing slash temizle,
// backtick ve tirnak temizligi. Bazi istemcilerin (OpenCode Zod) validator'i
// leading `./`'i reddediyor ("Write failed"). Relative path olarak istenen
// filename direkt verilmeli.
function normalizePathForTool(value) {
  if (typeof value !== 'string') return value;
  let out = value.trim();
  // Kucuk backtick/tirnak temizligi
  out = out.replace(/^[`'"]+|[`'"]+$/g, '').trim();
  // Trailing XML-like close tag artifact: 'manifest.json</Read>' veya
  // 'index.html</Tool>' -> model tool frame'ini path alanina sizdirmis.
  // Sadece path'in SONUNDAKI close tag'i temizle.
  out = out.replace(/<\/[A-Za-z_][\w:-]*>\s*$/, '').trim();
  // Trailing open-angle artifact (bazen '<' tek basina kalabiliyor)
  out = out.replace(/[<>]+\s*$/, '').trim();
  // Windows backslash escape
  if (/^[A-Za-z]:\\\\/.test(out)) out = out.replace(/\\\\/g, '\\');
  // Leading './' veya '.\\'
  out = out.replace(/^\.[\\/]+/, '');
  return out;
}

// Schema-aware default filler. Istemciler (OpenCode, Claude Code, Cursor)
// arasinda schema'lar farkli olabilir. Ornegin OpenCode `bash` icin `timeout`
// (number, required) bekler, Claude Code beklemez. Zayif modeller bu ekstra
// field'lari gondermezse "invalid_type" hatasi aliniyor.
//
// Bu fonksiyon schema'daki `required` listesine bakar; model'in bos biraktigi
// her required field icin MAKUL bir default atar. Sadece basit tiplerde
// (string, number, boolean, array, object). Kompleks nested schema'lara
// dokunmaz. Dil-bagimsiz, istemci-agnostik.
function fillSchemaRequiredDefaults(result, properties, required, normalizedToolName) {
  if (!Array.isArray(required) || required.length === 0) return;
  if (!properties || typeof properties !== 'object') return;

  for (const fieldName of required) {
    if (result[fieldName] !== undefined && result[fieldName] !== null && result[fieldName] !== '') continue;

    const fieldSchema = properties[fieldName];
    if (!fieldSchema || typeof fieldSchema !== 'object') continue;

    const fieldType = fieldSchema.type;
    const fieldDefault = fieldSchema.default;

    // Eger schema'da default tanimli ise onu kullan
    if (fieldDefault !== undefined) {
      result[fieldName] = fieldDefault;
      continue;
    }

    // Tool-specific makul default'lar (field adina gore)
    const smartDefault = pickSmartDefault(normalizedToolName, fieldName, fieldType);
    if (smartDefault !== undefined) {
      result[fieldName] = smartDefault;
      continue;
    }

    // Primitive tip default'lar
    if (fieldType === 'string') {
      result[fieldName] = '';
    } else if (fieldType === 'number' || fieldType === 'integer') {
      result[fieldName] = 0;
    } else if (fieldType === 'boolean') {
      result[fieldName] = false;
    } else if (fieldType === 'array') {
      result[fieldName] = [];
    } else if (fieldType === 'object') {
      result[fieldName] = {};
    }
  }
}

// Field adi ve tool'a gore makul default'lar. Bu list dile-bagimsiz, standart
// tool alanlarinin yaygin kullanimlarina dayanir.
function pickSmartDefault(normalizedToolName, fieldName, fieldType) {
  const lowerField = String(fieldName).toLowerCase();

  // Bash tool: timeout field'i (OpenCode icin zorunlu)
  if (normalizedToolName === 'bash') {
    if (lowerField === 'timeout') return 30000; // 30 saniye makul
    if (lowerField === 'workdir' || lowerField === 'cwd' || lowerField === 'directory') return '.';
    if (lowerField === 'description') return 'Run command';
    if (lowerField === 'run_in_background' || lowerField === 'background') return false;
  }

  // Glob: pattern required oldugunda
  if (normalizedToolName === 'glob') {
    if (lowerField === 'pattern' || lowerField === 'glob') return '**/*';
    if (lowerField === 'path' || lowerField === 'directory') return '.';
    if (lowerField === 'limit' || lowerField === 'maxresults' || lowerField === 'max_results') return 100;
  }

  // Grep
  if (normalizedToolName === 'grep') {
    if (lowerField === 'path' || lowerField === 'directory') return '.';
    if (lowerField === 'include' || lowerField === 'glob') return '**/*';
    if (lowerField === 'limit' || lowerField === 'maxresults' || lowerField === 'max_results') return 100;
    if (lowerField === 'case_sensitive' || lowerField === 'casesensitive') return false;
  }

  // Read / Write / Edit: path'ler icin bilinen default yok (model vermeli).
  // Ama offset/limit gibi pagination field'lari varsayilan ayarlanabilir.
  if (normalizedToolName === 'read') {
    if (lowerField === 'offset') return 0;
    if (lowerField === 'limit' || lowerField === 'maxlines' || lowerField === 'max_lines') return 2000;
  }

  // Webfetch
  if (normalizedToolName === 'webfetch') {
    if (lowerField === 'format') return 'markdown';
    if (lowerField === 'timeout') return 30;
  }

  return undefined;
}

function sanitizeToolText(value) {
  if (typeof value !== 'string') {
    return value;
  }
  let out = value;

  // Stray non-HTML KAPANIS tag'leri (acilisi olmayan). Ornek: '</tool_use_error>'
  // peşi sıra tekrar eden durumlar. Model chain-of-thought sinyali olarak
  // bunlari bassiyor ama text'in normal parcasi degil. Bu pattern dile
  // bagimsiz yapisal: non-HTML kapanis etiketi + ardisik tekrar.
  out = out.replace(/(?:\s*<\/([a-zA-Z][\w-]*)>\s*)+/g, (match, firstTag) => {
    if (isLegitimateCloseTag(firstTag)) return match;
    // Non-HTML kapanis tag'i (tek veya cok), hepsini sil
    return '\n';
  });

  out = out
    // Ardisik "tool_use>" veya "tool_use" stray token'lari (bazen \n\n aralikli
    // geliyor, bazen tek satir). Once multi-occurrence sonra tek satir kalinti.
    .replace(/(?:(?:^|\n)\s*tool_use>?\s*){2,}(?=\n|$)/gi, '\n')
    .replace(/^\s*tool_use>\s*$/gim, '')
    .replace(/^\s*tool_use\s*$/gim, '')
    .replace(/^tool_use_input>\s*$/gim, '')
    .replace(/^<server_name>\s*filesystem\s*<\/server_name>\s*$/gim, '')
    .replace(/^\{"name":\s*$/gim, '')
    // Pseudo-tool-call notasyonu: 'tool_use tool="Bash" command="ls">' veya
    // 'tool_use tool="Read" file_path="x">'. Model'in kendi iç monologu -
    // gercek tool_use'u zaten yan taraftan geliyor veya ayri turda. Yapisal
    // pattern: tool_use + attribute'lar + optional '>'.
    .replace(/tool_use\s+tool\s*=\s*["'][^"']+["'](?:\s+\w+\s*=\s*["'][^"']*["'])*\s*>?/gi, '')
    // <content> XML tag'leri - bazi zayif modeller prompt format'indan dolayi
    // bu tag'i cevaplarina sizdiriyor. Acilis/kapanis ikisi de temizlenir.
    // Dile bagimsiz: sadece tag yapisina bakar, icerik korunur.
    .replace(/<\/?content>\s*/gi, '');

  out = out
    // Model-agnostik tool-call dump temizligi: bazi zayif modeller native
    // tool_use yerine text'e "ToolCall inputs: {...}" veya "Function call:
    // {...}" tarzi bir DEBUG LINE basiyor. Bu kullanicinin gormemesi gereken
    // ic sinyaldir - tool zaten sonraki tool_use bloguyla cagriliyor veya
    // syntesize ediliyor. Yapisal pattern: <prefix> + 'inputs'/'arguments'/
    // 'parameters'/'args' + ':' + ' ' + '{...}'. Case-insensitive.
    .replace(/^\s*(?:tool[_ -]?call|function[_ -]?call|tool[_ -]?use|invoke|action)[ _-]?(?:inputs?|arguments?|params?|parameters?|args)\s*:\s*\{[\s\S]*?\}\s*$/gim, '')
    // Ayni sekilde satiri "Function call:" ile baslayan JSON dump'lari
    .replace(/^\s*(?:tool[_ -]?call|function[_ -]?call|tool[_ -]?use|invoke)\s*:\s*\{[\s\S]*?\}\s*$/gim, '')
    // Cok sayida bos satiri teke indir
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return out;
}

function shellQuote(value) {
  const text = String(value ?? '');
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function extractPathFromCatCommand(value) {
  const command = sanitizeCommand(value);
  if (typeof command !== 'string' || !command) {
    return undefined;
  }

  const match = command.match(/^cat\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+|$)/);
  return normalizeEscapedPath(match?.[1] ?? match?.[2] ?? match?.[3]);
}

function coerceToolInput(toolName, input, schema) {
  const normalizedToolName = normalizeName(toolName);
  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const result = { ...(input && typeof input === 'object' && !Array.isArray(input) ? input : {}) };

  for (const propName of Object.keys(properties)) {
    if (result[propName] !== undefined) {
      continue;
    }
    const value = findPropertyValue(result, propName);
    if (value !== undefined) {
      result[propName] = value;
    }
  }

  for (const propName of ['file_path', 'filePath', 'path', 'pattern', 'file', 'filename', 'source', 'destination', 'old_string', 'new_string', 'oldString', 'newString', 'search', 'find', 'replace', 'replacement']) {
    if (typeof result[propName] === 'string') {
      result[propName] = sanitizeToolInputString(result[propName]);
    }
  }
  // Path field'ler icin leading './' strip + tirnak temizligi.
  // Pattern (glob) ve search/find (grep) DAHIL DEGIL - bunlar regex veya
  // glob pattern, './' anlami farkli olabilir.
  for (const propName of ['file_path', 'filePath', 'path', 'file', 'filename', 'source', 'destination']) {
    if (typeof result[propName] === 'string') {
      result[propName] = normalizePathForTool(result[propName]);
    }
  }

  if (normalizedToolName === 'bash') {
    if (!result.command && !result.value && !result.arguments && Object.keys(result).length > 0) {
      const firstValue = Object.values(result)[0];
      if (typeof firstValue === 'string') {
        result.command = firstValue;
      }
    }
    result.command = sanitizeCommand(result.command ?? result.value ?? result.arguments ?? '');
    if (!result.command) {
      result.command = '';
    }
    result.description = result.description ?? synthesizeDescription(result.command) ?? 'Bash command';
  }

  // Schema-aware default filler (client-agnostik):
  // Bazi istemciler (OpenCode Zod) `bash` icin `timeout` (number), `workdir`
  // (string) gibi ekstra required field'lar bekliyor. Model bunlari gondermezse
  // "invalid_type" hatasi aliyoruz. Proxy schema'yi okuyup required field'lara
  // makul default doldurur. Sadece schema'da required olan field'lar icin.
  fillSchemaRequiredDefaults(result, properties, required, normalizedToolName);

  if (normalizedToolName === 'read' || normalizedToolName === 'edit') {
    const catPath = extractPathFromCatCommand(result.command ?? result.value ?? result.arguments);
    const pathFromCmd = catPath ?? (result.command && looksLikePath(result.command) ? result.command : null);
    result.filePath = normalizeEscapedPath(result.filePath ?? result.file_path ?? result.value ?? pathFromCmd ?? result.path ?? result.file ?? result.filename);
    result.file_path = normalizeEscapedPath(result.file_path ?? result.filePath ?? result.value ?? pathFromCmd ?? result.path ?? result.file ?? result.filePath);
    result.path = normalizeEscapedPath(result.path ?? result.file_path ?? result.filePath);
    if (normalizedToolName === 'read' && isBogusReadTarget(result.filePath ?? result.file_path ?? result.path ?? result.value)) {
      delete result.filePath;
      delete result.file_path;
      delete result.path;
    }
    if (normalizedToolName === 'edit') {
      result.oldString = result.oldString ?? result.old ?? result.search ?? result.find ?? result.oldstring ?? result.old_text;
      result.newString = result.newString ?? result.new ?? result.replace ?? result.replacement ?? result.newtext ?? result.new_string;
      result.old_string = result.old_string ?? result.oldString;
      result.new_string = result.new_string ?? result.newString;
    }
  }

  if (normalizedToolName === 'glob' || normalizedToolName === 'grep') {
    result.pattern = result.pattern ?? result.value;
  }

  if (normalizedToolName === 'glob' && result.pattern === undefined && typeof result.path === 'string') {
    const base = result.path.replace(/[\\/]+$/, '');
    result.pattern = base === '.' ? '*' : `${base}/*`;
  }

  if ((normalizedToolName === 'write' || normalizedToolName === 'edit') && result.filePath === undefined) {
    result.filePath = normalizeEscapedPath(result.file_path ?? result.path ?? result.file ?? result.filename ?? (looksLikeFileReference(result.value) ? result.value : undefined));
  }

  if (normalizedToolName === 'write' || normalizedToolName === 'edit') {
    result.file_path = normalizeEscapedPath(result.file_path ?? result.filePath ?? result.path ?? result.file ?? result.filename ?? (looksLikeFileReference(result.value) ? result.value : undefined));
  }

  if (normalizedToolName === 'write' && result.content === undefined) {
    if (result.value && !looksLikeFileReference(result.value)) {
      result.content = result.value;
    } else {
      result.content = result.content ?? result.text ?? result.body ?? result.value ?? '';
    }
  }

  if (normalizedToolName === 'write') {
    result.filePath = normalizeEscapedPath(result.filePath ?? result.file_path ?? result.path ?? result.file ?? result.filename);
    result.file_path = normalizeEscapedPath(result.file_path ?? result.filePath);
    if (result.content === undefined || result.content === '') {
      result.content = result.content ?? result.text ?? result.body ?? result.value ?? '';
    }
  }

  if (normalizedToolName === 'edit') {
    result.oldString = result.oldString ?? result.search ?? result.find ?? '';
    result.newString = result.newString ?? result.replace ?? result.replacement ?? '';
    result.old_string = result.old_string ?? result.oldString ?? result.search ?? result.find;
    result.new_string = result.new_string ?? result.newString ?? result.replace ?? result.replacement;
  }

  if (normalizedToolName === 'task') {
    if (!result.description) {
      result.description = result.description ?? result.task ?? (typeof result.value === 'string' ? result.value : undefined) ?? 'Delegates work to a subagent';
    }
    if (!result.prompt) {
      result.prompt = result.prompt ?? result.description;
    }
    if (!result.subagent_type) {
      result.subagent_type = result.subagent_type ?? 'general';
    }
  }

  if (Object.keys(properties).length > 0 && result.value !== undefined) {
    const stringProps = Object.entries(properties)
      .filter(([, prop]) => prop?.type === 'string')
      .map(([name]) => name);
    if (stringProps.length === 1 && result[stringProps[0]] === undefined) {
      result[stringProps[0]] = result.value;
    }
  }

  for (const propName of required) {
    if (result[propName] === undefined && propName === 'description' && result.command) {
      result[propName] = synthesizeDescription(result.command);
    }
  }

  if (Object.keys(properties).length > 0 && schema?.additionalProperties === false) {
    const filtered = {};
    for (const propName of Object.keys(properties)) {
      if (result[propName] !== undefined) {
        filtered[propName] = result[propName];
      }
    }
    // Read/Write/Edit tool'larinda path alias'lari birlikte korunmali.
    // Bazi istemciler filePath isterken bazilari file_path bekliyor.
    if (normalizedToolName === 'read' || normalizedToolName === 'write' || normalizedToolName === 'edit') {
      for (const alias of ['filePath', 'file_path', 'path']) {
        if (result[alias] !== undefined) {
          filtered[alias] = result[alias];
        }
      }
    }
    if (normalizedToolName === 'edit') {
      for (const alias of ['oldString', 'old_string', 'newString', 'new_string']) {
        if (result[alias] !== undefined) {
          filtered[alias] = result[alias];
        }
      }
    }
    return filtered;
  }

  return result;
}

function simplifyArgCarrierName(name) {
  return String(name ?? '')
    .replace(/<\/?arg_key>/gi, '')
    .replace(/<\/?tool_call>/gi, '')
    .trim();
}

function combineFragmentedToolCalls(toolCalls) {
  const merged = [];
  const carrierNames = new Set(['command', 'file', 'filepath', 'file_path', 'path', 'pattern', 'content', 'old_string', 'new_string', 'oldstring', 'newstring', 'prompt', 'description']);

  for (const toolCall of toolCalls) {
    const simplified = normalizeName(simplifyArgCarrierName(toolCall.name));
    const last = merged[merged.length - 1];
    const lastInputKeys = last ? Object.keys(last.input ?? {}) : [];
    const isCarrier = carrierNames.has(simplified);

    if (last && isCarrier) {
      const carrierValue = toolCall.input?.value ?? toolCall.input?.arguments ?? toolCall.input;
      last.input = {
        ...last.input,
        [simplified]: carrierValue
      };
      continue;
    }

    if (last && lastInputKeys.length === 0 && toolCall.input && Object.keys(toolCall.input).length > 0 && !isCarrier) {
      merged.push(toolCall);
      continue;
    }

    merged.push({
      ...toolCall,
      name: simplifyArgCarrierName(toolCall.name)
    });
  }

  return merged;
}

function hasAnyDefinedValue(input) {
  if (!input || typeof input !== 'object') return false;
  for (const value of Object.values(input)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return true;
  }
  return false;
}

function dropEmptyBrokenToolCalls(toolCalls) {
  return toolCalls.filter((toolCall) => {
    const normalized = normalizeName(toolCall.name);
    const input = toolCall.input && typeof toolCall.input === 'object' ? toolCall.input : {};
    if (isMetaToolToken(normalized)) {
      return false;
    }
    // Upstream sometimes emits tool_use blocks with completely empty OR
    // all-undefined/empty-string inputs (especially glm-5 style weak models).
    // Check VALUES, not just keys: coerceToolInput fills synonym fields with
    // undefined, so Object.keys length can be >0 yet nothing is actually set.
    if ((normalized === 'bash' || normalized === 'read' || normalized === 'glob' || normalized === 'grep' || normalized === 'skill' || normalized === 'delete' || normalized === 'write' || normalized === 'edit') && !hasAnyDefinedValue(input)) {
      return false;
    }
    if (normalized === 'bash' && !input.command && !input.value && !input.arguments) {
      return false;
    }
    if (normalized === 'bash' && typeof input.command === 'string' && isBogusBashCommand(input.command)) {
      return false;
    }
    if (normalized === 'read') {
      const readTarget = input.file_path ?? input.filePath ?? input.path ?? input.value ?? input.arguments;
      if (isBogusReadTarget(readTarget)) {
        return false;
      }
      // Read without ANY path-like value is useless and causes client validation errors.
      if (typeof readTarget !== 'string' || readTarget.trim() === '') {
        return false;
      }
    }
    if (normalized === 'glob') {
      const globPattern = input.pattern ?? input.glob ?? input.query ?? input.value;
      if (typeof globPattern !== 'string' || globPattern.trim() === '') {
        // Glob without pattern is useless; let intent synthesis fill it later.
        return false;
      }
    }
    if (normalized === 'grep') {
      const grepPattern = input.pattern ?? input.query ?? input.regex ?? input.value;
      if (typeof grepPattern !== 'string' || grepPattern.trim() === '') {
        return false;
      }
    }
    if (normalized === 'write') {
      const writePath = input.file_path ?? input.filePath ?? input.path ?? input.file ?? input.filename;
      if (typeof writePath !== 'string' || writePath.trim() === '') {
        return false;
      }
      // Bos content ile Write: model path verdi ama icerik uretemedi.
      // Bunu disari cikarmak yanlis cunku dosyanin uzerine BOS yazar (var
      // olan icerigi siler). Proxy'nin bu tool_use'u drop etmesi en guvenli:
      // model bir sonraki turda tekrar denesin.
      const writeContent = input.content ?? input.text ?? input.body ?? input.data;
      if (typeof writeContent !== 'string' || writeContent.length === 0) {
        return false;
      }
      // Content/path mismatch koruma: model bazen dosya adini karistirip
      // 'manifest.json' yazalim diyor ama icerige '# CLAUDE.md\n...' basiyor.
      // Bu mevcut dosyanin uzerine BASKA dosyanin icerigini ezer. Tespit:
      // content'in ilk satirinda markdown heading `# FILENAME.ext` varsa ve
      // bu filename, write path'in basename'i ile uyusmuyorsa -> drop.
      if (isContentFilenameMismatch(writePath, writeContent)) {
        return false;
      }
    }
    if (normalized === 'edit') {
      const editPath = input.file_path ?? input.filePath ?? input.path ?? input.file ?? input.filename;
      if (typeof editPath !== 'string' || editPath.trim() === '') {
        return false;
      }
    }
    if (normalized === 'delete' && !input.file_path && !input.filePath && !input.path) {
      return false;
    }
    if (normalized === 'skill' && !input.command && !input.value && !input.arguments && !input.prompt) {
      return false;
    }
    if ((normalized === 'task' || normalized === 'agent') && !input.command && !input.value && !input.arguments && !input.prompt && !input.description) {
      return false;
    }
    if (normalized === 'write' && isGenericPlaceholderValue(input.value)) {
      return false;
    }
    return true;
  });
}

// Onceki asistant turunda Write(X, content) yapildiysa, bu turda ayni
// content'in fenced block halinde text'te tekrar basilmasini temizle.
// Deterministik, dil-bagimsiz: sadece content benzerligine bakar.
//
// Neden: Zayif modeller Write tool_use'unu basariyla calistirdiktan sonra
// "yaptigini ozetledigini dusunup" ayni icerigi bir kez daha fenced block
// olarak basiyor. Claude Code / OpenCode bu text'i oldugu gibi render
// ediyor, kullanici "model dosyayi yazmadi, sadece yaziya dokti" saniyor.
// Halbuki dosya zaten yazilmisti.
function stripPostWriteDuplicateFencedBlocks(content, requestBody) {
  if (!Array.isArray(content) || content.length === 0) return;
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  if (messages.length === 0) return;

  // En yakin assistant turunda Write yapildi mi ve content'i neydi?
  // Tool_result'dan onceki assistant turunu ariyoruz (last assistant before
  // the final user message).
  let lastAssistant = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'assistant') {
      lastAssistant = messages[i];
      break;
    }
  }
  if (!lastAssistant || !Array.isArray(lastAssistant.content)) return;

  const writeContents = lastAssistant.content
    .filter((b) => b?.type === 'tool_use' && normalizeName(b?.name) === 'write')
    .map((b) => b?.input?.content ?? b?.input?.text ?? b?.input?.body ?? b?.input?.data)
    .filter((v) => typeof v === 'string' && v.length > 50); // kisa content duplicate'leri false positive riski tasiyor
  if (writeContents.length === 0) return;

  // Text block'larin icindeki fenced code block'lari tarayip match'eyenleri sil.
  for (let i = 0; i < content.length; i += 1) {
    const block = content[i];
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;

    let updatedText = block.text;
    let matched = false;
    FENCED_CODE_GLOBAL_RE.lastIndex = 0;
    const fencedMatches = [];
    let m;
    while ((m = FENCED_CODE_GLOBAL_RE.exec(block.text)) !== null) {
      fencedMatches.push({ raw: m[0], content: m[1] ?? '', index: m.index ?? 0 });
      if (FENCED_CODE_GLOBAL_RE.lastIndex === m.index) FENCED_CODE_GLOBAL_RE.lastIndex += 1;
    }

    for (const fenced of fencedMatches) {
      const fcontent = fenced.content.trim();
      if (fcontent.length < 50) continue;
      for (const writeContent of writeContents) {
        const wtrimmed = writeContent.trim();
        // Tam esitlik veya biri digerinin ilk kismi/son kismi. Zayif modeller
        // bazen content'in bir kismini daha atiyor.
        if (
          fcontent === wtrimmed ||
          wtrimmed.startsWith(fcontent) ||
          fcontent.startsWith(wtrimmed)
        ) {
          updatedText = updatedText.replace(fenced.raw, '').trim();
          matched = true;
          break;
        }
      }
    }

    if (matched) {
      block.text = updatedText;
    }
  }

  // Bos text block'lari kaldir
  for (let i = content.length - 1; i >= 0; i -= 1) {
    const block = content[i];
    if (block?.type === 'text' && (block.text === '' || block.text === null || block.text === undefined)) {
      content.splice(i, 1);
    }
  }
}

const FENCED_CODE_GLOBAL_RE = /```[a-zA-Z0-9_+#-]*\s*\n([\s\S]*?)```/g;

// Write enforcement: Model fenced code block basmis ama Write tool_use
// uretmemisse, proxy Write'i sentezler. Yalnizca guvenli kosullarda calisir.
function enforceWriteFromFencedContent(normalizedToolCalls, content, requestBody) {
  if (!Array.isArray(normalizedToolCalls)) return normalizedToolCalls;

  // Mevcut turde Write tool_use var mi?
  const hasWriteInThisTurn = normalizedToolCalls.some((tc) =>
    /^(?:write|writefile|createfile|savefile|newfile)/i.test(
      String(tc?.name ?? '').replace(/[^a-zA-Z0-9]/g, '')
    )
  );
  if (hasWriteInThisTurn) return normalizedToolCalls;

  // Istemci Write-tool-u destekliyor mu?
  const tools = Array.isArray(requestBody?.tools) ? requestBody.tools : [];
  const writeTool = tools.find((t) => {
    const name = String(t?.name ?? t?.function?.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return /^(?:write|writefile|createfile|savefile|newfile)/.test(name);
  });
  if (!writeTool) return normalizedToolCalls;

  // Text bloglarini birlestir
  const combinedText = content
    .filter((b) => b?.type === 'text' && typeof b?.text === 'string')
    .map((b) => b.text)
    .join('\n');
  if (!combinedText || combinedText.length < 30) return normalizedToolCalls;

  // Fenced block'lari bul
  FENCED_CODE_GLOBAL_RE.lastIndex = 0;
  const fencedBlocks = [];
  let match;
  while ((match = FENCED_CODE_GLOBAL_RE.exec(combinedText)) !== null) {
    fencedBlocks.push({ raw: match[0], content: match[1] ?? '', index: match.index ?? 0 });
    if (FENCED_CODE_GLOBAL_RE.lastIndex === match.index) FENCED_CODE_GLOBAL_RE.lastIndex += 1;
  }
  if (fencedBlocks.length === 0) return normalizedToolCalls;

  // En uzun fenced block'u ana aday olarak al (substantial kod olmali)
  const candidateBlock = fencedBlocks
    .filter((b) => b.content.trim().length >= 50) // minimum anlamli boyut
    .sort((a, b) => b.content.length - a.content.length)[0];
  if (!candidateBlock) return normalizedToolCalls;

  // Icerik listing mi shell-output mu? (intent-synthesis modulunden benzer check)
  if (isFencedBlockLikelyNotFileContent(candidateBlock.content)) return normalizedToolCalls;

  // Dosya adini bul - iki kaynak:
  //   1. Text'teki explicit filename (fenced block'tan ONCE veya icinde heading)
  //   2. User mesajindaki filename
  const filename = findFilenameForWriteEnforcement(
    combinedText, candidateBlock, requestBody
  );
  if (!filename) return normalizedToolCalls;

  // Ayni dosyaya daha onceki turda Write basariyla yapilmis mi?
  // (Duplicate yazma onleme - content mismatch olmasin diye)
  if (priorWriteAlreadyDoneForFile(requestBody, filename)) return normalizedToolCalls;

  // Schema field adlarini pick et
  const schema = writeTool.input_schema ?? writeTool.function?.parameters ?? {};
  const pathField = pickWriteFieldName(schema, ['file_path', 'filePath', 'path', 'file', 'filename']);
  const contentField = pickWriteFieldName(schema, ['content', 'text', 'body', 'data']);
  const writeToolName = writeTool.name ?? writeTool.function?.name;

  const syntheticWrite = {
    id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
    name: writeToolName,
    input: {
      [pathField]: filename,
      [contentField]: candidateBlock.content
    }
  };

  // Text'te fenced block'u temizle ki UI'da duplicate gozukmesin
  for (const textBlock of content) {
    if (textBlock?.type === 'text' && typeof textBlock.text === 'string') {
      textBlock.text = textBlock.text.replace(candidateBlock.raw, '').replace(/\n{3,}/g, '\n\n').trim();
    }
  }

  // Write'i onde, sonra mevcut tool_use'lar (Bash vb.)
  return [syntheticWrite, ...normalizedToolCalls];
}

function pickWriteFieldName(schema, candidates) {
  const properties = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  for (const cand of candidates) {
    if (properties[cand] !== undefined) return cand;
  }
  return candidates[0];
}

function isFencedBlockLikelyNotFileContent(text) {
  if (typeof text !== 'string') return true;
  // Path listesi
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const pathLike = lines.filter((l) =>
      /^[./~]/.test(l) || /^[A-Za-z]:[\\/]/.test(l) || /^[\w.-]+\.[A-Za-z0-9]{1,12}$/.test(l)
    ).length;
    if (pathLike / lines.length >= 0.8) return true; // dosya listesi
  }
  // Shell output (Exit code, $ prompt, > prompt)
  if (/^\s*(?:Exit code|exit code|\$\s|>\s|PID\s+\w)/m.test(text)) return true;
  return false;
}

// File adi patterni - Unicode letters + uzanti. Long extension alternation
// (markdown, json, yaml vs) once uzundan kisaya siralanmali.
const WRITE_FILENAME_RE = /([\p{L}\p{N}][\p{L}\p{N}_.\-]*?\.(?:markdown|html?|jsx|tsx|mjs|cjs|json|yaml|yml|bash|toml|conf|java|cpp|hpp|sql|rs|go|kt|rb|php|css|ts|js|py|md|xml|sh|cs|cc|c|h|ini|env|txt))\b/u;

function findFilenameForWriteEnforcement(modelText, candidateBlock, requestBody) {
  if (typeof modelText !== 'string') return null;

  // 1. Fenced block'un ICINDEKI ilk satirinda markdown heading olarak dosya
  //    adi var mi? Ornek: "# CLAUDE.md\n..."
  const contentHead = candidateBlock.content.slice(0, 300);
  const headingMatch = contentHead.match(/^\s*#{1,6}\s+([\p{L}\p{N}_.\-]+\.[A-Za-z0-9]{1,12})\b/mu);
  if (headingMatch) return headingMatch[1];

  // 2. Block'tan ONCEKI text'te acik dosya adi (Modelin "Create X.md" dedigi yer)
  const beforeText = modelText.slice(0, candidateBlock.index);
  const beforeMatch = beforeText.match(WRITE_FILENAME_RE);
  if (beforeMatch) return beforeMatch[1];

  // 3. Block'tan SONRAKI text'te dosya adi
  const afterText = modelText.slice(candidateBlock.index + candidateBlock.raw.length);
  const afterMatch = afterText.match(WRITE_FILENAME_RE);
  if (afterMatch) return afterMatch[1];

  // 4. Kullanici mesajinda explicit dosya adi
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  for (const msg of messages) {
    if (msg?.role !== 'user') continue;
    const text = typeof msg.content === 'string'
      ? msg.content
      : (Array.isArray(msg.content) ? msg.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');
    const userMatch = text.match(WRITE_FILENAME_RE);
    if (userMatch) return userMatch[1];
  }

  return null;
}

function priorWriteAlreadyDoneForFile(requestBody, filename) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  const target = String(filename).trim().toLowerCase().replace(/^\.[\\/]+/, '');
  for (const msg of messages) {
    if (msg?.role !== 'assistant' || !Array.isArray(msg?.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== 'tool_use') continue;
      const toolName = String(block?.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!/^(?:write|writefile|createfile|savefile|newfile)/.test(toolName)) continue;
      const path = block?.input?.file_path ?? block?.input?.filePath ?? block?.input?.path ?? block?.input?.file ?? block?.input?.filename;
      const normalized = String(path ?? '').trim().toLowerCase().replace(/^\.[\\/]+/, '');
      if (normalized && normalized === target) return true;
    }
  }
  return false;
}

// Legitimate HTML/XML tag'leri (content'in gercek bir parcasi olabilir).
// Bunlari whitelist olarak tutuyoruz ki kapanis tagleri bulunduklarinda bozuk
// sayilmasinlar. LIST OLMAYAN DIGER TUM kapanis tag'leri stray/unclosed
// kabul edilir — bu model-agnostik bir yaklasim: hangi model gelirse gelsin
// (</think>, </thinking>, </reasoning>, </scratchpad>, </planning>,
// </|thinking|>, ...) hepsi yakalanir.
const LEGIT_HTML_TAG_NAMES = new Set([
  // Block elements
  'div', 'p', 'section', 'article', 'nav', 'aside', 'header', 'footer', 'main',
  'figure', 'figcaption', 'details', 'summary', 'dialog',
  // Inline formatting
  'span', 'a', 'em', 'strong', 'i', 'b', 'u', 'code', 'kbd', 'var', 'samp',
  'mark', 'small', 'sub', 'sup', 'ins', 'del', 'abbr', 'cite', 'q', 'dfn',
  'time', 's', 'bdi', 'bdo', 'ruby', 'rt', 'rp',
  // Headings
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // Lists
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // Tables
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'col', 'colgroup',
  // Media / embed (void or legit)
  'br', 'hr', 'img', 'audio', 'video', 'source', 'track', 'picture', 'iframe',
  'embed', 'object', 'param', 'canvas', 'map', 'area', 'svg', 'math',
  // Forms
  'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'label',
  'fieldset', 'legend', 'datalist', 'output', 'progress', 'meter',
  // Meta
  'head', 'body', 'html', 'title', 'meta', 'link', 'style', 'script', 'noscript',
  'template', 'slot',
  // Pre/code blocks
  'pre', 'blockquote',
  // Other standard
  'address', 'hgroup', 'menu'
]);

// Kullanici faydali genel XML namespace'ler — legitimate kabul et.
const LEGIT_XML_PREFIXES = new Set(['xml', 'rss', 'atom', 'soap', 'xsl']);

// Kullanilan bir kapanis tag'i "legitimate HTML/XML content" sayilir mi?
function isLegitimateCloseTag(tagName) {
  if (!tagName) return true;
  const normalized = tagName.toLowerCase().replace(/[^a-z0-9:_-]/g, '');
  if (!normalized) return true;
  if (LEGIT_HTML_TAG_NAMES.has(normalized)) return true;
  // Namespace'li tag: "xsl:template", "rss:item" -> prefix kontrolu
  const colonIdx = normalized.indexOf(':');
  if (colonIdx > 0) {
    const prefix = normalized.slice(0, colonIdx);
    if (LEGIT_XML_PREFIXES.has(prefix)) return true;
  }
  return false;
}

// NOT: Onceki versiyonda `hasMalformedFinalText` vardi - stray XML-like
// kapanis tag'lerini tespit edip modelin cevabini proxy'nin kendi "malformed
// completion" mesaji ile DEGISTIRIYORDU. Bu cok yanlis-pozitif veriyordu:
// model legit ozet cevaplarinda, HTML icerigini anlatirken, SQL/code ornekleri
// gosterirken vs. tetikleniyordu. Proxy'nin asla modelin gercek text cevabini
// baska bir mesaj ile degistirmemesi gerekir. Kullanici metni gorur, gerekirse
// yeniden sorar. Bu yaklasim cok daha saygili ve guvenli.
// isLegitimateCloseTag fonksiyonu sadece stripNonHtmlStructuredBlocks icin
// kullaniliyor simdi; hatali-cevap algilama fonksiyonu kaldirildi.

// Write tool_use icin: content'in ilk satirindaki markdown heading
// (`# FILENAME.ext` veya `<!-- FILENAME.ext -->` / `/* filename.ext */`)
// write path'in basename'i ile uyusuyor mu? Eger content'te bariz bir baska
// dosyanin adi varsa, bu upstream modelin iki dosyayi karistirdiginin
// gostergesidir -> drop et ki dosyayi yanlis ustune yazmasin.
function isContentFilenameMismatch(writePath, content) {
  if (typeof writePath !== 'string' || typeof content !== 'string') return false;
  const pathBasename = writePath.trim().replace(/\\/g, '/').split('/').filter(Boolean).pop();
  if (!pathBasename) return false;

  // Content'in ilk 200 karakterinde bir dosya adi sinyali var mi?
  const head = content.slice(0, 200);

  // Deterministik patterns:
  //   1. Markdown heading: '# FILENAME.ext' veya '## FILENAME.ext'
  //   2. HTML yorum: '<!-- FILENAME.ext -->'
  //   3. JS/C yorum: '// FILENAME.ext' veya '/* FILENAME.ext */'
  //   4. Python/shell yorum: '# FILENAME.ext' (heading ile ayni)
  const patterns = [
    /^\s*#{1,6}\s+([A-Za-z0-9_.\-]+\.[A-Za-z0-9]{1,8})\b/m,
    /<!--\s*([A-Za-z0-9_.\-]+\.[A-Za-z0-9]{1,8})\s*-->/,
    /^\s*\/\/\s*([A-Za-z0-9_.\-]+\.[A-Za-z0-9]{1,8})\b/m,
    /^\s*\/\*\s*([A-Za-z0-9_.\-]+\.[A-Za-z0-9]{1,8})\s*\*\//m
  ];

  for (const re of patterns) {
    const match = head.match(re);
    if (!match) continue;
    const contentFilename = match[1];
    // Ayni filename? (case-insensitive karsilastir)
    if (contentFilename.toLowerCase() === pathBasename.toLowerCase()) {
      return false; // Uyusuyor, OK
    }
    // Content filename'inin uzantisi write path'inkinden FARKLI ise
    // (ornek: path='manifest.json', content-heading='CLAUDE.md'), bu
    // kesinlikle hata. Dile bagimsiz deterministik sinyal.
    const contentExt = contentFilename.split('.').pop()?.toLowerCase();
    const pathExt = pathBasename.split('.').pop()?.toLowerCase();
    if (contentExt && pathExt && contentExt !== pathExt) {
      return true; // Mismatch!
    }
    // Ayni uzanti ama farkli isim: daha az net, bir iki tanidik key-file
    // durumu disinda drop etme (yanlis pozitif riskli).
    // Ornek: path='README.md', content-heading='CLAUDE.md' - bu gercek bir
    // hata olasi. Key file prioriteyi kontrol et.
    const keyFiles = new Set(['claude.md', 'agents.md', 'readme.md', 'changelog.md', 'contributing.md', 'license.md']);
    if (keyFiles.has(contentFilename.toLowerCase()) && keyFiles.has(pathBasename.toLowerCase())) {
      return true; // Iki key-file birbirine karistirilmis
    }
  }
  return false;
}

// Bash komut adi olarak tool adinin kendisi ('Bash', 'Read') veya CLI flag'i
// ('--message=...', '-message=...', ':message=...') ya da anlam tasimayan
// tek-kelime tool/util isimleri (context, message, parameters, timeout)
// geliyorsa bu gercek bir shell command degildir, upstream model tool adini
// komuta yanlislikla ustune yazmistir. Bu tarz bash call'larini dusur.
function isBogusBashCommand(command) {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (!trimmed) return true;
  // Tek kelime ve tanidik tool/util adi (argüman olmadan calistirilirsa
  // anlamsiz veya zararli). 'timeout' argümansiz 'timeout: missing operand'.
  // 'ls', 'pwd' gibi gercekten argümansiz calisabilecekler hariç tut.
  if (/^(?:bash|read|write|edit|glob|grep|task|agent|skill|context|message|parameters?|command|tool_use|tool_call|timeout|xargs|sudo|env|exec|source)$/i.test(trimmed)) {
    return true;
  }
  // Tek kelimelik capitalized noun benzeri ve bilinen shell komutu degil:
  // Model bazen "Error", "Result", "Output", "Response" gibi anlamsiz kelimeleri
  // komut olarak basiyor. Whitelisted bilinen komut degilse drop.
  if (/^[A-Z][a-z]+$/.test(trimmed) || /^[A-Z]+$/.test(trimmed)) {
    // Tek kelimelik capitalized - bilinen komut mu?
    const KNOWN_CAPITALIZED_CMDS = new Set([
      'Get-Content', 'Get-ChildItem', 'Set-Location', 'Test-Path', 'Remove-Item',
      'Copy-Item', 'Move-Item', 'New-Item', 'Select-String', 'Where-Object',
      'ForEach-Object', 'Sort-Object', 'Measure-Object', 'Format-Table',
      'Invoke-WebRequest', 'Invoke-RestMethod', 'ConvertTo-Json', 'ConvertFrom-Json'
    ]);
    if (!KNOWN_CAPITALIZED_CMDS.has(trimmed)) {
      return true;
    }
  }
  // Shell variable assignment olarak gelen komutlar: 'cmd="ls -la"',
  // 'command="cat x"' - bunlar shell'de variable atar ama hic komut
  // calistirmaz, output yok. Drop.
  if (/^[A-Za-z_][\w]*=\s*["'][^"']+["']\s*$/.test(trimmed)) {
    return true;
  }
  // Salt `:message=...` veya `-message=...` veya `--message=...` gibi orphan flag'lar
  if (/^[:\-][:\-]?[A-Za-z_][\w-]*=/.test(trimmed)) {
    return true;
  }
  return false;
}

// Paralel calistirildiginda birbirine karisip hatali sonuc uretebilecek tool'lar.
// bash: cwd, env, dosya state'i paylasildigi icin paralel calistirmak tehlikeli.
//       (upstream modelleri tek turda 5-6 bash call'u atiyor, biri fail edince
//        Claude Code 'parallel tool errored' diyip tumunu iptal ediyor).
// delete: dosya sistemi race condition.
// write / edit: ayni dosyaya birden fazla yazma paralel yapilamaz.
// Diger tool'lar (read, glob, grep, webfetch, task) stateless olduklari icin
// paralel calistirilabilirler, onlarda collapse UYGULANMAZ.
const STATEFUL_TOOLS_TO_COLLAPSE = new Set(['bash', 'delete', 'write', 'edit']);

// Ayni turda ayni STATEFUL tool icin birden fazla call geldi mi? Sadece ilkini
// birakip digerlerini dusur. Komut icerigi HIC degistirilmez, sadece paralel
// duplicate'lar elenir. Farkli tool'lar (1 bash + 1 read) ve farkli aileler
// (1 read + 1 glob) korunur.
function collapseParallelToolCalls(toolCalls) {
  const seenStateful = new Set();
  const seenReadTargets = new Set();
  const seenGlobPatterns = new Set();
  const seenGrepPatterns = new Set();
  const result = [];
  for (const toolCall of toolCalls) {
    const key = normalizeName(toolCall.name);
    if (STATEFUL_TOOLS_TO_COLLAPSE.has(key)) {
      if (seenStateful.has(key)) {
        continue;
      }
      seenStateful.add(key);
    }
    if (key === 'read') {
      const target = normalizeEscapedPath(toolCall.input?.file_path ?? toolCall.input?.filePath ?? toolCall.input?.path ?? toolCall.input?.value);
      if (target) {
        const normalizedTarget = String(target).toLowerCase();
        if (seenReadTargets.has(normalizedTarget)) {
          continue;
        }
        seenReadTargets.add(normalizedTarget);
      }
      if (seenReadTargets.size > 4) {
        continue;
      }
    }
    // Duplicate Glob/Grep pattern'lari ayni turda -> drop. Upstream modeller
    // bazen ayni pattern'i 3-5 kez tekrar ediyor (ornek: 3x Glob('**/*')).
    // Bu gereksiz yere client'ta 3 kez ayni sonuc hesaplanip donuyor.
    if (key === 'glob') {
      const pattern = String(toolCall.input?.pattern ?? toolCall.input?.glob ?? toolCall.input?.query ?? '').trim().toLowerCase();
      if (pattern && seenGlobPatterns.has(pattern)) {
        continue;
      }
      if (pattern) seenGlobPatterns.add(pattern);
    }
    if (key === 'grep') {
      const pattern = String(toolCall.input?.pattern ?? toolCall.input?.query ?? toolCall.input?.regex ?? '').trim().toLowerCase();
      if (pattern && seenGrepPatterns.has(pattern)) {
        continue;
      }
      if (pattern) seenGrepPatterns.add(pattern);
    }
    result.push(toolCall);
  }
  return result;
}

function canonicalizeToolName(name, registry) {
  if (!name || registry.size === 0) {
    return name;
  }

  if (registry.has(name)) {
    return name;
  }

  const normalized = normalizeName(name);
  for (const [toolName, meta] of registry.entries()) {
    if (meta.normalized === normalized) {
      return toolName;
    }
    if (normalized.startsWith(meta.normalized) || normalized.endsWith(meta.normalized) || meta.normalized.startsWith(normalized)) {
      return toolName;
    }
  }

  for (const [targetName, aliases] of Object.entries(TOOL_NAME_ALIASES)) {
    if (!aliases.includes(normalized) && !aliases.some((alias) => normalized.startsWith(alias) || normalized.endsWith(alias) || alias.startsWith(normalized))) {
      continue;
    }
    if (targetName === 'delete') {
      for (const [toolName, meta] of registry.entries()) {
        if (meta.normalized === 'bash') {
          return toolName;
        }
      }
    }
    for (const [toolName, meta] of registry.entries()) {
      if (meta.normalized === normalizeName(targetName)) {
        return toolName;
      }
    }
  }

  return name;
}

// Read-like bash komutlarini proxyn'in Read tool'una redirect edebilmek icin
// dosya yolunu cikartir. Neden: 'cat X.html' gibi komutlar buyuk dosyalarda
// stdout'u tasirip client'in tool_result'ini kirar; Read tool'u offset/limit
// destegi ile daha guvenlidir. Cross-platform (Unix cat/head/less/more/view
// + Windows type + PowerShell Get-Content) hepsi destekleniyor.
// Komut TEK dosya okuma tarzi ise (pipe yok, redirect yok) match eder.
function extractPathFromReadLikeCommand(command) {
  const source = sanitizeCommand(command);
  if (typeof source !== 'string' || !source) {
    return null;
  }
  // Pipe'lar veya redirect varsa bu saf read degil; komutu oldugu gibi birak.
  if (/[|<>&;]/.test(source)) {
    return null;
  }
  // Unix: cat, head, tail (tek arg), less, more, view, bat, nl
  // Windows: type
  const readCmdMatch = source.match(/^(?:cat|type|less|more|view|bat|nl|head|tail)\b(?:\s+-\w+)*\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+|$)/i);
  if (readCmdMatch) {
    return normalizeEscapedPath(readCmdMatch[1] ?? readCmdMatch[2] ?? readCmdMatch[3]);
  }
  // PowerShell Get-Content
  const powershellGetContentMatch = source.match(/^(?:powershell(?:\.exe)?\s+-Command\s+)?Get-Content\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
  if (powershellGetContentMatch) {
    return normalizeEscapedPath(powershellGetContentMatch[1] ?? powershellGetContentMatch[2] ?? powershellGetContentMatch[3]);
  }
  return null;
}

function extractPatternFromListLikeCommand(command) {
  const source = sanitizeCommand(command);
  if (typeof source !== 'string' || !source) {
    return null;
  }
  if (/^(?:find|fd)(?:\s+|$)/i.test(source) || /Get-ChildItem/i.test(source)) {
    return '**/*';
  }
  return null;
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
    return { toolResultBlock, previousAssistant };
  }
  return null;
}

function getReadTargetsFromAssistantMessage(message) {
  if (!message || !Array.isArray(message?.content)) {
    return [];
  }
  return message.content
    .filter((block) => block?.type === 'tool_use' && normalizeName(block?.name) === 'read')
    .map((block) => normalizeEscapedPath(block?.input?.file_path ?? block?.input?.filePath ?? block?.input?.path ?? block?.input?.file ?? block?.input?.filename))
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase());
}

function collectAllPreviousReadTargets(requestBody) {
  const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  const targets = new Set();
  for (const msg of messages) {
    if (msg?.role !== 'assistant') continue;
    for (const value of getReadTargetsFromAssistantMessage(msg)) {
      targets.add(value);
    }
  }
  return targets;
}

function suppressRepeatedReadToolCalls(toolCalls, requestBody) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return toolCalls;
  }
  // Butun gecmis turlarda okunmus dosyalari topla (sadece son tur degil).
  // Zayif modeller ayni dosyayi 5-6 tur art arda okumaya calisiyor: "AGENTS.md
  // bos goruyorum, tekrar deneyeyim" -> loop. Ayni dosyaya ikinci kez gonderme
  // yoksa stateless bir is yapilmis olur; izin vermeyiz.
  const previousReadTargets = collectAllPreviousReadTargets(requestBody);
  if (previousReadTargets.size === 0) {
    return toolCalls;
  }

  let keptReadCount = 0;
  const filtered = toolCalls.filter((toolCall) => {
    if (normalizeName(toolCall?.name) !== 'read') {
      return true;
    }
    const currentTarget = normalizeEscapedPath(toolCall?.input?.file_path ?? toolCall?.input?.filePath ?? toolCall?.input?.path ?? toolCall?.input?.value);
    const normalizedTarget = currentTarget ? String(currentTarget).trim().toLowerCase() : '';
    if (normalizedTarget && previousReadTargets.has(normalizedTarget)) {
      return false;
    }
    keptReadCount += 1;
    return keptReadCount <= 1;
  });

  // Non-empty guarantee: suppression tum tool_use'lari sildiyse bos tool_use
  // donmek empty-retry loop'una yol acar. En azindan ilk orjinal Read'i geri
  // getir - client bu Read'i tekrar calistirsa bile tool_result donuyor ve
  // session ilerliyor, stall olmuyor. Bos turla karsilastirirsak bu kesinlikle
  // daha iyi.
  if (filtered.length === 0 && toolCalls.length > 0) {
    return [toolCalls[0]];
  }
  return filtered;
}

function canonicalizeToolCalls(toolCalls, requestBody) {
  const registry = buildToolRegistry(requestBody);
  if (registry.size === 0) {
    return toolCalls;
  }
  // Onceki turlarda okunmus dosyalari toplama: Bash(cat X) -> Read(X)
  // donusumu yapmadan once, X zaten okunmus mu kontrol edelim. Okunmussa
  // Read donusumu yapmayalim, cunku sonraki suppressRepeatedReadToolCalls
  // onu drop edip tool_use'u bos birakir. Bu durumda Bash'i korumak daha
  // guvenli (model gerçekten bash cıktısı istiyor olabilir veya cache yenile).
  const previousReadTargets = collectAllPreviousReadTargets(requestBody);

  return toolCalls.map((toolCall) => {
    const resolvedName = canonicalizeToolName(toolCall.name, registry);
    if (!registry.has(resolvedName)) {
      return null;
    }
    const schema = registry.get(resolvedName)?.schema ?? {};
    const input = toolCall.input && typeof toolCall.input === 'object' && !Array.isArray(toolCall.input)
      ? { ...toolCall.input }
      : {};
    const originalName = normalizeName(toolCall.name);
    if (
      normalizeName(resolvedName) === 'bash' &&
      resolvedName !== toolCall.name &&
      input.command === undefined &&
      input.value === undefined &&
      input.arguments === undefined &&
      SHELL_COMMAND_ALIASES.has(normalizeName(toolCall.name))
    ) {
      input.command = toolCall.name;
    }
    if (normalizeName(resolvedName) === 'bash' && TOOL_NAME_ALIASES.delete.includes(originalName)) {
      const filePath = normalizeEscapedPath(input.file_path ?? input.filePath ?? input.path);
      if (filePath) {
        input.command = `rm -f -- ${shellQuote(filePath)}`;
        input.description = input.description ?? `Delete file ${filePath}`;
      }
    }

    // Exploration-only bash commands are fragile across OSes and often lead weak
    // models into bash loops. Prefer client's native Glob/Read tools when a bash
    // command is just listing files or reading one file.
    if (normalizeName(resolvedName) === 'bash' && typeof input.command === 'string') {
      const readTarget = extractPathFromReadLikeCommand(input.command);
      if (readTarget) {
        // Hedef dosya daha once okunmus mu? Okunmussa Bash'i Read'e cevirmek
        // mantiksiz: sonraki suppressRepeatedReadToolCalls onu drop edip
        // tool_use'u kaybedecek. Bu durumda Bash'i oldugu gibi birakalim
        // (model'in niyeti kaybolsun diye - o da orijinal secim).
        const targetLower = String(readTarget).trim().toLowerCase();
        const alreadyRead = previousReadTargets.has(targetLower);
        if (!alreadyRead) {
          for (const [toolName, meta] of registry.entries()) {
            if (meta.normalized === 'read') {
              return {
                ...toolCall,
                name: toolName,
                input: coerceToolInput(toolName, { file_path: readTarget }, meta.schema ?? {})
              };
            }
          }
        }
        // Zaten okunmussa Bash olarak kalmaya birak; duser belki ama tool_use
        // korunur. NOT: daha iyisi bos cevap uretmemek.
      }
      const globPattern = extractPatternFromListLikeCommand(input.command);
      if (globPattern) {
        for (const [toolName, meta] of registry.entries()) {
          if (meta.normalized === 'glob') {
            return {
              ...toolCall,
              name: toolName,
              input: coerceToolInput(toolName, { pattern: globPattern }, meta.schema ?? {})
            };
          }
        }
      }
    }
    return {
      ...toolCall,
      name: resolvedName,
      input: coerceToolInput(resolvedName, input, schema)
    };
  }).filter(Boolean);
}

function extractFencedBashBlocks(text) {
  const source = String(text ?? '');
  const toolCalls = [];
  let stripped = source;

  for (const match of source.matchAll(FENCED_BASH_RE)) {
    const command = sanitizeCommand(match[1] ?? '');
    if (!command) {
      continue;
    }
    toolCalls.push({
      id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
      name: 'bash',
      input: { command }
    });
    stripped = stripped.replace(match[0], '').trim();
  }

  return {
    text: stripped,
    toolCalls
  };
}

function extractFileWriteBlocks(text) {
  const source = String(text ?? '');
  const toolCalls = [];
  let stripped = source;

  for (const match of source.matchAll(FILE_WRITE_BLOCK_RE)) {
    const filePath = normalizeEscapedPath(match[1]?.trim());
    const content = match[2] ?? '';
    if (!filePath) {
      continue;
    }
    toolCalls.push({
      id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
      name: 'write',
      input: {
        file_path: filePath,
        content
      }
    });
    stripped = stripped.replace(match[0], '').trim();
  }

  return {
    text: stripped,
    toolCalls
  };
}

function extractFirstFencedCodeBlock(text) {
  const source = String(text ?? '');
  const match = source.match(FENCED_CODE_BLOCK_RE);
  if (!match) {
    return null;
  }
  return {
    raw: match[0],
    lang: match[1] ?? '',
    content: match[2] ?? ''
  };
}

function cleanText(value) {
  let out = String(value ?? '').replace(/\r\n/g, '\n');

  // Model-agnostik chain-of-thought / reasoning tag temizligi.
  // Herhangi bir model'in kullandigi iç-monolog tag'i (</think>,
  // </thinking>, </reasoning>, </scratchpad>, </planning>, </rationale>,
  // </analysis>, </monologue>, <|thinking|>, vs) ayni kurala tabi:
  //   - Tag adi LEGITIMATE HTML/XML elementi DEGIL
  //   - Bir acilis ve bir kapanis var (yapilandirilmis blok)
  // Bu durumda tum blok (tag + icerik) silinir, kullaniciya sizmaz.
  out = stripNonHtmlStructuredBlocks(out);

  // <details>...</details> bloklari: sadece narration metni iceriyorsa
  // (kod blogu, tablo, liste, link, resim yoksa) temizle. Deterministik
  // yaklasim: yapiyi incele, icerige gore karar ver.
  out = stripNarrationDetailsBlocks(out);

  return sanitizeToolText(out.trim());
}

// Herhangi bir bilinmeyen (HTML/XML element olmayan) tag'in <open>...</open>
// yapisini blok + icerikle birlikte sil. Bu, model-specific reasoning
// tag'lerinin hepsini (think, thinking, reasoning, scratchpad, planning,
// rationale, analysis, monologue, ...) hardcode ETMEDEN temizler.
//
// Kapsanan sart: ayni tag adinin hem acilis hem kapanisi var (yapisal blok).
// Kapanisi olmayan stray tag'ler (ornek: yalniz '</think>' bir basina) bu
// fonksiyon tarafindan silinmez - cunku onlar bozuk-cevap sinyalidir ve
// `hasMalformedFinalText` tarafindan yakalanir (malformed completion error).
function stripNonHtmlStructuredBlocks(text) {
  if (typeof text !== 'string' || !text) return text;
  // Genel tag adi pattern'i. Anthropic'in <|thinking|> gibi alternatif
  // formatlarini da kapsamak icin basit case-insensitive eslesme.
  const openRe = /<([a-zA-Z][\w:-]*)\b[^>]*>/g;
  let out = text;
  let changed = true;
  // Birden fazla nested blok olabilir; iteratif devam et ta ki sabit nokta.
  while (changed) {
    changed = false;
    openRe.lastIndex = 0;
    let match;
    const toStrip = [];
    while ((match = openRe.exec(out)) !== null) {
      const tagName = match[1];
      if (isLegitimateCloseTag(tagName)) continue;
      // Kapanisi ayni tag ile kapali mi?
      const closeRe = new RegExp(`<\\/${tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`, 'i');
      const rest = out.slice(match.index);
      const closeMatch = rest.match(closeRe);
      if (!closeMatch) continue; // Stray, burada silmiyoruz
      const fullBlockEnd = match.index + closeMatch.index + closeMatch[0].length;
      toStrip.push({ start: match.index, end: fullBlockEnd });
    }
    if (toStrip.length > 0) {
      // Sondan basa dogru sil (indeks shift'i olmasin)
      toStrip.sort((a, b) => b.start - a.start);
      for (const { start, end } of toStrip) {
        out = out.slice(0, start) + out.slice(end);
      }
      changed = true;
    }
  }
  return out;
}

// <details>...</details> bloku sadece asistant'in "think-aloud" narration'i
// mi iceriyor? Kod, tablo, liste, markdown yapisi varsa korunur; sadece
// duz metin varsa silinir.
function stripNarrationDetailsBlocks(text) {
  if (typeof text !== 'string' || !text.includes('<details')) return text;
  // Non-greedy, case-insensitive, tum attribute'lari kabul et
  return text.replace(/<details\b[^>]*>([\s\S]*?)<\/details>/gi, (match, inner) => {
    const content = String(inner ?? '');
    // <summary> etiketini cikar (zaten var, dikkate alma)
    const afterSummary = content.replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/i, '').trim();
    // Gercek icerik sinyalleri: fenced kod bloku, markdown table, liste,
    // link, resim, HTML tag (details/summary disinda).
    const hasCodeBlock = /```/.test(afterSummary);
    const hasTable = /\|[\s-:|]+\|/.test(afterSummary); // markdown tablo row
    const hasList = /^\s*[-*+]\s+\S/m.test(afterSummary) || /^\s*\d+\.\s+\S/m.test(afterSummary);
    const hasLink = /\[.+?\]\(.+?\)/.test(afterSummary);
    const hasImage = /!\[.*?\]\(.+?\)/.test(afterSummary);
    const hasOtherHtml = /<(?!\/?(?:details|summary|br|p|em|strong|i|b)\b)[a-z][^>]*>/i.test(afterSummary);
    if (hasCodeBlock || hasTable || hasList || hasLink || hasImage || hasOtherHtml) {
      return match; // Korunur
    }
    return ''; // Sil
  });
}

function normalizeJsonToolCandidate(candidate) {
  const parsed = parseJsonSafe(candidate.trim());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  if (typeof parsed.name !== 'string') {
    return null;
  }

  const rawArguments = parsed.arguments ?? parsed.input ?? {};
  const input = rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
    ? rawArguments
    : { value: rawArguments };

  return {
    id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
    name: parsed.name,
    input
  };
}

function parseXmlScalarParameters(value) {
  const matches = [...String(value ?? '').matchAll(/<([A-Za-z_][\w-]*)>\s*([\s\S]*?)\s*<\/\1>/g)];
  if (matches.length === 0) {
    const namedParams = [...String(value ?? '').matchAll(/<parameter\s+name="([^"]+)">\s*([^\n<]+)/gi)];
    if (namedParams.length === 0) {
      return null;
    }
    const result = {};
    for (const match of namedParams) {
      result[match[1]] = match[2].trim();
    }
    return result;
  }

  const result = {};
  for (const match of matches) {
    result[match[1]] = match[2];
  }
  return result;
}

function parseHeader(header) {
  const trimmed = header.trim();
  if (!trimmed) {
    return null;
  }

  const jsonToolCall = normalizeJsonToolCandidate(trimmed);
  if (jsonToolCall) {
    return {
      name: jsonToolCall.name,
      input: jsonToolCall.input
    };
  }

  const xmlNameMatch = trimmed.match(XML_TOOL_NAME_RE);
  const xmlServerNameMatch = trimmed.match(XML_SERVER_NAME_RE);
  if (xmlNameMatch || xmlServerNameMatch) {
    const name = (xmlNameMatch?.[1] ?? xmlServerNameMatch?.[1] ?? '').trim();
    const argsMatch = trimmed.match(XML_ARGUMENTS_RE) ?? trimmed.match(XML_PARAMETERS_RE);
    const rawArgs = argsMatch?.[1]?.trim();
    const parsedArgs = rawArgs ? (parseJsonSafe(rawArgs) ?? parseXmlScalarParameters(rawArgs)) : null;
    const serverName = (xmlServerNameMatch?.[1] ?? '').trim();
    return {
      name: serverName && xmlNameMatch ? `${serverName}.${name}` : name,
      input: parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs) ? parsedArgs : {}
    };
  }

  const inlineAngleMatch = trimmed.match(/^([A-Za-z_][\w-]*)>(.+)$/);
  if (inlineAngleMatch) {
    return {
      name: inlineAngleMatch[1],
      input: { value: inlineAngleMatch[2].trim() }
    };
  }

  const firstSpace = trimmed.search(/\s/);
  const rawName = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const strippedName = rawName.replace(ARG_KEY_RE, '').trim();
  if (isMetaToolToken(strippedName)) {
    return null;
  }
  const splitToken = splitConcatenatedToolToken(strippedName);
  const name = splitToken?.name ?? strippedName;
  const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1);
  const input = {};

  for (const match of rest.matchAll(ATTR_RE)) {
    input[match[1]] = match[2];
  }

  const strippedRest = rest.replace(ATTR_RE, '').trim();
  if (strippedRest.startsWith('{')) {
    const parsed = parseJsonSafe(strippedRest);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.assign(input, parsed);
    }
  }

  if (splitToken && Object.keys(input).length === 0) {
    input.value = [splitToken.remainder, strippedRest].filter(Boolean).join(' ').trim();
  }

  return { name, input };
}

const CMD_PREFIX_RE = /^(cmd|command|commandls|commandlw|lw|l|end|c)\s+(.+)$/i;
const WINDOWS_CMD_RE = /^([\/\\][a-z])\s+(.+)$/i;
const GENERIC_PLACEHOLDER_VALUE_RE = /^(?:file|files|agent|task|tool|command|parameter|parameters)$/i;

function isGenericPlaceholderValue(value) {
  return typeof value === 'string' && GENERIC_PLACEHOLDER_VALUE_RE.test(value.trim());
}

function isBogusReadTarget(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }
  const normalized = normalizeName(trimmed.replace(/[>:]+$/g, ''));
  if (normalized === 'read' || normalized === 'readfile' || normalized === 'readfilecontents' || normalized === 'openfile' || normalized === 'cat') {
    return true;
  }
  if (/^read(?:file(?:contents)?)?[>:]+$/i.test(trimmed)) {
    return true;
  }
  // Path icinde XML tag var (model instrumentation tag'i path'e sizdirmis).
  // Ornek: '<system-reminder>The tool ran without output</systemResult>'
  // veya 'manifest.json</Read>'. Trailing </...> stripping normalizePathForTool
  // tarafindan yapiliyor; burada path ICINDE tag varsa (ortada), veya
  // path bir tag ile basliyorsa, bu hallusinated bir degerdir.
  if (/^<[a-zA-Z]/.test(trimmed) || /<\/[a-zA-Z][\w-]*>/.test(trimmed)) {
    return true;
  }
  // Path cok karakter hatali: sadece tag/quote/angle bracket karakterleri
  // iceriyorsa bu bir dosya adi degil.
  if (/^[<>\s`'"]+$/.test(trimmed)) {
    return true;
  }
  // Hallusine-looking random-hash filename: "bnvosbff5.txt", "bug8v7joh.txt"
  // - 6-12 karakter tamamen random (vowel-consonant distribution anormal)
  // Bu heuristik dile bagimsiz: sadece entropy/pattern analizi.
  // Deterministik kural: 8-12 karakter lowercase ASCII + 3 karakterli uzanti
  // + hic unlu harf veya hic unsuzu olmayan pattern veya 6+ ardisik
  // unsuzlu harf grubu. Cok sikletli degil ama false positive riski var;
  // yerine basit kural: ismin basi "." degil + ardisik 4+ unsuz varsa
  // muhtemelen halusinasyon.
  // NOT: "xml.txt" gibi legit cok kisa isimler de olabilir; bu check opt-in.
  // Simdilik kaldirdim, risk yuksek.
  return false;
}

function parseLooseToolLine(line) {
  const trimmed = sanitizeToolText(line)?.trim();
  if (!trimmed) {
    return null;
  }

  if (/^[A-Za-z_][\w-]*:\s*$/i.test(trimmed)) {
    return null;
  }

  const cmdPrefixMatch = trimmed.match(CMD_PREFIX_RE);
  if (cmdPrefixMatch) {
    const name = cmdPrefixMatch[1].toLowerCase();
    let mappedName = 'bash';
    if (name === 'l' || name === 'lw' || name === 'commandlw' || name === 'list') {
      mappedName = 'glob';
    }
    return {
      id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
      name: mappedName,
      input: { command: cmdPrefixMatch[2].trim() }
    };
  }

  const windowsCmdMatch = trimmed.match(WINDOWS_CMD_RE);
  if (windowsCmdMatch) {
    const flag = windowsCmdMatch[1].toLowerCase();
    const arg = windowsCmdMatch[2].trim();
    if (flag === '/c' || flag === '/c') {
      return {
        id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
        name: 'bash',
        input: { command: arg }
      };
    }
    if (flag === '/b' || flag === '/b') {
      return {
        id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
        name: 'glob',
        input: { pattern: '*' }
      };
    }
  }

  const queryArgMatch = trimmed.match(/^([A-Za-z_][\w-]*)\s+\?([A-Za-z_][\w-]*)=(.+)$/);
  if (queryArgMatch) {
    const [, name, key, value] = queryArgMatch;
    return {
      id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
      name,
      input: {
        [key]: value.replace(/<\/?tool_call>$/gi, '').trim()
      }
    };
  }

  const taggedToolUse = trimmed.match(/^<tool_use>([\s\S]+)$/);
  if (taggedToolUse) {
    const parsed = parseHeader(taggedToolUse[1]);
    if (parsed?.name) {
      return {
        id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
        name: parsed.name,
        input: parsed.input
      };
    }
  }

  const angleMatch = trimmed.match(ANGLE_TOOL_LINE_RE);
  if (angleMatch) {
    const [, name, value] = angleMatch;
    if (isMetaToolToken(name)) {
      return null;
    }
    return {
      id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
      name,
      input: { value: value.trim() }
    };
  }

  const wordThenValue = trimmed.match(/^([A-Za-z_][\w-]*)\s+(.+)$/);
  if (wordThenValue && isMetaToolToken(wordThenValue[1])) {
    return null;
  }
  if (wordThenValue && TOOL_NAME_ALIASES.read.includes(normalizeName(wordThenValue[1])) === false) {
    // continue to existing path-specific heuristic below
  }
  if (wordThenValue && ['read', 'readfile', 'readfilecontents', 'openfile', 'cat'].includes(normalizeName(wordThenValue[1]))) {
    const [, name, value] = wordThenValue;
    return {
      id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
      name,
      input: { value: value.trim() }
    };
  }
  if (wordThenValue && ['write', 'writefile', 'writefilecontents', 'createfile', 'savefile'].includes(normalizeName(wordThenValue[1]))) {
    const [, name, value] = wordThenValue;
    if (isGenericPlaceholderValue(value)) {
      return null;
    }
    return {
      id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
      name,
      input: { value: value.trim() }
    };
  }
  if (wordThenValue && /^[./~]|^[A-Za-z]:[\\/]|^\\\\/.test(wordThenValue[2])) {
    const [, name, value] = wordThenValue;
    return {
      id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
      name,
      input: { value: value.trim() }
    };
  }

  return null;
}

function mergeArgValues(input, segment) {
  const argKey = segment.match(ARG_KEY_RE)?.[1]?.trim();
  const argValues = [...segment.matchAll(ARG_VALUE_RE)]
    .map((match) => match[1].replace(/<\/tool_call>$/i, '').trim())
    .filter(Boolean);
  if (argValues.length === 0) {
    return input;
  }

  if (argKey && argValues.length >= 1) {
    const parsed = parseJsonSafe(argValues[0]);
    input[argKey] = parsed ?? argValues[0];
    return input;
  }

  if (argValues.length === 1 && Object.keys(input).length === 0) {
    const parsed = parseJsonSafe(argValues[0]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return { value: argValues[0] };
  }

  if (argValues.length === 1) {
    const parsed = parseJsonSafe(argValues[0]);
    input.arguments = parsed ?? argValues[0];
    return input;
  }

  input.arguments = argValues.map((value) => parseJsonSafe(value) ?? value);
  return input;
}

function extractMalformedXmlToolCalls(text) {
  const source = String(text ?? '');
  const toolCalls = [];
  let stripped = source;
  const nameMatches = [...source.matchAll(/<tool_name>\s*([\s\S]*?)\s*<\/tool_name>/gi)];

  for (let index = 0; index < nameMatches.length; index += 1) {
    const match = nameMatches[index];
    const rawName = match[1]?.trim();
    if (!rawName) {
      continue;
    }

    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < nameMatches.length ? (nameMatches[index + 1].index ?? source.length) : source.length;
    const slice = source.slice(start, end);
    const argsMatch = slice.match(/<(arguments|parameters)>\s*([\s\S]*?)\s*<\/\1>/i);
    const rawArgs = argsMatch?.[2]?.trim();
    const parsedArgs = rawArgs ? (parseJsonSafe(rawArgs) ?? parseXmlScalarParameters(rawArgs) ?? {}) : {};

    toolCalls.push({
      id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
      name: rawName,
      input: parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs) ? parsedArgs : {}
    });

    stripped = stripped.replace(source.slice(match.index ?? 0, end), '').trim();
  }

  return {
    text: stripped.replace(/<tool_call>[^>\n]*>?/gi, '').replace(/<\/?parameter[s]?>/gi, '').trim(),
    toolCalls
  };
}

// Anthropic native function-calling XML formatini parse et.
// Format: <function_calls><invoke name="X"><parameter name="Y">Z</parameter></invoke>...</function_calls>
// Bazi modeller (Claude variants, glm-5 Claude mode) bunu structured
// tool_calls yerine text icinde basiyorlar. Proxy bunu gercek tool_use'a cevirir.
function extractAnthropicXmlFunctionCalls(text) {
  if (typeof text !== 'string' || !text) return { toolCalls: [], text };
  const toolCalls = [];
  let remaining = text;

  // Outer wrapper: <function_calls>...</function_calls> (kapanis opsiyonel)
  const outerMatch = remaining.match(/<function_calls>([\s\S]*?)(?:<\/function_calls>|$)/i);
  if (!outerMatch) {
    // Wrapper yok ama inline <invoke> olabilir
    const invokeRe = /<invoke\s+name=["']([^"'\s>]+)["']\s*>([\s\S]*?)(?:<\/invoke>|$)/gi;
    let match;
    let anyFound = false;
    const toStrip = [];
    while ((match = invokeRe.exec(remaining)) !== null) {
      anyFound = true;
      const name = match[1];
      const body = match[2] ?? '';
      const input = parseInvokeParameters(body);
      toolCalls.push({
        id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
        name,
        input
      });
      toStrip.push({ start: match.index, end: match.index + match[0].length });
    }
    if (anyFound) {
      toStrip.sort((a, b) => b.start - a.start);
      for (const { start, end } of toStrip) {
        remaining = remaining.slice(0, start) + remaining.slice(end);
      }
    }
    return { toolCalls, text: remaining.replace(/\n{3,}/g, '\n\n').trim() };
  }

  const inner = outerMatch[1];
  const innerStart = outerMatch.index;
  const innerEnd = innerStart + outerMatch[0].length;

  const invokeRe = /<invoke\s+name=["']([^"'\s>]+)["']\s*>([\s\S]*?)(?:<\/invoke>|$)/gi;
  let match;
  while ((match = invokeRe.exec(inner)) !== null) {
    const name = match[1];
    const body = match[2] ?? '';
    const input = parseInvokeParameters(body);
    toolCalls.push({
      id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
      name,
      input
    });
  }

  remaining = remaining.slice(0, innerStart) + remaining.slice(innerEnd);
  return { toolCalls, text: remaining.replace(/\n{3,}/g, '\n\n').trim() };
}

// <invoke> body'sindeki <parameter name="X">Y</parameter> etiketlerini parse et.
function parseInvokeParameters(body) {
  const input = {};
  if (typeof body !== 'string' || !body) return input;
  const paramRe = /<parameter\s+name=["']([^"'\s>]+)["']\s*>([\s\S]*?)(?:<\/parameter>|$)/gi;
  let match;
  while ((match = paramRe.exec(body)) !== null) {
    const name = match[1];
    let value = match[2] ?? '';
    // JSON olabilir (number, boolean, array)
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) {
      input[name] = Number(trimmed);
    } else if (/^-?\d+\.\d+$/.test(trimmed)) {
      input[name] = Number(trimmed);
    } else if (trimmed === 'true') {
      input[name] = true;
    } else if (trimmed === 'false') {
      input[name] = false;
    } else {
      input[name] = value;
    }
  }
  return input;
}

export function extractPseudoToolCalls(text) {
  const source = String(text ?? '');
  const cleaned = cleanText(source).trim();
  const textBlocks = [];
  const toolCalls = [];
  let cursor = 0;

  // Once Anthropic native XML function-calling formatini ayikla.
  // <function_calls><invoke name="X"><parameter name="Y">Z</parameter></invoke></function_calls>
  const xmlExtracted = extractAnthropicXmlFunctionCalls(cleaned);
  if (xmlExtracted.toolCalls.length > 0) {
    toolCalls.push(...xmlExtracted.toolCalls);
    return { text: xmlExtracted.text, toolCalls };
  }

  for (const match of cleaned.matchAll(TOOL_BLOCK_RE)) {
    const start = match.index ?? 0;
    const segment = match[1] ?? '';
    const before = cleaned.slice(cursor, start).trim();
    if (before) {
      textBlocks.push(before);
    }

    const malformedSegment = extractMalformedXmlToolCalls(segment);
    if (malformedSegment.toolCalls.length > 0) {
      toolCalls.push(...malformedSegment.toolCalls);
      if (malformedSegment.text) {
        textBlocks.push(malformedSegment.text);
      }
      cursor = start + match[0].length;
      continue;
    }

    const headerSource = segment.split('<arg_value>')[0].replace(/<\/arg_value>/g, '').trim();
    const parsedHeader = parseHeader(headerSource);
    if (parsedHeader?.name) {
      const input = mergeArgValues({ ...parsedHeader.input }, segment);
      toolCalls.push({
        id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
        name: parsedHeader.name,
        input
      });
    } else {
      const fallback = segment.replace(/<\/?arg_value>/g, '').trim();
      if (fallback) {
        textBlocks.push(fallback);
      }
    }

    cursor = start + match[0].length;
  }

  const after = cleaned.slice(cursor).trim();
  if (after) {
    textBlocks.push(after);
  }

  // Fallback parsing for official <tool_use> tags
  const toolUseMatches = [...textBlocks.join('\n').matchAll(/<tool_use>([\s\S]*?)(?:<\/tool_use>|$)/gi)];
  let updatedTextBlocks = [...textBlocks];
  let updatedToolCalls = [...toolCalls];
  if (toolUseMatches.length > 0) {
    updatedTextBlocks = [];
    updatedToolCalls = [...toolCalls];
    for (const block of textBlocks) {
      let remaining = block;
      for (const match of toolUseMatches) {
        const start = remaining.indexOf(match[0]);
        if (start === -1) continue;
        if (start > 0) updatedTextBlocks.push(remaining.slice(0, start).trim());
        // Extract tool name and input from <tool_use> content
        const toolContent = match[1].trim();
        const parsedToolUse = parseHeader(toolContent);
        if (parsedToolUse?.name) {
          updatedToolCalls.push({
            id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
            name: parsedToolUse.name,
            input: parsedToolUse.input
          });
        } else {
          const pathMatch = toolContent.match(/path="([^"\n]+)"/);
          if (pathMatch && toolContent.startsWith('ReadFile')) {
            updatedToolCalls.push({
              id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
              name: 'ReadFile',
              input: { path: normalizeEscapedPath(pathMatch[1]) }
            });
          }
        }
        remaining = remaining.slice(start + match[0].length).trim();
      }
      if (remaining) updatedTextBlocks.push(remaining);
    }
  }

  let currentText = updatedTextBlocks.join('\n\n').trim();
  const malformedXml = extractMalformedXmlToolCalls(currentText);
  currentText = malformedXml.text;
  updatedToolCalls.push(...malformedXml.toolCalls);

  const fencedBash = extractFencedBashBlocks(currentText);
  currentText = fencedBash.text;
  updatedToolCalls.push(...fencedBash.toolCalls);

  const fileWriteBlocks = extractFileWriteBlocks(currentText);
  currentText = fileWriteBlocks.text;
  updatedToolCalls.push(...fileWriteBlocks.toolCalls);

  const looseToolCalls = [];
  const residualLines = [];
  for (const line of currentText.split('\n')) {
    const parsedLine = parseLooseToolLine(line);
    if (parsedLine) {
      looseToolCalls.push(parsedLine);
    } else if (line.trim()) {
      residualLines.push(line);
    }
  }
  if (looseToolCalls.length > 0) {
    updatedToolCalls.push(...looseToolCalls);
    currentText = residualLines.join('\n').trim();
  }

  if (updatedToolCalls.length === 0) {
    const providerMatches = [...currentText.matchAll(/functions\.(\w+):(\d+)/gi)];
    if (providerMatches.length > 0) {
      let stripped = currentText;
      for (const match of providerMatches) {
        const name = match[1]?.toLowerCase();
        if (!name) continue;
        const matchEnd = (match.index ?? 0) + match[0].length;
        const afterText = currentText.slice(matchEnd, matchEnd + 300);
        let input = {};
        const jsonMatch = afterText.match(/^\{[\s\S]*?\}/);
        if (jsonMatch) {
          try { input = JSON.parse(jsonMatch[0]); } catch { input = {}; }
        }
        if (!input.command && !input.description) {
          if (name === 'bash' || name === 'glob' || name === 'read' || name === 'grep' || name === 'write' || name === 'edit') {
            const lineMatch = afterText.match(/^[\s]*([^\n|<]+)/);
            if (lineMatch) {
              const potentialCmd = lineMatch[1].replace(/^[:\s]+/, '').replace(/["']+$/, '').trim();
              if (potentialCmd && potentialCmd.length < 500 && !potentialCmd.startsWith('{')) {
                input.command = potentialCmd;
                input.description = `Command from ${name} tool`;
              }
            }
          }
        }
        if (!input.command && !input.description) {
          input.command = '';
          input.description = 'Auto-generated from provider format';
        }
        toolCalls.push({
          id: `toolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          name,
          input
        });
        stripped = stripped.replace(match[0], '').trim();
      }
      return { text: stripped, toolCalls };
    }

    const fencedMatches = [...currentText.matchAll(FENCED_JSON_RE)];
    if (fencedMatches.length > 0) {
      let stripped = currentText;
      for (const match of fencedMatches) {
        const toolCall = normalizeJsonToolCandidate(match[1] ?? '');
        if (!toolCall) {
          continue;
        }
        toolCalls.push(toolCall);
        stripped = stripped.replace(match[0], '').trim();
      }

      return {
        text: stripped,
        toolCalls
      };
    }

    const bareJsonToolCall = normalizeJsonToolCandidate(currentText);
    if (bareJsonToolCall) {
      return {
        text: '',
        toolCalls: [bareJsonToolCall]
      };
    }
  }

  return {
    text: currentText,
    toolCalls: updatedToolCalls
  };
}

// NOT: Proxy'nin eski surumleri, upstream tool_call uretmediginde kendisi Linux-ozgu
// komutlar ('find . -maxdepth 2', '/workspace/...', '/init' branch'leri vb.)
// enjekte ediyordu. Bu proje-agnostik olmayi ve cross-platform calismayi bozuyordu.
// Tamami kaldirildi: proxy artik sadece upstream'in gercek ciktisini normalize eder.

export function applyAnthropicNormalization(payload, requestBody) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.content)) {
    return payload;
  }

  const content = [];
  const extractedToolCalls = [];

  for (const block of payload.content) {
    if (block?.type === 'thinking') {
      content.push(block);
      continue;
    }
    if (block?.type === 'tool_use') {
      extractedToolCalls.push({
        id: block.id ?? `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
        name: block.name,
        input: block.input ?? {}
      });
      continue;
    }

    if (block?.type === 'text' && typeof block.text === 'string') {
      const normalized = extractPseudoToolCalls(block.text);
      if (normalized.text) {
        content.push({ type: 'text', text: normalized.text });
      }
      extractedToolCalls.push(...normalized.toolCalls);
      continue;
    }

    if (block) {
      content.push(block);
    }
  }

  let normalizedToolCalls = dropEmptyBrokenToolCalls(
    canonicalizeToolCalls(combineFragmentedToolCalls(extractedToolCalls), requestBody)
  );
  normalizedToolCalls = suppressRepeatedReadToolCalls(normalizedToolCalls, requestBody);

  // Weak models sometimes emit `Write CLAUDE.md` as a tool call, then put the
  // actual file contents in a fenced code block in the adjacent text block.
  // If we already have exactly one write call with a target path but no
  // content, attach the first fenced block's content to that write call.
  const writeCallsMissingContent = normalizedToolCalls.filter((toolCall) => {
    const normalizedName = normalizeName(toolCall.name);
    const input = toolCall.input && typeof toolCall.input === 'object' ? toolCall.input : {};
    const pathValue = input.file_path ?? input.filePath ?? input.path;
    return normalizedName === 'write' &&
      Boolean(pathValue) &&
      (input.content === undefined || input.content === '' || input.content === input.value || input.content === pathValue);
  });
  if (writeCallsMissingContent.length === 1) {
    const textBlock = content.find((block) => block?.type === 'text' && typeof block?.text === 'string' && block.text.includes('```'));
    const fencedBlock = extractFirstFencedCodeBlock(textBlock?.text);
    if (fencedBlock?.content) {
      writeCallsMissingContent[0].input = {
        ...writeCallsMissingContent[0].input,
        content: fencedBlock.content
      };
      if (textBlock) {
        const strippedText = textBlock.text.replace(fencedBlock.raw, '').trim();
        textBlock.text = strippedText;
      }
    }
    normalizedToolCalls = suppressRepeatedReadToolCalls(normalizedToolCalls, requestBody);
  }

  // Post-Write duplicate suppression: onceki asistant turunda Write(X,
  // content) yapildi ve bu turun text'inde ayni content'in fenced block'u
  // var ise, model basarili yazmayi "ozetledigini dusunup" content'i
  // tekrar basiyor. Bu her turde olabilir - tool_use varken bile model
  // yanlisligi fence'te basabilir. Dil-bagimsiz content match'ine bakar.
  stripPostWriteDuplicateFencedBlocks(content, requestBody);

  // Write enforcement (dil-bagimsiz, yapisal):
  // Zayif modeller bazen dosya iceriğini text icinde fenced code block olarak
  // basip Write tool_use uretmeyi unutuyor - yanyana baska tool_use'lar
  // (Bash/Read) gonderiyor ama Write yok. Eger bu turda text'te substantial
  // fenced block var, explicit bir dosya adi gecerken (kod blogundan ONCE),
  // ve hic Write tool_use yoksa (ne bu turda ne gecmiste basarili), proxy
  // Write'i zorlayarak sentezler. Mevcut tool_use'lari (Bash vb.) silmez -
  // sadece Write'i eklemez.
  normalizedToolCalls = enforceWriteFromFencedContent(
    normalizedToolCalls, content, requestBody
  );

  // Intent synthesis (proje/OS/DIL agnostik): upstream model tool_call
  // uretmediyse, istemcinin tool listesinden uygun olanla sentezle.
  // Felsefe: deterministik sinyaller (tool-history, fenced block yapisi,
  // render container, dosya adi, slash-command) kullanilir; dile bagli
  // kelime regex'leri YOK. Boylece Cince/Almanca/Rusca kullanicilari da
  // ayni sekilde calisir. Kapatmak icin: SYNTHESIZE_INTENT=0
  if (normalizedToolCalls.length === 0) {
    const combinedModelText = content
      .filter((b) => b?.type === 'text' && typeof b?.text === 'string')
      .map((b) => b.text)
      .join('\n');
    const synthesized = synthesizeToolCallsFromIntent(combinedModelText, requestBody, [], payload?.stop_reason);
    if (synthesized.length > 0) {
      normalizedToolCalls = synthesized;
    }
  }

  if (normalizedToolCalls.length === 0) {

    // NOT: Onceki versiyonda "malformed completion" tespiti vardi - stray
    // kapanis tag'i tespit edip kullaniciya hata mesaji donuyordu. Bu cok
    // yanlis pozitif veriyordu: model legitimate ozet cevaplarinda, HTML
    // icerigini anlatirken, vs. tetikleniyordu. Model'in gercek text cevabini
    // proxy asla BASKASIYLA DEGISTIRMEMELI. Kullanici metni gorecek, gerekirse
    // yeniden soracak. Sessiz stall ile bu senaryo arasinda, text'e dokunmamak
    // daha guvenli.

    // Hic tool_use yok; upstream payload'u hala stop_reason: 'tool_use' ile
    // gelmis olabilir (cunku bozuk <tool_call> metin ekledi). Bu durumda
    // Anthropic istemcileri (Claude Code vs.) "parallel tool error" / loop
    // kilitlenmesi yaratir. stop_reason'u end_turn'e indir.
    if (content.length === 0) {
      content.push({ type: 'text', text: '' });
    }
    return {
      ...payload,
      content,
      stop_reason: payload.stop_reason === 'tool_use' ? 'end_turn' : (payload.stop_reason ?? 'end_turn')
    };
  }

  // Parallel tool call collapse: ayni turda ayni tool icin birden fazla call varsa
  // sadece ilkini birak. Komut icerigi HIC degistirilmez, sadece paralellik kaldirilir.
  // Bu, Claude Code'un "parallel tool error" ile kalanini iptal etmesi ve sistemin
  // kilitlenmesini onler. Farkli tool'lar (ornek: 1 bash + 1 read) korunur.
  const emittedToolCalls = COLLAPSE_PARALLEL_TOOL_CALLS
    ? collapseParallelToolCalls(normalizedToolCalls)
    : normalizedToolCalls;

  for (const toolCall of emittedToolCalls) {
    content.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.name,
      input: toolCall.input
    });
  }

  return {
    ...payload,
    content,
    stop_reason: 'tool_use'
  };
}

export function applyOpenAiChatNormalization(payload, requestBody) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.choices)) {
    return payload;
  }

  const choices = payload.choices.map((choice) => {
    const message = choice?.message;
    if (!message) {
      return choice;
    }

    // Structured tool_calls: normalize them through canonicalizeToolCalls for schema sync
    if (Array.isArray(message.tool_calls)) {
      let parsedCalls;
      try {
        parsedCalls = message.tool_calls.map((tc, idx) => ({
          id: tc.id ?? `call_${idx}`,
          name: tc.function?.name ?? tc.name ?? '',
          input: typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : (tc.function?.arguments ?? tc.input ?? {})
        }));
      } catch {
        return choice;
      }
      const canonical = canonicalizeToolCalls(parsedCalls, requestBody);
      // Drop empty/broken tool_calls (e.g. read({}) from weak models).
      // This was missing from the OpenAI-chat path; only Anthropic path had it.
      const cleanedToolCalls = dropEmptyBrokenToolCalls(canonical);
      const suppressedToolCalls = suppressRepeatedReadToolCalls(cleanedToolCalls, requestBody);
      const emittedToolCalls = COLLAPSE_PARALLEL_TOOL_CALLS
        ? collapseParallelToolCalls(suppressedToolCalls)
        : suppressedToolCalls;

      // If EVERY tool_call was dropped as broken, fall back to end_turn text
      // (prevents 'parallel tool error' / infinite retry from Anthropic clients).
      if (emittedToolCalls.length === 0) {
        return {
          ...choice,
          finish_reason: 'stop',
          message: {
            ...message,
            content: message.content || '',
            tool_calls: undefined
          }
        };
      }

      return {
        ...choice,
        finish_reason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'tool_calls',
        message: {
          ...message,
          content: message.content ?? null,
          tool_calls: emittedToolCalls.map((toolCall, index) => ({
            id: toolCall.id,
            type: 'function',
            index,
            function: {
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.input)
            }
          }))
        }
      };
    }

    if (typeof message.content !== 'string') {
      return choice;
    }

    const normalized = extractPseudoToolCalls(message.content);
    normalized.toolCalls = suppressRepeatedReadToolCalls(
      canonicalizeToolCalls(normalized.toolCalls, requestBody),
      requestBody
    );

    // Intent synthesis: zayif modeller text atiyor, tool call uretmiyor.
    // Kod blogu + dosya adi vb. niyetlerden tool call sentezle.
    if (normalized.toolCalls.length === 0) {
      const synthesized = synthesizeToolCallsFromIntent(normalized.text, requestBody, []);
      if (synthesized.length > 0) {
        normalized.toolCalls = synthesized;
      }
    }

    if (normalized.toolCalls.length === 0) {
      if (normalized.text !== message.content) {
        return {
          ...choice,
          message: {
            ...message,
            content: normalized.text
          }
        };
      }
      return choice;
    }

    // Parallel tool call collapse (OpenAI tarafi): ayni choice icinde ayni tool'a
    // birden fazla call geldiyse sadece ilkini birak. Komut icerigi degistirilmez.
    const emittedToolCalls = COLLAPSE_PARALLEL_TOOL_CALLS
      ? collapseParallelToolCalls(normalized.toolCalls)
      : normalized.toolCalls;

    return {
      ...choice,
      finish_reason: 'tool_calls',
      message: {
        ...message,
        content: normalized.text || null,
        tool_calls: emittedToolCalls.map((toolCall, index) => ({
          id: `call_${toolCall.id}`,
          type: 'function',
          index,
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.input)
          }
        }))
      }
    };
  });

  return {
    ...payload,
    choices
  };
}

export function applyOpenAiResponsesNormalization(payload, requestBody) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.output)) {
    return payload;
  }

  const output = payload.output.flatMap((item) => {
    if (item?.type !== 'message' || !Array.isArray(item.content)) {
      return [item];
    }

    const text = item.content
      .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
    const normalized = extractPseudoToolCalls(text);
    normalized.toolCalls = suppressRepeatedReadToolCalls(
      canonicalizeToolCalls(normalized.toolCalls, requestBody),
      requestBody
    );

    if (normalized.toolCalls.length === 0) {
      if (normalized.text && normalized.text !== text) {
        return [{
          ...item,
          content: [{ type: 'output_text', text: normalized.text, annotations: [] }]
        }];
      }
      return [item];
    }

    const parts = [];
    if (normalized.text) {
      parts.push({ type: 'output_text', text: normalized.text, annotations: [] });
    }

    // Parallel tool call collapse (OpenAI Responses)
    const emittedToolCalls = COLLAPSE_PARALLEL_TOOL_CALLS
      ? collapseParallelToolCalls(normalized.toolCalls)
      : normalized.toolCalls;

    return [
      {
        ...item,
        content: parts
      },
      ...emittedToolCalls.map((toolCall) => ({
        id: `fc_${toolCall.id}`,
        type: 'function_call',
        call_id: toolCall.id,
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.input),
        status: 'completed'
      }))
    ];
  });

  return {
    ...payload,
    output
  };
}

export function normalizeJsonPayload(pathname, payload, requestBody) {
  if (pathname.includes('/anthropic/')) {
    return applyAnthropicNormalization(payload, requestBody);
  }

  if (pathname.endsWith('/chat/completions')) {
    return applyOpenAiChatNormalization(payload, requestBody);
  }

  if (pathname.endsWith('/responses')) {
    return applyOpenAiResponsesNormalization(payload, requestBody);
  }

  return payload;
}

function isAnthropicToolSchema(tool) {
  return tool?.input_schema !== undefined;
}

function isOpenAiFunctionTool(tool) {
  return tool?.type === 'function' && tool?.function?.name !== undefined;
}

function convertAnthropicToOpenAiTools(tools) {
  if (!Array.isArray(tools)) {
    return tools;
  }
  return tools.map((tool) => {
    if (!isAnthropicToolSchema(tool)) {
      return tool;
    }
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema
      }
    };
  });
}

function convertOpenAiToAnthropicTools(tools) {
  if (!Array.isArray(tools)) {
    return tools;
  }
  return tools.map((tool) => {
    if (!isOpenAiFunctionTool(tool)) {
      return tool;
    }
    const fn = tool.function;
    return {
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters
    };
  });
}

function isOpenAiMessageWithToolResult(message) {
  return message?.role === 'tool';
}

function isAnthropicMessageWithToolResult(message) {
  if (message?.role !== 'user') {
    return false;
  }
  return Array.isArray(message?.content) && message.content.some((block) => block?.type === 'tool_result');
}

function convertOpenAiToolResultToAnthropic(message) {
  if (!isOpenAiMessageWithToolResult(message)) {
    return message;
  }
  const toolCallId = message.tool_call_id;
  const content = message.content;
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolCallId,
        content: typeof content === 'string' ? content : String(content)
      }
    ]
  };
}

function convertAnthropicToolResultToOpenAi(message) {
  if (!isAnthropicMessageWithToolResult(message)) {
    return message;
  }
  const toolResultBlock = message.content.find((block) => block?.type === 'tool_result');
  return {
    role: 'tool',
    tool_call_id: toolResultBlock?.tool_use_id,
    content: typeof toolResultBlock?.content === 'string' ? toolResultBlock.content : JSON.stringify(toolResultBlock?.content)
  };
}

function isOpenAiMessageWithToolCalls(message) {
  return message?.role === 'assistant' && Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
}

function isAnthropicMessageWithToolUse(message) {
  if (message?.role !== 'assistant') {
    return false;
  }
  return Array.isArray(message?.content) && message.content.some((block) => block?.type === 'tool_use');
}

const PROVIDER_FUNCTION_RE = /functions\.(\w+):(\d+)/gi;
const PROVIDER_FUNCTION_SIMPLE_RE = /functions\.(\w+):/gi;

function extractJsonArguments(text, startPos) {
  const input = {};

  const braceStart = text.indexOf('{', startPos);
  if (braceStart !== -1) {
    let braceEnd = braceStart + 1;
    let depth = 1;
    while (depth > 0 && braceEnd < text.length) {
      if (text[braceEnd] === '{') depth++;
      if (text[braceEnd] === '}') depth--;
      braceEnd++;
    }
    const jsonStr = text.slice(braceStart, braceEnd);
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {}
  }

  const afterText = text.slice(startPos, startPos + 150).trim();
  const cmdMatch = afterText.match(/(?:command|cmd)\s*["']?\s*[:=]\s*["']?([^"',}\n]+)/i);
  if (cmdMatch) {
    input.command = cmdMatch[1].replace(/["'];?$/, '').trim();
  }
  const descMatch = afterText.match(/(?:description|desc|reason)\s*["']?\s*[:=]\s*["']?([^"',}\n]+)/i);
  if (descMatch) {
    input.description = descMatch[1].replace(/["'];?$/, '').trim();
  }

  return input;
}

function convertProviderStyleToolCallsToAnthropicToolUse(message) {
  if (!message?.content || typeof message.content !== 'string') {
    return message;
  }
  const content = message.content;
  const toolCalls = [];
  let lastEnd = 0;

  const functionMatches = [...content.matchAll(PROVIDER_FUNCTION_RE)];
  const simpleMatches = [...content.matchAll(PROVIDER_FUNCTION_SIMPLE_RE)];

  if (functionMatches.length === 0 && simpleMatches.length === 0) {
    return message;
  }

  const allMatches = [...functionMatches, ...simpleMatches].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  for (const match of allMatches) {
    const name = match[1]?.toLowerCase();
    if (!name) {
      continue;
    }

    const matchStart = match.index ?? 0;
    if (matchStart > lastEnd) {
      const beforeText = content.slice(lastEnd, matchStart).trim();
      if (beforeText) {
        toolCalls.push({ type: 'text', text: beforeText });
      }
    }

    let input = {};
    const argsJson = match[3];
    if (argsJson) {
      try {
        input = JSON.parse(argsJson);
      } catch {
        input = extractArgumentsFromText(argsJson);
      }
    }

    if (Object.keys(input).length === 0) {
      const afterMatch = content.slice(matchStart + match[0].length, matchStart + match[0].length + 200).match(/^([^<|\n]+)/);
      if (afterMatch) {
        input = extractArgumentsFromText(afterMatch[1]);
      }
    }

    if (Object.keys(input).length === 0) {
      input = { command: '', description: 'Auto-generated from provider format' };
    }

    toolCalls.push({
      type: 'tool_use',
      id: `toolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: name,
      input
    });
    lastEnd = matchStart + match[0].length;
  }

  if (toolCalls.length === 0) {
    return message;
  }

  return {
    ...message,
    role: 'assistant',
    stop_reason: 'tool_use',
    content: toolCalls
  };
}

function convertOpenAiToolCallsToAnthropicToolUse(message) {
  if (!isOpenAiMessageWithToolCalls(message)) {
    return convertProviderStyleToolCallsToAnthropicToolUse(message);
  }
  const content = message.content
    ? typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : Array.isArray(message.content)
        ? message.content
        : [{ type: 'text', text: String(message.content) }]
    : [];
  for (const toolCall of message.tool_calls) {
    const fn = toolCall.function;
    let input;
    try {
      input = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments;
    } catch {
      input = {};
    }
    content.push({
      type: 'tool_use',
      id: toolCall.id,
      name: fn.name,
      input
    });
  }
  return { ...message, content };
}

function convertAnthropicToolUseToOpenAiToolCalls(message) {
  if (!isAnthropicMessageWithToolUse(message)) {
    return message;
  }
  const toolCalls = [];
  const content = [];
  for (const block of message.content) {
    if (block?.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input)
        }
      });
    } else {
      content.push(block);
    }
  }
  return {
    ...message,
    content: content.length > 0 ? content.map((c) => (typeof c === 'string' ? c : c.text ?? JSON.stringify(c))).join('\n\n') : null,
    tool_calls: toolCalls
  };
}

export function normalizeRequestMessages(requestBody, targetPath) {
  if (!requestBody || typeof requestBody !== 'object' || !Array.isArray(requestBody.messages)) {
    return requestBody;
  }

  const isAnthropicRequest = targetPath.includes('/anthropic/') || targetPath === '/v1/messages';
  const isOpenAiRequest = targetPath.endsWith('/chat/completions');

  const hasOpenAiToolResult = requestBody.messages.some(isOpenAiMessageWithToolResult);
  const hasAnthropicToolResult = requestBody.messages.some(isAnthropicMessageWithToolResult);
  const hasOpenAiToolCalls = requestBody.messages.some(isOpenAiMessageWithToolCalls);
  const hasAnthropicToolUse = requestBody.messages.some(isAnthropicMessageWithToolUse);

  if (isAnthropicRequest && (hasOpenAiToolResult || hasOpenAiToolCalls)) {
    return {
      ...requestBody,
      messages: requestBody.messages.map((msg) => convertOpenAiToolCallsToAnthropicToolUse(convertOpenAiToolResultToAnthropic(msg)))
    };
  }

  if (isOpenAiRequest && (hasAnthropicToolResult || hasAnthropicToolUse)) {
    return {
      ...requestBody,
      messages: requestBody.messages.map((msg) => convertAnthropicToolUseToOpenAiToolCalls(convertAnthropicToolResultToOpenAi(msg)))
    };
  }

  return requestBody;
}

export function normalizeRequestTools(requestBody, targetPath) {
  if (!requestBody || typeof requestBody !== 'object') {
    return requestBody;
  }

  const hasTools = Array.isArray(requestBody.tools) && requestBody.tools.length > 0;
  const isAnthropicRequest = targetPath.includes('/anthropic/') || targetPath === '/v1/messages';
  const isOpenAiRequest = targetPath.endsWith('/chat/completions');

  if (!hasTools) {
    return requestBody;
  }

  if (isAnthropicRequest && requestBody.tools.some(isOpenAiFunctionTool)) {
    return {
      ...requestBody,
      tools: convertOpenAiToAnthropicTools(requestBody.tools)
    };
  }

  if (isOpenAiRequest && requestBody.tools.some(isAnthropicToolSchema)) {
    return {
      ...requestBody,
      tools: convertAnthropicToOpenAiTools(requestBody.tools)
    };
  }

  return requestBody;
}

export function maybeRewriteModel(requestBody, aliases) {
  if (!requestBody || typeof requestBody !== 'object') {
    return requestBody;
  }

  const requestedModel = requestBody.model;
  if (typeof requestedModel !== 'string' || !aliases[requestedModel]) {
    return requestBody;
  }

  return {
    ...requestBody,
    model: aliases[requestedModel]
  };
}

export function restorePresentedModel(requestBody, responseBody) {
  if (!requestBody || typeof requestBody !== 'object' || !responseBody || typeof responseBody !== 'object') {
    return responseBody;
  }

  if (typeof requestBody.model !== 'string') {
    return responseBody;
  }

  if (typeof responseBody.model === 'string') {
    return {
      ...responseBody,
      model: requestBody.model
    };
  }

  return responseBody;
}
