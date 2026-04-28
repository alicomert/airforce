// Tool registry + dispatcher + audit hook.

import * as systemStatus from './tools/system-status.js';
import * as repoAccess from './tools/repo-access.js';
import * as providerMutate from './tools/provider-mutate.js';
import * as modelMutate from './tools/model-mutate.js';
import * as actions from './tools/actions.js';
import { appendAudit } from './audit-log.js';

const REGISTRY = {
  ...systemStatus.tools,
  ...repoAccess.tools,
  ...providerMutate.tools,
  ...modelMutate.tools,
  ...actions.tools,
};

const MUTATING = new Set([
  'create_provider', 'update_provider', 'delete_provider', 'toggle_provider', 'set_provider_rate_limit',
  'add_model', 'remove_model', 'toggle_model', 'set_priority',
  'set_alias', 'remove_alias',
  'export_config',
]);

export function listToolDefs() {
  return Object.values(REGISTRY).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function listToolNames() {
  return Object.keys(REGISTRY);
}

export async function dispatch(toolName, argsJson, sessionId) {
  const tool = REGISTRY[toolName];
  if (!tool) throw new Error(`unknown tool: ${toolName}`);
  let args = {};
  try {
    args = typeof argsJson === 'string' ? JSON.parse(argsJson || '{}') : (argsJson || {});
  } catch {
    throw new Error('bad args json');
  }
  for (const req of tool.parameters?.required || []) {
    if (args[req] === undefined) throw new Error(`missing arg: ${req}`);
  }
  const result = await tool.handler(args);
  if (MUTATING.has(toolName)) {
    await appendAudit({ tool: toolName, args, session: sessionId });
  }
  return result;
}
