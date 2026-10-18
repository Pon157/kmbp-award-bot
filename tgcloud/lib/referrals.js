// Реферальная система. Ссылка: https://t.me/<бот>?start=ref_<id>.
// Правила: привязывается только НОВЫЙ пользователь (которого бот раньше не видел); себя пригласить нельзя;
// первый пригласивший остаётся навсегда; реферал «засчитан», когда приглашённый подал хотя бы одну заявку.
import { api } from 'sdk';
import { all, get, val, run } from './db.js';
import * as S from './store.js';
import { D } from './doc.js';
import { em } from './emoji.js';
import { B, show } from './tg.js';
import { esc, now } from './util.js';

const REF_RE = /^ref_(\d{3,15})$/;
export const parseRefParam = (p) => { const m = REF_RE.exec(String(p || '').trim()); return m ? Number(m[1]) : null; };

const NOT_BANNED = "NOT IN (SELECT user_id FROM bans WHERE scope IN ('all', 'bot'))";
const VOTED = 'EXISTS (SELECT 1 FROM applications a WHERE a.user_id = r.user_id)';

export async function attachReferral(userId, referrerId) {
  userId = Number(userId); referrerId = Number(referrerId);
  if (!referrerId || !userId || referrerId === userId) return false;
  if (!(await S.getUser(referrerId))) return false;               // пригласивший должен быть известен боту
  if (await S.isBanned(referrerId, 'bot')) return false;
  if (await get('SELECT 1 AS x FROM referrals WHERE user_id = :u', { u: userId })) return false;
  try { await run('INSERT INTO referrals (user_id, referrer_id, created_at) VALUES (:u, :r, :t)', { u: userId, r: referrerId, t: now() }); }
  catch (e) { return false; }                                       // параллельная привязка — первая побеждает
  return true;
}

export async function refStats(userId) {
  const r = await get(`SELECT COUNT(*) AS invited, COALESCE(SUM(CASE WHEN ${VOTED} THEN 1 ELSE 0 END), 0) AS voted
                       FROM referrals r WHERE r.referrer_id = :u AND r.user_id ${NOT_BANNED}`, { u: userId });
  return { invited: Number(r?.invited) || 0, voted: Number(r?.voted) || 0 };
}

const TOP_FROM = `FROM referrals r LEFT JOIN users u ON u.id = r.referrer_id
  WHERE r.user_id ${NOT_BANNED} AND r.referrer_id ${NOT_BANNED} GROUP BY r.referrer_id HAVING voted > 0`;
const TOP_COLS = `r.referrer_id AS id, u.username AS username, u.first_name AS first_name, COUNT(*) AS invited,
  SUM(CASE WHEN ${VOTED} THEN 1 ELSE 0 END) AS voted`;

// Топ рефоводов: только те, у кого есть хотя бы один проголосовавший реферал.
export const refTop = (limit, offset = 0) => all(
  `SELECT ${TOP_COLS} ${TOP_FROM} ORDER BY voted DESC, invited DESC, r.referrer_id ASC LIMIT :n OFFSET :o`, { n: limit, o: offset });
export const refTopCount = async () => Number(await val(`SELECT COUNT(*) FROM (SELECT ${TOP_COLS} ${TOP_FROM})`)) || 0;

export async function refTotals() {
  const r = await get(`SELECT COUNT(*) AS invited, COALESCE(SUM(CASE WHEN ${VOTED} THEN 1 ELSE 0 END), 0) AS voted
                       FROM referrals r WHERE r.user_id ${NOT_BANNED} AND r.referrer_id ${NOT_BANNED}`);
  return { invited: Number(r?.invited) || 0, voted: Number(r?.voted) || 0 };
}

export async function botUsername() {
  let u = await S.getSetting('bot_username', '');
  if (u) return u;
  try {
    const me = await api.getMe();
    if (me && typeof me === 'object' && me.username) { u = me.username; await S.setSetting('bot_username', u); }
  } catch (e) { /* ссылка просто не покажется, пока имя бота не известно */ }
  return u;
}
export async function refLink(userId) { const b = await botUsername(); return b ? `https://t.me/${b}?start=ref_${userId}` : ''; }

// Экран пользователя: ссылка, статистика, кнопка «Поделиться».
export async function refScreen(c) {
  const [link, st] = await Promise.all([refLink(c.userId), refStats(c.userId)]);
  const blocks = [D.h(`${em('star')} Пригласить друзей`)];
  if (!link) {
    blocks.push(D.p('Ссылка пока недоступна: не удалось узнать имя бота. Попробуйте чуть позже.'));
    return show(c, blocks, [[B.cb('‹ В меню', 'home')]]);
  }
  blocks.push(D.p('Отправьте друзьям вашу ссылку. Друг засчитывается, когда проголосует хотя бы в одной номинации.'));
  blocks.push(D.p(`<code>${esc(link)}</code>`));
  blocks.push(D.ul([`Пришло по вашей ссылке: <b>${st.invited}</b>`, `Из них проголосовали: <b>${st.voted}</b>`]));
  const share = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent('Выдвигай кандидатов в премию года КМБП!');
  return show(c, blocks, [[B.url('Поделиться ссылкой', share, { style: 'success' })], [B.cb('‹ В меню', 'home')]]);
}
