// Vanilla SPA, sıfır dependency.

const TOKEN_KEY = 'bridge_admin_token';

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let pollTimer = null;
let logsTimer = null;

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'authorization': 'Bearer ' + getToken() },
  };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    showLogin('Token geçersiz.');
    throw new Error('unauthorized');
  }
  let json = null;
  try { json = await res.json(); } catch {}
  if (!res.ok) {
    const msg = json?.error?.message || json?.error || `HTTP ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return json;
}

// --- Login ---
let loginMode = 'password'; // 'password' | 'token'

async function detectLoginMode() {
  try {
    const res = await fetch('/admin/api/auth-mode');
    const j = await res.json();
    if (!j.password_login) {
      loginMode = 'token';
      $('#login-pw-mode').classList.add('hidden');
      $('#login-token-mode').classList.remove('hidden');
      $('#login-mode-text').textContent = 'Panel girişi için admin token gir.';
    } else {
      loginMode = 'password';
      $('#login-pw-mode').classList.remove('hidden');
      $('#login-token-mode').classList.add('hidden');
      $('#login-mode-text').textContent = 'Panel girişi';
      $('#login-toggle').style.display = 'block';
    }
  } catch {
    // sunucu erişilemezse password modda kal
  }
}

$('#login-toggle')?.addEventListener('click', () => {
  if (loginMode === 'password') {
    loginMode = 'token';
    $('#login-pw-mode').classList.add('hidden');
    $('#login-token-mode').classList.remove('hidden');
    $('#login-toggle').textContent = 'Şifre ile gir';
    setTimeout(() => $('#token-input').focus(), 30);
  } else {
    loginMode = 'password';
    $('#login-pw-mode').classList.remove('hidden');
    $('#login-token-mode').classList.add('hidden');
    $('#login-toggle').textContent = 'Token ile gir';
    setTimeout(() => $('#username-input').focus(), 30);
  }
});

function showLogin(error) {
  $('#login').classList.remove('hidden');
  $('#login-error').textContent = error || '';
  detectLoginMode().then(() => {
    setTimeout(() => {
      const target = loginMode === 'password' ? $('#username-input') : $('#token-input');
      target?.focus();
    }, 50);
  });
}
function hideLogin() {
  $('#login').classList.add('hidden');
}

async function attemptLogin() {
  $('#login-error').textContent = '';
  if (loginMode === 'password') {
    const u = $('#username-input').value.trim();
    const p = $('#password-input').value;
    if (!u || !p) { $('#login-error').textContent = 'Kullanıcı adı ve şifre gerekli'; return; }
    try {
      const res = await fetch('/admin/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: u, password: p }),
      });
      const j = await res.json();
      if (!res.ok) { $('#login-error').textContent = j.error || `HTTP ${res.status}`; return; }
      setToken(j.token);
      hideLogin();
      boot();
    } catch (e) {
      $('#login-error').textContent = 'Bağlantı hatası: ' + e.message;
    }
  } else {
    const t = $('#token-input').value.trim();
    if (!t) { $('#login-error').textContent = 'Token gerekli'; return; }
    setToken(t);
    try {
      await api('GET', '/admin/api/state');
      hideLogin();
      boot();
    } catch (e) {
      setToken('');
      $('#login-error').textContent = e.message || 'Doğrulama başarısız';
    }
  }
}

$('#login-btn').addEventListener('click', attemptLogin);
$('#username-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#password-input').focus(); });
$('#password-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptLogin(); });
$('#token-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptLogin(); });

$('#logout').addEventListener('click', async () => {
  // Best-effort server-side session invalidation
  try {
    await fetch('/admin/api/logout', { method: 'POST', headers: { 'authorization': 'Bearer ' + getToken() } });
  } catch {}
  setToken('');
  stopPolling();
  showLogin('');
});

// --- Tabs ---
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + target));
    if (target === 'logs') refreshLogs();
  });
});

// --- Probe button ---
$('#probe-run').addEventListener('click', async () => {
  const btn = $('#probe-run');
  btn.disabled = true; btn.textContent = 'başlatılıyor…';
  try {
    await api('POST', '/admin/api/probe/run');
    setStatus('warn', 'probe çalışıyor');
    btn.textContent = 'çalışıyor…';
  } catch (e) {
    btn.textContent = 'Probe çalıştır';
    btn.disabled = false;
    alert('Hata: ' + e.message);
  }
  // Timer poll'i ile düzelir
  setTimeout(() => { btn.disabled = false; btn.textContent = 'Probe çalıştır'; }, 8_000);
});

// --- Status & state polling ---
function setStatus(level, text) {
  const dot = $('#status-dot');
  dot.className = 'dot ' + ({ ok: 'dot-ok', warn: 'dot-warn', err: 'dot-err', pending: 'dot-pending' }[level] || 'dot-pending');
  $('#status-text').textContent = text;
}

async function refreshState() {
  try {
    const s = await api('GET', '/admin/api/state');
    setStatus(s.probe.running ? 'warn' : 'ok', s.probe.running ? 'probe çalışıyor' : `${s.config.upstreamBaseUrl}`);
    renderCapability(s.probe.snapshot, s.rate_limit);
    renderKeys(s.keys);
    renderConfig(s.config);
  } catch (e) {
    setStatus('err', 'bağlantı hatası: ' + e.message);
  }
}

function renderConfig(cfg) {
  $('#config-dump').textContent = JSON.stringify(cfg, null, 2);
}

function renderCapability(snap, budget) {
  const models = snap?.models || {};
  const entries = Object.entries(models);
  let capable = 0, freeOk = 0, premiumOk = 0, incompat = 0, skipped = 0;
  for (const [, v] of entries) {
    if (v.status === 'ok') {
      capable++;
      if (v.tier === 'free') freeOk++;
      else if (v.tier === 'premium') premiumOk++;
    }
    if (v.status === 'incompatible') incompat++;
    if (v.status === 'skipped') skipped++;
  }
  $('#stat-capable').textContent = capable;
  $('#stat-free').textContent = freeOk;
  $('#stat-premium').textContent = premiumOk;
  $('#stat-incompat').textContent = incompat;
  $('#stat-skipped').textContent = skipped;
  $('#stat-last-probe').textContent = snap?.last_run_iso ? timeAgo(snap.last_run_iso) : 'henüz çalışmadı';
  if (budget) {
    $('#stat-budget').textContent = `${budget.remaining}/${budget.cap}`;
    $('#stat-budget').title = `son ${Math.round((budget.window_age_ms || 0)/1000)}s'de ${budget.spent} mult harcandı, dakika başı ${budget.cap}`;
  } else {
    $('#stat-budget').textContent = '–';
  }

  const filterText = ($('#model-filter').value || '').toLowerCase();
  const tbody = $('#model-table tbody');
  tbody.innerHTML = '';

  const tierOrder = { free: 0, premium: 1, p2g: 2, unknown: 3 };
  entries
    .sort(([a, av], [b, bv]) => {
      // 1) capable (status=ok) en üstte
      const okA = av.status === 'ok' ? 0 : 1;
      const okB = bv.status === 'ok' ? 0 : 1;
      if (okA !== okB) return okA - okB;

      // 2) tier önceliği: free → premium → p2g (kullanıcı önce free görmek istiyor)
      const tA = tierOrder[av.tier] ?? 9;
      const tB = tierOrder[bv.tier] ?? 9;
      if (tA !== tB) return tA - tB;

      // 3) latency ascending (hızlı en üstte). null/undefined latency en sona.
      const lA = Number.isFinite(av.latency_ms) ? av.latency_ms : Number.POSITIVE_INFINITY;
      const lB = Number.isFinite(bv.latency_ms) ? bv.latency_ms : Number.POSITIVE_INFINITY;
      if (lA !== lB) return lA - lB;

      // 4) son çare: id alfabetik
      return a.localeCompare(b);
    })
    .forEach(([id, v]) => {
      if (filterText && !id.toLowerCase().includes(filterText) && !(v.owned_by||'').toLowerCase().includes(filterText)) return;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><code>${escapeHtml(id)}</code></td>
        <td>${escapeHtml(v.owned_by || '–')}</td>
        <td>${tierBadge(v.tier)}</td>
        <td class="muted">${formatMult(v.multiplier)}</td>
        <td>${statusBadge(v.status)}</td>
        <td>${boolBadge(v.xml)}</td>
        <td>${v.latency_ms != null ? v.latency_ms + ' ms' : '–'}</td>
        <td class="muted">${v.checked_at ? timeAgo(v.checked_at) : '–'}</td>
      `;
      tbody.appendChild(tr);
    });
}

$('#model-filter').addEventListener('input', () => {
  // re-render with current snapshot (cheap, just refetch)
  refreshState();
});

function statusBadge(s) {
  if (s === 'ok') return '<span class="badge badge-ok">capable</span>';
  if (s === 'incompatible') return '<span class="badge badge-err">incompat</span>';
  if (s === 'payg') return '<span class="badge badge-payg">payg</span>';
  if (s === 'skipped') return '<span class="badge">skipped</span>';
  return `<span class="badge">${escapeHtml(s || '?')}</span>`;
}
function boolBadge(b) {
  return b ? '<span class="badge badge-ok">✓</span>' : '<span class="badge muted">–</span>';
}
function tierBadge(t) {
  if (t === 'free') return '<span class="badge badge-tier-free">free</span>';
  if (t === 'premium') return '<span class="badge badge-tier-premium">premium</span>';
  if (t === 'p2g') return '<span class="badge badge-tier-p2g">p2g</span>';
  return '<span class="badge muted">?</span>';
}
function formatMult(m) {
  if (m == null) return '<span title="api.airforce multiplier alanı boş — varsayılan free">×1*</span>';
  if (m === 0 || m === 1) return '×1';
  return '×' + m;
}

// --- Keys tab ---
function renderKeys(keys) {
  const tbody = $('#keys-table tbody');
  tbody.innerHTML = '';
  for (const k of keys || []) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(k.label || '')}</td>
      <td><code>${escapeHtml(k.key_preview)}</code></td>
      <td class="muted">${k.created_iso ? timeAgo(k.created_iso) : '–'}</td>
      <td class="muted">${k.last_used_iso ? timeAgo(k.last_used_iso) : 'never'}</td>
      <td><button class="ghost small" data-id="${k.id}">sil</button></td>
    `;
    tr.querySelector('button').addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      if (!confirm('Bu key silinsin mi? Kullanan istemciler kilitlenir.')) return;
      await api('DELETE', '/admin/api/keys/' + id);
      refreshState();
    });
    tbody.appendChild(tr);
  }
}

