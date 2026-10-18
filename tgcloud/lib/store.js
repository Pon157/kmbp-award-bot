// Доступ к данным.
import { all, get, run, insert, val } from './db.js';
import { OWNER_IDS, APP_URL, DEFAULT_NOMINATIONS, DEFAULT_ABOUT, BACKUP_EVERY } from './config.js';
import { now, oneLine, cleanText, normUsername, isUsername } from './util.js';

// ── Настройки ─────────────────────────────────────────────────────────
export const getSetting = async (key, def = null) => {
  const v = await val('SELECT value FROM settings WHERE key = :key', { key });
  return v === null || v === undefined ? def : v;
};
export const setSetting = (key, value) =>
  run('INSERT INTO settings (key, value) VALUES (:key, :value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    { key, value: value === null ? null : String(value) });

// ── Чёрный список юзернеймов кандидатов ───────────────────────────────
// Хранится в settings как JSON-массив в нижнем регистре — отдельная таблица и migrate не нужны.
const BL_KEY = 'username_blacklist';
export async function getBlacklist() {
  try {
    const a = JSON.parse((await getSetting(BL_KEY, '[]')) || '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch (e) { return []; }
}
export const isBlacklisted = async (norm) => (await getBlacklist()).includes(String(norm || '').toLowerCase());
export async function addBlacklist(norms) {
  const list = await getBlacklist();
  const added = [];
  for (const raw of norms) {
    const n = String(raw || '').toLowerCase();
    if (n && !list.includes(n)) { list.push(n); added.push(n); }
  }
  if (added.length) await setSetting(BL_KEY, JSON.stringify(list));
  return added;
}
export async function removeBlacklist(norm) {
  const n = String(norm || '').toLowerCase();
  const list = await getBlacklist();
  const next = list.filter((x) => x !== n);
  if (next.length === list.length) return false;
  await setSetting(BL_KEY, JSON.stringify(next));
  return true;
}

export async function appUrl() {
  const u = (await getSetting('app_url')) || APP_URL || '';
  return u && !u.endsWith('/') ? u + '/' : u;
}

// Баннеры (картинка сверху): отдельно в боте и отдельно в мини-аппе.
// banner_bot / banner_site: default — стандартная из app/img · custom — загруженное фото · off — без баннера.
// Бот хранит file_id (banner_bot_file). Для сайта нужны байты: банк хранит base64 (banner_site_data), file_id — для превью.
export async function banners() {
  const [bm, bf, sm, sf, base] = await Promise.all([
    getSetting('banner_bot', 'default'), getSetting('banner_bot_file', ''),
    getSetting('banner_site', 'default'), getSetting('banner_site_file', ''), appUrl(),
  ]);
  const pick = (mode, file) => (mode === 'off' ? 'off' : mode === 'custom' && file ? 'custom' : 'default');
  return {
    bot: { mode: pick(bm, bf), file: bf || null, url: base ? base + 'img/hero-640.jpg' : null },
    site: { mode: pick(sm, sf), file: sf || null, src: 'img/hero.jpg', url: base ? base + 'img/hero-640.jpg' : null },
  };
}
export async function setBanner(kind, mode, file = '', data = '') {
  if (kind === 'site') {
    await setSetting('banner_site_data', mode === 'custom' ? data : '');
    await setSetting('banner_site_file', mode === 'custom' ? file : '');
    await setSetting('banner_site', mode);
  } else {
    await setSetting('banner_bot_file', mode === 'custom' ? file : '');
    await setSetting('banner_bot', mode);
  }
}
export const siteBannerData = () => getSetting('banner_site_data', '');

// Первый запуск: номинации по умолчанию и служебные настройки.
export async function ensureSeed() {
  if (!(await getSetting('seeded'))) {
    const claimed = await run("INSERT OR IGNORE INTO settings (key, value) VALUES ('seeded', '1')");
    if (claimed?.rowsAffected) {
      let pos = 1;
      for (const n of DEFAULT_NOMINATIONS) {
        await run('INSERT INTO nominations (title, kind, emoji_id, is_open, active, position, created_at) VALUES (:title, :kind, :emoji, 1, 1, :pos, :at)',
          { title: n.title, kind: n.kind, emoji: n.emoji, pos: pos++, at: now() });
      }
      await setSetting('about', DEFAULT_ABOUT);
      await setSetting('apps_open', '1');
      await setSetting('limit_mode', 'nomination');
      await setSetting('auto_backup', '1');
      await setSetting('last_backup', String(now()));
    }
  }
  await ensureSponsorNominations();
}

const SPONSOR_NOMINATIONS = [
  { type: 'person', title: 'Спонсорская номинация — Личность', kind: 'person' },
  { type: 'bot', title: 'Спонсорская номинация — Бот', kind: 'bot' },
  { type: 'project', title: 'Спонсорская номинация — Проект', kind: 'project' },
];

export async function ensureSponsorNominations() {
  for (const n of SPONSOR_NOMINATIONS) {
    const exists = await val('SELECT id FROM nominations WHERE sponsor_type = :type', { type: n.type });
    if (exists) continue;
    const pos = ((await val('SELECT MAX(position) FROM nominations')) || 0) + 1;
    await run(`INSERT OR IGNORE INTO nominations
      (title, kind, sponsor_type, sponsor_only, is_open, active, position, created_at)
      VALUES (:title, :kind, :type, 1, 1, 1, :pos, :at)`,
    { title: n.title, kind: n.kind, type: n.type, pos, at: now() });
  }
}

// ── Пользователи ──────────────────────────────────────────────────────
export async function touchUser(u, { started = false } = {}) {
  if (!u?.id) return;
  const t = now();
  await run(
    `INSERT INTO users (id, username, first_name, last_name, started, blocked, first_seen, last_seen)
     VALUES (:id, :username, :fn, :ln, :started, 0, :t, :t)
     ON CONFLICT(id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name,
       last_name = excluded.last_name, last_seen = excluded.last_seen,
       started = CASE WHEN :started = 1 THEN 1 ELSE users.started END,
       blocked = CASE WHEN :started = 1 THEN 0 ELSE users.blocked END`,
    { id: u.id, username: u.username ?? null, fn: u.first_name ?? null, ln: u.last_name ?? null, started: started ? 1 : 0, t });
}
export const getUser = (id) => get('SELECT * FROM users WHERE id = :id', { id });
export const findUserByUsername = (name) =>
  get('SELECT * FROM users WHERE lower(username) = lower(:n)', { n: String(name).replace(/^@/, '') });
export const setBlocked = (id, blocked) => run('UPDATE users SET blocked = :b WHERE id = :id', { id, b: blocked ? 1 : 0 });

// ── Владельцы и баны ──────────────────────────────────────────────────
export async function isOwner(id) {
  if (!id) return false;
  if (OWNER_IDS.includes(Number(id))) return true;
  return !!(await get('SELECT user_id FROM owners WHERE user_id = :id', { id }));
}
export async function ownerIds() {
  const rows = await all('SELECT user_id FROM owners');
  return [...new Set([...OWNER_IDS.map(Number), ...rows.map((r) => r.user_id)])];
}
export const addOwner = (id, by) => run('INSERT OR IGNORE INTO owners (user_id, added_by, added_at) VALUES (:id, :by, :t)', { id, by, t: now() });
export const removeOwner = (id) => run('DELETE FROM owners WHERE user_id = :id', { id });

export async function banScope(id) {
  const r = await get('SELECT scope FROM bans WHERE user_id = :id', { id });
  return r ? r.scope : null;
}
export async function isBanned(id, where) {
  const s = await banScope(id);
  return !!s && (s === 'all' || s === where);
}
export const ban = (id, scope, reason, by) =>
  run(`INSERT INTO bans (user_id, scope, reason, by_id, at) VALUES (:id, :scope, :reason, :by, :t)
       ON CONFLICT(user_id) DO UPDATE SET scope = excluded.scope, reason = excluded.reason, by_id = excluded.by_id, at = excluded.at`,
    { id, scope, reason: reason ?? null, by, t: now() });
export const unban = (id) => run('DELETE FROM bans WHERE user_id = :id', { id });

// ── Номинации ─────────────────────────────────────────────────────────
export const listNominations = () => all('SELECT * FROM nominations WHERE active = 1 ORDER BY position, id');
export const getNomination = (id) => get('SELECT * FROM nominations WHERE id = :id AND active = 1', { id });
export const listSponsorNominations = () =>
  all('SELECT * FROM nominations WHERE active = 1 AND sponsor_type IS NOT NULL ORDER BY position, id');
export async function createNomination({ title, kind, emojiId }) {
  const pos = ((await val('SELECT MAX(position) FROM nominations')) || 0) + 1;
  return insert('INSERT INTO nominations (title, kind, emoji_id, is_open, active, position, created_at) VALUES (:title, :kind, :emoji, 1, 1, :pos, :t)',
    { title: oneLine(title, 60), kind, emoji: emojiId ?? null, pos, t: now() });
}
export const updateNomination = (id, fields) => {
  const map = { title: 'title', kind: 'kind', emoji_id: 'emoji_id', is_open: 'is_open' };
  const keys = Object.keys(fields).filter((k) => map[k]);
  if (!keys.length) return null;
  return run(`UPDATE nominations SET ${keys.map((k) => `${map[k]} = :${k}`).join(', ')} WHERE id = :id`, { ...fields, id });
};
export const deleteNomination = async (id) => {
  await run('UPDATE nominations SET active = 0 WHERE id = :id', { id });
};

export const listQuestions = (nid, onlyActive = true) =>
  all(`SELECT * FROM questions WHERE nomination_id = :nid ${onlyActive ? 'AND active = 1' : ''} ORDER BY position, id`, { nid });
export const getQuestion = (id) => get('SELECT * FROM questions WHERE id = :id', { id });
export async function addQuestion(nid, text, required = false) {
  const pos = ((await val('SELECT MAX(position) FROM questions WHERE nomination_id = :nid', { nid })) || 0) + 1;
  return insert('INSERT INTO questions (nomination_id, text, required, max_len, active, position) VALUES (:nid, :text, :req, 500, 1, :pos)',
    { nid, text: oneLine(text, 200), req: required ? 1 : 0, pos });
}
export const toggleQuestionRequired = (id) => run('UPDATE questions SET required = 1 - required WHERE id = :id', { id });
export const deleteQuestion = (id) => run('UPDATE questions SET active = 0 WHERE id = :id', { id });

// ── Заявки ────────────────────────────────────────────────────────────
export const getApplication = (id) => get('SELECT * FROM applications WHERE id = :id', { id });
export const userApplications = (userId) =>
  all(`SELECT a.*, n.title AS nomination_title, n.kind AS nomination_kind,
              n.sponsor_type AS nomination_sponsor_type, n.sponsor_only AS nomination_sponsor_only FROM applications a
       JOIN nominations n ON n.id = a.nomination_id WHERE a.user_id = :userId ORDER BY a.id`, { userId });
export const userApplication = (userId, nominationId) =>
  get('SELECT * FROM applications WHERE user_id = :userId AND nomination_id = :nominationId', { userId, nominationId });
export const nominationApplications = (nominationId) =>
  all('SELECT id, user_id, username, username_norm, title, admin_chat_id, admin_msg_id FROM applications WHERE nomination_id = :nominationId', { nominationId });
export const deleteApplication = (id) => run('DELETE FROM applications WHERE id = :id', { id });
// Совпадение юзернейма с записью спонсора в подноминации того же типа (Личность / Бот / Проект).
// Подходит только точное совпадение. Возвращает { id, title, app_id } или null.
export async function findSponsorMatch(kind, usernameNorm) {
  if (!['person', 'bot', 'project'].includes(kind)) return null;
  return get(`SELECT n.id AS id, n.title AS title, a.id AS app_id
              FROM applications a JOIN nominations n ON n.id = a.nomination_id
              WHERE n.active = 1 AND n.sponsor_type = :kind AND a.username_norm = :usernameNorm
              ORDER BY a.id LIMIT 1`, { kind, usernameNorm });
}
export const sponsorVotesCount = (sponsorNominationId, usernameNorm = null) => val(
  usernameNorm
    ? 'SELECT COUNT(*) FROM applications WHERE sponsor_nomination_id = :sid AND username_norm = :usernameNorm'
    : 'SELECT COUNT(*) FROM applications WHERE sponsor_nomination_id = :sid',
  { sid: sponsorNominationId, usernameNorm });
export const applicationsByUsername = (usernameNorm) =>
  all(`SELECT a.id, a.nomination_id, a.title, a.username, a.description, a.answers, a.created_at,
              n.title AS nomination_title, n.kind AS nomination_kind
       FROM applications a JOIN nominations n ON n.id = a.nomination_id
       WHERE a.username_norm = :usernameNorm AND n.sponsor_type IS NULL
       ORDER BY a.created_at, a.id`, { usernameNorm });

// ── Спонсоры и рекламные баннеры ─────────────────────────────────────
export const listSponsors = () => all('SELECT * FROM sponsors ORDER BY added_at, id');
export const getSponsor = (id) => get('SELECT * FROM sponsors WHERE id = :id', { id });
export async function isSponsor(username) {
  const norm = normUsername(username).toLowerCase();
  if (!isUsername(norm)) return false;
  return !!(await get('SELECT id FROM sponsors WHERE username_norm = :usernameNorm', { usernameNorm: norm }));
}
export async function addSponsor(username, by) {
  const clean = normUsername(username);
  const norm = clean.toLowerCase();
  if (!isUsername(norm)) throw new Error('Некорректный Telegram username');
  return insert(`INSERT INTO sponsors (username, username_norm, added_by, added_at)
                 VALUES (:username, :usernameNorm, :by, :at)`,
  { username: clean, usernameNorm: norm, by, at: now() });
}
export const deleteSponsor = (id) => run('DELETE FROM sponsors WHERE id = :id', { id });

export const listSponsorBanners = () =>
  all('SELECT id, title, target_url, active, position, created_at FROM sponsor_banners WHERE active = 1 ORDER BY position, id');
export const getSponsorBanner = (id) =>
  get('SELECT id, title, target_url, image_data FROM sponsor_banners WHERE id = :id AND active = 1', { id });
export async function addSponsorBanner(title, targetUrl, imageData) {
  title = title || 'Баннер'; // подпись не показывается; поле оставлено для совместимости с базой
  const position = ((await val('SELECT MAX(position) FROM sponsor_banners')) || 0) + 1;
  return insert(`INSERT INTO sponsor_banners (title, target_url, image_data, active, position, created_at)
                 VALUES (:title, :url, :data, 1, :position, :at)`,
  { title: oneLine(title, 80), url: targetUrl, data: imageData, position, at: now() });
}
export const deleteSponsorBanner = (id) => run('DELETE FROM sponsor_banners WHERE id = :id', { id });

// ── Новости и ссылки ──────────────────────────────────────────────────
export const listNews = (limit = 30) => all('SELECT * FROM news ORDER BY pinned DESC, id DESC LIMIT :limit', { limit });
export function addNews(text, entities, by) {
  return insert('INSERT INTO news (text, entities, pinned, created_by, created_at) VALUES (:text, :entities, 0, :by, :t)',
    { text: cleanText(text, 8000), entities: JSON.stringify(entities || []), by, t: now() });
}
export const toggleNewsPin = (id) => run('UPDATE news SET pinned = 1 - pinned WHERE id = :id', { id });
export const deleteNews = (id) => run('DELETE FROM news WHERE id = :id', { id });

export const listLinks = () => all('SELECT * FROM links ORDER BY position, id');
export async function addLink(title, url, kind) {
  const pos = ((await val('SELECT MAX(position) FROM links')) || 0) + 1;
  return insert('INSERT INTO links (title, url, kind, position) VALUES (:title, :url, :kind, :pos)', { title: oneLine(title, 60), url, kind, pos });
}
export const deleteLink = (id) => run('DELETE FROM links WHERE id = :id', { id });

// ── Диалоги админа ────────────────────────────────────────────────────
export async function getState(userId) {
  const r = await get('SELECT * FROM states WHERE user_id = :userId', { userId });
  if (!r) return null;
  let data = {};
  try { data = JSON.parse(r.data || '{}'); } catch (e) { data = {}; }
  return { state: r.state, data };
}
export const setState = (userId, state, data = {}) =>
  run(`INSERT INTO states (user_id, state, data, updated_at) VALUES (:userId, :state, :data, :t)
       ON CONFLICT(user_id) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`,
    { userId, state, data: JSON.stringify(data), t: now() });
export const clearState = (userId) => run('DELETE FROM states WHERE user_id = :userId', { userId });

export { BACKUP_EVERY };
