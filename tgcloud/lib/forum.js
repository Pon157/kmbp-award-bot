// Форум 2 тура: только текст. Защита от спама: лимиты частоты, дубли, ссылки/упоминания, капс, повторы, жалобы, автомьют.
import { EndpointError } from 'sdk';
import { all, get, run, val } from './db.js';
import * as S from './store.js';
import { R2 } from './config.js';
import { now, cleanText } from './util.js';
import { hit } from './sec.js';
import { getCfg, publicName } from './r2.js';

const err = (m, code, extra) => new EndpointError(m, { code, ...(extra || {}) });

const DEFAULT_TOPICS = [
  ['Общий разговор', 'Всё о премии и сообществе'],
  ['Про номинации', 'Кого поддержать и почему'],
  ['Идеи и предложения', 'Что улучшить в премии'],
];
export async function ensureTopics() {
  if ((await S.getSetting('r2_topics_seeded')) === '1') return;
  const claimed = await run("INSERT OR IGNORE INTO settings (key, value) VALUES ('r2_topics_seeded', '1')");
  if (!claimed?.rowsAffected) return;
  let pos = 1;
  for (const [title, descr] of DEFAULT_TOPICS) await run('INSERT INTO r2_topics (title, descr, locked, pinned, active, position, created_at) VALUES (:t, :d, 0, 0, 1, :p, :a)', { t: title, d: descr, p: pos++, a: now() });
}

export async function listTopics() {
  await ensureTopics();
  const rows = await all(
    `SELECT t.id, t.title, t.descr, t.locked, t.pinned,
            (SELECT COUNT(*) FROM r2_posts p WHERE p.topic_id = t.id AND p.hidden = 0) AS posts,
            (SELECT MAX(p.created_at) FROM r2_posts p WHERE p.topic_id = t.id AND p.hidden = 0) AS last_at
     FROM r2_topics t WHERE t.active = 1 ORDER BY t.pinned DESC, t.position, t.id`);
  return rows.map((t) => ({ id: t.id, title: t.title, descr: t.descr, locked: !!t.locked, pinned: !!t.pinned, posts: Number(t.posts), lastAt: t.last_at || 0 }));
}

// ── Проверка текста ─────────────────────────────────────────────────
const TLD = 'com|ru|net|org|io|me|xyz|info|biz|cc|su|ua|by|kz|top|club|online|site|shop|store|app|dev|ly|gg|tv|to|link|click|live|pro|co|ru\\.net|рф';
const URL_RE = new RegExp(`(https?:\\/\\/|www\\.|tg:\\/\\/|\\bt\\s?\\.\\s?me\\b|telegram\\.me|telegram\\.dog|\\b[\\p{L}\\p{N}-]{2,}\\s?\\.\\s?(?:${TLD})\\b)`, 'iu');
const MENTION_RE = /(^|[^\p{L}\p{N}_])@[A-Za-z][A-Za-z0-9_]{3,31}/u;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

export function normText(s) {
  return String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '').replace(/(.)\1{2,}/gu, '$1$1');
}
export function checkText(raw, { staff = false } = {}) {
  let text = cleanText(raw, R2.POST_MAX * 2);
  text = text.replace(/[\u0300-\u036f]{2,}/g, '').replace(/\n{3,}/g, '\n\n');     // «зальго»-символы и пустые строки
  const bad = (reason, spam = true) => ({ ok: false, reason, spam });
  if (text.length < R2.POST_MIN) return bad('Сообщение слишком короткое', false);
  if (text.length > R2.POST_MAX) return bad(`Сообщение длиннее ${R2.POST_MAX} символов`, false);
  if (text.split('\n').length > 8) return bad('Слишком много строк', false);
  if (!/[\p{L}\p{N}]/u.test(text)) return bad('Напишите хотя бы пару слов');
  if (!staff) {
    if (URL_RE.test(text) || URL_RE.test(text.replace(/[\s()\[\]{}<>*_|]+/g, ''))) return bad('Ссылки на форуме не разрешены');
    if (MENTION_RE.test(text)) return bad('Упоминания @юзернеймов на форуме не разрешены');
    if (/(.)\1{7,}/u.test(text)) return bad('Слишком много одинаковых символов подряд');
    const letters = [...text].filter((c) => /\p{L}/u.test(c));
    if (letters.length > 12 && letters.filter((c) => c !== c.toLowerCase()).length / letters.length > 0.7) return bad('Пожалуйста, не пишите капсом');
    if ((text.match(EMOJI_RE) || []).length > 10) return bad('Слишком много эмодзи');
  }
  return { ok: true, text, norm: normText(text) };
}

