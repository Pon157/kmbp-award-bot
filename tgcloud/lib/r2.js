// 2 тур: доступ, карточки, голосование, рисунки. Администрирование и подсчёт — в r2admin.js, форум — в forum.js.
import { EndpointError } from 'sdk';
import { all, get, run, val } from './db.js';
import { transaction } from './tx.js';
import * as S from './store.js';
import { R2 } from './config.js';
import { now, oneLine } from './util.js';
import { hit, limit, makeTicket, checkTicket, burnTicket, mediaUrl, hmacHex } from './sec.js';
import { makeCaptcha, verifyCaptcha } from './captcha.js';
import { parseStrokes } from './draw.js';

const err = (m, code, extra) => new EndpointError(m, { code, ...(extra || {}) });

// ── Настройки 2 тура ────────────────────────────────────────────────
export async function getCfg() {
  const [restrict, voting, forum, draw, drawScope, shuffle] = await Promise.all([
    S.getSetting('r2_restrict', '1'), S.getSetting('r2_voting', '1'), S.getSetting('r2_forum', '1'),
    S.getSetting('r2_draw', '1'), S.getSetting('r2_draw_scope', 'nomination'), S.getSetting('r2_shuffle', '1'),
  ]);
  return { restrict: restrict === '1', voting: voting === '1', forum: forum === '1', draw: draw === '1', drawScope: drawScope === 'global' ? 'global' : 'nomination', shuffle: shuffle === '1' };
}

// ── Доступ ──────────────────────────────────────────────────────────
export async function accessOf(userId) {
  if (await S.isOwner(userId)) return { ok: true, owner: true };
  if ((await S.getSetting('r2_restrict', '1')) !== '1') return { ok: true, owner: false };
  const r = await get('SELECT user_id FROM r2_access WHERE user_id = :u', { u: userId });
  return { ok: !!r, owner: false };
}
export async function requireAccess(user) {
  const a = await accessOf(user.id);
  if (!a.ok) throw err('Второй тур пока открыт не для всех. Мы сообщим, когда он станет доступен.', 'NO_ACCESS');
  return a;
}
export async function requireOwner(user) {
  if (!(await S.isOwner(user.id))) throw err('Только для организаторов', 'FORBIDDEN');
}

// ── Карточки ────────────────────────────────────────────────────────
export const publicName = (u) => oneLine(u?.first_name || u?.firstName || '', 24) || 'Участник';

export const listVoteNominations = () => all(
  `SELECT n.id, n.title, n.kind, n.position,
          (SELECT COUNT(*) FROM r2_projects p WHERE p.nomination_id = n.id AND p.active = 1) AS cnt
   FROM nominations n WHERE n.active = 1 ORDER BY n.position, n.id`).then((rows) => rows.filter((r) => Number(r.cnt) > 0));

const projectShape = (p) => ({
  id: p.id, title: p.title, description: p.description, editorsChoice: !!p.editors_choice,
  banner: p.banner_ver > 0 ? mediaUrl('p', p.id, p.banner_ver) : null,
});

