// Админка 2 тура (вызывается только после requireOwner): доступ, карточки, результаты, антинакрутка, рисунки, форум.
import { EndpointError } from 'sdk';
import { all, get, run, val } from './db.js';
import * as S from './store.js';
import { R2 } from './config.js';
import { now, oneLine, cleanText, normUsername, fmtDate } from './util.js';
import { mediaSig, mediaUrl } from './sec.js';
import { getCfg, publicName } from './r2.js';
import { mute, unmute } from './forum.js';

const err = (m, code) => new EndpointError(m, { code: code || 'BAD' });
const nm = (u) => (u?.first_name ? u.first_name + (u.last_name ? ' ' + u.last_name : '') : u?.username ? '@' + u.username : '') || 'без имени';

// ── Настройки ───────────────────────────────────────────────────────
export async function overview() {
  const [cfg, c] = await Promise.all([getCfg(), all(`SELECT
    (SELECT COUNT(*) FROM r2_access) AS access,
    (SELECT COUNT(DISTINCT user_id) FROM r2_votes WHERE kind = 'main') AS voters,
    (SELECT COUNT(*) FROM r2_votes) AS votes,
    (SELECT COUNT(*) FROM r2_projects WHERE active = 1) AS projects,
    (SELECT COUNT(*) FROM r2_drawings) AS drawings,
    (SELECT COUNT(*) FROM r2_posts WHERE hidden = 0) AS posts,
    (SELECT COUNT(*) FROM r2_posts WHERE hidden = 0 AND reports > 0) AS reported`)]);
  const x = c[0];
  return { cfg, counts: { access: +x.access, voters: +x.voters, votes: +x.votes, projects: +x.projects, drawings: +x.drawings, posts: +x.posts, reported: +x.reported } };
}
const FLAGS = { restrict: 'r2_restrict', voting: 'r2_voting', forum: 'r2_forum', draw: 'r2_draw', shuffle: 'r2_shuffle' };
export async function setCfg(input) {
  for (const [k, key] of Object.entries(FLAGS)) if (typeof input?.[k] === 'boolean') await S.setSetting(key, input[k] ? '1' : '0');
  if (input?.drawScope === 'global' || input?.drawScope === 'nomination') await S.setSetting('r2_draw_scope', input.drawScope);
  return getCfg();
}

// ── Доступ по Telegram ID ───────────────────────────────────────────
export async function accessList() {
  const rows = await all(`SELECT a.user_id, a.added_at, a.note, u.username, u.first_name, u.last_name, u.last_seen,
    (SELECT COUNT(*) FROM r2_votes v WHERE v.user_id = a.user_id AND v.kind = 'main') AS votes FROM r2_access a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.added_at DESC, a.user_id`);
  return rows.map((r) => ({ id: r.user_id, name: r.first_name || r.username ? nm(r) : '', username: r.username || '', lastSeen: r.last_seen || 0, votes: +r.votes, note: r.note || '' }));
}
export async function accessAdd(text, by) {
  const tokens = String(text || '').split(/[\s,;]+/).filter(Boolean).slice(0, 200);
  const added = [], known = [], unknown = [];
  for (const tk of tokens) {
    let id = null;
    if (/^\d{3,15}$/.test(tk)) id = Number(tk);
    else { const u = await S.findUserByUsername(normUsername(tk)); if (u) id = u.id; else unknown.push(tk); }
    if (!id) continue;
    const r = await run('INSERT OR IGNORE INTO r2_access (user_id, added_by, added_at) VALUES (:id, :by, :t)', { id, by, t: now() });
    (r.rowsAffected ? added : known).push(id);
  }
  return { added, known, unknown };
}
export const accessRemove = (id) => run('DELETE FROM r2_access WHERE user_id = :id', { id: Number(id) });
export async function searchUsers(q) {
  q = String(q || '').trim().replace(/^@/, '');
  if (q.length < 2) return [];
  const like = q.toLowerCase().replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  const rows = await all(`SELECT id, username, first_name, last_name, last_seen FROM users
    WHERE lower(username) LIKE :l ESCAPE '\\' OR lower(first_name) LIKE :l ESCAPE '\\' OR CAST(id AS TEXT) = :q ORDER BY last_seen DESC LIMIT 10`, { l: like, q });
  return rows.map((u) => ({ id: u.id, name: nm(u), username: u.username || '' }));
}

