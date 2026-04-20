import crypto from 'node:crypto';

const THINK_TAG_RE = /<think>[\s\S]*?<\/think>/gi;
const TOOL_BLOCK_RE = /<tool_call>([\s\S]*?)(?=(?:<tool_call>|$))/gi;
const ARG_VALUE_RE = /<arg_value>([\s\S]*?)(?=<\/arg_value>|$)/gi;
const ARG_KEY_RE = /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>/i;
const ATTR_RE = /([A-Za-z_][\w-]*)="([^"]*)"/g;
const FENCED_JSON_RE = /```json\s*([\s\S]*?)```/gi;
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

function sanitizeCommand(value) {
  if (typeof value !== 'string') {
    return value;
  }
  return value
    .replace(/[^\x09\x0A\x0D\x20-\x7E]+/g, '')
    .replace(/<\/think>[\s\S]*$/i, '')
    .replace(/<\/bash>[\s\S]*$/i, '')
    .replace(/<\/?parameter>/gi, '')
    .replace(/<\/?arg_value>/gi, '')
    .replace(/<\/?tool_call>/gi, '')
    .replace(/<\/[A-Za-z_][\w-]*>$/g, '')
    .replace(/<\/$/g, '')
    .replace(/[A-Za-z][A-Za-z0-9_-]*>$/g, '')
    .replace(/^>\s*/, '')
    .trim();
}

function sanitizeToolText(value) {
  if (typeof value !== 'string') {
    return value;
  }
  return value
    .replace(/^\s*tool_use>\s*$/gim, '')
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

  if (normalizedToolName === 'bash') {
    result.command = sanitizeCommand(result.command ?? result.value ?? result.arguments);
    result.description = result.description ?? synthesizeDescription(result.command);
  }

  if (normalizedToolName === 'task') {
    result.description = result.description ?? result.task ?? (typeof result.value === 'string' ? result.value : undefined) ?? 'Delegates work to a subagent';
    result.prompt = result.prompt ?? result.description;
    result.subagent_type = result.subagent_type ?? 'general';
  }

  if (normalizedToolName === 'read') {
    const catPath = extractPathFromCatCommand(result.command ?? result.value ?? result.arguments);
    result.filePath = normalizeEscapedPath(result.filePath ?? result.value ?? catPath);
    result.file_path = normalizeEscapedPath(result.file_path ?? result.filePath ?? result.value ?? catPath);
    result.path = normalizeEscapedPath(result.path ?? result.file_path ?? result.filePath);
  }

  if (normalizedToolName === 'glob' || normalizedToolName === 'grep') {
    result.pattern = result.pattern ?? result.value;
  }

  if (normalizedToolName === 'glob' && result.pattern === undefined && typeof result.path === 'string') {
    const base = result.path.replace(/[\\/]+$/, '');
    result.pattern = base === '.' ? '*' : `${base}/*`;
  }

  if ((normalizedToolName === 'write' || normalizedToolName === 'edit') && result.filePath === undefined) {
    result.filePath = normalizeEscapedPath(result.path ?? result.file ?? result.filename ?? (looksLikePath(result.value) ? result.value : undefined));
  }

  if (normalizedToolName === 'write' || normalizedToolName === 'edit') {
    result.file_path = normalizeEscapedPath(result.file_path ?? result.filePath ?? result.path ?? result.file ?? result.filename ?? (looksLikePath(result.value) ? result.value : undefined));
  }

  if (normalizedToolName === 'write' && result.content === undefined) {
    result.content = looksLikePath(result.value) ? result.content : result.value;
  }

  if (normalizedToolName === 'write') {
    result.filePath = normalizeEscapedPath(result.filePath ?? result.file_path ?? result.path ?? result.file ?? result.filename);
    result.file_path = normalizeEscapedPath(result.file_path ?? result.filePath);
    result.content = result.content ?? result.text ?? result.body;
  }

  if (normalizedToolName === 'edit') {
    result.oldString = result.oldString ?? result.search ?? result.find;
    result.newString = result.newString ?? result.replace ?? result.replacement;
    result.old_string = result.old_string ?? result.oldString ?? result.search ?? result.find;
    result.new_string = result.new_string ?? result.newString ?? result.replace ?? result.replacement;
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
    if ((normalized === 'bash' || normalized === 'read' || normalized === 'glob' || normalized === 'grep' || normalized === 'skill' || normalized === 'delete') && Object.keys(input).length === 0) {
      return false;
    }
    if (normalized === 'bash' && !input.command && !input.value && !input.arguments) {
      return false;
    }
    if (normalized === 'delete' && !input.file_path && !input.filePath && !input.path) {
      return false;
    }
    if (normalized === 'skill' && !input.command && !input.value && !input.arguments && !input.prompt) {
      return false;
    }
    return true;
  });
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

