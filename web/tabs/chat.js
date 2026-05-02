// Chat tab — built-in admin chatbot UI.

const HISTORY_KEY = 'llm-bridge.chat.history';

export async function initChat(root, api) {
  root.innerHTML = `
    <div class="chat-shell">
      <div class="chat-toolbar">
        <select id="chat-model"></select>
        <button id="chat-new">+ New chat</button>
        <button id="chat-clear" class="ghost">Clear</button>
      </div>
      <div id="chat-msgs"></div>
      <div class="chat-input">
        <textarea id="chat-input" placeholder="Mesaj (Cmd/Ctrl+Enter ile gönder)…"></textarea>
        <button id="chat-send" class="primary">Send</button>
      </div>
    </div>
  `;

  const sel = document.getElementById('chat-model');
  try {
    // /v1/models bridge API key bekler; admin session ile /admin/api/providers'tan flatten edelim.
    const r = await api('GET', '/admin/api/providers');
    const j = await r.json();
    const seen = new Set();
    for (const p of (j.providers || [])) {
      for (const m of (p.models || [])) {
        if (!m.enabled) continue;
        const id = m.presented_id || (m.upstream_id.includes('/') ? m.upstream_id.split('/').pop() : m.upstream_id);
        if (seen.has(id)) continue;
        seen.add(id);
        const o = document.createElement('option');
        o.value = id;
        o.textContent = `${id} (${p.id})`;
        sel.appendChild(o);
      }
    }
    if (!sel.options.length) sel.appendChild(new Option('glm-4.6', 'glm-4.6'));
  } catch {
    sel.appendChild(new Option('glm-4.6', 'glm-4.6'));
  }

  let messages = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  let streaming = null;
  render();

  document.getElementById('chat-new').addEventListener('click', () => {
    if (streaming) return;
    messages = []; saveAndRender();
  });
  document.getElementById('chat-clear').addEventListener('click', () => {
    if (streaming) return;
    if (confirm('Clear local chat history?')) { messages = []; saveAndRender(); }
  });

  const input = document.getElementById('chat-input');
  const send = document.getElementById('chat-send');
  send.addEventListener('click', () => sendMessage());
  input.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendMessage();
  });

  async function sendMessage() {
    if (streaming) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    messages.push({ role: 'user', content: text });
    saveAndRender();
    send.disabled = true;
    streaming = { text: '', tools: [] };
    render();
    await streamChat(sel.value);
    streaming = null;
    send.disabled = false;
    render();
  }

  async function streamChat(model) {
    const tk = sessionStorage.getItem('llm-bridge-token');
    let res;
    try {
      res = await fetch('/admin/api/chat', {
        method: 'POST',
        headers: { 'authorization': `Bearer ${tk}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: messages.filter((m) => m.role === 'user' || m.role === 'assistant'),
          model,
          stream: true,
        }),
      });
    } catch (err) {
      messages.push({ role: 'assistant', content: '⚠️ network error: ' + err.message });
      saveAndRender();
      return;
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      messages.push({ role: 'assistant', content: `⚠️ HTTP ${res.status}: ${t.slice(0, 500)}` });
      saveAndRender();
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let assistantText = '';
    const assistantTools = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const blocks = buf.split('\n\n');
      buf = blocks.pop() || '';
      for (const block of blocks) {
        const ev = block.match(/^event: (.+)$/m)?.[1];
        const dataStr = block.match(/^data: (.+)$/m)?.[1];
        if (!ev || !dataStr) continue;
        let j;
        try { j = JSON.parse(dataStr); } catch { continue; }
        if (ev === 'text') {
          assistantText += j.content || '';
          streaming = { text: assistantText, tools: assistantTools.slice() };
          render();
        } else if (ev === 'tool_use') {
          assistantTools.push({ kind: 'use', id: j.id, name: j.name, args: j.args });
          streaming = { text: assistantText, tools: assistantTools.slice() };
          render();
        } else if (ev === 'tool_result') {
          assistantTools.push({ kind: 'result', id: j.id, name: j.name, content: j.content, error: j.error });
          streaming = { text: assistantText, tools: assistantTools.slice() };
          render();
        } else if (ev === 'done') {
          messages.push({ role: 'assistant', content: assistantText, tool_calls: assistantTools });
          saveAndRender();
        } else if (ev === 'error') {
          messages.push({ role: 'assistant', content: '⚠️ ' + (j.message || 'error'), tool_calls: assistantTools });
          saveAndRender();
        }
      }
    }
  }

  function saveAndRender() {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-100)));
    render();
  }

  function render() {
    const c = document.getElementById('chat-msgs');
    c.innerHTML = '';
    for (const m of messages) c.appendChild(renderMsg(m));
    if (streaming) c.appendChild(renderMsg({ role: 'assistant', content: streaming.text, tool_calls: streaming.tools, _streaming: true }));
    if (!messages.length && !streaming) {
      const hint = document.createElement('div');
      hint.className = 'muted';
      hint.style.textAlign = 'center';
      hint.style.padding = '40px 0';
      hint.textContent = "Bir şey sor — örn. 'list_providers' ya da 'glm-4.6 capability'sini probe et'";
      c.appendChild(hint);
    }
    c.scrollTop = c.scrollHeight;
  }

  function renderMsg(m) {
    const div = document.createElement('div');
    div.className = `chat-msg role-${m.role}` + (m._streaming ? ' streaming' : '');
    div.innerHTML = `<div class="role">${m.role}</div><div class="content"></div>`;
    div.querySelector('.content').textContent = m.content || '';
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const t = document.createElement('details');
        t.className = 'tool-call';
        const arrow = tc.kind === 'use' ? '→' : '←';
        const summary = tc.kind === 'use'
          ? `${arrow} ${tc.name || ''}(...)`
          : `${arrow} ${tc.name || ''}${tc.error ? ' [ERROR]' : ''}`;
        t.innerHTML = `<summary></summary><pre></pre>`;
        t.querySelector('summary').textContent = summary;
        t.querySelector('pre').textContent = tc.kind === 'use'
          ? formatJson(tc.args)
          : (tc.error || formatJson(tc.content));
        div.appendChild(t);
      }
    }
    return div;
  }

  function formatJson(s) {
    if (typeof s !== 'string') return JSON.stringify(s, null, 2);
    try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
  }
}
