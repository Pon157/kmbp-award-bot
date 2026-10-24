import { h, icon, toast, num } from './dom.js';
import { r2, call, openUrl, inTelegram } from './api.js';
import { state, go } from './nav.js';
import { nominationScreen } from './vote.js';
import { changeScreen } from './extras.js';

export async function loadHome() { state.home = await r2('home'); return state.home; }

// ── Новости: Telegram entities → DOM (только безопасные элементы) ──
const safeUrl = (u) => (/^(https?:|tg:)/i.test(u) ? u : '');
function link(href, kids) {
  const a = h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, kids);
  a.addEventListener('click', (e) => { e.preventDefault(); openUrl(href); });
  return a;
}
export function renderEntities(text, entities) {
  const ents = (entities || []).filter((e) => e && e.length > 0).map((e) => ({ ...e, end: e.offset + e.length }));
  const cuts = new Set([0, text.length]);
  for (const e of ents) { cuts.add(Math.max(0, Math.min(text.length, e.offset))); cuts.add(Math.max(0, Math.min(text.length, e.end))); }
  const pts = [...cuts].sort((a, b) => a - b), frag = document.createDocumentFragment();
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]; if (a === b) continue;
    let node = document.createTextNode(text.slice(a, b));
    for (const e of ents.filter((x) => x.offset <= a && x.end >= b)) {
      const t = e.type;
      if (t === 'bold') node = h('strong', {}, node);
      else if (t === 'italic') node = h('em', {}, node);
      else if (t === 'underline') node = h('u', {}, node);
      else if (t === 'strikethrough') node = h('s', {}, node);
      else if (t === 'code' || t === 'pre') node = h('code', {}, node);
      else if (t === 'text_link' && safeUrl(e.url)) node = link(safeUrl(e.url), node);
      else if (t === 'url') { const raw = text.slice(e.offset, e.end), u = safeUrl(/^[a-z]+:/i.test(raw) ? raw : 'https://' + raw); if (u) node = link(u, node); }
    }
    frag.append(node);
  }
  return frag;
}

function newsSection(news) {
  if (!news?.length) return null;
  const wrap = h('section', { class: 'sec' }, h('div', { class: 'sec__h' }, h('h2', { class: 'h2' }, 'Новости')));
  const list = h('div', {});
  let all = false;
  const paint = () => {
    list.replaceChildren(...(all ? news : news.slice(0, 3)).map((n) => h('article', { class: 'post' + (n.pinned ? ' post--pin' : '') }, renderEntities(n.text, n.entities))));
    more.classList.toggle('hide', all || news.length <= 3);
  };
  const more = h('button', { class: 'btn btn--ghost btn--block', style: { marginTop: '10px' }, onclick: () => { all = true; paint(); } }, 'Показать все новости');
  paint(); wrap.append(list, more);
  return wrap;
}
function linksSection(links) {
  if (!links?.length) return null;
  return h('section', { class: 'sec' }, h('div', { class: 'sec__h' }, h('h2', { class: 'h2' }, 'Ссылки')),
    h('div', { class: 'links' }, links.map((l) => h('button', { class: 'link', onclick: () => openUrl(l.url) }, icon('ext'), h('span', {}, l.title)))));
}
function sponsorsSection(banners) {
  if (!banners?.length) return null;
  const items = banners.map((b) => {
    const img = h('img', { alt: '', loading: 'lazy' });
    call('getSponsorBanner', { id: b.id }).then((d) => { img.src = d.src; }).catch(() => {});
    return h('button', { class: 'sponsor', 'aria-label': 'Открыть ссылку спонсора', onclick: () => openUrl(b.targetUrl) }, img);
  });
  return h('section', { class: 'sec' }, h('div', { class: 'sec__h' }, h('h2', { class: 'h2' }, 'Партнёры премии')), h('div', { class: 'sponsors' }, items));
}
const logoutBtn = () => (inTelegram() ? null : h('button', { class: 'btn btn--ghost btn--block', style: { marginTop: '22px' }, onclick: async () => { await call('authLogout').catch(() => {}); location.reload(); } }, icon('out'), 'Выйти'));

// ── Главная ──
export async function homeScreen() {
  const home = await loadHome(), me = state.me, { voted, total } = home.progress;
  const done = total > 0 && voted >= total;
  const first = Math.max(0, home.nominations.findIndex((n) => !n.voted));
  const cta = total === 0 ? h('button', { class: 'btn btn--gold btn--big', disabled: true }, 'Номинации скоро появятся')
    : !home.cfg.voting ? h('button', { class: 'btn btn--ghost btn--big', disabled: true }, icon('lock'), 'Голосование закрыто')
      : done ? h('button', { class: 'btn btn--gold btn--big', onclick: () => go(changeScreen) }, icon('swap'), 'Изменить голос')
        : h('button', { class: 'btn btn--gold btn--big', onclick: () => go(nominationScreen({ index: first })) }, voted ? 'Продолжить голосование' : 'Начать голосовать', icon('arrow'));
  const hero = h('section', { class: 'hero' },
    h('div', { class: 'kicker' }, me.award.name + ' · 2 тур'),
    h('h1', { class: 'h1' }, 'Выберите лучших', h('br'), 'в каждой номинации'),
    h('p', { class: 'hero__lead' }, 'Привет, ' + me.user.name + '! Листайте карточки проектов и отдайте голос за тех, кто вам действительно нравится. Итоги скрыты до объявления победителей.'),
    h('div', { class: 'hero__cta' }, cta),
    total ? h('div', { class: 'progress' }, h('div', { class: 'row row--between small muted' }, h('span', {}, done ? 'Все голоса отданы' : 'Вы проголосовали'), h('b', {}, voted + ' из ' + total)),
      h('div', { class: 'bar' }, h('i', { style: { width: Math.round((voted / total) * 100) + '%' } }))) : null,
  );
  return h('div', { class: 'screen' }, !home.cfg.voting ? h('div', { class: 'banner' }, 'Голосование сейчас закрыто организаторами. Рисунки и форум доступны в меню.') : null, hero,
    newsSection(me.news), linksSection(me.links), sponsorsSection(me.sponsorBanners), logoutBtn());
}

// ── Нет доступа к 2 туру ──
export async function gateScreen() {
  const me = state.me;
  const hero = h('section', { class: 'hero' },
    h('div', { class: 'kicker' }, me.award.name),
    h('h1', { class: 'h1' }, 'Второй тур скоро'),
    h('p', { class: 'hero__lead' }, 'Сейчас второй тур открыт ограниченному кругу участников. Первый тур продолжается — подать заявку можно в Telegram через бота.'),
    h('div', { class: 'hero__cta' },
      me.bot ? h('a', { class: 'btn btn--gold', href: 'https://t.me/' + me.bot, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть первый тур в Telegram', icon('ext')) : null,
      h('span', { class: 'chip' }, 'Ваш Telegram ID: ', h('b', {}, String(me.user.id))),
      h('button', { class: 'btn btn--ghost btn--sm', onclick: async () => { try { await navigator.clipboard.writeText(String(me.user.id)); toast('ID скопирован', 'ok'); } catch (e) { toast('Не удалось скопировать'); } } }, 'Скопировать')),
    h('p', { class: 'muted small', style: { marginTop: '14px' } }, 'Если вам должны были открыть доступ — отправьте этот ID организаторам.'),
  );
  return h('div', { class: 'screen' }, hero, newsSection(me.news), linksSection(me.links), sponsorsSection(me.sponsorBanners), logoutBtn());
}
