import * as S from '../lib/store.js';
import { enter } from '../lib/appctx.js';
import { safe } from '../lib/tg.js';
import { requiredFrom, coinProgress } from '../lib/coins.js';
import { kindOf } from '../lib/kinds.js';
import { AWARD_NAME, COMMUNITY, ROUND2_TEXT, DEFAULT_ABOUT } from '../lib/config.js';

const parse = (s, d) => { try { return JSON.parse(s); } catch (e) { return d; } };

// Всё для лендинга одним запросом.
export default async function (input, ctx) {
  const user = await enter(ctx);
  const [noms, mine, news, links, about, open, mode, bn, sponsor, sponsorBanners] = await Promise.all([
    S.listNominations(), S.userApplications(user.id), S.listNews(30), S.listLinks(),
    S.getSetting('about', DEFAULT_ABOUT), S.getSetting('apps_open', '1'), S.getSetting('limit_mode', 'nomination'), S.banners(),
    S.isSponsor(user.username), S.listSponsorBanners(),
  ]);
  const myByNom = Object.fromEntries(mine.map((a) => [a.nomination_id, a]));
  const normalNominations = noms.filter((n) => !n.sponsor_type);
  const sponsorNominations = sponsor ? noms.filter((n) => !!n.sponsor_type) : [];
  const mapNomination = (n) => ({
    id: n.id, title: n.title, kind: n.kind, noun: kindOf(n.kind).name,
    sponsorType: n.sponsor_type || null,
    open: !!n.is_open && open === '1',
    submitted: myByNom[n.id] ? { title: myByNom[n.id].title, username: myByNom[n.id].username } : null,
  });
  // Бэкап и напоминания теперь запускает фоновый tick — главная не ждёт их.
  const prog = await safe(() => coinProgress(user.id, requiredFrom(noms, open, mode)));
  return {
    award: { name: AWARD_NAME, community: COMMUNITY, round2: ROUND2_TEXT, about },
    // custom: картинка грузится отдельным запросом getBanner, чтобы не тормозить главную
    banner: bn.site.mode === 'off' ? null : bn.site.mode === 'custom' ? { custom: true, lazy: true } : { src: bn.site.src, custom: false },
    appsOpen: open === '1',
    limitMode: mode,
    nominations: normalNominations.map(mapNomination),
    sponsorNominations: sponsorNominations.map(mapNomination),
    sponsorBanners: sponsorBanners.slice(0, 8).map((b) => ({ id: b.id, targetUrl: b.target_url })),
    isSponsor: sponsor,
    coins: prog ? { enabled: prog.enabled, reward: prog.reward, balance: prog.balance, earned: prog.earned, required: prog.required, covered: prog.covered } : null,
    news: news.map((n) => ({ id: n.id, text: n.text, entities: parse(n.entities, []), pinned: !!n.pinned, at: n.created_at })),
    links: links.map((l) => ({ id: l.id, title: l.title, url: l.url, kind: l.kind })),
    user: { id: user.id, name: user.first_name || '' },
  };
}
