// Заявки: проверка, сохранение, карточка в админ-чате и подсчёт похожих юзернеймов.
import { EndpointError } from 'sdk';
import { all, run, insert } from './db.js';
import * as S from './store.js';
import { D } from './doc.js';
import { em } from './emoji.js';
import { B, send, edit, safe } from './tg.js';
import { kindOf } from './kinds.js';
import { LIMITS } from './config.js';
import { esc, now, cleanText, oneLine, normUsername, isUsername, compareUsernames, fmtDate, userName } from './util.js';

// ── Совпадения ────────────────────────────────────────────────────────
export async function findMatches(app) {
  const others = await S.nominationApplications(app.nomination_id);
  const exact = [], similar = [];
  for (const o of others) {
    if (o.id === app.id) continue;
    const m = compareUsernames(app.username_norm, o.username_norm);
    if (m === 'exact') exact.push(o);
    else if (m === 'similar') similar.push(o);
  }
  return { exact, similar, total: exact.length + similar.length };
}

// ── Карточка для админ-чата ───────────────────────────────────────────
export async function renderCard(appId) {
  const app = await S.getApplication(appId);
  if (!app) return null;
  const nom = await S.getNomination(app.nomination_id) || { title: 'Номинация удалена', kind: 'project' };
  const k = kindOf(nom.kind);
  const author = await S.getUser(app.user_id);
  const qs = await S.listQuestions(app.nomination_id, false);
  let answers = {};
  try { answers = JSON.parse(app.answers || '{}'); } catch (e) { answers = {}; }
  const m = await findMatches(app);
  const selfNom = author?.username && author.username.toLowerCase() === app.username_norm;

  const blocks = [
    D.h(`${em('write')} Заявка #${app.id} · ${esc(nom.title)}`),
    D.p(`<b>${esc(k.titleLabel)}:</b> ${esc(app.title)}\n<b>Юзернейм:</b> <a href="https://t.me/${esc(app.username)}">@${esc(app.username)}</a>${selfNom ? ' · самовыдвижение' : ''}`),
    D.q(esc(app.description)),
  ];
  if (app.sponsor_nomination_id) {
    const sn = await S.getNomination(app.sponsor_nomination_id);
    if (sn) blocks.push(D.p(`${em('star')} <b>Голос ушёл в спонсорскую номинацию:</b> ${esc(sn.title)}`));
  }
  if (nom.sponsor_only) {
    const votes = await S.sponsorVotesCount(nom.id, app.username_norm);
    blocks.push(D.p(`${em('star')} <b>Голосов от пользователей за этого кандидата:</b> ${votes || 0}`));
  }
  for (const q of qs) {
    if (answers[q.id]) blocks.push(D.p(`<b>${esc(q.text)}</b>\n${esc(answers[q.id])}`));
  }
  const imported = Array.isArray(answers._sponsorImported) ? answers._sponsorImported : [];
  for (const source of imported) {
    blocks.push(D.p(`<b>Копия прежней заявки #${source.id}</b> · ${esc(source.nomination_title || 'Номинация')}\n` +
      `${esc(source.title || '')} · @${esc(source.username || '')}`));
    if (source.description) blocks.push(D.q(esc(source.description)));
    let sourceAnswers = {};
    try { sourceAnswers = JSON.parse(source.answers || '{}'); } catch (e) { sourceAnswers = {}; }
    const sourceQuestions = await S.listQuestions(source.nomination_id, false);
    for (const q of sourceQuestions) {
      if (sourceAnswers[q.id]) blocks.push(D.p(`<b>${esc(q.text)}</b>\n${esc(sourceAnswers[q.id])}`));
    }
  }
  if (m.total) {
    const lines = [...m.exact.map((o) => `#${o.id} @${esc(o.username)} — точное`), ...m.similar.map((o) => `#${o.id} @${esc(o.username)} — похожее`)].slice(0, 10);
    blocks.push(D.p(`${em('eyes')} <b>Совпадения юзернейма в номинации: ${m.total}</b> (точных ${m.exact.length}, похожих ${m.similar.length})\n${lines.join('\n')}`));
  } else {
    blocks.push(D.p(`${em('eyes')} Совпадений юзернейма в номинации нет`));
  }
  blocks.push(D.p(`<b>Автор:</b> <a href="tg://user?id=${app.user_id}">${esc(userName(author) )}</a>${author?.username ? ` (@${esc(author.username)})` : ''} · ID <code>${app.user_id}</code>\n` +
    `${fmtDate(app.created_at)}${app.updated_at > app.created_at ? ` · изменена ${fmtDate(app.updated_at)}` : ''}`));

  const rows = [[
    B.cb('Удалить заявку', `a:ad:${app.id}`, { style: 'danger', emoji: 'cross' }),
    B.cb('Забанить автора', `a:bn:${app.user_id}`, { style: 'danger', emoji: 'lock' }),
  ], [B.cb('В чёрный список юзернейм', `a:bk:${app.id}`, { style: 'danger', emoji: 'lock' })]];
  return { app, blocks, rows };
}

