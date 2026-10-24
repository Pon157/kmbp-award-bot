import { h, icon, $ } from './dom.js';
import { state, go, root } from './nav.js';
import { call, inTelegram } from './api.js';
import { changeScreen, extraScreen, drawScreen } from './extras.js';

let btn = null;
export function unmountMenu() { btn?.remove(); btn = null; $('.drawer-wrap')?.remove(); }

export function mountMenu() {
  if (btn) return;
  btn = h('button', { class: 'burger', 'aria-label': 'Меню', 'aria-haspopup': 'dialog', onclick: open }, icon('menu'));
  document.body.append(btn);
}
async function open() {
  const { homeScreen } = await import('./home.js');
  const { forumScreen } = await import('./forum.js');
  const { adminScreen } = await import('./admin.js');
  const me = state.me, home = state.home;
  const wrap = h('div', { class: 'drawer-wrap' });
  const close = () => { wrap.classList.add('out'); document.removeEventListener('keydown', onKey); setTimeout(() => wrap.remove(), 180); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const item = (ic, title, sub, fn, disabled) => h('button', { class: 'mitem', 'aria-disabled': disabled ? 'true' : null, onclick: () => { close(); fn(); } },
    h('span', { class: 'mitem__ic' }, icon(ic)), h('span', {}, h('div', { class: 'mitem__t' }, title), sub ? h('div', { class: 'mitem__s' }, sub) : null));
  const cfg = home?.cfg || { voting: true, forum: true, draw: true };
  const cost = home?.coins?.cost || 35;
  wrap.append(h('div', { class: 'drawer-bg', onclick: close }),
    h('nav', { class: 'drawer', 'aria-label': 'Меню' },
      h('div', { class: 'drawer__user' }, h('div', { class: 'mitem__t' }, me.user.name), h('div', { class: 'small muted' }, me.user.username ? '@' + me.user.username : 'ID ' + me.user.id)),
      item('star', 'Главная', 'Прогресс и новости', () => root(homeScreen)),
      item('swap', 'Поменять голос', cfg.voting ? 'Изменить выбор в номинации' : 'Голосование закрыто', () => go(changeScreen), !cfg.voting),
      item('coin', 'Отдать дополнительный голос', cost + ' монет = 0,5 голоса' + (home ? ' · у вас ' + home.coins.balance : ''), () => go(extraScreen), !cfg.voting),
      item('brush', 'Нарисовать рисунок', cfg.draw ? 'Оставьте рисунок на карточке' : 'Отключено', () => go(drawScreen()), !cfg.draw),
      item('chat', 'Форум', cfg.forum ? 'Обсуждения участников' : 'Закрыт', () => go(forumScreen), !cfg.forum),
      item('arrow', 'Первый тур', 'Заявки и номинации 1 тура', () => { location.href = '/r1/' + location.hash; }),
      me.owner ? item('shield', 'Админ-панель', 'Для организаторов', () => go(adminScreen)) : null,
      inTelegram() ? null : item('out', 'Выйти', null, async () => { await call('authLogout').catch(() => {}); location.reload(); })));
  $('#layer').append(wrap);
}
