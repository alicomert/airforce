// Whitelisted repo file read tools.
// Forbidden: .env, data/, node_modules/, .git/.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../../config.js';

const ALLOWED = [
  /^lib\//, /^docs\//, /^web\//, /^test\//,
  /^(README|CHANGELOG|AGENTS|package\.json|server\.js)/,
];
const FORBIDDEN = [
  /^\.env/, /^data\//, /^node_modules\//, /^\.git\//,
];
const MAX_FILE_SIZE = 100 * 1024;

function isAllowed(rel) {
  if (!rel || typeof rel !== 'string') return false;
  if (FORBIDDEN.some((re) => re.test(rel))) return false;
  return ALLOWED.some((re) => re.test(rel));
}

function safeJoin(rel) {
  const norm = path.posix.normalize(rel.replace(/^\/+/, ''));
  if (norm.startsWith('..') || norm.includes('/../') || path.isAbsolute(norm)) {
    throw new Error('path traversal blocked');
  }
  return path.join(ROOT_DIR, norm);
}

export const tools = {
  list_repo_files: {
    name: 'list_repo_files',
    description: 'List files under a directory recursively. Allowed roots: lib/, docs/, web/, test/, server.js, README/CHANGELOG/AGENTS/package.json. Forbidden: .env, data/, node_modules/, .git/.',
    parameters: {
      type: 'object',
      properties: { dir: { type: 'string' } },
      required: [],
    },
    handler: async ({ dir = 'lib' }) => {
      if (!isAllowed(dir)) throw new Error(`directory not allowed: ${dir}`);
      const abs = safeJoin(dir);
      if (!fs.existsSync(abs)) throw new Error(`not found: ${dir}`);
      const stat = fs.statSync(abs);
      if (stat.isFile()) return { files: [dir], note: 'single file' };
      const out = [];
      function walk(d, rel) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const childRel = path.posix.join(rel, e.name);
          if (FORBIDDEN.some((re) => re.test(childRel))) continue;
          if (e.isDirectory()) walk(path.join(d, e.name), childRel);
          else if (e.isFile()) out.push(childRel);
        }
      }
      walk(abs, dir);
      return { files: out };
    },
  },

  read_repo_file: {
    name: 'read_repo_file',
    description: 'Read a file from the repo. Whitelisted paths only. Max 100KB. Returns content + size.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    handler: async ({ path: p }) => {
      if (!isAllowed(p)) throw new Error(`path not allowed: ${p}`);
      const abs = safeJoin(p);
      if (!fs.existsSync(abs)) throw new Error(`not found: ${p}`);
      const stat = fs.statSync(abs);
      if (!stat.isFile()) throw new Error(`not a file: ${p}`);
      if (stat.size > MAX_FILE_SIZE) throw new Error(`file too large (${stat.size} > ${MAX_FILE_SIZE})`);
      return { path: p, content: fs.readFileSync(abs, 'utf8'), size: stat.size };
    },
  },
};