// ── Карточки проектов ───────────────────────────────────────────────
export async function adminNominations() {
  const rows = await all(`SELECT n.id, n.title, n.kind, n.sponsor_only,
    (SELECT COUNT(*) FROM r2_projects p WHERE p.nomination_id = n.id AND p.active = 1) AS cnt FROM nominations n WHERE n.active = 1 ORDER BY n.position, n.id`);
  return rows.map((r) => ({ id: r.id, title: r.title, kind: r.kind, sponsor: !!r.sponsor_only, projects: +r.cnt }));
}
export async function adminProjects(nominationId) {
  const rows = await all(`SELECT id, title, description, editors_choice, banner_ver, position FROM r2_projects WHERE nomination_id = :n AND active = 1 ORDER BY position, id`, { n: Number(nominationId) });
  return rows.map((p) => ({ id: p.id, title: p.title, description: p.description, editorsChoice: !!p.editors_choice, bannerVer: p.banner_ver, banner: p.banner_ver > 0 ? mediaUrl('p', p.id, p.banner_ver) : null, position: p.position }));
}

// Минимальная проверка JPEG без внешних библиотек: сигнатура, размеры из SOF, ограничение по весу. Картинку клиент пережимает в canvas.
export function checkJpeg(b64) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw err('Картинка повреждена');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > R2.BANNER_MAX_BYTES) throw err(`Картинка тяжелее ${Math.round(R2.BANNER_MAX_BYTES / 1024)} КБ`);
  if (buf.length < 600 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) throw err('Нужна картинка JPEG');
  let i = 2, w = 0, h = 0;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break; }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  if (!w || !h) throw err('Не удалось прочитать размеры картинки');
  if (w < 200 || h < 120 || w > 4096 || h > 4096) throw err('Размер картинки должен быть от 200×120 до 4096×4096');
  return b64;
}

export async function saveProject(input) {
  const nominationId = Number(input?.nominationId);
  if (!(await S.getNomination(nominationId))) throw err('Номинация не найдена', 'NOT_FOUND');
  const title = oneLine(input?.title, R2.TITLE_MAX);
  if (title.length < 2) throw err('Введите название проекта');
  const description = cleanText(input?.description, R2.DESC_MAX);
  const choice = input?.editorsChoice ? 1 : 0;
  const bannerOk = !input?.removeBanner && input?.banner ? checkJpeg(input.banner) : null;   // сначала проверяем картинку — иначе при ошибке останется пустая карточка
  let id = Number(input?.id) || 0;
  if (id) {
    const p = await get('SELECT id FROM r2_projects WHERE id = :id AND nomination_id = :n AND active = 1', { id, n: nominationId });
    if (!p) throw err('Карточка не найдена', 'NOT_FOUND');
    await run('UPDATE r2_projects SET title = :t, description = :d, editors_choice = :c, updated_at = :at WHERE id = :id', { t: title, d: description, c: choice, at: now(), id });
  } else {
    const pos = ((await val('SELECT MAX(position) FROM r2_projects WHERE nomination_id = :n', { n: nominationId })) || 0) + 1;
    id = (await run(`INSERT INTO r2_projects (nomination_id, title, description, editors_choice, active, position, banner_ver, created_at, updated_at)
                     VALUES (:n, :t, :d, :c, 1, :p, 0, :at, :at)`, { n: nominationId, t: title, d: description, c: choice, p: pos, at: now() })).lastInsertRowid;
  }
  if (input?.removeBanner) await run('UPDATE r2_projects SET banner_data = NULL, banner_ver = 0 WHERE id = :id', { id });
  else if (bannerOk) await run('UPDATE r2_projects SET banner_data = :b, banner_ver = banner_ver + 1 WHERE id = :id', { b: bannerOk, id });
  return { id };
}
export async function deleteProject(id) {
  await run('UPDATE r2_projects SET active = 0, editors_choice = 0 WHERE id = :id', { id: Number(id) });
  await run('DELETE FROM r2_drawings WHERE project_id = :id', { id: Number(id) });
  return { ok: true };
}
export async function moveProject(id, dir) {
  const p = await get('SELECT id, nomination_id FROM r2_projects WHERE id = :id AND active = 1', { id: Number(id) });
  if (!p) throw err('Карточка не найдена', 'NOT_FOUND');
  const list = await all('SELECT id FROM r2_projects WHERE nomination_id = :n AND active = 1 ORDER BY position, id', { n: p.nomination_id });
  const i = list.findIndex((x) => x.id === p.id), j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= list.length) return { ok: true };
  [list[i], list[j]] = [list[j], list[i]];
  for (let k = 0; k < list.length; k++) await run('UPDATE r2_projects SET position = :p WHERE id = :id', { p: k + 1, id: list[k].id });
  return { ok: true };
}
export async function toggleChoice(id) {
  await run('UPDATE r2_projects SET editors_choice = 1 - editors_choice, updated_at = :t WHERE id = :id AND active = 1', { id: Number(id), t: now() });
  return { ok: true };
}
// Отдаёт байты баннера, если подпись и версия совпали (используется маршрутом /m/p/<id>.jpg).
export async function bannerBytes(id, ver, sig) {
  id = Number(id); ver = Number(ver);
  if (!Number.isInteger(id) || !Number.isInteger(ver) || ver < 1 || sig !== mediaSig('p', id, ver)) return null;
  const p = await get('SELECT banner_data, banner_ver, active FROM r2_projects WHERE id = :id', { id });
  if (!p || !p.active || p.banner_ver !== ver || !p.banner_data) return null;
  return Buffer.from(p.banner_data, 'base64');
}