export async function publishCard(appId) {
  const chat = Number(await S.getSetting('admin_chat', 0));
  if (!chat) return null;
  const card = await renderCard(appId);
  if (!card) return null;
  const { app, blocks, rows } = card;
  if (app.admin_msg_id && Number(app.admin_chat_id) === chat) {
    await safe(() => edit(chat, app.admin_msg_id, blocks, rows));
    return app.admin_msg_id;
  }
  const msg = await send(chat, blocks, rows);
  if (msg?.message_id) {
    await run('UPDATE applications SET admin_chat_id = :c, admin_msg_id = :m WHERE id = :id', { c: chat, m: msg.message_id, id: app.id });
  }
  return msg?.message_id ?? null;
}

// Обновить карточки заявок, у которых изменились совпадения.
// Карточки независимы — шлём правки в Telegram параллельно, а не по одной,
// иначе кнопка «Отправить» ждёт столько же round-trip'ов подряд.
export async function refreshRelated(app) {
  const m = await findMatches(app);
  const targets = [...m.exact, ...m.similar].slice(0, 12);
  await Promise.all(targets.map((o) => safe(() => publishCard(o.id))));
}

export async function closeCard(app, text = 'Заявка удалена') {
  if (app?.admin_chat_id && app?.admin_msg_id) {
    await safe(() => edit(Number(app.admin_chat_id), app.admin_msg_id, [D.p(`${em('cross')} ${esc(text)} · #${app.id} · @${esc(app.username)}`)], []));
  }
}

// Всё, что нужно админам после приёма заявки: карточка, связанные карточки, карточка спонсора.
// Это десятки запросов к базе и к Telegram — поэтому его можно вынести из ожидания ответа (defer).
export async function publishSubmission(appId, sponsorMatchAppId = undefined) {
  await safe(() => publishCard(appId));
  const saved = await S.getApplication(appId);
  if (!saved) return;
  await safe(() => refreshRelated(saved));
  // Карточка спонсора показывает число голосов — обновляем её.
  if (sponsorMatchAppId === undefined) {
    const nom = await S.getNomination(saved.nomination_id);
    const m = nom && !nom.sponsor_only ? await S.findSponsorMatch(nom.kind, saved.username_norm) : null;
    sponsorMatchAppId = m ? m.app_id : null;
  }
  if (sponsorMatchAppId) await safe(() => publishCard(sponsorMatchAppId));
}

// Страховка: если пользователь закрыл мини-апп до публикации, карточка не потеряется —
// догоняем заявки без сообщения в админ-чате (старше минуты, не старше суток).
export async function publishMissing(limit = 3) {
  const chat = Number(await S.getSetting('admin_chat', 0));
  if (!chat) return 0;
  const t = now();
  const rows = await all('SELECT id FROM applications WHERE admin_msg_id IS NULL AND created_at < :a AND created_at > :b ORDER BY id LIMIT :n',
    { a: t - 60, b: t - 86400, n: limit });
  for (const r of rows) await safe(() => publishCard(r.id));
  return rows.length;
}

// ── Приём заявки из мини-аппа ─────────────────────────────────────────
const fail = (message, code, extra) => { throw new EndpointError(message, { code, ...(extra || {}) }); };

