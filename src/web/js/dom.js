/** Minimal DOM builder: h('div', { class: 'x', onclick }, child, 'text', [more]) */
export function h(tag, props, ...children) {
  const el = tag === 'svg' || SVG_TAGS.has(tag) ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

const SVG_TAGS = new Set(['path', 'g', 'rect', 'circle', 'line', 'polyline', 'polygon', 'text', 'defs', 'linearGradient', 'stop', 'title', 'clipPath']);

export function mount(target, ...nodes) {
  target.replaceChildren();
  append(target, nodes);
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

let tipEl;
export function tip(evt, html) {
  tipEl ||= document.getElementById('tip');
  if (!html) {
    tipEl.classList.remove('on');
    return;
  }
  tipEl.innerHTML = html;
  const pad = 14;
  const rect = tipEl.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY - rect.height - pad;
  if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
  if (y < 8) y = evt.clientY + pad;
  tipEl.style.left = `${x}px`;
  tipEl.style.top = `${y}px`;
  tipEl.classList.add('on');
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function toast(message, kind = '') {
  const box = document.getElementById('toasts');
  const el = h('div', { class: ['toast', kind], role: kind === 'err' ? 'alert' : 'status' }, message);
  box.appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 4200);
}

/** A native <dialog> confirm. Resolves true/false. */
export function confirmDialog({ title, body, confirm = 'Confirm', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const dlg = h(
      'dialog',
      { 'aria-labelledby': 'dlg-title' },
      h('div', { class: 'dialog-body' }, h('h2', { id: 'dlg-title' }, title), body),
      h(
        'div',
        { class: 'dialog-foot' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => close(false) }, cancel),
        h('button', { class: ['btn', danger ? '' : 'primary'], type: 'button', onclick: () => close(true), autofocus: true }, confirm),
      ),
    );
    function close(v) {
      dlg.close();
      dlg.remove();
      resolve(v);
    }
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(false);
    });
    document.body.appendChild(dlg);
    dlg.showModal();
  });
}