// ── Мьюты и нарушения ───────────────────────────────────────────────
const violations = new Map();            // userId → времена нарушений (в памяти процесса)
export const resetViolations = () => violations.clear();   // для тестов
const MUTE_STEPS = [600, 3600, 86400, 7 * 86400];
export async function muteInfo(userId) {
  const m = await get('SELECT * FROM r2_mutes WHERE user_id = :u', { u: userId });
  if (!m) return null;
  if (m.until !== 0 && m.until <= now()) return null;
  return m;
}
export async function mute(userId, seconds, reason, auto = false) {
  const prev = await get('SELECT strikes FROM r2_mutes WHERE user_id = :u', { u: userId });
  const strikes = (prev?.strikes || 0) + (auto ? 1 : 0);
  const until = seconds === 0 ? 0 : now() + seconds;
  await run(`INSERT INTO r2_mutes (user_id, until, reason, strikes, at) VALUES (:u, :until, :r, :s, :t)
             ON CONFLICT(user_id) DO UPDATE SET until = excluded.until, reason = excluded.reason, strikes = excluded.strikes, at = excluded.at`,
  { u: userId, until, r: reason || null, s: strikes, t: now() });
  return until;
}
export const unmute = (userId) => run('DELETE FROM r2_mutes WHERE user_id = :u', { u: userId });
async function strike(userId, why) {
  const t = Date.now(), a = (violations.get(userId) || []).filter((x) => t - x < 600000);
  a.push(t); violations.set(userId, a);
  if (a.length >= 5) {
    violations.delete(userId);
    const prev = await get('SELECT strikes FROM r2_mutes WHERE user_id = :u', { u: userId });
    const sec = MUTE_STEPS[Math.min(prev?.strikes || 0, MUTE_STEPS.length - 1)];
    await mute(userId, sec, 'автомьют: ' + why, true);
    return sec;
  }
  return 0;
}
const fmtLeft = (until) => { if (until === 0) return 'навсегда'; const s = until - now(); return s >= 3600 ? `ещё ${Math.ceil(s / 3600)} ч` : `ещё ${Math.max(1, Math.ceil(s / 60))} мин`; };

// ── Чтение ──────────────────────────────────────────────────────────
export async function listPosts(user, { topicId, after = 0, before = 0 }) {
  const topic = await get('SELECT * FROM r2_topics WHERE id = :id AND active = 1', { id: Number(topicId) });
  if (!topic) throw err('Тема не найдена', 'NOT_FOUND');
  const staff = await S.isOwner(user.id);
  const vis = staff ? '' : 'AND p.hidden = 0';
  const base = `SELECT p.id, p.user_id, p.name, p.is_staff, p.body, p.reply_to, p.hidden, p.reports, p.created_at,
                       r.name AS r_name, r.body AS r_body, r.hidden AS r_hidden
                FROM r2_posts p LEFT JOIN r2_posts r ON r.id = p.reply_to WHERE p.topic_id = :t`;
  let rows;
  if (after > 0) rows = await all(`${base} AND p.id > :a ${vis} ORDER BY p.id ASC LIMIT 100`, { t: topic.id, a: Number(after) });
  else if (before > 0) rows = (await all(`${base} AND p.id < :b ${vis} ORDER BY p.id DESC LIMIT 40`, { t: topic.id, b: Number(before) })).reverse();
  else rows = (await all(`${base} ${vis} ORDER BY p.id DESC LIMIT 40`, { t: topic.id })).reverse();
  const maxId = Number(await val('SELECT MAX(id) FROM r2_posts WHERE topic_id = :t', { t: topic.id })) || 0;
  const gone = staff ? [] : (await all('SELECT id FROM r2_posts WHERE topic_id = :t AND hidden = 1 AND id > :m', { t: topic.id, m: Math.max(0, maxId - 150) })).map((r) => r.id);
  const reported = new Set((await all('SELECT post_id FROM r2_reports WHERE user_id = :u AND post_id IN (SELECT id FROM r2_posts WHERE topic_id = :t)', { u: user.id, t: topic.id })).map((r) => r.post_id));
  return {
    topic: { id: topic.id, title: topic.title, descr: topic.descr, locked: !!topic.locked },
    posts: rows.map((p) => ({
      id: p.id, name: p.name, staff: !!p.is_staff, text: p.body, at: p.created_at, mine: p.user_id === user.id,
      reply: p.reply_to ? { id: p.reply_to, name: p.r_name || '', text: p.r_hidden && !staff ? 'сообщение скрыто' : String(p.r_body || '').slice(0, 90) } : null,
      hidden: staff ? !!p.hidden : undefined, reports: staff ? p.reports : undefined, userId: staff ? p.user_id : undefined,
      reported: reported.has(p.id),
    })),
    gone, more: before > 0 || after === 0 ? rows.length >= 40 : false,
  };
}

