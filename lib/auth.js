// Bearer/x-api-key + admin token doğrulama.
// Ayrıca username/password ile admin login → in-memory session token.

import crypto from 'node:crypto';
import { config } from './config.js';
import { loadKeys, saveKeys } from './store.js';
import { nowIso, newId } from './util.js';

function extractKey(req) {
  const h = req.headers;
  const auth = h['authorization'] || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const xkey = h['x-api-key'];
  if (xkey) return String(xkey).trim();
  return '';
}

// --- Admin sessions (memory only — restart = re-login) ---
const sessions = new Map(); // token → { username, issued_iso }

function timingSafeEq(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

export function loginWithCredentials(username, password) {
  const u = config.adminUsername;
  const p = config.adminPassword;
  if (!u || !p) {
    return { ok: false, error: 'username/password girişi sunucuda kapalı (ADMIN_USERNAME / ADMIN_PASSWORD set edilmemiş)' };
  }
  if (!timingSafeEq(username || '', u) || !timingSafeEq(password || '', p)) {
    return { ok: false, error: 'kullanıcı adı veya şifre hatalı' };
  }
  const token = 'sess-' + crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username, issued_iso: nowIso() });
  return { ok: true, token };
}

export function isValidSessionToken(token) {
  if (!token) return false;
  return sessions.has(token);
}

export function logoutSession(token) {
  return sessions.delete(token);
}

export function passwordLoginEnabled() {
  return Boolean(config.adminUsername && config.adminPassword);
}

function envKeySet() {
  return new Set(config.bridgeApiKeys);
}

function fileKeySet() {
  const { keys } = loadKeys();
  return new Set(keys.map((k) => k.key));
}

function allKeySet() {
  return new Set([...envKeySet(), ...fileKeySet()]);
}

export function isAuthorized(req, { requireAdmin = false } = {}) {
  const key = extractKey(req);

  if (requireAdmin) {
    // 1) Session token (username/password login sonucu)
    if (key && isValidSessionToken(key)) return true;
    // 2) Statik admin token
    const adminTok = config.adminToken || (config.bridgeApiKeys[0] || '');
    if (adminTok && key && key === adminTok) return true;
    // 3) Hiçbir admin auth tanımlı değilse sadece loopback'e izin ver
    if (!adminTok && !passwordLoginEnabled()) {
      const remote = req.socket?.remoteAddress || '';
      return /^(::1|127\.|::ffff:127\.)/.test(remote);
    }
    return false;
  }

  const all = allKeySet();
  if (all.size === 0) {
    // Hiç key yoksa sadece loopback'e izin ver.
    const remote = req.socket?.remoteAddress || '';
    return /^(::1|127\.|::ffff:127\.)/.test(remote);
  }
  if (!key) return false;
  if (all.has(key)) {
    touchKeyUsage(key);
    return true;
  }
  return false;
}

function touchKeyUsage(key) {
  const state = loadKeys();
  const entry = state.keys.find((k) => k.key === key);
  if (entry) {
    entry.last_used_iso = nowIso();
    saveKeys(state);
  }
}

// --- Key CRUD (admin panel'i kullanır) ---

export function listKeys() {
  return loadKeys().keys.map((k) => ({
    id: k.id,
    label: k.label,
    key_preview: maskKey(k.key),
    created_iso: k.created_iso,
    last_used_iso: k.last_used_iso || null,
  }));
}

export function createKey(label) {
  const state = loadKeys();
  const key = 'sk-bridge-' + newId('').slice(3, 35);
  const entry = {
    id: newId('key'),
    label: label || 'unnamed',
    key,
    created_iso: nowIso(),
    last_used_iso: null,
  };
  state.keys.push(entry);
  saveKeys(state);
  return { ...entry };
}

export function deleteKey(id) {
  const state = loadKeys();
  const before = state.keys.length;
  state.keys = state.keys.filter((k) => k.id !== id);
  saveKeys(state);
  return state.keys.length !== before;
}

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 12) return k.slice(0, 4) + '****';
  return k.slice(0, 10) + '****' + k.slice(-4);
}
