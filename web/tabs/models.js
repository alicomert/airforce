// Models tab — unified table + discover modal.

import { openModal, openConfirm, openAlert, openForm } from '../components/modal.js';

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
  document.getElementById('discover-btn').addEventListener('click', () => discoverFlow(api, refresh));
  await refresh();

  async function refresh() {
    const [provR, capR] = await Promise.all([
      api('GET', '/admin/api/providers').then((r) => r.json()),
      api('GET', '/admin/api/capability').then((r) => r.json()).catch(() => ({ models: {} })),
    ]);
    const tbody = document.querySelector('#models-table tbody');
    tbody.innerHTML = '';
    let count = 0;
    for (const p of provR.providers || []) {
      for (const m of (p.models || [])) {
        tbody.appendChild(renderRow(p, m, capR.models || {}, api, refresh));
        count++;
      }
    }
    if (!count) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="9" class="muted" style="text-align:center;padding:20px;">No models. Click "Discover models…" to find some.</td>`;
      tbody.appendChild(tr);
    }
  }
}

async function discoverFlow(api, refresh) {
  // Step 1: provider seçimi
  const list = await api('GET', '/admin/api/providers').then((r) => r.json());
  const providers = list.providers || [];
  if (!providers.length) {
    await openAlert({ title: 'No providers', message: 'Önce Providers sekmesinden bir provider ekle.' });
    return;
  }
  const chosen = await openForm({
    title: 'Discover models — step 1',
    submitText: 'Discover',
    fields: [
      { name: 'provider_id', label: 'Provider', type: 'select',
        options: providers.map((p) => ({ value: p.id, label: `${p.id} (${p.type})` })),
        value: providers[0].id, required: true },
    ],
  });
  if (!chosen) return;

  // Step 2: discover'ı çalıştır
  let resp;
  try {
    const r = await api('POST', `/admin/api/providers/${chosen.provider_id}/discover`, {});
    resp = await r.json();
    if (resp.error || !resp.models) {
      await openAlert({ title: 'Discover failed', message: resp.error?.message || resp.error || 'unknown error' });
      return;
    }
  } catch (err) {
    await openAlert({ title: 'Discover failed', message: err.message });
    return;
  }

  // Step 3: filter + checkbox seçim modal
  const allModels = resp.models;
  const existingIds = new Set();
  const existingProvider = providers.find((p) => p.id === chosen.provider_id);
  for (const m of (existingProvider?.models || [])) existingIds.add(m.upstream_id);

  await openCheckboxModal({
    title: `Discover ${chosen.provider_id} — ${allModels.length} model`,
    models: allModels,
    existingIds,
    defaultExclude: 'image|audio|embedding|tts|midjourney|suno',
    onSubmit: async (selected, defaultPriority) => {
      if (!selected.length) return;
      await api('POST', `/admin/api/providers/${chosen.provider_id}/models`, {
        models: selected.map((id) => ({ upstream_id: id, priority: defaultPriority, enabled: true })),
      });
      refresh();
      await openAlert({
        title: 'Added',
        message: `${selected.length} model "${chosen.provider_id}" provider'ına eklendi.`,
      });
    },
  });
}

function openCheckboxModal({ title, models, existingIds, defaultExclude, onSubmit }) {
  return new Promise((resolve) => {
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="discover-toolbar">
        <input type="text" id="dx-filter" placeholder="filtre (pattern var ise dahil edilir)" />
        <input type="text" id="dx-exclude" placeholder="exclude regex" value="${escapeHtmlAttr(defaultExclude)}" />
        <input type="number" id="dx-prio" value="0" title="default priority" style="width:60px" />
        <button id="dx-all" class="ghost small">All</button>
        <button id="dx-none" class="ghost small">None</button>
      </div>
      <div class="discover-list" id="dx-list"></div>
      <div class="muted" id="dx-count" style="margin-top:8px;font-size:12px;"></div>
    `;

    const footer = document.createElement('div');
    const cancel = document.createElement('button'); cancel.className = 'ghost'; cancel.textContent = 'Cancel';
    const add = document.createElement('button'); add.className = 'primary'; add.textContent = 'Add Selected';
    footer.appendChild(cancel); footer.appendChild(add);

    const m = openModal({ title, bodyEl: body, footerEl: footer });
    m.card.classList.add('modal-large');

    const filterInp = body.querySelector('#dx-filter');
    const excludeInp = body.querySelector('#dx-exclude');
    const prioInp = body.querySelector('#dx-prio');
    const list = body.querySelector('#dx-list');
    const count = body.querySelector('#dx-count');

    function render() {
      const inc = filterInp.value.trim();
      const exc = excludeInp.value.trim();
      let incRe, excRe;
      try { if (inc) incRe = new RegExp(inc, 'i'); } catch {}
      try { if (exc) excRe = new RegExp(exc, 'i'); } catch {}
      list.innerHTML = '';
      let shown = 0;
      for (const m of models) {
        const id = m.id;
        if (incRe && !incRe.test(id)) continue;
        if (excRe && excRe.test(id)) continue;
        const lbl = document.createElement('label');
        lbl.className = 'discover-row' + (existingIds.has(id) ? ' already' : '');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = id;
        if (existingIds.has(id)) { cb.disabled = true; cb.title = 'already added'; }
        const sp = document.createElement('span');
        sp.textContent = id + (existingIds.has(id) ? ' (added)' : '');
        lbl.appendChild(cb); lbl.appendChild(sp);
        list.appendChild(lbl);
        shown++;
      }
      count.textContent = `${shown}/${models.length} gösteriliyor (filtre/exclude'a göre)`;
    }
    filterInp.addEventListener('input', render);
    excludeInp.addEventListener('input', render);
    body.querySelector('#dx-all').addEventListener('click', () => {
      list.querySelectorAll('input[type="checkbox"]:not(:disabled)').forEach((cb) => { cb.checked = true; });
    });
    body.querySelector('#dx-none').addEventListener('click', () => {
      list.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
    });
    cancel.addEventListener('click', () => { m.close(); resolve(); });
    add.addEventListener('click', async () => {
      const selected = [...list.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.value);
      const prio = Number(prioInp.value) || 0;
      m.close();
      await onSubmit(selected, prio);
      resolve();
    });
    render();
  });
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
    const ok = await openConfirm({
      title: 'Remove model?',
      message: `${m.upstream_id} (${p.id})`,
      confirmText: 'Remove',
      danger: true,
    });
    if (!ok) return;
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
function escapeHtmlAttr(s) { return escapeHtml(s).replace(/`/g, '&#96;'); }