// ── Результаты (видны только организатору) ──────────────────────────
const CLEAN = `v.excluded = 0 AND NOT EXISTS (SELECT 1 FROM bans b WHERE b.user_id = v.user_id AND b.scope IN ('all', 'app'))`;
const w = (x) => (Number(x) || 0) / 2;
export async function results(nominationId) {
  const noms = nominationId ? [{ id: Number(nominationId) }] : await all('SELECT id FROM nominations WHERE active = 1 ORDER BY position, id');
  const out = [];
  for (const n of noms) {
    const nom = await S.getNomination(n.id);
    if (!nom) continue;
    const rows = await all(`SELECT p.id, p.title, p.editors_choice,
        COALESCE(SUM(CASE WHEN ${CLEAN} THEN v.weight2 END), 0) AS clean2, COALESCE(SUM(v.weight2), 0) AS raw2,
        COUNT(DISTINCT CASE WHEN v.kind = 'main' AND ${CLEAN} THEN v.user_id END) AS mains,
        COUNT(DISTINCT CASE WHEN v.kind = 'extra' AND ${CLEAN} THEN v.user_id END) AS extras,
        COUNT(DISTINCT CASE WHEN v.id IS NOT NULL AND NOT (${CLEAN}) THEN v.id END) AS removed
      FROM r2_projects p LEFT JOIN r2_votes v ON v.project_id = p.id
      WHERE p.nomination_id = :n AND p.active = 1 GROUP BY p.id ORDER BY clean2 DESC, p.position, p.id`, { n: nom.id });
    if (!rows.length) continue;
    const total = rows.reduce((s, r) => s + Number(r.clean2), 0);
    out.push({
      id: nom.id, title: nom.title, total: w(total),
      projects: rows.map((r) => ({ id: r.id, title: r.title, editorsChoice: !!r.editors_choice, score: w(r.clean2), raw: w(r.raw2), mains: +r.mains, extras: +r.extras, removed: +r.removed, share: total ? Math.round((Number(r.clean2) / total) * 1000) / 10 : 0 })),
    });
  }
  return out;
}
export async function resultsText() {
  const rs = await results();
  return rs.map((n) => `${n.title} (всего ${n.total})\n` + n.projects.map((p, i) => `${i + 1}. ${p.title} — ${p.score}${p.editorsChoice ? ' ★' : ''}`).join('\n')).join('\n\n');
}

