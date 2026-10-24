import { h, icon, $, toast, spinner, fill } from './dom.js';
import { call, r2, tg, inTelegram, onAuthLost, openUrl, ApiError } from './api.js';
import { state, root, go, replace, back, refresh, onLeave, errorView, depth } from './nav.js';
import { homeScreen, gateScreen } from './home.js';
import { mountMenu, unmountMenu } from './menu.js';

try { tg?.ready(); tg?.expand(); tg?.setHeaderColor?.('#0b0e20'); tg?.setBackgroundColor?.('#0b0e20'); } catch (e) { /* не в Telegram */ }

export function logoView() { return h('span', { class: 'logo' }, icon('star')); }

// ── Вход в браузере: число-подтверждение через бота ──
function loginScreen(note) {
  state.me = null; unmountMenu();
  const box = h('div', { class: 'login screen' });
  const paint = (...kids) => fill(box, ...kids);
  const intro = () => paint(
    logoView(), h('div', { class: 'kicker' }, 'Премия года КМБП'), h('h1', { class: 'h1' }, 'Второй тур'),
    h('p', { class: 'muted' }, 'Войдите через Telegram — так мы узнаем, что вы настоящий участник. Пароли не нужны.'),
    note ? h('div', { class: 'banner' }, note) : null,
    h('button', { class: 'btn btn--gold btn--big btn--block', onclick: begin }, 'Войти через Telegram'),
  );
  let timer = null;
  const stop = () => { clearInterval(timer); timer = null; };
  async function begin() {
    let s;
    try { s = await call('authStart'); } catch (e) { toast(e.message, 'err'); return; }
    const status = h('div', { class: 'muted small center' }, 'Ждём подтверждения в Telegram…');
    const left = h('span', { class: 'muted small' }); let t0 = Date.now();
    paint(
      h('div', { class: 'kicker' }, 'Подтвердите вход'), h('p', { class: 'muted' }, 'Число для подтверждения:'), h('div', { class: 'code', 'aria-label': 'Число ' + s.code }, s.code),
      h('ol', { class: 'steps' }, h('li', {}, 'Нажмите кнопку ниже — откроется бот'), h('li', {}, 'Нажмите «Start» (если спросит)'), h('li', {}, 'В сообщении бота выберите число ' + s.code)),
      h('a', { class: 'btn btn--gold btn--big btn--block', href: s.link, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть Telegram', icon('ext')),
      status, left, h('button', { class: 'btn btn--ghost btn--block', onclick: () => { stop(); intro(); } }, 'Отмена'),
    );
    const tick = () => { const r = Math.max(0, s.expiresIn - Math.floor((Date.now() - t0) / 1000)); left.textContent = 'Ссылка действует ещё ' + Math.floor(r / 60) + ':' + String(r % 60).padStart(2, '0'); };
    tick();
    timer = setInterval(async () => {
      tick();
      try {
        const r = await call('authPoll', { id: s.id, key: s.key });
        if (r.status === 'waiting_confirm') status.textContent = 'Выберите число в боте…';
        else if (r.status === 'ok') { stop(); boot(); }
        else if (['denied', 'failed', 'expired', 'gone'].includes(r.status)) {
          stop();
          const msg = { denied: 'Вход отклонён в боте.', failed: 'Выбрано не то число — вход отменён.', expired: 'Время вышло.', gone: 'Запрос на вход больше не действует.' }[r.status];
          intro(); box.prepend(h('div', { class: 'banner' }, msg + ' Попробуйте ещё раз.'));
        }
      } catch (e) { if (e.code === 'RATE') status.textContent = 'Слишком частые запросы, подождите…'; }
    }, 2000);
    onLeave(stop);
  }
  intro();
  $('#app').replaceChildren(box);
}

onAuthLost(() => { if (state.me && !inTelegram()) loginScreen('Сессия закончилась — войдите снова.'); });

export async function boot() {
  const app = $('#app'); app.replaceChildren(h('div', { class: 'splash' }, spinner()));
  try { state.me = await call('me'); }
  catch (e) {
    if (e.code === 'AUTH' || e.code === 'ORIGIN') {
      if (inTelegram()) { app.replaceChildren(errorView(new ApiError('Сессия Telegram устарела. Закройте мини-апп и откройте её снова через бота.'), () => location.reload())); return; }
      return loginScreen();
    }
    app.replaceChildren(errorView(e, boot)); return;
  }
  if (!state.me.access) {
    unmountMenu();
    // Второй тур пока только для списка ID. Остальным — рабочий первый тур (/r1/). Подпись Telegram переживает переход (sessionStorage Telegram-скрипта), хэш передаём на всякий случай.
    if (inTelegram()) { location.replace('/r1/' + location.hash); return; }
    return root(gateScreen);
  }
  mountMenu();
  return root(homeScreen);
}
boot();
