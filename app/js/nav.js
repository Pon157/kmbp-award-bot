// Навигация: стек экранов + история браузера + кнопка «Назад» Telegram.
import { $, h, spinner } from './dom.js';
import { tg } from './api.js';

export const state = { me: null, home: null };
const stack = [];
let cleanups = [], token = 0;
export const onLeave = (fn) => cleanups.push(fn);

export function errorView(e, retry) {
  return h('div', { class: 'screen splash' }, h('h2', { class: 'h2' }, 'Что-то пошло не так'), h('p', { class: 'muted' }, e?.message || 'Неизвестная ошибка'),
    h('div', { class: 'row' }, retry ? h('button', { class: 'btn btn--gold', onclick: retry }, 'Повторить') : null));
}
async function show() {
  cleanups.splice(0).forEach((f) => { try { f(); } catch (e) { /* ignore */ } });
  const my = ++token, root = $('#app');
  root.replaceChildren(spinner());
  try {
    const node = await stack[stack.length - 1]();
    if (my !== token) return;
    root.replaceChildren(node); window.scrollTo(0, 0);
  } catch (e) {
    if (my !== token) return;
    if (e?.code === 'AUTH') return;                      // обработает onAuthLost
    root.replaceChildren(errorView(e, () => show()));
  }
  syncBack();
}
function syncBack() {
  const b = tg?.BackButton; if (!b) return;
  if (stack.length > 1) b.show(); else b.hide();
}
export function root(render) { stack.length = 0; stack.push(render); history.replaceState({ n: 1 }, ''); return show(); }
export function go(render) { stack.push(render); history.pushState({ n: stack.length }, ''); return show(); }
export function replace(render) { stack[stack.length - 1] = render; return show(); }
export function back() { if (stack.length > 1) history.back(); }
export const refresh = () => show();
export const depth = () => stack.length;
window.addEventListener('popstate', (e) => {
  const n = e.state?.n || 1;
  if (n < stack.length) { stack.length = n; show(); }
});
try { tg?.BackButton?.onClick(back); } catch (e) { /* старая версия клиента */ }
