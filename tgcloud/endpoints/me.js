import * as S from '../lib/store.js';
import { enter } from '../lib/appctx.js';
import { accessOf } from '../lib/r2.js';
import { AWARD_NAME, COMMUNITY, ROUND2_TEXT } from '../lib/config.js';

const parse = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };

// Первый запрос клиента: кто вошёл, есть ли доступ к 2 туру, и общие данные главной (новости, ссылки, баннеры спонсоров).
export default async function (input, ctx) {
  const user = await enter(ctx);
  const [access, news, links, banners, bot] = await Promise.all([accessOf(user.id), S.listNews(10), S.listLinks(), S.listSponsorBanners(), S.getSetting('bot_username', '')]);
  return {
    user: { id: user.id, name: user.first_name || user.username || 'Участник', username: user.username || '' },
    via: ctx.initData?.via || 'tg',
    access: access.ok, owner: !!access.owner, bot,
    award: { name: AWARD_NAME, community: COMMUNITY, round2: ROUND2_TEXT },
    news: news.map((n) => ({ id: n.id, text: n.text, entities: parse(n.entities, []), pinned: !!n.pinned, at: n.created_at })),
    links: links.map((l) => ({ id: l.id, title: l.title, url: l.url, kind: l.kind })),
    sponsorBanners: banners.slice(0, 8).map((b) => ({ id: b.id, targetUrl: b.target_url })),
  };
}
