// Вход в браузере через Telegram — без паролей и без настройки домена в BotFather.
//  1) сайт просит ссылку (authStart) и показывает на экране число;
//  2) человек открывает ссылку t.me/<бот>?start=login_<nonce>, бот показывает 3 числа и данные браузера;
//  3) нужно нажать то число, что на сайте (защита от «фишинговой» ссылки: чужой браузер вы не увидите);
//  4) сайт (authPoll) получает сессию в HttpOnly-cookie.
import { api } from 'sdk';
import { EndpointError } from 'sdk';
import { all, get, run, val } from './db.js';
import * as S from './store.js';
import { now, esc } from './util.js';
import { sha256, randomToken, randomInt, safeEq, ipInfo, uaHash, uaLabel, limit } from './sec.js';

export const COOKIE = 'kmbp_s';
const LOGIN_TTL = 300, SESSION_TTL = 30 * 24 * 3600, MAX_SESSIONS = 8;
const handleOf = (nonce) => sha256(nonce).slice(0, 32);

export async function startLogin({ ip, ua }) {
  const { ipHash, mask } = ipInfo(ip);
  limit(`login:ip:${ipHash}`, 6, 600, 'Слишком много попыток входа.');
  const pending = Number(await val("SELECT COUNT(*) FROM web_logins WHERE ip_hash = :ip AND status IN ('pending', 'claimed') AND expires_at > :t", { ip: ipHash, t: now() })) || 0;
  if (pending >= 5) throw new EndpointError('Слишком много незавершённых входов. Подождите несколько минут.', { code: 'RATE' });
  const bot = await S.getSetting('bot_username', '');
  if (!bot) throw new EndpointError('Вход пока недоступен: бот ещё не запущен.', { code: 'NO_BOT' });
  const nonce = randomToken(16), key = randomToken(24), code = String(randomInt(10, 100));
  const id = handleOf(nonce), t = now();
  await run(`INSERT INTO web_logins (id, poll_hash, code, status, ip_hash, ua_label, attempts, created_at, expires_at)
             VALUES (:id, :ph, :code, 'pending', :ip, :ua, 0, :t, :exp)`,
  { id, ph: sha256(key), code, ip: ipHash, ua: `${uaLabel(ua)} · IP ${mask}`, t, exp: t + LOGIN_TTL });
  return { id, key, code, link: `https://t.me/${bot}?start=login_${nonce}`, expiresIn: LOGIN_TTL };
}

