// Мини-библиотека: сборка DOM без innerHTML (весь пользовательский текст попадает в страницу только как текст — XSS невозможен).
const NS = 'http://www.w3.org/2000/svg';
function append(el, kids) {
  for (const k of kids.flat(Infinity)) { if (k == null || k === false) continue; el.append(k instanceof Node ? k : document.createTextNode(String(k))); }
}
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') { for (const [a, b] of Object.entries(v)) { if (a.startsWith('--')) el.style.setProperty(a, b); else el.style[a] = b; } }   // через CSSOM: строгий CSP это разрешает
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'text') el.textContent = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, kids);
  return el;
}
export const icon = (name, cls = '') => {
  const s = document.createElementNS(NS, 'svg'); s.setAttribute('class', 'ic ' + cls); s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(NS, 'use'); u.setAttribute('href', '#i-' + name); s.append(u); return s;
};
export const $ = (sel, root = document) => root.querySelector(sel);
export const clear = (el) => { el.replaceChildren(); return el; };
// replaceChildren, который пропускает null/false (иначе в страницу попадёт текст «null»)
export const fill = (el, ...kids) => { el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return el; };

export function toast(msg, kind = '') {
  const box = $('#toasts');
  const t = h('div', { class: 'toast ' + kind, role: 'status' }, msg);
  box.append(t);
  setTimeout(() => t.classList.add('out'), 3400);
  setTimeout(() => t.remove(), 3900);
}

// Нижняя шторка (на ПК — окно по центру).
export function sheet({ title = '', body, wide = false, onClose } = {}) {
  const layer = $('#layer');
  const wrap = h('div', { class: 'sheet-wrap' });
  const box = h('div', { class: 'sheet' + (wide ? ' sheet--wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Окно' });
  let closed = false;
  const close = () => { if (closed) return; closed = true; wrap.classList.add('out'); document.removeEventListener('keydown', onKey); setTimeout(() => wrap.remove(), 180); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.append(h('div', { class: 'sheet__bg', onclick: close }), box);
  box.append(h('div', { class: 'sheet__head' }, h('h3', { class: 'sheet__title' }, title), h('button', { class: 'iconbtn', 'aria-label': 'Закрыть', onclick: close }, icon('close'))));
  const content = h('div', { class: 'sheet__body' }); content.append(...[].concat(body || [])); box.append(content);
  layer.append(wrap);
  return { close, box, content };
}
export function confirmSheet({ title, text, ok = 'Да', cancel = 'Отмена', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (v) => { answered = true; s.close(); resolve(v); };
    const s = sheet({
      title, onClose: () => { if (!answered) resolve(false); },
      body: [h('div', { class: 'sheet__text' }, [].concat(text)),
        h('div', { class: 'sheet__actions' }, h('button', { class: 'btn btn--ghost', onclick: () => done(false) }, cancel), h('button', { class: 'btn ' + (danger ? 'btn--danger' : 'btn--gold'), onclick: () => done(true) }, ok))],
    });
  });
}

export const fmtTime = (ts) => new Date(ts * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
export const fmtDay = (ts) => new Date(ts * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
export const fmtDateTime = (ts) => ts ? new Date(ts * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
export const num = (n) => String(n).replace('.', ',');
export const spinner = () => h('div', { class: 'spin', role: 'progressbar', 'aria-label': 'Загрузка' });