$('#new-key-btn').addEventListener('click', async () => {
  const label = $('#new-key-label').value.trim() || 'unnamed';
  const r = await api('POST', '/admin/api/keys', { label });
  $('#new-key-label').value = '';
  const banner = $('#key-newly-created');
  banner.classList.remove('hidden');
  banner.innerHTML = `<strong>Yeni key oluşturuldu — yalnızca burada gösterilir, kopyala:</strong><br/><br/><code>${escapeHtml(r.key.key)}</code>`;
  refreshState();
});

// --- Logs tab ---
async function refreshLogs() {
  try {
    const r = await api('GET', '/admin/api/logs?n=300');
    const filter = $('#log-level').value;
    const lines = (r.logs || []).filter((l) => !filter || l.level === filter);
    const html = lines.map(formatLogLine).join('\n');
    const el = $('#logs');
    const auto = $('#log-autoscroll').checked;
    el.innerHTML = html;
    if (auto) el.scrollTop = el.scrollHeight;
  } catch {}
}
function formatLogLine(l) {
  const cls = 'log-' + (l.level || 'info');
  const ts = (l.ts || '').replace('T', ' ').replace('Z', '');
  const fields = Object.entries(l).filter(([k]) => !['ts','level','msg'].includes(k));
  const fieldStr = fields.length ? ' ' + fields.map(([k,v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ') : '';
  return `<div class="log-line ${cls}">${escapeHtml(ts)} <strong>${(l.level||'').toUpperCase()}</strong> ${escapeHtml(l.msg||'')}${escapeHtml(fieldStr)}</div>`;
}
$('#logs-clear').addEventListener('click', async () => {
  await api('DELETE', '/admin/api/logs');
  refreshLogs();
});
$('#log-level').addEventListener('change', refreshLogs);

// --- Polling ---
function startPolling() {
  stopPolling();
  pollTimer = setInterval(refreshState, 4_000);
  logsTimer = setInterval(() => {
    if (document.querySelector('#tab-logs.active')) refreshLogs();
  }, 3_000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (logsTimer) clearInterval(logsTimer);
}

// --- Helpers ---
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function timeAgo(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 0) return 'şimdi';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return sec + 's önce';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'dk önce';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'sa önce';
  return Math.floor(hr / 24) + 'g önce';
}

// --- Boot ---
async function boot() {
  await refreshState();
  startPolling();
}

if (!getToken()) {
  showLogin();
} else {
  boot().catch((e) => {
    if (e.message !== 'unauthorized') {
      setStatus('err', e.message);
    }
  });
}