// Порядок карточек у каждого человека свой (но стабильный): так позиция в списке не влияет на исход.
function orderFor(userId, projects, shuffle) {
  if (!shuffle) return projects;
  return projects.map((p) => [hmacHex('ord', `${userId}:${p.id}`, 8), p]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((x) => x[1]);
}

export async function myVotes(userId) {
  return all('SELECT nomination_id, project_id, kind, changes, updated_at FROM r2_votes WHERE user_id = :u', { u: userId });
}

export async function homeState(user) {
  const [cfg, noms, mine, drawn, balance] = await Promise.all([
    getCfg(), listVoteNominations(), myVotes(user.id),
    all('SELECT nomination_id FROM r2_drawings WHERE user_id = :u', { u: user.id }),
    val('SELECT COALESCE(SUM(amount), 0) FROM coin_log WHERE user_id = :u', { u: user.id }).catch(() => 0),
  ]);
  const main = new Map(mine.filter((v) => v.kind === 'main').map((v) => [v.nomination_id, v]));
  const extra = new Set(mine.filter((v) => v.kind === 'extra').map((v) => v.nomination_id));
  const drew = new Set(drawn.map((d) => d.nomination_id));
  const items = noms.map((n) => ({ id: n.id, title: n.title, kind: n.kind, projects: Number(n.cnt), voted: main.has(n.id), extra: extra.has(n.id), drew: drew.has(n.id) }));
  return {
    cfg: { voting: cfg.voting, forum: cfg.forum, draw: cfg.draw, drawScope: cfg.drawScope },
    nominations: items,
    progress: { voted: items.filter((i) => i.voted).length, total: items.length },
    coins: { balance: Number(balance) || 0, cost: R2.EXTRA_COST },
    rules: { maxChanges: R2.MAX_CHANGES, cooldownMin: Math.round(R2.CHANGE_COOLDOWN_SEC / 60) },
  };
}

export async function nominationView(user, nominationId) {
  const nom = await S.getNomination(Number(nominationId));
  if (!nom) throw err('Номинация не найдена', 'NOT_FOUND');
  const [cfg, projects, mine, humanUntil, mineDraw] = await Promise.all([
    getCfg(),
    all('SELECT * FROM r2_projects WHERE nomination_id = :n AND active = 1 ORDER BY position, id', { n: nom.id }),
    all('SELECT project_id, kind, changes, updated_at FROM r2_votes WHERE user_id = :u AND nomination_id = :n', { u: user.id, n: nom.id }),
    val('SELECT until FROM r2_human WHERE user_id = :u', { u: user.id }),
    all('SELECT id, project_id FROM r2_drawings WHERE user_id = :u', { u: user.id }),
  ]);
  if (!projects.length) throw err('В этой номинации пока нет карточек', 'NOT_FOUND');
  const ids = projects.map((p) => p.id);
  const [counts, prev] = await Promise.all([
    all(`SELECT project_id, COUNT(*) AS c FROM r2_drawings WHERE nomination_id = :n GROUP BY project_id`, { n: nom.id }),
    all(`SELECT id, project_id, strokes FROM (
           SELECT d.id, d.project_id, d.strokes, ROW_NUMBER() OVER (PARTITION BY d.project_id ORDER BY d.id DESC) AS rn
           FROM r2_drawings d WHERE d.nomination_id = :n) WHERE rn <= 3`, { n: nom.id }),
  ]);
  const cnt = new Map(counts.map((c) => [c.project_id, Number(c.c)]));
  const byProj = new Map();
  for (const d of prev) { if (!byProj.has(d.project_id)) byProj.set(d.project_id, []); byProj.get(d.project_id).push({ id: d.id, strokes: JSON.parse(d.strokes) }); }
  const main = mine.find((v) => v.kind === 'main'), extra = mine.find((v) => v.kind === 'extra');
  const changesLeft = main ? Math.max(0, R2.MAX_CHANGES - main.changes) : R2.MAX_CHANGES;
  const nextChangeAt = main ? main.updated_at + R2.CHANGE_COOLDOWN_SEC : 0;
  const myDraw = mineDraw.find((d) => ids.includes(d.project_id)) || null;
  return {
    id: nom.id, title: nom.title, kind: nom.kind,
    voting: cfg.voting, drawEnabled: cfg.draw,
    projects: orderFor(user.id, projects, cfg.shuffle).map((p) => ({
      ...projectShape(p), drawings: { count: cnt.get(p.id) || 0, preview: byProj.get(p.id) || [] },
    })),
    my: {
      main: main ? { projectId: main.project_id, changesLeft, nextChangeAt } : null,
      extra: extra ? { projectId: extra.project_id } : null,
      drawing: myDraw ? { id: myDraw.id, projectId: myDraw.project_id } : null,
    },
    ticket: makeTicket(user.id, nom.id),
    needHuman: !(Number(humanUntil) > now()),
  };
}

// ── Проверка «я не бот» ─────────────────────────────────────────────
export async function humanChallenge(user) {
  limit(`cap:${user.id}`, 8, 600, 'Слишком много попыток проверки.');
  return makeCaptcha();
}
async function ensureHuman(user, captcha) {
  const until = Number(await val('SELECT until FROM r2_human WHERE user_id = :u', { u: user.id })) || 0;
  if (until > now()) return;
  if (!captcha?.id) throw err('Подтвердите, что вы не бот', 'HUMAN');
  const ok = await verifyCaptcha(captcha.id, captcha.answer);
  if (!ok) throw err('Код с картинки неверный или устарел', 'HUMAN', { wrong: true });
  await run('INSERT INTO r2_human (user_id, until) VALUES (:u, :t) ON CONFLICT(user_id) DO UPDATE SET until = excluded.until', { u: user.id, t: now() + R2.HUMAN_TTL_SEC });
}

// Общая подготовка перед записью голоса. Порядок важен: сначала дешёвые проверки, потом капча, потом сжигаем билет.
async function guardVote(user, input, req, kind) {
  limit(`vote:u:${user.id}`, 15, 60, 'Слишком много действий подряд.');
  if (req?.ipHash) limit(`vote:ip:${req.ipHash}`, 60, 600, 'С вашего адреса слишком много голосов.');
  const cfg = await getCfg();
  if (!cfg.voting) throw err('Голосование сейчас закрыто', 'CLOSED');
  const nominationId = Number(input?.nominationId), projectId = Number(input?.projectId);
  if (!Number.isInteger(nominationId) || !Number.isInteger(projectId)) throw err('Неверный запрос', 'BAD');
  const t = checkTicket(input?.ticket, user.id, nominationId, { minAge: R2.MIN_VIEW_SEC, maxAge: R2.INTENT_TTL_SEC });
  if (t === 'early') throw err('Посмотрите карточки внимательнее — голос можно отдать через пару секунд.', 'EARLY');
  if (t !== 'ok') throw err('Сессия голосования устарела — откройте номинацию заново.', 'STALE');
  await ensureHuman(user, input?.captcha);
  if (!burnTicket(input.ticket)) throw err('Сессия голосования устарела — откройте номинацию заново.', 'STALE');
  await logVote(user.id, nominationId, projectId, 'try:' + kind, req);
  return { nominationId, projectId };
}
const logVote = (u, n, p, action, req) => run(
  'INSERT INTO r2_vote_log (user_id, nomination_id, project_id, action, ip_hash, ua_hash, at) VALUES (:u, :n, :p, :a, :ip, :ua, :t)',
  { u, n, p, a: action, ip: req?.ipHash || null, ua: req?.uaHash || null, t: now() }).catch(() => {});

// ── Основной голос / смена голоса ───────────────────────────────────
export async function castMain(user, input, req) {
  const { nominationId, projectId } = await guardVote(user, input, req, 'main');
  const res = await transaction(async (t) => {
    const nom = await t.get('SELECT id FROM nominations WHERE id = :id AND active = 1', { id: nominationId });
    const proj = await t.get('SELECT id FROM r2_projects WHERE id = :p AND nomination_id = :n AND active = 1', { p: projectId, n: nominationId });
    if (!nom || !proj) throw err('Такой карточки нет', 'NOT_FOUND');
    const cur = await t.get("SELECT * FROM r2_votes WHERE user_id = :u AND nomination_id = :n AND kind = 'main'", { u: user.id, n: nominationId });
    const stamp = { ip: req?.ipHash || null, net: req?.netHash || null, ua: req?.uaHash || null, via: req?.via || null, t: now() };
    if (!cur) {
      await t.run(`INSERT INTO r2_votes (user_id, nomination_id, project_id, kind, weight2, changes, excluded, ip_hash, net_hash, ua_hash, via, created_at, updated_at)
                   VALUES (:u, :n, :p, 'main', :w, 0, 0, :ip, :net, :ua, :via, :t, :t)`, { u: user.id, n: nominationId, p: projectId, w: R2.MAIN_WEIGHT2, ...stamp });
      return { action: 'vote', changesLeft: R2.MAX_CHANGES, nextChangeAt: 0 };
    }
    if (cur.project_id === projectId) return { action: 'same', changesLeft: Math.max(0, R2.MAX_CHANGES - cur.changes), nextChangeAt: cur.updated_at + R2.CHANGE_COOLDOWN_SEC };
    const old = await t.get('SELECT active FROM r2_projects WHERE id = :p', { p: cur.project_id });
    const free = !old || !old.active;                       // прежняя карточка удалена — переголосовать можно без ограничений
    if (!free) {
      if (cur.changes >= R2.MAX_CHANGES) throw err(`Голос в этой номинации можно менять не более ${R2.MAX_CHANGES} раз — лимит исчерпан.`, 'LIMIT');
      const wait = cur.updated_at + R2.CHANGE_COOLDOWN_SEC - stamp.t;
      if (wait > 0) throw err(`Менять голос можно раз в ${Math.round(R2.CHANGE_COOLDOWN_SEC / 60)} минут. Подождите ещё ${Math.ceil(wait / 60)} мин.`, 'COOLDOWN', { wait });
    }
    await t.run(`UPDATE r2_votes SET project_id = :p, changes = changes + :c, ip_hash = :ip, net_hash = :net, ua_hash = :ua, via = :via, updated_at = :t WHERE id = :id`,
      { p: projectId, c: free ? 0 : 1, id: cur.id, ...stamp });
    return { action: 'change', changesLeft: Math.max(0, R2.MAX_CHANGES - cur.changes - (free ? 0 : 1)), nextChangeAt: stamp.t + R2.CHANGE_COOLDOWN_SEC };
  });
  await logVote(user.id, nominationId, projectId, res.action, req);
  return res;
}

// ── Дополнительный голос за монеты (0,5 голоса) ─────────────────────
export async function castExtra(user, input, req) {
  const { nominationId, projectId } = await guardVote(user, input, req, 'extra');
  const reason = `r2extra:${nominationId}`;
  const res = await transaction(async (t) => {
    const proj = await t.get('SELECT id FROM r2_projects WHERE id = :p AND nomination_id = :n AND active = 1', { p: projectId, n: nominationId });
    if (!proj) throw err('Такой карточки нет', 'NOT_FOUND');
    const main = await t.get("SELECT id FROM r2_votes WHERE user_id = :u AND nomination_id = :n AND kind = 'main'", { u: user.id, n: nominationId });
    if (!main) throw err('Сначала отдайте обычный голос в этой номинации.', 'NEED_MAIN');
    const had = await t.get("SELECT id FROM r2_votes WHERE user_id = :u AND nomination_id = :n AND kind = 'extra'", { u: user.id, n: nominationId });
    if (had) throw err('Дополнительный голос в этой номинации уже отдан.', 'ALREADY');
    const bal = Number(await t.val('SELECT COALESCE(SUM(amount), 0) FROM coin_log WHERE user_id = :u', { u: user.id })) || 0;
    if (bal < R2.EXTRA_COST) throw err(`Не хватает монет: нужно ${R2.EXTRA_COST}, у вас ${bal}.`, 'NO_COINS');
    const tt = now();
    await t.run('INSERT INTO coin_log (user_id, amount, reason, created_at) VALUES (:u, :a, :r, :t)', { u: user.id, a: -R2.EXTRA_COST, r: reason, t: tt });
    await t.run(`INSERT INTO r2_votes (user_id, nomination_id, project_id, kind, weight2, changes, excluded, ip_hash, net_hash, ua_hash, via, created_at, updated_at)
                 VALUES (:u, :n, :p, 'extra', :w, 0, 0, :ip, :net, :ua, :via, :t, :t)`,
    { u: user.id, n: nominationId, p: projectId, w: R2.EXTRA_WEIGHT2, ip: req?.ipHash || null, net: req?.netHash || null, ua: req?.uaHash || null, via: req?.via || null, t: tt });
    return { balance: bal - R2.EXTRA_COST };
  });
  await logVote(user.id, nominationId, projectId, 'extra', req);
  return res;
}

// ── Рисунки ─────────────────────────────────────────────────────────
export async function saveDrawing(user, input) {
  const cfg = await getCfg();
  if (!cfg.draw) throw err('Рисунки сейчас отключены', 'CLOSED');
  const nominationId = Number(input?.nominationId), projectId = Number(input?.projectId);
  const json = parseStrokes(input?.strokes);                       // сначала формат — ошибки не тратят лимит
  limit(`draw:${user.id}`, 6, 3600, 'Слишком много рисунков за час.');
  return transaction(async (t) => {
    const proj = await t.get('SELECT id FROM r2_projects WHERE id = :p AND nomination_id = :n AND active = 1', { p: projectId, n: nominationId });
    if (!proj) throw err('Такой карточки нет', 'NOT_FOUND');
    if (cfg.drawScope === 'global') {
      const other = await t.get('SELECT id FROM r2_drawings WHERE user_id = :u AND nomination_id <> :n', { u: user.id, n: nominationId });
      if (other) throw err('Рисунок можно оставить только на одной карточке. Удалите прежний, чтобы нарисовать новый.', 'ONE_ONLY');
    }
    const tt = now();
    await t.run(`INSERT INTO r2_drawings (user_id, nomination_id, project_id, strokes, created_at, updated_at) VALUES (:u, :n, :p, :s, :t, :t)
                 ON CONFLICT(user_id, nomination_id) DO UPDATE SET project_id = excluded.project_id, strokes = excluded.strokes, updated_at = excluded.updated_at`,
    { u: user.id, n: nominationId, p: projectId, s: json, t: tt });
    return { ok: true };
  });
}
export async function deleteOwnDrawing(user, nominationId) {
  limit(`drawdel:${user.id}`, 10, 3600);
  await run('DELETE FROM r2_drawings WHERE user_id = :u AND nomination_id = :n', { u: user.id, n: Number(nominationId) });
  return { ok: true };
}
export async function listDrawings(user, projectId, before = 0) {
  const rows = await all(
    `SELECT d.id, d.user_id, d.strokes, d.updated_at, u.first_name FROM r2_drawings d LEFT JOIN users u ON u.id = d.user_id
     WHERE d.project_id = :p AND (:b = 0 OR d.id < :b) ORDER BY d.id DESC LIMIT 13`, { p: Number(projectId), b: Number(before) || 0 });
  const more = rows.length > 12;
  return { items: rows.slice(0, 12).map((d) => ({ id: d.id, strokes: JSON.parse(d.strokes), name: publicName(d), mine: d.user_id === user.id })), more };
}