// Опрос из браузера. Для выдачи сессии нужны и id, и секретный ключ, который есть только у этого браузера.
export async function pollLogin({ id, key }, { ip, ua }) {
  if (typeof id !== 'string' || typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return { status: 'gone' };
  limit(`poll:${id}`, 90, 300, 'Слишком частые запросы.');
  const row = await get('SELECT * FROM web_logins WHERE id = :id', { id });
  if (!row || !safeEq(sha256(key), row.poll_hash)) return { status: 'gone' };
  if (row.expires_at < now() && row.status !== 'used') return { status: 'expired' };
  if (row.status === 'pending' || row.status === 'claimed') return { status: row.status === 'claimed' ? 'waiting_confirm' : 'waiting' };
  if (row.status === 'denied') return { status: 'denied' };
  if (row.status === 'failed') return { status: 'failed' };
  if (row.status === 'used') return { status: 'gone' };
  // confirmed → меняем статус атомарно: сессию получит только один запрос
  const claim = await run("UPDATE web_logins SET status = 'used' WHERE id = :id AND status = 'confirmed'", { id });
  if (!claim.rowsAffected) return { status: 'gone' };
  const token = await createSession(row.user_id, { ip, ua });
  return { status: 'ok', token };
}

export async function createSession(userId, { ip, ua }) {
  const token = randomToken(32), t = now(), { ipHash } = ipInfo(ip);
  await run('INSERT INTO web_sessions (id, user_id, ip_hash, ua_hash, created_at, last_at, expires_at) VALUES (:id, :u, :ip, :ua, :t, :t, :exp)',
    { id: sha256(token), u: userId, ip: ipHash, ua: uaHash(ua), t, exp: t + SESSION_TTL });
  await run(`DELETE FROM web_sessions WHERE user_id = :u AND id NOT IN (SELECT id FROM web_sessions WHERE user_id = :u ORDER BY created_at DESC LIMIT ${MAX_SESSIONS})`, { u: userId });
  return token;
}
export async function resolveSession(token) {
  if (typeof token !== 'string' || token.length < 30 || token.length > 80) return null;
  const id = sha256(token), t = now();
  const s = await get('SELECT * FROM web_sessions WHERE id = :id', { id });
  if (!s || s.expires_at < t) return null;
  if (t - s.last_at > 600) await run('UPDATE web_sessions SET last_at = :t WHERE id = :id', { t, id });
  const u = await S.getUser(s.user_id);
  if (!u) return null;
  return { id: u.id, username: u.username || undefined, first_name: u.first_name || '', last_name: u.last_name || undefined, sid: id };
}
export const destroySession = (token) => run('DELETE FROM web_sessions WHERE id = :id', { id: sha256(String(token)) });
export const purgeLogins = async () => {
  await run('DELETE FROM web_logins WHERE expires_at < :t', { t: now() - 3600 });
  await run('DELETE FROM web_sessions WHERE expires_at < :t', { t: now() });
};

export function sessionCookie(token, secure) {
  return `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
export const clearCookie = (secure) => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

// ── Сторона бота ────────────────────────────────────────────────────
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = randomInt(0, i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export async function botStart(from, chatId, nonce) {
  const id = handleOf(String(nonce).slice(0, 40));
  const row = await get('SELECT * FROM web_logins WHERE id = :id', { id });
  const say = (text, rows) => api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: rows ? { inline_keyboard: rows } : undefined });
  if (!row || row.status !== 'pending' || row.expires_at < now()) return say('Эта ссылка для входа уже не действует. Вернитесь на сайт и нажмите «Войти через Telegram» ещё раз.');
  if (await S.isBanned(from.id, 'app')) { await run("UPDATE web_logins SET status = 'failed' WHERE id = :id", { id }); return say('Доступ к сайту ограничен.'); }
  const claim = await run("UPDATE web_logins SET status = 'claimed', user_id = :u WHERE id = :id AND status = 'pending'", { u: from.id, id });
  if (!claim.rowsAffected) return say('Эта ссылка уже использована.');
  const nums = new Set([row.code]);
  while (nums.size < 3) nums.add(String(randomInt(10, 100)));
  const kb = shuffle([...nums]).map((n) => ({ text: n, callback_data: `lg:${nonce}:${n}` }));
  return say(`<b>Вход на сайт премии</b>\nЗапрос с устройства: <b>${esc(row.ua_label)}</b>\n\nВыберите число, которое сейчас показано <b>на экране сайта</b>. Если вы ничего не открывали — нажмите «Это не я».`,
    [kb, [{ text: 'Это не я', callback_data: `lg:${nonce}:no` }]]);
}

// callback_data: lg:<nonce>:<число|no>. Возвращает текст-подсказку для toast.
export async function botCallback(from, chatId, msgId, data) {
  const m = /^lg:([A-Za-z0-9_-]{10,40}):(\d{2}|no)$/.exec(data);
  if (!m) return 'Неверный запрос';
  const [, nonce, pick] = m, id = handleOf(nonce);
  const row = await get('SELECT * FROM web_logins WHERE id = :id', { id });
  const edit = (text) => api.editMessageText({ chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML' }).catch(() => {});
  if (!row || row.status !== 'claimed' || row.user_id !== from.id || row.expires_at < now()) { await edit('Запрос на вход уже не действует.'); return 'Запрос устарел'; }
  if (pick === 'no') { await run("UPDATE web_logins SET status = 'denied' WHERE id = :id", { id }); await edit('Вход отклонён. Если это были не вы — ничего делать не нужно.'); return 'Отклонено'; }
  if (!safeEq(pick, row.code)) { await run("UPDATE web_logins SET status = 'failed' WHERE id = :id", { id }); await edit('Число не совпало — вход отменён. Вернитесь на сайт и попробуйте снова.'); return 'Не то число'; }
  await run("UPDATE web_logins SET status = 'confirmed' WHERE id = :id AND status = 'claimed'", { id });
  await S.touchUser(from);
  await edit('Вход подтверждён. Вернитесь на сайт — он откроется сам.');
  return 'Готово';
}
