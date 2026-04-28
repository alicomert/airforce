// Logs tab — breakers + probe trigger + export/import + log tail.

import { openConfirm, openAlert } from '../components/modal.js';

let refreshTimer = null;

export async function initLogs(root, api) {
  root.innerHTML = `
    <div class="toolbar">
      <button id="probe-now" class="primary">Run probe (all)</button>
      <button id="export-cfg">Export config</button>
      <button id="import-cfg">Import config…</button>
      <input type="file" id="import-file" accept=".json" style="display:none" />
    </div>
    <h3>Circuit breakers</h3>
    <div id="breakers"></div>
    <h3>Logs</h3>
    <pre id="log-pre"></pre>
  `;

  document.getElementById('probe-now').addEventListener('click', async () => {
    const r = await api('POST', '/admin/api/probe/run', {});
    const j = await r.json().catch(() => ({}));
    await openAlert({
      title: r.ok ? 'Probe Started' : 'Probe Failed',
      message: j.message || j.error || (r.ok ? 'Probe is now running in the background.' : 'unknown error'),
    });
  });

  document.getElementById('export-cfg').addEventListener('click', async () => {
    const r = await api('GET', '/admin/api/export');
    if (!r.ok) { await openAlert({ title: 'Export Failed', message: `HTTP ${r.status}` }); return; }
    const j = await r.json();
    const blob = new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'providers.json';
    a.click();
  });

  document.getElementById('import-cfg').addEventListener('click', () => {
    document.getElementById('import-file').click();
  });

  document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const ok = await openConfirm({
      title: 'Import config?',
      message: 'Bu işlem mevcut providers.json dosyasının üstüne yazar. Devam edilsin mi?',
      confirmText: 'Import',
      danger: true,
    });
    if (!ok) return;
    try {
      const cfg = JSON.parse(text);
      const r = await api('POST', '/admin/api/import', cfg);
      const j = await r.json();
      await openAlert({
        title: r.ok ? 'Imported' : 'Import Failed',
        message: r.ok ? 'Config imported. Sekmeleri yenile.' : (j.error?.message || j.error || 'unknown'),
      });
    } catch (err) {
      await openAlert({ title: 'Invalid JSON', message: err.message });
    }
  });

  if (refreshTimer) clearInterval(refreshTimer);
  await refresh(api);
  refreshTimer = setInterval(() => refresh(api).catch(() => {}), 5000);
  return () => { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } };
}

async function refresh(api) {
  const [br, lr] = await Promise.all([
    api('GET', '/admin/api/breakers').then((r) => r.json()).catch(() => ({ breakers: [] })),
    api('GET', '/admin/api/logs?n=100').then((r) => r.json()).catch(() => ({ logs: [] })),
  ]);

  const bdiv = document.getElementById('breakers');
  if (!bdiv) return;
  bdiv.innerHTML = '';
  if (!br.breakers?.length) {
    bdiv.innerHTML = '<p class="muted">No breakers active yet.</p>';
  } else {
    for (const b of br.breakers) {
      const row = document.createElement('div');
      row.className = 'breaker-row';
      row.innerHTML = `
        <code>${escapeHtml(b.id)}</code>
        <span class="state state-${escapeHtml(b.state)}">[${escapeHtml(b.state)}]</span>
        <span class="muted">${escapeHtml(b.reason || '')}</span>
        <span class="grow"></span>
        <button data-id="${escapeHtml(b.id)}">Reset</button>
      `;
      row.querySelector('button').addEventListener('click', async (e) => {
        await api('POST', `/admin/api/providers/${e.target.dataset.id}/breaker/reset`, {});
        refresh(api);
      });
      bdiv.appendChild(row);
    }
  }

  const pre = document.getElementById('log-pre');
  if (pre) {
    const lines = (lr.logs || lr.lines || []).slice(-200);
    pre.textContent = lines.map((l) => typeof l === 'string' ? l : JSON.stringify(l)).join('\n');
    pre.scrollTop = pre.scrollHeight;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
