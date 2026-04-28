// Providers tab — list, add, edit, delete, test, toggle.
// Custom modal UI (no browser prompts).

import { openForm, openConfirm, openAlert } from '../components/modal.js';

export async function initProviders(root, api) {
  root.innerHTML = `
    <div class="toolbar">
      <button id="add-provider" class="primary">+ Add Provider</button>
    </div>
    <div id="providers-list"></div>
  `;
  document.getElementById('add-provider').addEventListener('click', () => openAddModal(api, refresh));
  await refresh();

  async function refresh() {
    const r = await api('GET', '/admin/api/providers');
    const j = await r.json();
    const list = document.getElementById('providers-list');
    list.innerHTML = '';
    if (!j.providers?.length) {
      list.innerHTML = '<p class="muted">No providers yet. Click "+ Add Provider" above.</p>';
      return;
    }
    for (const p of j.providers) list.appendChild(renderProviderCard(p, api, refresh));
  }
}

function renderProviderCard(p, api, refresh) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-header">
      <input type="checkbox" ${p.enabled ? 'checked' : ''} data-action="toggle" />
      <strong>${escapeHtml(p.id)}</strong>
      <span class="type">${escapeHtml(p.type)}</span>
      <span class="grow"></span>
      <button data-action="test">Test</button>
      <button data-action="edit">Edit</button>
      <button data-action="delete" class="danger">Delete</button>
    </div>
    <div class="card-body">
      <div>label: <code>${escapeHtml(p.label || p.id)}</code></div>
      <div>base_url: <code>${escapeHtml(p.base_url)}</code></div>
      <div>key: <code>****${escapeHtml(p.api_key_last4 || '')}</code></div>
      <div>models: ${p.models?.length || 0}</div>
    </div>
  `;
  card.querySelector('[data-action="toggle"]').addEventListener('change', async (e) => {
    await api('PUT', `/admin/api/providers/${p.id}`, { enabled: e.target.checked });
    refresh();
  });
  card.querySelector('[data-action="test"]').addEventListener('click', async () => {
    const btn = card.querySelector('[data-action="test"]');
    btn.disabled = true; btn.textContent = '…';
    try {
      const r = await api('POST', `/admin/api/providers/${p.id}/test`, {});
      const j = await r.json();
      await openAlert({
        title: j.ok ? 'Connection OK' : 'Connection Failed',
        message: j.ok
          ? `Latency: ${j.latency_ms}ms`
          : `${j.category || 'error'}: ${j.error || j.message || 'unknown'}`,
      });
    } finally {
      btn.disabled = false; btn.textContent = 'Test';
    }
  });
  card.querySelector('[data-action="edit"]').addEventListener('click', () => openEditModal(p, api, refresh));
  card.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    const ok = await openConfirm({
      title: 'Delete provider?',
      message: `"${p.id}" provider'ı tüm modelleriyle birlikte silinecek. Bu geri alınamaz.`,
      confirmText: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await api('DELETE', `/admin/api/providers/${p.id}`);
    refresh();
  });
  return card;
}

async function openAddModal(api, refresh) {
  const v = await openForm({
    title: 'Add Provider',
    submitText: 'Create',
    fields: [
      { name: 'id', label: 'Provider ID (slug)', type: 'text', placeholder: 'groq', required: true,
        hint: 'lowercase, harfler/rakamlar/tire/alt çizgi (örn: groq, openrouter, anth_direct)' },
      { name: 'type', label: 'Type', type: 'select', value: 'openai-compat',
        options: [
          { value: 'openai-compat', label: 'OpenAI-compatible' },
          { value: 'anthropic-native', label: 'Anthropic native' },
        ] },
      { name: 'label', label: 'Label (opsiyonel)', type: 'text', placeholder: 'Groq Cloud' },
      { name: 'base_url', label: 'Base URL', type: 'text', placeholder: 'https://api.groq.com/openai', required: true },
      { name: 'api_key', label: 'API Key', type: 'password', required: true },
      { name: 'enabled', label: 'Enabled', type: 'checkbox', value: true },
    ],
  });
  if (!v) return;
  const r = await api('POST', '/admin/api/providers', {
    id: v.id, type: v.type, label: v.label || v.id,
    base_url: v.base_url, api_key: v.api_key, enabled: !!v.enabled,
  });
  if (r.status === 201) refresh();
  else {
    const j = await r.json().catch(() => ({}));
    await openAlert({ title: 'Error', message: j.error?.message || JSON.stringify(j.error || j) });
  }
}

async function openEditModal(p, api, refresh) {
  const v = await openForm({
    title: `Edit "${p.id}"`,
    submitText: 'Save',
    fields: [
      { name: 'label', label: 'Label', type: 'text', value: p.label || p.id },
      { name: 'base_url', label: 'Base URL', type: 'text', value: p.base_url },
      { name: 'api_key', label: 'New API Key', type: 'password',
        placeholder: '(boş bırak: değiştirme)', hint: 'Mevcut anahtarı korumak için boş bırak.' },
      { name: 'enabled', label: 'Enabled', type: 'checkbox', value: p.enabled },
    ],
  });
  if (!v) return;
  const patch = {
    label: v.label,
    base_url: v.base_url,
    enabled: !!v.enabled,
  };
  if (v.api_key) patch.api_key = v.api_key;
  const r = await api('PUT', `/admin/api/providers/${p.id}`, patch);
  if (r.ok) refresh();
  else {
    const j = await r.json().catch(() => ({}));
    await openAlert({ title: 'Error', message: j.error?.message || JSON.stringify(j.error || j) });
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