// ── Запись ──────────────────────────────────────────────────────────
export async function post(user, input, req) {
  const cfg = await getCfg();
  if (!cfg.forum) throw err('Форум сейчас закрыт', 'CLOSED');
  const staff = await S.isOwner(user.id);
  const topic = await get('SELECT * FROM r2_topics WHERE id = :id AND active = 1', { id: Number(input?.topicId) });
  if (!topic) throw err('Тема не найдена', 'NOT_FOUND');
  if (topic.locked && !staff) throw err('Тема закрыта для новых сообщений', 'LOCKED');
  const m = await muteInfo(user.id);
  if (m && !staff) throw err(`Вы временно не можете писать на форуме (${fmtLeft(m.until)}).`, 'MUTED');

  if (!staff) {
    // Лимиты частоты — до любой работы с базой.
    const gap = hit(`f:gap:${user.id}`, 1, 6);
    if (!gap.ok) throw err(`Не так быстро — подождите ${gap.retry} с.`, 'RATE', { retry: gap.retry });
    const burst = hit(`f:2m:${user.id}`, 8, 120), hour = hit(`f:1h:${user.id}`, 40, 3600);
    const ip = req?.ipHash ? hit(`f:ip:${req.ipHash}`, 30, 600) : { ok: true };
    if (!burst.ok || !hour.ok || !ip.ok) {
      const sec = await strike(user.id, 'частота');
      throw err(sec ? `Слишком много сообщений. Вы отдохнёте от форума (${fmtLeft(now() + sec)}).` : 'Слишком много сообщений — немного подождите.', 'RATE', { retry: Math.max(burst.retry, hour.retry, ip.retry || 0) });
    }
  }
  const chk = checkText(input?.text, { staff });
  if (!chk.ok) {
    if (chk.spam && !staff) { const sec = await strike(user.id, chk.reason); if (sec) throw err(`${chk.reason}. Вы отдохнёте от форума (${fmtLeft(now() + sec)}).`, 'MUTED'); }
    throw err(chk.reason, 'TEXT');
  }
  if (!staff && chk.norm.length >= 8) {
    const dupOwn = await get('SELECT id FROM r2_posts WHERE user_id = :u AND norm = :n AND created_at > :t LIMIT 1', { u: user.id, n: chk.norm, t: now() - 1800 });
    const dupAny = chk.norm.length >= 12 ? await get('SELECT id FROM r2_posts WHERE norm = :n AND user_id <> :u AND created_at > :t LIMIT 1', { n: chk.norm, u: user.id, t: now() - 600 }) : null;
    if (dupOwn || dupAny) {
      const sec = await strike(user.id, 'повтор сообщений');
      throw err(sec ? `Повторяющиеся сообщения. Вы отдохнёте от форума (${fmtLeft(now() + sec)}).` : 'Такое сообщение уже есть — не повторяйтесь.', 'DUP');
    }
  }
  let replyTo = null;
  if (input?.replyTo) {
    const r = await get('SELECT id FROM r2_posts WHERE id = :id AND topic_id = :t AND hidden = 0', { id: Number(input.replyTo), t: topic.id });
    if (r) replyTo = r.id;
  }
  const u = await S.getUser(user.id);
  const name = staff ? 'Организатор' : publicName(u || user);
  const id = (await run(`INSERT INTO r2_posts (topic_id, user_id, name, is_staff, body, norm, reply_to, hidden, reports, created_at)
                         VALUES (:t, :u, :name, :staff, :b, :norm, :r, 0, 0, :at)`,
  { t: topic.id, u: user.id, name, staff: staff ? 1 : 0, b: chk.text, norm: chk.norm, r: replyTo, at: now() })).lastInsertRowid;
  return { id, name };
}

export async function report(user, postId) {
  if (!hit(`f:rep:${user.id}`, 10, 600).ok) throw err('Слишком много жалоб подряд', 'RATE');
  const p = await get('SELECT id, user_id, is_staff, hidden FROM r2_posts WHERE id = :id', { id: Number(postId) });
  if (!p || p.is_staff) return { ok: true };
  if (p.user_id === user.id) throw err('Нельзя пожаловаться на своё сообщение', 'BAD');
  const ins = await run('INSERT OR IGNORE INTO r2_reports (post_id, user_id, created_at) VALUES (:p, :u, :t)', { p: p.id, u: user.id, t: now() });
  if (ins.rowsAffected) {
    const n = Number(await val('SELECT COUNT(*) FROM r2_reports WHERE post_id = :p', { p: p.id }));
    await run('UPDATE r2_posts SET reports = :n, hidden = CASE WHEN :n >= 3 THEN 1 ELSE hidden END WHERE id = :p', { n, p: p.id });
  }
  return { ok: true };
}
export async function deleteOwn(user, postId) {
  await run('UPDATE r2_posts SET hidden = 1 WHERE id = :id AND user_id = :u', { id: Number(postId), u: user.id });
  return { ok: true };
}