export async function submitApplication(user, input, opts = {}) {
  const nomId = Number(input?.nominationId);
  const nom = nomId ? await S.getNomination(nomId) : null;
  if (!nom) fail('Номинация не найдена', 'NOT_FOUND');
  if (!nom.is_open || (await S.getSetting('apps_open', '1')) !== '1') fail('Приём заявок в этой номинации закрыт', 'CLOSED');
  if (nom.sponsor_only && !(await S.isSponsor(user.username))) {
    fail('Эта подноминация доступна только указанным спонсорам', 'SPONSOR_ONLY');
  }

  const k = kindOf(nom.kind);
  const title = oneLine(input?.title, LIMITS.title);
  const username = normUsername(input?.username);
  const norm = username.toLowerCase();
  const description = cleanText(input?.description, LIMITS.desc);

  const errors = {};
  if (title.length < 2) errors.title = 'Укажите название';
  if (!isUsername(username)) errors.username = 'Нужен юзернейм Telegram: 4–32 символа, латиница, цифры и «_»';
  else if (await S.isBlacklisted(norm)) errors.username = 'Этот юзернейм нельзя выдвигать в премии';
  if (description.length < LIMITS.descMin) errors.description = `Опишите подробнее — минимум ${LIMITS.descMin} символов`;

  const qs = await S.listQuestions(nom.id);
  const answers = {};
  for (const q of qs) {
    const a = cleanText(input?.answers?.[q.id], q.max_len || 500);
    if (q.required && !a) errors['q' + q.id] = 'Обязательный вопрос';
    if (a) answers[q.id] = a;
  }
  if (Object.keys(errors).length) fail('Проверьте поля формы', 'VALIDATION', { fields: errors });
  // Сохраняем копии всех прежних точных совпадений username; исходные заявки не меняются.
  if (nom.sponsor_only) answers._sponsorImported = await S.applicationsByUsername(norm);

  const existing = await S.userApplication(user.id, nom.id);
  if (!nom.sponsor_only && !existing && (await S.getSetting('limit_mode', 'nomination')) === 'global') {
    const any = (await S.userApplications(user.id))[0];
    if (any) fail(`Вы уже предложили кандидата в номинации «${any.nomination_title}». Одна заявка на человека.`, 'ALREADY');
  }

  // Обычный голос за юзернейм, который уже есть в спонсорской подноминации, уходит в неё.
  const sponsorMatch = nom.sponsor_only ? null : await S.findSponsorMatch(nom.kind, norm);
  const sponsorNomId = sponsorMatch ? sponsorMatch.id : null;

  const t = now();
  let appId;
  try {
    if (existing) {
      appId = existing.id;
      await run(`UPDATE applications SET title = :title, username = :username, username_norm = :norm, description = :description,
                 answers = :answers, sponsor_nomination_id = :sn, updated_at = :t WHERE id = :id`,
        { title, username, norm, description, answers: JSON.stringify(answers), sn: sponsorNomId, t, id: appId });
    } else {
      appId = await insert(`INSERT INTO applications (nomination_id, user_id, title, username, username_norm, description, answers, sponsor_nomination_id, created_at, updated_at)
                            VALUES (:nid, :uid, :title, :username, :norm, :description, :answers, :sn, :t, :t)`,
        { nid: nom.id, uid: user.id, title, username, norm, description, answers: JSON.stringify(answers), sn: sponsorNomId, t });
    }
  } catch (e) {
    fail('Вы уже отправили заявку в этой номинации', 'ALREADY');
  }

  // Карточка в админ-чат и обновление связанных — ошибки не должны ломать приём.
  // opts.defer: ответить пользователю сразу, а публикацию сделать отдельным вызовом (publishSubmission).
  if (!opts.defer) await publishSubmission(appId, sponsorMatch ? sponsorMatch.app_id : null);
  return {
    id: appId, created: !existing, imported: nom.sponsor_only ? answers._sponsorImported.length : 0,
    sponsorNomination: sponsorMatch ? { id: sponsorMatch.id, title: sponsorMatch.title } : null,
  };
}

export const allApplicationsCount = async () => (await all('SELECT COUNT(*) AS c FROM applications'))[0]?.c || 0;
