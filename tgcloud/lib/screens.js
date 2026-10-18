// Экраны для обычных пользователей.
import * as S from './store.js';
import { D } from './doc.js';
import { em } from './emoji.js';
import { B, show } from './tg.js';
import { DEFAULT_KIND_EMOJI } from './kinds.js';
import { AWARD_NAME, COMMUNITY, ROUND2_TEXT } from './config.js';
import { esc } from './util.js';

export const nomEmoji = (n) => n.emoji_id || DEFAULT_KIND_EMOJI[n.kind] || undefined;

// Баннер для сообщения бота: своё фото (file_id), стандартная картинка по адресу или ничего.
export function bannerBlock(b) {
  if (b.mode === 'custom' && b.file) return D.photo(b.file);
  if (b.mode === 'default' && b.url) return D.img(b.url);
  return null;
}

export async function homeScreen(c) {
  const [allNoms, url, appsOpen, mode, bn, user] = await Promise.all([
    S.listNominations(), S.appUrl(), S.getSetting('apps_open', '1'), S.getSetting('limit_mode', 'nomination'), S.banners(),
    S.getUser(c.userId),
  ]);
  const sponsor = await S.isSponsor(user?.username);
  const noms = allNoms.filter((n) => !n.sponsor_only || sponsor);
  const open = appsOpen === '1';

  const blocks = [];
  const pic = bannerBlock(bn.bot);
  if (pic) blocks.push(pic);
  blocks.push(D.h(`${em('star')} ${esc(AWARD_NAME)}`));
  blocks.push(D.p(`<i>${esc(COMMUNITY)} · поддержка всегда рядом</i>`));
  blocks.push(D.p(open
    ? `${em('rocket')} Сейчас идёт <b>1 тур — выдвижение</b>. Выберите номинацию: откроется форма, где нужно указать название, юзернейм и описание кандидата. ` +
      (mode === 'global' ? 'От одного человека принимается одна заявка.' : 'В каждой номинации можно предложить одного кандидата.')
    : `${em('lock')} Приём заявок сейчас закрыт.`));
  blocks.push(D.p(`${em('bell')} ${esc(ROUND2_TEXT)}.`));

  const rows = [];
  for (const n of noms) {
    if (url && n.is_open && open) rows.push([B.web(n.title, `${url}?nom=${n.id}`, { style: 'primary', emoji: nomEmoji(n) })]);
    else rows.push([B.cb(n.is_open && open ? n.title : `${n.title} · закрыто`, `nc:${n.id}`, { emoji: nomEmoji(n) })]);
  }
  const last = [];
  if (url) last.push(B.web('Открыть премию', url, { style: 'success', emoji: 'star' }));
  last.push(B.cb('Мои заявки', 'my', { emoji: 'folder' }));
  rows.push(last);
  rows.push([B.cb('Пригласить друзей', 'ref:me', { emoji: 'star' })]);
  if (c.isOwner) rows.push([B.cb('Админ-панель', 'a:home', { emoji: 'shield' })]);
  if (c.isOwner && !url) {
    blocks.push(D.p(`${em('info')} <b>Для владельца:</b> адрес мини-аппа не задан. Откройте Админ-панель → Настройки → URL мини-аппа.`));
  }
  return show(c, blocks, rows);
}

export async function myScreen(c) {
  const [allApps, url, user] = await Promise.all([S.userApplications(c.userId), S.appUrl(), S.getUser(c.userId)]);
  const sponsor = await S.isSponsor(user?.username);
  const apps = allApps.filter((a) => !a.nomination_sponsor_only || sponsor);
  const blocks = [D.h(`${em('folder')} Мои заявки`)];
  const rows = [];
  if (!apps.length) {
    blocks.push(D.p('Вы пока не отправляли заявок. Выберите номинацию в меню — это займёт пару минут.'));
  } else {
    blocks.push(D.ul(apps.map((a) => `<b>${esc(a.nomination_title)}</b> — ${esc(a.title)} (@${esc(a.username)})`)));
    blocks.push(D.p('Заявку можно изменить в мини-аппе, пока приём открыт.'));
    if (url) for (const a of apps) rows.push([B.web(`Изменить · ${a.nomination_title}`, `${url}?nom=${a.nomination_id}`, { emoji: 'write' })]);
  }
  rows.push([B.cb('‹ В меню', 'home')]);
  return show(c, blocks, rows);
}

export const bannedScreen = (c) =>
  show(c, [D.p(`${em('lock')} <b>Доступ ограничен.</b> Если считаете, что это ошибка, напишите организаторам премии.`)], []);
