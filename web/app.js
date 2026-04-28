// Entry: login + tab router + api helper.

import { initProviders } from './tabs/providers.js';
import { initModels } from './tabs/models.js';
import { initLogs } from './tabs/logs.js';
import { initChat } from './tabs/chat.js';

const TABS = { providers: initProviders, models: initModels, logs: initLogs, chat: initChat };

let token = sessionStorage.getItem('llm-bridge-token') || null;

const $ = (sel) => document.querySelector(sel);

async function login(username, password) {
  const r = await fetch('/admin/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const j = await r.json();
  if (!j.ok) return { ok: false, error: j.error || 'login failed' };
  token = j.token;
  sessionStorage.setItem('llm-bridge-token', token);
  return { ok: true };
}

function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

function showLogin() {
  $('#login').classList.remove('hidden');
  $('#app').classList.add('hidden');
}

export async function api(method, urlPath, body) {
  const r = await fetch(urlPath, {
    method,
    headers: { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) {
    sessionStorage.removeItem('llm-bridge-token');
    token = null;
    showLogin();
    throw new Error('unauthorized');
  }
  return r;
}

async function switchTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  const root = $('#content');
  root.innerHTML = '';
  await TABS[name](root, api);
}

document.querySelectorAll('#tabs button').forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
});

$('#login-btn').addEventListener('click', async () => {
  const u = $('#login-user').value.trim();
  const p = $('#login-pass').value;
  $('#login-error').textContent = '';
  const r = await login(u, p);
  if (!r.ok) { $('#login-error').textContent = r.error; return; }
  showApp();
  switchTab('providers');
});

$('#logout-btn').addEventListener('click', async () => {
  await fetch('/admin/api/logout', { method: 'POST', headers: { 'authorization': `Bearer ${token}` } });
  sessionStorage.removeItem('llm-bridge-token');
  token = null;
  showLogin();
});

$('#login-pass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#login-btn').click();
});

if (token) {
  fetch('/admin/api/state', { headers: { 'authorization': `Bearer ${token}` } }).then((r) => {
    if (r.ok) { showApp(); switchTab('providers'); }
    else { sessionStorage.removeItem('llm-bridge-token'); token = null; showLogin(); }
  });
} else {
  showLogin();
}
