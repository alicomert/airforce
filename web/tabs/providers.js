// Providers tab — list, add, edit, delete, test, toggle.

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
      list.innerHTML = '<p class="muted">No providers yet. Add one above.</p>';
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
    const r = await api('POST', `/admin/api/providers/${p.id}/test`, {});
    const j = await r.json();
    alert(j.ok ? `OK ${j.latency_ms}ms` : `FAIL: ${j.error || j.message || 'unknown'}`);
  });
  card.querySelector('[data-action="edit"]').addEventListener('click', () => openEditModal(p, api, refresh));
  card.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    if (!confirm(`Delete provider "${p.id}"?`)) return;
    await api('DELETE', `/admin/api/providers/${p.id}`);
    refresh();
  });
  return card;
}

function openAddModal(api, refresh) {
  const id = prompt('Provider ID (lowercase slug, e.g. "groq")');
  if (!id) return;
  const type = prompt('Type: openai-compat | anthropic-native', 'openai-compat');
  if (!type) return;
  const base_url = prompt('Base URL (e.g. https://api.groq.com/openai)');
  if (!base_url) return;
  const api_key = prompt('API Key');
  if (!api_key) return;
  api('POST', '/admin/api/providers', {
    id, type, base_url, api_key, label: id, enabled: true,
  }).then(async (r) => {
    if (r.status === 201) refresh();
    else {
      const j = await r.json();
      alert('Error: ' + (j.error?.message || JSON.stringify(j.error || j)));
    }
  });
}

function openEditModal(p, api, refresh) {
  const label = prompt('Label', p.label || p.id);
  if (label === null) return;
  const new_key = prompt('New API key (leave blank to keep current)', '');
  const patch = { label };
  if (new_key) patch.api_key = new_key;
  api('PUT', `/admin/api/providers/${p.id}`, patch).then(async (r) => {
    if (r.ok) refresh();
    else {
      const j = await r.json();
      alert('Error: ' + (j.error?.message || JSON.stringify(j.error || j)));
    }
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
