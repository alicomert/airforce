// Vanilla modal/dialog helpers — no framework.
// API:
//   openModal({ title, bodyEl, footerEl }) → { close }
//   openAlert({ title, message }) → Promise<void>
//   openConfirm({ title, message, confirmText?, danger? }) → Promise<boolean>
//   openForm({ title, fields, submitText? }) → Promise<values | null>
//   fields: [{ name, label, type?, value?, placeholder?, options?, required?, hint? }]
//     type: 'text' | 'password' | 'textarea' | 'select' | 'checkbox' | 'number' | 'json'

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function openModal({ title, bodyEl, footerEl }) {
  const overlay = el('div', 'modal-overlay');
  const card = el('div', 'modal-card');
  const header = el('div', 'modal-header');
  const titleEl = el('h2'); titleEl.textContent = title || '';
  const close = el('button', 'modal-close', '×');
  header.appendChild(titleEl);
  header.appendChild(close);
  const body = el('div', 'modal-body');
  if (bodyEl) body.appendChild(bodyEl);
  const footer = el('div', 'modal-footer');
  if (footerEl) footer.appendChild(footerEl);
  card.appendChild(header);
  card.appendChild(body);
  card.appendChild(footer);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  function closeFn() {
    overlay.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  function onKey(e) { if (e.key === 'Escape') closeFn(); }
  close.addEventListener('click', closeFn);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeFn(); });
  overlay.tabIndex = -1;
  setTimeout(() => overlay.focus(), 0);
  document.addEventListener('keydown', onKey, { once: true });

  return { close: closeFn, body, footer, card };
}

export function openAlert({ title = 'Notice', message = '' }) {
  return new Promise((resolve) => {
    const body = el('div', 'modal-message');
    body.textContent = message;
    const footer = el('div');
    const ok = el('button', 'primary', 'OK');
    footer.appendChild(ok);
    const m = openModal({ title, bodyEl: body, footerEl: footer });
    ok.addEventListener('click', () => { m.close(); resolve(); });
    setTimeout(() => ok.focus(), 50);
  });
}

export function openConfirm({ title = 'Confirm', message = '', confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const body = el('div', 'modal-message');
    body.textContent = message;
    const footer = el('div');
    const cancel = el('button', 'ghost', 'Cancel');
    const confirm = el('button', danger ? 'danger primary' : 'primary');
    confirm.textContent = confirmText;
    footer.appendChild(cancel);
    footer.appendChild(confirm);
    const m = openModal({ title, bodyEl: body, footerEl: footer });
    cancel.addEventListener('click', () => { m.close(); resolve(false); });
    confirm.addEventListener('click', () => { m.close(); resolve(true); });
    setTimeout(() => confirm.focus(), 50);
  });
}

export function openForm({ title = 'Form', fields = [], submitText = 'Save' }) {
  return new Promise((resolve) => {
    const body = el('div', 'modal-form');
    const inputs = {};

    for (const f of fields) {
      const lbl = el('label');
      const span = el('span'); span.textContent = f.label || f.name;
      lbl.appendChild(span);
      let inp;
      if (f.type === 'textarea' || f.type === 'json') {
        inp = el('textarea');
        if (f.value != null) inp.value = typeof f.value === 'string' ? f.value : JSON.stringify(f.value, null, 2);
      } else if (f.type === 'select') {
        inp = el('select');
        for (const opt of (f.options || [])) {
          const o = el('option');
          o.value = opt.value ?? opt;
          o.textContent = opt.label ?? opt.value ?? opt;
          if ((f.value ?? '') === o.value) o.selected = true;
          inp.appendChild(o);
        }
      } else if (f.type === 'checkbox') {
        inp = el('input');
        inp.type = 'checkbox';
        if (f.value) inp.checked = true;
      } else {
        inp = el('input');
        inp.type = f.type || 'text';
        if (f.value != null) inp.value = f.value;
        if (f.placeholder) inp.placeholder = f.placeholder;
      }
      inp.dataset.name = f.name;
      if (f.required) inp.required = true;
      lbl.appendChild(inp);
      if (f.hint) {
        const hint = el('small', 'modal-hint');
        hint.textContent = f.hint;
        lbl.appendChild(hint);
      }
      body.appendChild(lbl);
      inputs[f.name] = { inp, type: f.type };
    }

    const footer = el('div');
    const cancel = el('button', 'ghost', 'Cancel');
    const submit = el('button', 'primary');
    submit.textContent = submitText;
    footer.appendChild(cancel);
    footer.appendChild(submit);

    const m = openModal({ title, bodyEl: body, footerEl: footer });

    function gather() {
      const out = {};
      for (const [name, { inp, type }] of Object.entries(inputs)) {
        if (type === 'checkbox') out[name] = inp.checked;
        else if (type === 'number') {
          const v = inp.value.trim();
          out[name] = v === '' ? null : Number(v);
        } else if (type === 'json') {
          const v = inp.value.trim();
          if (!v) { out[name] = null; continue; }
          try { out[name] = JSON.parse(v); }
          catch { out[name] = '__invalid_json__'; }
        } else {
          out[name] = inp.value;
        }
      }
      return out;
    }

    cancel.addEventListener('click', () => { m.close(); resolve(null); });
    submit.addEventListener('click', () => {
      const v = gather();
      // Required check
      for (const f of fields) {
        if (f.required && (v[f.name] == null || v[f.name] === '')) {
          inputs[f.name].inp.focus();
          inputs[f.name].inp.classList.add('invalid');
          return;
        }
        if (f.type === 'json' && v[f.name] === '__invalid_json__') {
          inputs[f.name].inp.focus();
          inputs[f.name].inp.classList.add('invalid');
          return;
        }
      }
      m.close();
      resolve(v);
    });

    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && e.target.tagName === 'INPUT') {
        e.preventDefault();
        submit.click();
      }
    });

    setTimeout(() => {
      const first = body.querySelector('input, textarea, select');
      first?.focus();
    }, 50);
  });
}

export function escapeHtmlExport(s) { return escapeHtml(s); }
