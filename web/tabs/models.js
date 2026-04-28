// Models tab — unified table + discover.

export async function initModels(root, api) {
  root.innerHTML = `
    <div class="toolbar">
      <button id="discover-btn" class="primary">Discover models…</button>
    </div>
    <table id="models-table">
      <thead>
        <tr>
          <th>Model</th><th>Provider</th><th>Type</th>
          <th>Native</th><th>XML</th><th>Priority</th>
          <th>Enabled</th><th>Latency</th><th></th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  `;
  document.getElementById('discover-btn').addEventListener('click', () => discoverPrompt(api, refresh));
  await refresh();

  async function refresh() {
    const [provR, capR] = await Promise.all([
      api('GET', '/admin/api/providers').then((r) => r.json()),
      api('GET', '/admin/api/capability').then((r) => r.json()).catch(() => ({ models: {} })),
    ]);
    const tbody = document.querySelector('#models-table tbody');
    tbody.innerHTML = '';
    for (const p of provR.providers || []) {
      for (const m of (p.models || [])) {
        tbody.appendChild(renderRow(p, m, capR.models || {}, api, refresh));
      }
    }
  }
}

async function discoverPrompt(api, refresh) {
  const list = await api('GET', '/admin/api/providers').then((r) => r.json());
  const ids = (list.providers || []).map((p) => p.id);
  if (!ids.length) { alert('No providers configured. Add a provider first.'); return; }
  const id = prompt(`Discover models from which provider?\nAvailable: ${ids.join(', ')}`);
  if (!id || !ids.includes(id)) return;
  const r = await api('POST', `/admin/api/providers/${id}/discover`, {});
  const j = await r.json();
  if (!j.models) { alert('Discover failed: ' + (j.error?.message || j.error || 'unknown')); return; }
  const filter = prompt(
    `Found ${j.models.length} models. Filter (regex, blank = all). Common excludes: image|audio|embedding|tts.`,
    '',
  );
  const re = filter ? new RegExp(filter) : null;
  const filtered = re ? j.models.filter((m) => !re.test(m.id)) : j.models;
  const sample = filtered.slice(0, 30).map((m) => m.id).join('\n');
  const csv = prompt(
    `${filtered.length} candidates after filter. Add which? (comma-separated ids; "all" for all)\n\nFirst 30:\n${sample}${filtered.length > 30 ? '\n...' : ''}`,
    'all',
  );
  if (!csv) return;
  const wanted = csv.trim() === 'all'
    ? filtered.map((m) => m.id)
    : csv.split(',').map((s) => s.trim()).filter(Boolean);
  if (!wanted.length) return;
  await api('POST', `/admin/api/providers/${id}/models`, {
    models: wanted.map((uid) => ({ upstream_id: uid, priority: 0, enabled: true })),
  });
  alert(`Added ${wanted.length} models to ${id}.`);
  refresh();
}

function renderRow(p, m, capMap, api, refresh) {
  const tr = document.createElement('tr');
  const capKey = `${p.id}/${m.upstream_id}`;
  const cap = capMap?.[capKey];
  tr.innerHTML = `
    <td>${escapeHtml(m.upstream_id)}</td>
    <td>${escapeHtml(p.id)}</td>
    <td>${escapeHtml(p.type)}</td>
    <td>${cap?.native ? '✓' : ''}</td>
    <td>${cap?.xml ? '✓' : ''}</td>
    <td><input type="number" value="${m.priority || 0}" data-action="priority" style="width:50px" /></td>
    <td><input type="checkbox" ${m.enabled ? 'checked' : ''} data-action="enabled" /></td>
    <td>${cap?.latency_ms ?? ''}</td>
    <td><button data-action="del" class="danger">×</button></td>
  `;
  tr.querySelector('[data-action="priority"]').addEventListener('change', async (e) => {
    await api('PUT', `/admin/api/providers/${p.id}/models/${encodeURIComponent(m.upstream_id)}`, {
      priority: Number(e.target.value),
    });
  });
  tr.querySelector('[data-action="enabled"]').addEventListener('change', async (e) => {
    await api('PUT', `/admin/api/providers/${p.id}/models/${encodeURIComponent(m.upstream_id)}`, {
      enabled: e.target.checked,
    });
  });
  tr.querySelector('[data-action="del"]').addEventListener('click', async () => {
    if (!confirm(`Remove ${m.upstream_id} from ${p.id}?`)) return;
    await api('DELETE', `/admin/api/providers/${p.id}/models/${encodeURIComponent(m.upstream_id)}`);
    refresh();
  });
  return tr;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