// ── Антинакрутка: подозрительные группы ─────────────────────────────
export async function suspicious() {
  const votes = await all(`SELECT v.id, v.user_id, v.nomination_id, v.project_id, v.kind, v.weight2, v.changes, v.excluded, v.ip_hash, v.net_hash, v.ua_hash, v.via, v.created_at,
      u.first_name, u.last_name, u.username, p.title AS project, n.title AS nomination
    FROM r2_votes v LEFT JOIN users u ON u.id = v.user_id LEFT JOIN r2_projects p ON p.id = v.project_id LEFT JOIN nominations n ON n.id = v.nomination_id`);
  const users = new Map();
  const group = (key) => { const m = new Map(); for (const v of votes) { const k = v[key]; if (!k) continue; if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v.user_id); } return m; };
  const byIp = group('ip_hash'), byNet = group('net_hash'), byUa = group('ua_hash');
  const get_ = (v) => { if (!users.has(v.user_id)) users.set(v.user_id, { userId: v.user_id, name: nm(v), username: v.username || '', score: 0, reasons: new Set(), votes: [] }); return users.get(v.user_id); };
  for (const v of votes) {
    const u = get_(v);
    u.votes.push({ id: v.id, nomination: v.nomination, project: v.project || '—', kind: v.kind, weight: w(v.weight2), excluded: !!v.excluded, at: v.created_at });
  }
  const mark = (uid, pts, why) => { const u = users.get(uid); if (!u || u.reasons.has(why)) return; u.reasons.add(why); u.score += pts; };
  for (const [, set] of byIp) if (set.size >= 2) for (const uid of set) mark(uid, 3, `общий IP с ещё ${set.size - 1}`);
  for (const [, set] of byNet) if (set.size >= 4) for (const uid of set) mark(uid, 1, `одна подсеть, ${set.size} чел.`);
  for (const [, set] of byUa) if (set.size >= 6) for (const uid of set) mark(uid, 1, `одинаковое устройство у ${set.size} чел.`);
  // всплески: ≥8 основных голосов за один проект в пределах минуты
  const perProj = new Map();
  for (const v of votes) if (v.kind === 'main') { if (!perProj.has(v.project_id)) perProj.set(v.project_id, []); perProj.get(v.project_id).push(v); }
  for (const arr of perProj.values()) {
    arr.sort((a, b) => a.created_at - b.created_at);
    for (let i = 0, j = 0; i < arr.length; i++) {
      while (arr[i].created_at - arr[j].created_at > 60) j++;
      if (i - j + 1 >= 8) for (let k = j; k <= i; k++) mark(arr[k].user_id, 2, 'всплеск голосов за проект');
    }
  }
  // группа с общей подсетью, где все голосуют одинаково
  for (const [net, set] of byNet) {
    if (set.size < 3) continue;
    const same = new Set(votes.filter((v) => v.net_hash === net && v.kind === 'main').map((v) => v.project_id));
    if (same.size === 1) for (const uid of set) mark(uid, 2, 'вся группа голосует за один проект');
  }
  for (const v of votes) if (v.kind === 'main' && v.changes >= 3) mark(v.user_id, 1, 'часто меняет голос');
  return [...users.values()].filter((u) => u.score >= 3).sort((a, b) => b.score - a.score).slice(0, 100)
    .map((u) => ({ ...u, reasons: [...u.reasons] }));
}
export async function setExcluded(userId, excluded, reason) {
  const r = await run('UPDATE r2_votes SET excluded = :e, excl_reason = :r WHERE user_id = :u', { e: excluded ? 1 : 0, r: excluded ? oneLine(reason || 'исключено организатором', 80) : null, u: Number(userId) });
  return { changed: r.rowsAffected };
}
// Полное удаление голосов человека; монеты за дополнительные голоса возвращаются.
export async function resetVotes(userId) {
  userId = Number(userId);
  const extras = await all("SELECT nomination_id FROM r2_votes WHERE user_id = :u AND kind = 'extra'", { u: userId });
  for (const e of extras) await run('DELETE FROM coin_log WHERE user_id = :u AND reason = :r AND amount < 0', { u: userId, r: `r2extra:${e.nomination_id}` });
  const r = await run('DELETE FROM r2_votes WHERE user_id = :u', { u: userId });
  return { removed: r.rowsAffected, refunded: extras.length * R2.EXTRA_COST };
}

