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

const THINK_TAG_RE = /<think>[\s\S]*?<\/think>/gi;
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
const INSTRUMENTATION_TAG_RE = /<\/?(?:command_message|system-reminder|local-command-stdout|local-command-stderr|local-command|command_stdout|command_stderr)[^>]*>/gi;
const INSTRUMENTATION_BLOCK_RE = /\n?\s*<(?:command_message|system-reminder|local-command-stdout|local-command-stderr|local-command|command_stdout|command_stderr)[^>]*>[\s\S]*$/i;
const GENERIC_COMMAND_TAG_RE = /<\/?command[^>]*>/gi;
const LEADING_SINGLE_DASH_CMD_RE = /^-([A-Za-z][\w.-]*)(\s|$)/;

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
    .replace(/<\/think>[\s\S]*$/i, '')
    .replace(/<\/bash>[\s\S]*$/i, '')
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

function sanitizeToolText(value) {
  if (typeof value !== 'string') {
    return value;
  }
  return value
    .replace(/(?:^|\n)\s*(?:tool_use>\s*){2,}(?=\n|$)/gim, '\n')
    .replace(/(?:^|\n)\s*(?:tool_use\s*){2,}(?=\n|$)/gim, '\n')
    .replace(/^\s*tool_use>\s*$/gim, '')
    .replace(/^\s*tool_use\s*$/gim, '')
    .replace(/^tool_use_input>\s*$/gim, '')
    .replace(/^<server_name>\s*filesystem\s*<\/server_name>\s*$/gim, '')
    .replace(/^\{"name":\s*$/gim, '')
    .trim();
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

function dropEmptyBrokenToolCalls(toolCalls) {
  return toolCalls.filter((toolCall) => {
    const normalized = normalizeName(toolCall.name);
    const input = toolCall.input && typeof toolCall.input === 'object' ? toolCall.input : {};
    if (isMetaToolToken(normalized)) {
      return false;
    }
    if ((normalized === 'bash' || normalized === 'read' || normalized === 'glob' || normalized === 'grep' || normalized === 'skill' || normalized === 'delete') && Object.keys(input).length === 0) {
      return false;
    }
    if (normalized === 'bash' && !input.command && !input.value && !input.arguments) {
      return false;
    }
    if (normalized === 'read' && isBogusReadTarget(input.file_path ?? input.filePath ?? input.path ?? input.value ?? input.arguments)) {
      return false;
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

function extractPathFromReadLikeCommand(command) {
  const source = sanitizeCommand(command);
  if (typeof source !== 'string' || !source) {
    return null;
  }
  const catMatch = source.match(/^(?:cat|type)\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+|$)/i);
  if (catMatch) {
    return normalizeEscapedPath(catMatch[1] ?? catMatch[2] ?? catMatch[3]);
  }
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

function suppressRepeatedReadToolCalls(toolCalls, requestBody) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return toolCalls;
  }
  const context = getLastToolResultContext(requestBody);
  if (!context?.previousAssistant) {
    return toolCalls;
  }
  const previousReadTargets = new Set(getReadTargetsFromAssistantMessage(context.previousAssistant));
  if (previousReadTargets.size === 0) {
    return toolCalls;
  }

  let keptReadCount = 0;
  return toolCalls.filter((toolCall) => {
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
}

function canonicalizeToolCalls(toolCalls, requestBody) {
  const registry = buildToolRegistry(requestBody);
  if (registry.size === 0) {
    return toolCalls;
  }

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
  // Remove closed think tags and unclosed `<think>` tags
  return sanitizeToolText(value
    .replace(THINK_TAG_RE, '')
    .replace(/<think>[\s\S]*?(?=\n|$)/gi, '')
    .replace(/\r\n/g, '\n')
    .trim());
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
  return /^read(?:file(?:contents)?)?[>:]+$/i.test(trimmed);
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

export function extractPseudoToolCalls(text) {
  const source = String(text ?? '');
  const cleaned = cleanText(source).trim();
  const textBlocks = [];
  const toolCalls = [];
  let cursor = 0;

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

  // Intent synthesis (proje/OS agnostik): upstream model tool_call uretmediyse
  // ama text'te net bir niyet varsa (kod blogu + dosya adi, "let me read X",
  // "/init" + stalling), istemcinin tool listesindeki uygun tool'a sentezle.
  // Boylece zayif modeller (glm-5, llama vb.) bile Claude Code / OpenCode gibi
  // Anthropic uyumlu istemcilerde kodlama asistani olarak kullanilabilir.
  // Kapatmak icin: SYNTHESIZE_INTENT=0
  if (normalizedToolCalls.length === 0) {
    const combinedModelText = content
      .filter((b) => b?.type === 'text' && typeof b?.text === 'string')
      .map((b) => b.text)
      .join('\n');
    const synthesized = synthesizeToolCallsFromIntent(combinedModelText, requestBody, []);
    if (synthesized.length > 0) {
      normalizedToolCalls = synthesized;
    }
  }

  if (normalizedToolCalls.length === 0) {
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
      const normalizedToolCalls = suppressRepeatedReadToolCalls(
        canonicalizeToolCalls(parsedCalls, requestBody),
        requestBody
      );
      const emittedToolCalls = COLLAPSE_PARALLEL_TOOL_CALLS
        ? collapseParallelToolCalls(normalizedToolCalls)
        : normalizedToolCalls;
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