function canonicalizeToolCalls(toolCalls, requestBody) {
  const registry = buildToolRegistry(requestBody);
  if (registry.size === 0) {
    return toolCalls;
  }

  return toolCalls.map((toolCall) => {
    const resolvedName = canonicalizeToolName(toolCall.name, registry);
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
    return {
      ...toolCall,
      name: resolvedName,
      input: coerceToolInput(resolvedName, input, schema)
    };
  });
}

function flattenMessageText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) => {
      if (typeof block?.text === 'string') {
        return block.text;
      }
      if (typeof block === 'string') {
        return block;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
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

function parseLooseToolLine(line) {
  const trimmed = sanitizeToolText(line)?.trim();
  if (!trimmed) {
    return null;
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
    return {
      id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
      name,
      input: { value: value.trim() }
    };
  }

  const wordThenValue = trimmed.match(/^([A-Za-z_][\w-]*)\s+(.+)$/);
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

function looksLikeFileReadBashCommand(command) {
  const text = sanitizeCommand(command);
  return typeof text === 'string' && /^(cat|head|tail)\s+/i.test(text);
}

function extractPathFromReadBashCommand(command) {
  const text = sanitizeCommand(command);
  if (typeof text !== 'string' || !text) {
    return null;
  }

  const catPath = extractPathFromCatCommand(text);
  if (catPath) {
    return catPath;
  }

  const match = text.match(/^(?:head|tail)(?:\s+-\S+)*\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+|$)/i);
  return normalizeEscapedPath(match?.[1] ?? match?.[2] ?? match?.[3] ?? null);
}

function hasRecentAssistantReadToolUse(requestBody) {
  return Array.isArray(requestBody?.messages) && requestBody.messages
    .slice(-3)
    .some((message) =>
      message?.role === 'assistant' &&
      Array.isArray(message?.content) &&
      message.content.some((block) => {
        if (block?.type !== 'tool_use') {
          return false;
        }
        const normalizedName = normalizeName(block?.name);
        if (normalizedName === 'read') {
          return true;
        }
        return normalizedName === 'bash' && looksLikeFileReadBashCommand(block?.input?.command);
      })
    );
}

function hasRecentUserToolResult(requestBody) {
  return Array.isArray(requestBody?.messages) && requestBody.messages
    .slice(-2)
    .some((message) =>
      message?.role === 'user' &&
      Array.isArray(message?.content) &&
      message.content.some((block) => block?.type === 'tool_result')
    );
}

function flattenToolResultContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (typeof item?.text === 'string') {
          return item.text;
        }
        if (typeof item?.content === 'string') {
          return item.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return typeof content?.text === 'string' ? content.text : '';
}

function collectDiscoveredFiles(requestBody) {
  const files = new Set();
  if (!Array.isArray(requestBody?.messages)) {
    return files;
  }

  for (const message of requestBody.messages.slice(-6)) {
    if (message?.role !== 'user' || !Array.isArray(message?.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block?.type !== 'tool_result') {
        continue;
      }
      const text = flattenToolResultContent(block.content);
      for (const rawLine of String(text).split('\n')) {
        const line = rawLine.trim();
        if (/^(?:[A-Za-z]:[\\/]|\/|\.\.?\/)/.test(line) && !line.endsWith('/')) {
          files.add(normalizeEscapedPath(line));
        }
      }
    }
  }

  return files;
}

function collectReadFiles(requestBody) {
  const files = new Set();
  if (!Array.isArray(requestBody?.messages)) {
    return files;
  }

  for (const message of requestBody.messages.slice(-6)) {
    if (message?.role !== 'assistant' || !Array.isArray(message?.content)) {
      continue;
    }
    for (const block of message.content) {
      if (block?.type !== 'tool_use') {
        continue;
      }
      const normalizedName = normalizeName(block?.name);
      if (normalizedName === 'read') {
        const filePath = normalizeEscapedPath(block?.input?.file_path ?? block?.input?.filePath ?? block?.input?.path);
        if (filePath) {
          files.add(filePath);
        }
        continue;
      }
      if (normalizedName === 'bash') {
        const filePath = extractPathFromReadBashCommand(block?.input?.command);
        if (filePath) {
          files.add(filePath);
        }
      }
    }
  }

  return files;
}

function isLikelySourceFile(filePath) {
  return /\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|php|rb|swift|c|cc|cpp|h|hpp|cs|scala|sh|bash|zsh)$/i.test(filePath);
}

function scoreSourceFile(filePath) {
  const normalized = String(filePath).replace(/\\/g, '/');
  let score = 0;
  const depth = normalized.split('/').filter(Boolean).length;
  score += depth;
  if (/\/(?:src|lib|app|server|pkg)\//i.test(normalized) || /\/server\.[^.]+$/i.test(normalized)) {
    score -= 3;
  }
  if (/\/test\//i.test(normalized)) {
    score -= 1;
  }
  if (/\.(?:test|spec)\./i.test(normalized)) {
    score += 1;
  }
  return score;
}

function selectUnreadSourceFiles(requestBody) {
  const discovered = [...collectDiscoveredFiles(requestBody)];
  const readFiles = collectReadFiles(requestBody);
  return discovered
    .filter((filePath) => isLikelySourceFile(filePath) && !readFiles.has(filePath))
    .sort((a, b) => scoreSourceFile(a) - scoreSourceFile(b))
    .slice(0, 3);
}

function buildReadSourceFilesCommand(filePaths) {
  const quoted = filePaths.map((filePath) => shellQuote(filePath)).join(' ');
  return `for f in ${quoted}; do printf '=== %s ===\\n' "$f"; head -120 "$f"; printf '\\n'; done`;
}

function synthesizeExplorationFollowup(text, requestBody) {
  const compactText = String(text ?? '').trim();
  if (!hasRecentAssistantReadToolUse(requestBody) || !hasRecentUserToolResult(requestBody)) {
    return [];
  }

  const registry = buildToolRegistry(requestBody);
  const bashEntry = [...registry.entries()].find(([, meta]) => meta.normalized === 'bash');
  if (!bashEntry) {
    return [];
  }

  const unreadSourceFiles = selectUnreadSourceFiles(requestBody);
  const seemsLikeExplorationStep = compactText === '' || /\b(i'll|i will|let me|now|next|first|then|understand|explore|read|check|review|analyze|architecture|codebase|files)\b/i.test(compactText);
  if (unreadSourceFiles.length > 0 && seemsLikeExplorationStep) {
    return [{
      id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
      name: bashEntry[0],
      input: {
        command: buildReadSourceFilesCommand(unreadSourceFiles),
        description: `Read source files: ${unreadSourceFiles.map((filePath) => filePath.split(/[\\/]/).pop()).join(', ')}`
      }
    }];
  }

  if (compactText && seemsLikeExplorationStep) {
    return [{
      id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
      name: bashEntry[0],
      input: {
        command: 'find . -maxdepth 2 -type f | head -80',
        description: 'Inspect remaining repository files'
      }
    }];
  }

  if (!compactText || !/remaining files|key files|more closely|for completeness/i.test(compactText)) {
    return [];
  }

  return [{
    id: `toolu_${crypto.randomUUID().replace(/-/g, '')}`,
    name: bashEntry[0],
    input: {
      command: 'find . -maxdepth 2 -type f | head -80',
      description: 'Inspect remaining repository files'
    }
  }];
}

export function applyAnthropicNormalization(payload, requestBody) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.content)) {
    return payload;
  }

  const content = [];
  const extractedToolCalls = [];

  for (const block of payload.content) {
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

  const normalizedToolCalls = dropEmptyBrokenToolCalls(
    canonicalizeToolCalls(combineFragmentedToolCalls(extractedToolCalls), requestBody)
  );
  if (normalizedToolCalls.length === 0) {
    const textContent = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n\n')
      .trim();
    const followupToolCalls = synthesizeExplorationFollowup(textContent, requestBody);
    if (followupToolCalls.length > 0) {
      for (const toolCall of followupToolCalls) {
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

    return {
      ...payload,
      content
    };
  }

  for (const toolCall of normalizedToolCalls) {
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
    if (!message || typeof message.content !== 'string' || Array.isArray(message.tool_calls)) {
      return choice;
    }

    const normalized = extractPseudoToolCalls(message.content);
    normalized.toolCalls = canonicalizeToolCalls(normalized.toolCalls, requestBody);
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

    return {
      ...choice,
      finish_reason: 'tool_calls',
      message: {
        ...message,
        content: normalized.text || null,
        tool_calls: normalized.toolCalls.map((toolCall, index) => ({
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
    normalized.toolCalls = canonicalizeToolCalls(normalized.toolCalls, requestBody);

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

    return [
      {
        ...item,
        content: parts
      },
      ...normalized.toolCalls.map((toolCall) => ({
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