// ── Рисунки ─────────────────────────────────────────────────────────
export async function adminDrawings(before = 0) {
  const rows = await all(`SELECT d.id, d.user_id, d.nomination_id, d.project_id, d.strokes, d.created_at, u.first_name, u.last_name, u.username, p.title AS project, n.title AS nomination
    FROM r2_drawings d LEFT JOIN users u ON u.id = d.user_id LEFT JOIN r2_projects p ON p.id = d.project_id LEFT JOIN nominations n ON n.id = d.nomination_id
    WHERE (:b = 0 OR d.id < :b) ORDER BY d.id DESC LIMIT 25`, { b: Number(before) || 0 });
  return { more: rows.length > 24, items: rows.slice(0, 24).map((d) => ({ id: d.id, userId: d.user_id, name: nm(d), username: d.username || '', project: d.project || '—', nomination: d.nomination || '—', at: d.created_at, strokes: JSON.parse(d.strokes) })) };
}
export const deleteDrawing = (id) => run('DELETE FROM r2_drawings WHERE id = :id', { id: Number(id) });

// ── Форум ───────────────────────────────────────────────────────────
export async function adminPosts(filter) {
  const where = filter === 'reported' ? 'p.reports > 0' : filter === 'hidden' ? 'p.hidden = 1' : '1 = 1';
  const rows = await all(`SELECT p.id, p.topic_id, p.user_id, p.name, p.body, p.hidden, p.reports, p.created_at, t.title AS topic, m.until AS muted_until
    FROM r2_posts p LEFT JOIN r2_topics t ON t.id = p.topic_id LEFT JOIN r2_mutes m ON m.user_id = p.user_id WHERE ${where} ORDER BY p.id DESC LIMIT 50`);
  return rows.map((p) => ({ id: p.id, topic: p.topic || '', userId: p.user_id, name: p.name, text: p.body, hidden: !!p.hidden, reports: p.reports, at: p.created_at, muted: p.muted_until !== null && p.muted_until !== undefined && (p.muted_until === 0 || p.muted_until > now()) }));
}
export const setPostHidden = (id, hidden) => run('UPDATE r2_posts SET hidden = :h WHERE id = :id', { h: hidden ? 1 : 0, id: Number(id) });
export async function adminMute(userId, minutes, reason) {
  userId = Number(userId);
  if (await S.isOwner(userId)) throw err('Организатора заглушить нельзя');
  if (!minutes) { await unmute(userId); return { ok: true }; }
  await mute(userId, minutes < 0 ? 0 : Math.min(minutes, 60 * 24 * 365) * 60, oneLine(reason || 'решение организатора', 80));
  return { ok: true };
}
export async function saveTopic(input) {
  const title = oneLine(input?.title, 60), descr = oneLine(input?.descr, 120);
  if (title.length < 2) throw err('Введите название темы');
  const id = Number(input?.id) || 0;
  if (id) await run('UPDATE r2_topics SET title = :t, descr = :d, locked = :l, pinned = :p WHERE id = :id', { t: title, d: descr, l: input.locked ? 1 : 0, p: input.pinned ? 1 : 0, id });
  else {
    const pos = ((await val('SELECT MAX(position) FROM r2_topics')) || 0) + 1;
    await run('INSERT INTO r2_topics (title, descr, locked, pinned, active, position, created_at) VALUES (:t, :d, :l, :p, 1, :pos, :at)', { t: title, d: descr, l: input?.locked ? 1 : 0, p: input?.pinned ? 1 : 0, pos, at: now() });
  }
  return { ok: true };
}
export const deleteTopic = (id) => run('UPDATE r2_topics SET active = 0 WHERE id = :id', { id: Number(id) });
export { publicName, fmtDate };
