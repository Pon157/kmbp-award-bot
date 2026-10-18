// Админ-панель в боте: кнопки (callback_data a:*) и пошаговые диалоги (states).
import { api, BotApiError } from 'sdk';
import { all, get, run, val } from './db.js';
import * as S from './store.js';
import { coinStats } from './coins.js';
import { refTop, refTopCount, refTotals } from './referrals.js';
import { reminderOverview, runReminders, reminderDiagnostics } from './reminders.js';
import { COIN_REWARD, REMIND_EVERY_SEC, REMIND_DEFAULT } from './config.js';
import { D } from './doc.js';
import { em } from './emoji.js';
import { B, show, send, toast, safe, isForbidden, isRateLimit, errText } from './tg.js';
import { KINDS, KIND_KEYS, kindOf } from './kinds.js';
import { renderCard, closeCard, refreshRelated, findMatches } from './apps.js';
import { sendBackup } from './backup.js';
import { decodeText, parseBackup, backupPreview, restoreJson, importCsv, MAX_FILE } from './restore.js';
import { nomEmoji, bannerBlock } from './screens.js';
import { OWNER_IDS, DONATE_URL } from './config.js';
import { esc, now, fmtDate, userName, normUsername, isUsername, oneLine, cleanText, toBase64 } from './util.js';

const back = (to = 'a:home', text = '‹ Назад') => [B.cb(text, to)];
const cancelRow = () => [B.cb('Отмена', 'a:cx', { style: 'danger', emoji: 'cross' })];
const yn = (v) => (v ? 'да' : 'нет');
const LINK_KINDS = { channel: 'Канал', chat: 'Чат', site: 'Сайт', bot: 'Бот', github: 'GitHub', docs: 'Документы', video: 'Видео', other: 'Другое' };

// ─────────────────────────── Главная ────────────────────────────────
export async function home(c) {
  const [users, started, apps, noms, bans, adminChat, lastBackup, autoBackup] = await Promise.all([
    val('SELECT COUNT(*) FROM users'), val('SELECT COUNT(*) FROM users WHERE started = 1 AND blocked = 0'),
    val('SELECT COUNT(*) FROM applications'), val('SELECT COUNT(*) FROM nominations WHERE active = 1'),
    val('SELECT COUNT(*) FROM bans'), S.getSetting('admin_chat'), S.getSetting('last_backup', '0'), S.getSetting('auto_backup', '1'),
  ]);
  const blocks = [
    D.h(`${em('shield')} Админ-панель`),
    D.ul([
      `Пользователей: <b>${users}</b> (получают рассылку: ${started})`,
      `Заявок: <b>${apps}</b> · номинаций: <b>${noms}</b> · в бане: <b>${bans}</b>`,
      `Админ-чат: ${adminChat ? '<b>подключён</b>' : '<b>не подключён</b> — отправьте /setchat в нужном чате'}`,
      `Автовыгрузка базы: ${autoBackup === '1' ? 'вкл' : 'выкл'}, последняя: ${Number(lastBackup) ? fmtDate(Number(lastBackup)) : '—'}`,
    ]),
  ];
  const rows = [
    [B.cb('Номинации', 'a:noms', { emoji: 'star' }), B.cb('Заявки', 'a:apps', { emoji: 'write' })],
    [B.cb('Баны', 'a:bans', { emoji: 'lock' }), B.cb('Рассылка', 'a:bc', { emoji: 'speak' })],
    [B.cb('Новости', 'a:nw', { emoji: 'bell' }), B.cb('Ресурсы', 'a:ln', { emoji: 'globe' })],
    [B.cb('Владельцы', 'a:ow', { emoji: 'key' }), B.cb('База данных', 'a:db', { emoji: 'db' })],
    [B.cb('Спонсоры', 'a:sp', { emoji: 'star' }), B.cb('Чёрный список', 'a:blk', { emoji: 'lock' })],
    [B.cb('Монеты и напоминания', 'a:coin', { emoji: 'bell' })],
    [B.cb('Рефералы · топ', 'a:ref', { emoji: 'star' })],
    [B.cb('Загрузить базу из файла', 'a:rst', { emoji: 'folder' })],
    [B.cb('Настройки', 'a:st', { emoji: 'gear' }), B.cb('Баннер', 'a:bnr', { emoji: 'image' })],
    [B.cb('‹ В меню', 'home')],
  ];
  return show(c, blocks, rows);
}

// ─────────────────────────── Номинации ──────────────────────────────
async function noms(c) {
  const list = (await S.listNominations()).filter((n) => !n.sponsor_type);
  const counts = await all('SELECT nomination_id AS id, COUNT(*) AS n FROM applications GROUP BY nomination_id');
  const cnt = Object.fromEntries(counts.map((r) => [r.id, r.n]));
  const blocks = [D.h(`${em('star')} Номинации`)];
  blocks.push(list.length
    ? D.ul(list.map((n) => `<b>${esc(n.title)}</b> · ${kindOf(n.kind).adminName} · ${n.is_open ? 'открыта' : 'закрыта'} · заявок: ${cnt[n.id] || 0}`))
    : D.p('Номинаций пока нет.'));
  const rows = list.map((n) => [B.cb(n.title, `a:n:${n.id}`, { emoji: nomEmoji(n) })]);
  rows.push([B.cb('Добавить номинацию', 'a:nadd', { style: 'success', emoji: 'plus' })]);
  rows.push(back());
  return show(c, blocks, rows);
}

async function nomView(c, id) {
  const n = await S.getNomination(id);
  if (!n) return noms(c);
  const qs = await S.listQuestions(id);
  const cnt = await val('SELECT COUNT(*) FROM applications WHERE nomination_id = :id', { id });
  const blocks = [
    D.h(`${em('star')} ${esc(n.title)}`),
    D.ul([
      `Тип: <b>${kindOf(n.kind).adminName}</b> (подписи полей формы зависят от типа)`,
      `Приём заявок: <b>${n.is_open ? 'открыт' : 'закрыт'}</b>`,
      `Заявок: <b>${cnt}</b>`,
      `Доп. вопросов в форме: <b>${qs.length}</b>`,
    ]),
  ];
  const rows = [
    [B.cb(n.is_open ? 'Закрыть приём' : 'Открыть приём', `a:nt:${id}`, { style: n.is_open ? undefined : 'success' }), B.cb('Переименовать', `a:nr:${id}`, { emoji: 'write' })],
    [B.cb('Тип номинации', `a:nk:${id}`, { emoji: 'gear' }), B.cb('Эмодзи кнопки', `a:ne:${id}`, { emoji: 'star2' })],
    [B.cb(`Вопросы в форме (${qs.length})`, `a:nq:${id}`, { emoji: 'ask' })],
    [B.cb('Заявки номинации', `a:al:${id}:0`, { emoji: 'folder' })],
    [B.cb('Удалить', `a:nd:${id}`, { style: 'danger', emoji: 'cross' }), B.cb('‹ Назад', 'a:noms')],
  ];
  return show(c, blocks, rows);
}

function kindRows(prefix, extra = []) {
  return [
    ...KIND_KEYS.map((k) => [B.cb(`${KINDS[k].adminName} — ${KINDS[k].titleLabel.toLowerCase()}, ${KINDS[k].descLabel.toLowerCase()}`, `${prefix}:${k}`)]),
    ...extra,
  ];
}

async function questionsView(c, nid) {
  const n = await S.getNomination(nid);
  if (!n) return noms(c);
  const qs = await S.listQuestions(nid);
  const blocks = [D.h(`${em('ask')} Вопросы · ${esc(n.title)}`)];
  blocks.push(qs.length
    ? D.ol(qs.map((q) => `${esc(q.text)} — <i>${q.required ? 'обязательный' : 'необязательный'}</i>`))
    : D.p('Дополнительных вопросов нет. В форме только название, юзернейм и описание. Вопросы появятся в мини-аппе под описанием.'));
  const rows = [];
  qs.forEach((q, i) => rows.push([
    B.cb(`${i + 1}: ${q.required ? 'сделать необязательным' : 'сделать обязательным'}`, `a:qr:${q.id}`),
    B.cb(`Удалить ${i + 1}`, `a:qd:${q.id}`, { style: 'danger' }),
  ]));
  rows.push([B.cb('Добавить вопрос', `a:qa:${nid}`, { style: 'success', emoji: 'plus' })]);
  rows.push(back(`a:n:${nid}`));
  return show(c, blocks, rows);
}

// ─────────────────────────── Заявки ─────────────────────────────────
async function appsHome(c) {
  const list = await S.listNominations();
  const counts = await all('SELECT nomination_id AS id, COUNT(*) AS n FROM applications GROUP BY nomination_id');
  const cnt = Object.fromEntries(counts.map((r) => [r.id, r.n]));
  const total = counts.reduce((s, r) => s + r.n, 0);
  const blocks = [D.h(`${em('write')} Заявки`), D.p(`Всего заявок: <b>${total}</b>. Новые приходят карточками в админ-чат — там же видно совпадения юзернеймов.`)];
  const rows = list.map((n) => [B.cb(`${n.title} · ${cnt[n.id] || 0}`, `a:al:${n.id}:0`, { emoji: nomEmoji(n) })]);
  rows.push([B.cb('Найти по юзернейму', 'a:as', { emoji: 'eyes' })]);
  rows.push(back());
  return show(c, blocks, rows);
}

const PAGE = 8;
async function appsList(c, nid, page) {
  const n = await S.getNomination(nid);
  if (!n) return appsHome(c);
  const total = await val('SELECT COUNT(*) FROM applications WHERE nomination_id = :nid', { nid });
  const items = await all('SELECT id, username, title FROM applications WHERE nomination_id = :nid ORDER BY id DESC LIMIT :lim OFFSET :off', { nid, lim: PAGE, off: page * PAGE });
  const blocks = [D.h(`${em('folder')} ${esc(n.title)} · заявки`)];
  blocks.push(items.length ? D.ul(items.map((a) => `#${a.id} · @${esc(a.username)} — ${esc(a.title)}`)) : D.p('Заявок нет.'));
  const rows = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2).map((a) => B.cb(`#${a.id} @${a.username}`, `a:av:${a.id}`)));
  const nav = [];
  if (page > 0) nav.push(B.cb('‹', `a:al:${nid}:${page - 1}`));
  if ((page + 1) * PAGE < total) nav.push(B.cb('›', `a:al:${nid}:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push(back('a:apps'));
  return show(c, blocks, rows);
}

const APP_SEARCH_PAGE = 5;
async function appSearch(c, raw, requestedPage = 0, newMessage = false) {
  const q = normUsername(raw).toLowerCase();
  if (!/^[a-z0-9_]{2,32}$/.test(q)) {
    const blocks = [D.p('Введите username кандидата или его часть: от 2 до 32 символов, латиница, цифры и «_».')];
    return newMessage ? send(c.chatId, blocks, [back('a:apps')]) : show(c, blocks, [back('a:apps')]);
  }

  // Если есть точное совпадение, показываем только его; частичный поиск —
  // запасной вариант, чтобы похожие username не смешивались с точным результатом.
  const exactTotal = Number(await val('SELECT COUNT(*) FROM applications WHERE username_norm = :q', { q })) || 0;
  const exact = exactTotal > 0;
  const total = exact ? exactTotal
    : Number(await val('SELECT COUNT(*) FROM applications WHERE username_norm LIKE :q', { q: `%${q}%` })) || 0;
  const page = Math.min(Math.max(0, Number(requestedPage) || 0), Math.max(0, Math.ceil(total / APP_SEARCH_PAGE) - 1));
  const items = exact
    ? await all(`SELECT a.id, a.username, a.title, n.title AS nomination
                 FROM applications a LEFT JOIN nominations n ON n.id = a.nomination_id
                 WHERE a.username_norm = :q ORDER BY a.id DESC LIMIT :lim OFFSET :off`,
      { q, lim: APP_SEARCH_PAGE, off: page * APP_SEARCH_PAGE })
    : await all(`SELECT a.id, a.username, a.title, n.title AS nomination
                 FROM applications a LEFT JOIN nominations n ON n.id = a.nomination_id
                 WHERE a.username_norm LIKE :q ORDER BY a.id DESC LIMIT :lim OFFSET :off`,
      { q: `%${q}%`, lim: APP_SEARCH_PAGE, off: page * APP_SEARCH_PAGE });

  const blocks = [D.h(`${em('eyes')} Поиск заявок: ${esc(q)}`)];
  blocks.push(D.p(total
    ? `Найдено: <b>${total}</b> · ${exact ? 'точное совпадение username' : 'частичное совпадение'}. Удаление относится только к выбранной заявке.`
    : 'Заявок с таким username не найдено.'));
  if (items.length) blocks.push(D.ul(items.map((r) =>
    `#${r.id} · @${esc(r.username)} — ${esc(r.title)} (${esc(r.nomination || '—')})`)));
  const rows = [];
  for (const item of items) {
    rows.push([
      B.cb(`#${item.id} · @${item.username}`, `a:av:${item.id}`),
      B.cb(`Удалить #${item.id}`, `a:adq:${item.id}:${page}:${q}`, { style: 'danger' }),
    ]);
  }
  const nav = [];
  if (page > 0) nav.push(B.cb('‹', `a:asr:${page - 1}:${q}`));
  if ((page + 1) * APP_SEARCH_PAGE < total) nav.push(B.cb('›', `a:asr:${page + 1}:${q}`));
  if (nav.length) rows.push(nav);
  rows.push(back('a:apps', '‹ К заявкам'));
  return newMessage ? send(c.chatId, blocks, rows) : show(c, blocks, rows);
}

async function deleteApplicationRecord(id) {
  const app = await S.getApplication(id);
  if (!app) return null;
  const matches = await findMatches(app);
  await S.deleteApplication(id);
  await closeCard(app);
  for (const other of [...matches.exact, ...matches.similar].slice(0, 12)) {
    await safe(() => refreshRelated({ ...other, nomination_id: app.nomination_id, username_norm: other.username_norm }));
  }
  return app;
}

async function appView(c, id) {
  const card = await renderCard(id);
  if (!card) return appsHome(c);
  const rows = [...card.rows];
  if (c.private) rows.push(back(`a:al:${card.app.nomination_id}:0`));
  return show(c, card.blocks, rows);
}

// ─────────────────────── Загрузка базы из выгрузки ───────────────────
const TABLE_RU = { users: 'пользователи', owners: 'владельцы', bans: 'баны', nominations: 'номинации', questions: 'вопросы', applications: 'заявки', news: 'новости',
  links: 'ресурсы', settings: 'настройки', broadcasts: 'рассылки', sponsors: 'спонсоры', sponsor_banners: 'баннеры спонсоров', referrals: 'рефералы', coin_log: 'монеты', reminders: 'напоминания' };

function previewMessage(pv) {
  if (pv.kind === 'csv') {
    return { blocks: [D.h(`${em('folder')} Файл CSV с заявками`), D.p(`Строк в файле: <b>${pv.rows}</b>. Будут добавлены недостающие заявки (по названию номинации); существующие не изменятся.`)],
      rows: [[B.cb('Добавить заявки', 'a:rstgo:csv', { style: 'success' })], cancelRow()] };
  }
  const lines = Object.keys(pv.file).map((t) => `${TABLE_RU[t] || t}: в файле <b>${pv.file[t]}</b> · сейчас <b>${pv.cur[t]}</b>`);
  return { blocks: [D.h(`${em('folder')} Выгрузка базы`), D.p(`Файл от ${pv.exportedAt ? fmtDate(pv.exportedAt) : 'неизвестной даты'}. Выберите, как загрузить:`), D.ul(lines),
      D.p('<b>Заменить всё</b> — таблицы из файла будут очищены и заполнены данными из файла (перед этим владельцам придёт резервная копия текущей базы). <b>Только добавить</b> — недостающее добавится, существующее не изменится.')],
    rows: [[B.cb('Заменить всё', 'a:rstgo:replace', { style: 'danger' })], [B.cb('Только добавить недостающее', 'a:rstgo:merge')], cancelRow()] };
}

async function restoreGo(c, mode) {
  const st = await S.getState(c.userId);
  if (!st || st.state !== 'rst_confirm') return send(c.chatId, [D.p('Сначала пришлите файл: Админ-панель → Загрузить базу из файла.')], [back()]);
  let parsed;
  try { parsed = parseBackup(decodeText(await api.getFileContent(st.data.file_id))); }
  catch (e) { await S.clearState(c.userId); return send(c.chatId, [D.p(`Файл больше недоступен (${esc(e.message)}). Пришлите его заново.`)], [back()]); }
  await S.clearState(c.userId);
  try {
    if (parsed.kind === 'csv') {
      const r = await importCsv(parsed);
      const miss = Object.entries(r.unmatched).map(([t, n]) => `«${esc(t)}» — ${n}`).join(', ');
      return send(c.chatId, [D.p(`${em('check')} Готово. Добавлено заявок: <b>${r.inserted}</b> из ${r.total}; пропущено: ${r.skipped}.${miss ? ` Нет такой номинации: ${miss}.` : ''}`)], [back()]);
    }
    const has = Number(await val('SELECT COUNT(*) FROM users')) + Number(await val('SELECT COUNT(*) FROM applications')) > 0;
    if (mode === 'replace' && has) await safe(async () => sendBackup(await S.ownerIds(), 'Резервная копия перед загрузкой базы'));
    const rep = await restoreJson(parsed, { mode: mode === 'merge' ? 'merge' : 'replace', keepOwner: c.userId });
    const lines = Object.entries(rep).map(([t, r]) => `${TABLE_RU[t] || t}: загружено <b>${r.inserted}</b> из ${r.total}${r.note ? ` (${esc(r.note)})` : ''}`);
    return send(c.chatId, [D.p(`${em('check')} База загружена (${mode === 'merge' ? 'добавлено недостающее' : 'заменено'}).`), D.ul(lines),
      D.p('Картинки баннеров спонсоров в выгрузку не входят — загрузите их заново в разделе «Спонсоры».')], [back()]);
  } catch (e) {
    return send(c.chatId, [D.p(`${em('alert')} Загрузка не выполнена: ${esc(String(e.message || e).slice(0, 300))}. Изменения откатились, база осталась прежней.`)], [back()]);
  }
}

// ─────────────────────── Рефералы: топ рефоводов ─────────────────────
const MEDAL = ['🥇', '🥈', '🥉'];
const refName = (r) => (r.username ? `@${esc(r.username)}` : esc(r.first_name || '') || `id ${r.id}`);
async function refHome(c, page = 0) {
  const [tot, count] = await Promise.all([refTotals(), refTopCount()]);
  const pages = Math.max(1, Math.ceil(count / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const rows = await refTop(PAGE, page * PAGE);
  const blocks = [D.h(`${em('star')} Рефералы · топ`),
    D.p('Реферал засчитывается, когда приглашённый проголосовал хотя бы в одной номинации. Забаненные не считаются.')];
  blocks.push(rows.length
    ? D.ul(rows.map((r, i) => { const n = page * PAGE + i; return `${MEDAL[n] || `${n + 1}.`} ${refName(r)} — <b>${r.voted}</b> проголосовало из ${r.invited} пришедших`; }))
    : D.p('Пока никто из приглашённых не проголосовал.'));
  blocks.push(D.p(`Всего по ссылкам пришло: <b>${tot.invited}</b> · проголосовали: <b>${tot.voted}</b> · рефоводов в топе: <b>${count}</b>${count > PAGE ? ` · страница ${page + 1} из ${pages}` : ''}`));
  const nav = [];
  if (page > 0) nav.push(B.cb('‹', `a:ref:${page - 1}`));
  if (page < pages - 1) nav.push(B.cb('›', `a:ref:${page + 1}`));
  return show(c, blocks, [...(nav.length ? [nav] : []), back()]);
}

// ─────────────────── Монеты и напоминания ───────────────────────
async function coinsHome(c, note = '') {
  const [cs, rm] = await Promise.all([coinStats(), reminderOverview()]);
  const days = Math.round(REMIND_EVERY_SEC / 86400);
  const blocks = [D.h(`${em('bell')} Монеты и напоминания`),
    D.p(`Кто проголосовал во <b>всех</b> номинациях, получает <b>${COIN_REWARD} монет</b> — их можно потратить на дополнительный голос во 2 туре.`)];
  if (note) blocks.push(D.p(note));
  blocks.push(D.ul([
    `Получили награду: <b>${cs.holders}</b> · выдано монет: <b>${cs.issued}</b> · потрачено: <b>${cs.spent}</b>`,
    `Номинаций для награды: <b>${rm.nominations}</b>${rm.nominations ? '' : ' (приём закрыт, включён лимит «одна заявка» или нет открытых номинаций)'}`,
    `Напоминания: <b>${rm.enabled ? 'включены' : 'выключены'}</b> · раз в ${days} дн. · отправлено всего: <b>${rm.total}</b>`,
    `Проголосовали не во всех: <b>${rm.waiting}</b> · отключили напоминания: <b>${rm.muted}</b>`,
  ]));
  blocks.push(D.p('Напоминания уходят «лениво»: при активности в боте или мини-аппе, небольшими пачками — точного времени у них нет.'));
  return show(c, blocks, [
    [B.cb(rm.enabled ? 'Выключить напоминания' : 'Включить напоминания', 'a:cointg', { style: rm.enabled ? 'danger' : 'success' })],
    [B.cb('Отправить пачку сейчас', 'a:coinrun')],
    back(),
  ]);
}

// ─────────────────────── Чёрный список юзернеймов ───────────────────
// Заявки на эти юзернеймы мини-апп не принимает. Подсказки в форме их тоже не показывают.
async function blacklistHome(c, page = 0) {
  const list = (await S.getBlacklist()).slice().sort();
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const part = list.slice(page * PAGE, page * PAGE + PAGE);
  const blocks = [D.h(`${em('lock')} Чёрный список юзернеймов`),
    D.p('Юзернеймы из списка нельзя выдвигать в номинациях: форма вернёт отказ. Уже поданные заявки не удаляются автоматически.')];
  blocks.push(part.length ? D.ul(part.map((u) => `@${esc(u)}`)) : D.p('Список пуст.'));
  if (total > PAGE) blocks.push(D.p(`Всего: ${total} · страница ${page + 1} из ${pages}`));
  const rows = [[B.cb('Добавить юзернеймы', 'a:bka', { style: 'success', emoji: 'plus' })]];
  for (let i = 0; i < part.length; i += 2) rows.push(part.slice(i, i + 2).map((u) => B.cb(`Убрать @${u}`, `a:bkd:${u}:${page}`)));
  const nav = [];
  if (page > 0) nav.push(B.cb('‹', `a:blk:${page - 1}`));
  if (page < pages - 1) nav.push(B.cb('›', `a:blk:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push(back());
  return show(c, blocks, rows);
}

// ─────────────────────────── Баны ───────────────────────────────────
const SCOPE = { all: 'везде', bot: 'в боте', app: 'в мини-аппе' };

async function bansHome(c, page = 0) {
  const total = await val('SELECT COUNT(*) FROM bans');
  const list = await all(`SELECT b.user_id, b.scope, b.at, u.username, u.first_name, u.last_name FROM bans b
                          LEFT JOIN users u ON u.id = b.user_id ORDER BY b.at DESC LIMIT :lim OFFSET :off`, { lim: PAGE, off: page * PAGE });
  const blocks = [D.h(`${em('lock')} Баны`),
    D.p('Бан действует в боте и/или в мини-аппе. Заблокированный пользователь не может отправлять заявки и пользоваться ботом.')];
  if (list.length) blocks.push(D.ul(list.map((b) => `<code>${b.user_id}</code> ${esc(userName(b))}${b.username ? ' @' + esc(b.username) : ''} — ${SCOPE[b.scope] || b.scope}`)));
  else blocks.push(D.p('Список пуст.'));
  const rows = [[B.cb('Забанить', 'a:bnew', { style: 'danger', emoji: 'lock' }), B.cb('Разбанить по ID', 'a:bunew', { style: 'success' })]];
  for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2).map((b) => B.cb(`Разбанить ${b.username ? '@' + b.username : b.user_id}`, `a:bu:${b.user_id}`)));
  const nav = [];
  if (page > 0) nav.push(B.cb('‹', `a:bl:${page - 1}`));
  if ((page + 1) * PAGE < total) nav.push(B.cb('›', `a:bl:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push(back());
  return show(c, blocks, rows);
}

async function banScopePick(c, uid) {
  if (await S.isOwner(uid)) return toast(c.cbId, 'Владельца забанить нельзя', true);
  const u = await S.getUser(uid);
  const blocks = [D.h(`${em('lock')} Забанить пользователя`),
    D.p(`${esc(userName(u) || '')} ${u?.username ? '@' + esc(u.username) : ''} · ID <code>${uid}</code>\nГде ограничить доступ?`)];
  const rows = [
    [B.cb('Везде (бот + мини-апп)', `a:bs:${uid}:all`, { style: 'danger' })],
    [B.cb('Только в боте', `a:bs:${uid}:bot`), B.cb('Только в мини-аппе', `a:bs:${uid}:app`)],
    back('a:bans', 'Отмена'),
  ];
  return show(c, blocks, rows);
}

async function resolveTarget(text) {
  const t = String(text || '').trim();
  if (/^-?\d{5,}$/.test(t)) return { id: Number(t), user: await S.getUser(Number(t)) };
  const u = await S.findUserByUsername(normUsername(t));
  return u ? { id: u.id, user: u } : null;
}

// ─────────────────────────── Рассылка ───────────────────────────────
const recipientsSql = `FROM users WHERE started = 1 AND blocked = 0
  AND id NOT IN (SELECT user_id FROM bans WHERE scope IN ('all', 'bot'))`;

async function bcHome(c) {
  const n = await val(`SELECT COUNT(*) ${recipientsSql}`);
  const running = await get("SELECT * FROM broadcasts WHERE status = 'running' ORDER BY id DESC LIMIT 1");
  const blocks = [D.h(`${em('speak')} Рассылка`),
    D.p(`Получателей сейчас: <b>${n}</b> (те, кто запускал бота и не заблокировал его). Можно слать текст, фото, видео — с любым форматированием и премиум-эмодзи: сообщение копируется как есть.`)];
  const rows = [[B.cb('Новая рассылка', 'a:bcn', { style: 'success', emoji: 'plus' })]];
  if (running) {
    blocks.push(D.p(`Есть незавершённая рассылка #${running.id}: ${running.sent} из ${running.total}.`));
    rows.push([B.cb(`Продолжить #${running.id}`, `a:bcgo:${running.id}`, { style: 'primary', emoji: 'rocket' })]);
  }
  rows.push(back());
  return show(c, blocks, rows);
}

async function bcRun(c, id) {
  const bc = await get('SELECT * FROM broadcasts WHERE id = :id', { id });
  if (!bc || bc.status === 'done' || bc.status === 'cancelled') return show(c, [D.p('Эта рассылка уже завершена.')], [back('a:bc')]);
  if (bc.status === 'draft') {
    const total = await val(`SELECT COUNT(*) ${recipientsSql}`);
    await run("UPDATE broadcasts SET status = 'running', total = :total, status_chat = :chat, status_msg = :msg WHERE id = :id",
      { total, chat: c.chatId, msg: c.msgId || null, id });
    bc.total = total;
  }
  const started = Date.now();
  let { cursor, sent, failed } = bc;
  let stop = '';
  while (!stop) {
    const batch = await all(`SELECT id ${recipientsSql} AND id > :cursor ORDER BY id LIMIT 10`, { cursor });
    if (!batch.length) { stop = 'done'; break; }
    const results = await Promise.all(batch.map(async (u) => {
      try {
        await api.copyMessage({ chat_id: u.id, from_chat_id: bc.from_chat, message_id: bc.message_id });
        return { id: u.id, r: 'ok' };
      } catch (e) {
        if (isRateLimit(e)) return { id: u.id, r: 'limit' };
        if (isForbidden(e)) { await S.setBlocked(u.id, true); return { id: u.id, r: 'blocked' }; }
        console.warn('broadcast to', u.id, errText(e));
        return { id: u.id, r: 'fail' };
      }
    }));
    // курсор двигаем только до первого лимита, чтобы никого не пропустить
    for (const x of results) {
      if (x.r === 'limit') { stop = 'limit'; break; }
      cursor = x.id;
      if (x.r === 'ok') sent++; else failed++;
    }
    await run('UPDATE broadcasts SET cursor = :cursor, sent = :sent, failed = :failed WHERE id = :id', { cursor, sent, failed, id });
    if (!stop && Date.now() - started > 18000) stop = 'time';
  }
  if (stop === 'done') await run("UPDATE broadcasts SET status = 'done' WHERE id = :id", { id });
  const left = stop === 'done' ? 0 : 1;
  const blocks = [D.h(`${em('speak')} Рассылка #${id}`),
    D.p(left
      ? `Отправлено: <b>${sent}</b> из ${bc.total}, ошибок: ${failed}. ${stop === 'limit' ? 'Telegram попросил притормозить — нажмите «Продолжить» через несколько секунд.' : 'Достигнут лимит времени одного запуска — нажмите «Продолжить».'}`
      : `${em('rocket')} Готово. Доставлено: <b>${sent}</b>, не доставлено: ${failed} (заблокировавшие бота исключены из будущих рассылок).`)];
  const rows = left ? [[B.cb('Продолжить', `a:bcgo:${id}`, { style: 'primary', emoji: 'rocket' })]] : [];
  rows.push(back('a:bc', '‹ К рассылкам'));
  return show(c, blocks, rows);
}

// ─────────────────────────── Новости ────────────────────────────────
async function newsHome(c) {
  const list = await S.listNews(10);
  const blocks = [D.h(`${em('bell')} Новости`),
    D.p('Новости показываются на лендинге мини-аппа. Пришлите сообщение — форматирование (жирный, курсив, ссылки, цитаты, спойлеры, код) сохранится.')];
  if (list.length) blocks.push(D.ul(list.map((n) => `#${n.id}${n.pinned ? ' (закреплена)' : ''} · ${esc(oneLine(n.text, 60))}`)));
  const rows = [[B.cb('Добавить новость', 'a:nwa', { style: 'success', emoji: 'plus' })]];
  for (const n of list) rows.push([
    B.cb(`${n.pinned ? 'Открепить' : 'Закрепить'} #${n.id}`, `a:nwp:${n.id}`),
    B.cb(`Удалить #${n.id}`, `a:nwd:${n.id}`, { style: 'danger' }),
  ]);
  rows.push(back());
  return show(c, blocks, rows);
}

// ─────────────────────────── Ресурсы ────────────────────────────────
async function linksHome(c) {
  const list = await S.listLinks();
  const blocks = [D.h(`${em('globe')} Ресурсы проекта`), D.p('Эти ссылки показываются на лендинге в мини-аппе.')];
  if (list.length) blocks.push(D.ul(list.map((l) => `<b>${esc(l.title)}</b> · ${LINK_KINDS[l.kind] || 'Другое'} · ${esc(l.url)}`)));
  const rows = [[B.cb('Добавить ссылку', 'a:lna', { style: 'success', emoji: 'plus' })]];
  for (const l of list) rows.push([B.cb(`Удалить «${l.title}»`, `a:lnd:${l.id}`, { style: 'danger' })]);
  rows.push(back());
  return show(c, blocks, rows);
}

// ─────────────────────────── Владельцы ──────────────────────────────
async function ownersHome(c) {
  const dbOwners = await all('SELECT o.user_id, u.username, u.first_name, u.last_name FROM owners o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.added_at');
  const blocks = [D.h(`${em('key')} Владельцы`),
    D.p('Владельцы управляют премией, получают выгрузки базы и заявки. Добавить можно по ID или по @юзернейму (человек должен хотя бы раз открыть бота).'),
    D.ul([...OWNER_IDS.map((id) => `<code>${id}</code> — из настроек проекта (постоянный)`),
      ...dbOwners.map((o) => `<code>${o.user_id}</code> ${esc(userName(o))}${o.username ? ' @' + esc(o.username) : ''}`)])];
  const rows = [[B.cb('Добавить владельца', 'a:owa', { style: 'success', emoji: 'plus' })]];
  for (const o of dbOwners) if (o.user_id !== c.userId) rows.push([B.cb(`Убрать ${o.username ? '@' + o.username : o.user_id}`, `a:owd:${o.user_id}`, { style: 'danger' })]);
  rows.push(back());
  return show(c, blocks, rows);
}

// ─────────────────────────── База данных ────────────────────────────
async function dbHome(c) {
  const t = ['users', 'applications', 'nominations', 'questions', 'news', 'links', 'bans', 'owners', 'sponsors', 'sponsor_banners'];
  const counts = [];
  for (const name of t) counts.push(`${name}: <b>${await val(`SELECT COUNT(*) FROM ${name}`)}</b>`);
  const [last, auto] = await Promise.all([S.getSetting('last_backup', '0'), S.getSetting('auto_backup', '1')]);
  const blocks = [D.h(`${em('db')} База данных`), D.ul(counts),
    D.p(`Автовыгрузка раз в сутки: <b>${auto === '1' ? 'включена' : 'выключена'}</b>, последняя — ${Number(last) ? fmtDate(Number(last)) : '—'}.\n` +
      `<i>В Serverless нет планировщика, поэтому проверка идёт при активности в боте и мини-аппе: если за сутки хоть кто-то зашёл, выгрузка уйдёт всем владельцам.</i>`)];
  const rows = [
    [B.cb('Выгрузить сейчас', 'a:dbx', { style: 'primary', emoji: 'cloud' })],
    [B.cb(auto === '1' ? 'Выключить автовыгрузку' : 'Включить автовыгрузку', 'a:dbt')],
    back(),
  ];
  return show(c, blocks, rows);
}

// ─────────────────────────── Настройки ──────────────────────────────
async function settingsHome(c) {
  const [mode, open, url, chat, about] = await Promise.all([
    S.getSetting('limit_mode', 'nomination'), S.getSetting('apps_open', '1'), S.appUrl(), S.getSetting('admin_chat'), S.getSetting('about', '')]);
  const blocks = [D.h(`${em('gear')} Настройки`), D.ul([
    `Лимит заявок: <b>${mode === 'global' ? 'одна заявка на человека (всего)' : 'одна заявка на человека в каждой номинации'}</b>`,
    `Приём заявок: <b>${open === '1' ? 'открыт' : 'закрыт для всех номинаций'}</b>`,
    `URL мини-аппа: ${url ? esc(url) : '<b>не задан</b>'}`,
    `Админ-чат: ${chat ? `<code>${chat}</code>` : '<b>не подключён</b>'}`,
    `Текст «О премии»: ${esc(oneLine(about, 70))}…`,
  ])];
  const rows = [
    [B.cb('Лимит: на номинацию / на всё', 'a:stl')],
    [B.cb(open === '1' ? 'Закрыть приём заявок' : 'Открыть приём заявок', 'a:sta')],
    [B.cb('Текст «О премии»', 'a:stab', { emoji: 'write' }), B.cb('URL мини-аппа', 'a:stu', { emoji: 'globe' })],
    chat ? [B.cb('Отвязать админ-чат', 'a:stcx', { style: 'danger' })] : [B.cb('Как подключить админ-чат', 'a:stc', { emoji: 'info' })],
    back(),
  ];
  return show(c, blocks, rows);
}

// ─────────────────────────── Баннер ─────────────────────────────────
const BN = { bot: 'в боте', site: 'на сайте (в мини-аппе)' };
const bnMode = (m) => (m === 'custom' ? 'своё фото' : m === 'off' ? 'скрыт' : 'стандартный');
const kindKey = (k) => (k === 'site' ? 's' : 'b');

async function bannerHome(c) {
  const b = await S.banners();
  const blocks = [D.h(`${em('image')} Баннер`), D.ul([
    `В боте: <b>${bnMode(b.bot.mode)}</b>`,
    `На сайте (в мини-аппе): <b>${bnMode(b.site.mode)}</b>`,
  ]), D.p('Баннер в боте и на сайте настраиваются отдельно. Выберите, какой менять.')];
  return show(c, blocks, [
    [B.cb('Баннер в боте', 'a:bnb', { emoji: 'image' }), B.cb('Баннер на сайте', 'a:bns', { emoji: 'globe' })],
    back(),
  ]);
}

async function bannerView(c, kind) {
  const b = (await S.banners())[kind];
  const k = kindKey(kind);
  const blocks = [D.h(`${em('image')} Баннер ${BN[kind]}`)];
  const pic = bannerBlock(b);
  if (pic) blocks.push(pic);
  blocks.push(D.ul([`Сейчас: <b>${bnMode(b.mode)}</b>`]));
  blocks.push(D.p(kind === 'site'
    ? 'Нажмите «Загрузить фото» и пришлите картинку. На сайте она обрезается до квадрата, лучше всего квадрат от 1000×1000 px. Если картинки выше не видно, пришлите фото ещё раз.'
    : 'Нажмите «Загрузить фото» и пришлите картинку: она появится вверху главного сообщения бота. Если картинки выше не видно, пришлите фото ещё раз.'));
  const rows = [[B.cb('Загрузить фото', `a:bn${k}u`, { emoji: 'image' })]];
  if (b.mode !== 'default') rows.push([B.cb('Вернуть стандартный', `a:bn${k}d`)]);
  if (b.mode !== 'off') rows.push([B.cb('Убрать баннер', `a:bn${k}o`, { style: 'danger' })]);
  rows.push(back('a:bnr'));
  return show(c, blocks, rows);
}

// ─────────────────────────── Спонсоры ───────────────────────────────
async function sponsorsHome(c) {
  const [sponsors, nominations, banners] = await Promise.all([
    S.listSponsors(), S.listSponsorNominations(), S.listSponsorBanners(),
  ]);
  const blocks = [
    D.h(`${em('star')} Спонсоры`),
    D.p('В этот список добавляются Telegram-аккаунты, которым разрешено подавать заявки в три спонсорские подноминации. При совпадении username прежние заявки копируются в новую карточку; исходные заявки не удаляются. Голоса пользователей за такой же username в обычных номинациях автоматически засчитываются в спонсорскую подноминацию.'),
  ];
  if (sponsors.length) {
    blocks.push(D.ul(sponsors.map((s) => `<code>@${esc(s.username)}</code>`)));
  } else {
    blocks.push(D.p('Список доступа пока пуст.'));
  }
  if (nominations.length) {
    const rows = [];
    for (const n of nominations) {
      const count = await val('SELECT COUNT(*) FROM applications WHERE nomination_id = :id', { id: n.id });
      const votes = await S.sponsorVotesCount(n.id);
      blocks.push(D.p(`<b>${esc(n.title)}</b> · ${n.is_open ? 'приём открыт' : 'приём закрыт'} · заявок спонсоров: ${count || 0} · голосов пользователей: ${votes || 0}`));
      rows.push([B.cb(n.is_open ? `Закрыть: ${kindOf(n.kind).name}` : `Открыть: ${kindOf(n.kind).name}`, `a:spt:${n.id}`, { style: n.is_open ? undefined : 'success' })]);
    }
    rows.unshift([B.cb('Добавить спонсора по @username', 'a:spa', { style: 'success', emoji: 'plus' })]);
    rows.push([B.cb(`Баннеры спонсоров (${banners.length})`, 'a:sbl', { emoji: 'image' })]);
    for (const s of sponsors) rows.push([B.cb(`Убрать @${s.username}`, `a:spdr:${s.id}`, { style: 'danger' })]);
    rows.push(back());
    return show(c, blocks, rows);
  }
  return show(c, blocks, [
    [B.cb('Добавить спонсора по @username', 'a:spa', { style: 'success', emoji: 'plus' })],
    [B.cb(`Баннеры спонсоров (${banners.length})`, 'a:sbl', { emoji: 'image' })],
    back(),
  ]);
}

async function sponsorBannersHome(c) {
  const banners = await S.listSponsorBanners();
  const blocks = [D.h(`${em('image')} Баннеры спонсоров`),
    D.p('Укажите HTTPS-ссылку и загрузите фото. В мини-аппе показывается только картинка без подписи; нажатие открывает ссылку.')];
  if (banners.length) blocks.push(D.ul(banners.map((b) => `#${b.id} · ${esc(b.target_url)}`)));
  else blocks.push(D.p('Баннеров пока нет.'));
  const rows = [[B.cb('Добавить баннер', 'a:sba', { style: 'success', emoji: 'plus' })]];
  for (const b of banners) rows.push([B.cb(`Удалить #${b.id}`, `a:sbd:${b.id}`, { style: 'danger' })]);
  rows.push(back('a:sp'));
  return show(c, blocks, rows);
}

function isHttpsUrl(value) {
  const raw = String(value || '').trim();
  const match = /^https:\/\/([^/?#\s]+)(?:[/?#][^\s]*)?$/i.exec(raw);
  if (!match) return false;

  // Keep validation independent of the global URL API: some serverless runtimes
  // do not expose it, which otherwise made every sponsor link look invalid.
  const hostPort = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(match[1]);
  if (!hostPort) return false;
  const hostname = hostPort[1];
  const labels = hostname.split('.');
  if (hostname.length > 253 || labels.some((label) =>
    label.length < 1 || label.length > 63 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) return false;
  if (hostPort[2] && (Number(hostPort[2]) < 1 || Number(hostPort[2]) > 65535)) return false;
  return true;
}

// Какой размер фото брать: для бота — самый большой, для сайта — самый большой не шире 1000 px и до ~900 КБ.
function pickPhoto(photos, kind) {
  const list = [...(photos || [])].sort((a, z) => (a.width || 0) - (z.width || 0));
  if (!list.length) return null;
  if (kind !== 'site') return list[list.length - 1];
  const ok = list.filter((p) => (p.width || 0) <= 1000 && (!p.file_size || p.file_size <= 900000));
  return ok.length ? ok[ok.length - 1] : list[0];
}

// ═════════════════════════ Роутер кнопок ═══════════════════════════
export async function adminCb(c, data) {
  const [, act, a1, a2, a3] = data.split(':');
  const id = Number(a1);
  const prompt = async (state, payload, text, rows) => {
    await S.setState(c.userId, state, payload || {});
    return show(c, [D.p(text)], rows || [cancelRow()]);
  };

  switch (act) {
    case 'home': return home(c);
    case 'cx': await S.clearState(c.userId); return home(c);

    // номинации
    case 'noms': return noms(c);
    case 'n': return nomView(c, id);
    case 'nt': { const n = await S.getNomination(id); if (n) await S.updateNomination(id, { is_open: n.is_open ? 0 : 1 }); return nomView(c, id); }
    case 'nr': return prompt('nom_rename', { nid: id }, 'Пришлите новое название номинации.');
    case 'nk': return a2
      ? (await S.updateNomination(id, { kind: a2 }), nomView(c, id))
      : show(c, [D.h('Тип номинации'), D.p('От типа зависят подписи полей в форме: «Название бота», «Имя или псевдоним» и т. д.')], kindRows(`a:nk:${id}`, [back(`a:n:${id}`)]));
    case 'ne': return prompt('nom_emoji', { nid: id }, 'Пришлите <b>одно премиум-эмодзи</b> — оно появится на кнопке номинации в боте.', [[B.cb('Сбросить на стандартное', `a:nes:${id}`)], cancelRow()]);
    case 'nes': await S.updateNomination(id, { emoji_id: null }); await S.clearState(c.userId); return nomView(c, id);
    case 'nd': return show(c, [D.p(`${em('cross')} Удалить номинацию? Заявки сохранятся в базе, но номинация исчезнет из бота и мини-аппа.`)],
      [[B.cb('Да, удалить', `a:ndd:${id}`, { style: 'danger' }), B.cb('Отмена', `a:n:${id}`)]]);
    case 'ndd': await S.deleteNomination(id); return noms(c);
    case 'nadd': return prompt('nom_new_title', {}, 'Пришлите название новой номинации, например «Идея года».');
    case 'nkn': { // выбор типа в сценарии создания
      const st = await S.getState(c.userId);
      if (!st || st.state !== 'nom_new_kind') return home(c);
      await S.setState(c.userId, 'nom_new_emoji', { title: st.data.title, kind: a1 });
      return show(c, [D.p('Пришлите <b>премиум-эмодзи</b> для кнопки номинации или нажмите «Пропустить».')], [[B.cb('Пропустить', 'a:nskip')], cancelRow()]);
    }
    case 'nskip': {
      const st = await S.getState(c.userId);
      if (!st || st.state !== 'nom_new_emoji') return home(c);
      const nid = await S.createNomination({ title: st.data.title, kind: st.data.kind, emojiId: null });
      await S.clearState(c.userId);
      return nomView(c, Number(nid));
    }
    case 'nq': return questionsView(c, id);
    case 'qa': return prompt('q_new', { nid: id }, 'Пришлите текст вопроса — он появится в форме мини-аппа под описанием.');
    case 'qr': { const q = await S.getQuestion(id); if (q) { await S.toggleQuestionRequired(id); return questionsView(c, q.nomination_id); } return noms(c); }
    case 'qd': { const q = await S.getQuestion(id); if (q) { await S.deleteQuestion(id); return questionsView(c, q.nomination_id); } return noms(c); }

    // Спонсорский список, подноминации и баннеры
    case 'sp': await S.clearState(c.userId); return sponsorsHome(c);
    case 'spa': return prompt('sponsor_user', {}, 'Пришлите Telegram username спонсора, например @support_team. Спонсор должен открыть мини-апп от этого аккаунта.');
    case 'spdr': return show(c, [D.p(`Убрать @${esc((await S.getSponsor(id))?.username || '')} из списка спонсоров? Новые заявки в спонсорские подноминации станут недоступны.`)],
      [[B.cb('Да, убрать', `a:spdy:${id}`, { style: 'danger' }), B.cb('Отмена', 'a:sp')]]);
    case 'spdy': await S.deleteSponsor(id); await toast(c.cbId, 'Спонсор убран'); return sponsorsHome(c);
    case 'spt': {
      const nomination = await S.getNomination(id);
      if (!nomination?.sponsor_type) return sponsorsHome(c);
      await S.updateNomination(id, { is_open: nomination.is_open ? 0 : 1 });
      return sponsorsHome(c);
    }
    case 'sbl': await S.clearState(c.userId); return sponsorBannersHome(c);
    case 'sba': return prompt('sponsor_banner_url', {}, 'Пришлите HTTPS-ссылку, которую откроет баннер, или нажмите кнопку ниже, чтобы использовать ссылку «Поддержать нас».',
      [[B.cb('Поддержать нас (DonationAlerts)', 'a:sbdon')], cancelRow()]);
    case 'sbdon': {
      const st = await S.getState(c.userId);
      if (!st || st.state !== 'sponsor_banner_url') return sponsorBannersHome(c);
      await S.setState(c.userId, 'sponsor_banner_photo', { url: DONATE_URL });
      return show(c, [D.p('Ссылка: DonationAlerts. Теперь пришлите баннер фотографией (не файлом).')], [cancelRow()]);
    }
    case 'sbd': {
      const banner = await S.getSponsorBanner(id);
      if (!banner) return sponsorBannersHome(c);
      return show(c, [D.p(`Удалить баннер #${id} (${esc(banner.target_url)})?`)], [
        [B.cb('Да, удалить', `a:sbdy:${id}`, { style: 'danger' }), B.cb('Отмена', 'a:sbl')],
      ]);
    }
    case 'sbdy': await S.deleteSponsorBanner(id); await toast(c.cbId, 'Баннер удалён'); return sponsorBannersHome(c);

    // заявки
    case 'apps': return appsHome(c);
    case 'al': return appsList(c, id, Number(a2) || 0);
    case 'av': return appView(c, id);
    case 'as': return prompt('app_search', {}, 'Пришлите username кандидата (точный или его часть), чтобы найти заявки.');
    case 'asr': return appSearch(c, a2, id);
    case 'ad': return show(c, [D.p(`${em('cross')} Удалить заявку #${id}? Автор сможет отправить новую.`)],
      [[B.cb('Да, удалить', `a:ady:${id}`, { style: 'danger' }), B.cb('Отмена', `a:av:${id}`)]]);
    case 'adq': {
      const app = await S.getApplication(id);
      if (!app) return appSearch(c, a3, Number(a2) || 0);
      const nomination = await S.getNomination(app.nomination_id);
      return show(c, [
        D.p(`${em('cross')} Удалить только заявку <b>#${id}</b>?`),
        D.p(`@${esc(app.username)} · ${esc(app.title)} · ${esc(nomination?.title || 'номинация')}`),
        D.p('Другие заявки с таким же username останутся в базе.'),
      ], [[
        B.cb('Да, удалить эту заявку', `a:adqy:${id}:${Number(a2) || 0}:${a3}`, { style: 'danger' }),
        B.cb('Отмена', `a:asr:${Number(a2) || 0}:${a3}`),
      ]]);
    }
    case 'adqy': {
      const app = await deleteApplicationRecord(id);
      if (!app) { await toast(c.cbId, 'Заявка уже удалена'); return appSearch(c, a3, Number(a2) || 0); }
      await toast(c.cbId, `Заявка #${id} удалена`);
      return appSearch(c, a3, Number(a2) || 0);
    }
    case 'ady': {
      const app = await deleteApplicationRecord(id);
      if (!app) return toast(c.cbId, 'Заявка уже удалена');
      return show(c, [D.p(`${em('cross')} Заявка #${id} удалена.`)], c.private ? [back('a:apps')] : []);
    }

    // загрузка базы из файла
    case 'rst': return prompt('rst_file', {}, 'Пришлите файл выгрузки: <b>JSON</b> — полная база или <b>CSV</b> — только заявки (их бот присылает при автовыгрузке). До подтверждения ничего не изменится. Файл до 20 МБ.');
    case 'rstgo': return restoreGo(c, a1);
    // рефералы
    case 'ref': return refHome(c, id || 0);
    // монеты и напоминания
    case 'coin': return coinsHome(c);
    case 'cointg': { const on = (await S.getSetting('remind_enabled', REMIND_DEFAULT)) === '1'; await S.setSetting('remind_enabled', on ? '0' : '1'); return coinsHome(c, on ? 'Напоминания выключены.' : 'Напоминания включены.'); }
    case 'coinrun': {
      const r = await runReminders({ force: true, manual: true, limit: 20 });
      let note;
      if (r.reason === 'off') note = 'Сначала включите напоминания.';
      else if (r.reason === 'nothing') note = 'Сейчас нет номинаций для награды.';
      else if (r.reason === 'no_url') note = 'Не задан URL мини-аппа (Настройки).';
      else {
        note = `Подобрано: ${r.picked || 0} · отправлено: ${r.sent || 0}${r.failed ? ` · ошибок: ${r.failed} (${esc(String(r.error).slice(0, 120))})` : ''}.`;
        if (!r.picked) {
          const d = await reminderDiagnostics();
          if (d) note += ` Сейчас подходящих нет. Из ${d.incomplete} неполных: готовы к отправке ${d.ready}, активны в последний час ${d.activeNow}, уже получали за последние 5 дней ${d.recent}, были в боте меньше суток ${d.tooNew}.`;
        }
      }
      return coinsHome(c, note);
    }
    // чёрный список юзернеймов
    case 'blk': await S.clearState(c.userId); return blacklistHome(c, id || 0);
    case 'bka': return prompt('blk_add', {}, 'Пришлите один или несколько юзернеймов через пробел, запятую или с новой строки, например @spam_bot @fake_channel.');
    case 'bkd': await S.removeBlacklist(a1); await toast(c.cbId, 'Убран из чёрного списка'); return blacklistHome(c, Number(a2) || 0);
    case 'bk': { // с карточки заявки
      const app = await S.getApplication(id);
      if (!app) return toast(c.cbId, 'Заявка уже удалена', true);
      const same = await val('SELECT COUNT(*) FROM applications WHERE username_norm = :n', { n: app.username_norm });
      const rows = [[B.cb('Только в чёрный список', `a:bky:${id}`, { style: 'danger' })]];
      if (same) rows.push([B.cb(`В список и удалить заявки (${same})`, `a:bkyd:${id}`, { style: 'danger' })]);
      rows.push([B.cb('Отмена', `a:av:${id}`)]);
      return show(c, [D.p(`${em('lock')} Занести @${esc(app.username)} в чёрный список?`),
        D.p('Новые заявки на этот юзернейм форма будет отклонять. Прежние заявки можно оставить или удалить сразу.')], rows);
    }
    case 'bky': case 'bkyd': {
      const app = await S.getApplication(id);
      if (!app) return toast(c.cbId, 'Заявка уже удалена', true);
      await S.addBlacklist([app.username_norm]);
      let removed = 0;
      if (act === 'bkyd') {
        const ids = await all('SELECT id FROM applications WHERE username_norm = :n ORDER BY id LIMIT 50', { n: app.username_norm });
        for (const r of ids) { if (await deleteApplicationRecord(r.id)) removed++; }
      }
      await toast(c.cbId, 'Добавлен в чёрный список');
      return show(c, [D.p(`${em('lock')} @${esc(app.username)} в чёрном списке.${removed ? ` Удалено заявок: ${removed}.` : ''}`)],
        c.private ? [back('a:blk')] : []);
    }

    // баны
    case 'bans': return bansHome(c);
    case 'bl': return bansHome(c, id || 0);
    case 'bnew': return prompt('ban_target', {}, 'Пришлите ID пользователя или его @юзернейм (человек должен был открывать бота или мини-апп).');
    case 'bunew': return prompt('unban_target', {}, 'Пришлите ID или @юзернейм пользователя, которого нужно разбанить.');
    case 'bn': return banScopePick(c, id);
    case 'bs': {
      if (await S.isOwner(id)) return toast(c.cbId, 'Владельца забанить нельзя', true);
      await S.ban(id, a2, null, c.userId);
      const u = await S.getUser(id);
      return show(c, [D.p(`${em('lock')} ${esc(userName(u))} <code>${id}</code> — бан ${SCOPE[a2] || a2}.`)], [[B.cb('К банам', 'a:bans')]]);
    }
    case 'bu': await S.unban(id); await toast(c.cbId, 'Разбанен'); return bansHome(c);

    // рассылка
    case 'bc': return bcHome(c);
    case 'bcn': return prompt('bc_msg', {}, 'Пришлите сообщение для рассылки (текст, фото, видео — с любым форматированием и премиум-эмодзи).');
    case 'bcgo': return bcRun(c, id);
    case 'bcx': await run("UPDATE broadcasts SET status = 'cancelled' WHERE id = :id AND status IN ('draft','running')", { id }); return bcHome(c);

    // новости
    case 'nw': return newsHome(c);
    case 'nwa': return prompt('news_new', {}, 'Пришлите текст новости. Форматирование сохранится. Премиум-эмодзи в мини-аппе не отображаются.');
    case 'nwp': await S.toggleNewsPin(id); return newsHome(c);
    case 'nwd': await S.deleteNews(id); return newsHome(c);

    // ресурсы
    case 'ln': return linksHome(c);
    case 'lna': return prompt('link_title', {}, 'Пришлите название ссылки, например «Канал сообщества».');
    case 'lk': {
      const st = await S.getState(c.userId);
      if (!st || st.state !== 'link_kind') return linksHome(c);
      await S.addLink(st.data.title, st.data.url, a1);
      await S.clearState(c.userId);
      return linksHome(c);
    }
    case 'lnd': await S.deleteLink(id); return linksHome(c);

    // владельцы
    case 'ow': return ownersHome(c);
    case 'owa': return prompt('owner_add', {}, 'Пришлите ID или @юзернейм нового владельца (он должен хотя бы раз открыть бота).');
    case 'owd': if (!OWNER_IDS.includes(id) && id !== c.userId) await S.removeOwner(id); return ownersHome(c);

    // база
    case 'db': return dbHome(c);
    case 'dbx': {
      await toast(c.cbId, 'Готовлю файлы…');
      const r = await sendBackup([c.userId], 'Выгрузка по запросу');
      return r.ok ? null : show(c, [D.p('Не удалось отправить файлы. Откройте личный чат с ботом и повторите.')], [back('a:db')]);
    }
    case 'dbt': await S.setSetting('auto_backup', (await S.getSetting('auto_backup', '1')) === '1' ? '0' : '1'); return dbHome(c);

    // баннер
    case 'bnr': await S.clearState(c.userId); return bannerHome(c);
    case 'bnb': await S.clearState(c.userId); return bannerView(c, 'bot');
    case 'bns': await S.clearState(c.userId); return bannerView(c, 'site');
    case 'bnbu': return prompt('banner_bot', {}, 'Пришлите фото для баннера <b>в боте</b> (как обычное фото, не файлом).', [[B.cb('‹ Назад', 'a:bnb')], cancelRow()]);
    case 'bnsu': return prompt('banner_site', {}, 'Пришлите фото для баннера <b>на сайте</b> (как обычное фото, не файлом). Лучше всего квадрат от 1000×1000 px.', [[B.cb('‹ Назад', 'a:bns')], cancelRow()]);
    case 'bnbd': await S.setBanner('bot', 'default'); await S.clearState(c.userId); return bannerView(c, 'bot');
    case 'bnbo': await S.setBanner('bot', 'off'); await S.clearState(c.userId); return bannerView(c, 'bot');
    case 'bnsd': await S.setBanner('site', 'default'); await S.clearState(c.userId); return bannerView(c, 'site');
    case 'bnso': await S.setBanner('site', 'off'); await S.clearState(c.userId); return bannerView(c, 'site');

    // настройки
    case 'st': return settingsHome(c);
    case 'stl': await S.setSetting('limit_mode', (await S.getSetting('limit_mode', 'nomination')) === 'global' ? 'nomination' : 'global'); return settingsHome(c);
    case 'sta': await S.setSetting('apps_open', (await S.getSetting('apps_open', '1')) === '1' ? '0' : '1'); return settingsHome(c);
    case 'stab': return prompt('about_text', {}, 'Пришлите новый текст «О премии» для лендинга. Абзацы разделяйте пустой строкой.');
    case 'stu': return prompt('app_url', {}, 'Пришлите адрес мини-аппа вида https://app123.tgcloud.ai/ — его печатает <code>npx tgcloud push</code>.');
    case 'stc': return show(c, [D.h('Админ-чат'), D.p('Добавьте бота в группу владельцев и отправьте в ней команду <code>/setchat</code> — заявки начнут приходить туда. Команду принимает только владелец.')], [back('a:st')]);
    case 'stcx': await S.setSetting('admin_chat', ''); return settingsHome(c);
    default: return home(c);
  }
}

// ═════════════════════════ Диалоги (текст от админа) ═══════════════
const customEmojiId = (msg) => (msg.entities || []).find((e) => e.type === 'custom_emoji')?.custom_emoji_id
  || (/^\d{10,}$/.test((msg.text || '').trim()) ? msg.text.trim() : null);

export async function adminState(c, msg, st) {
  const text = cleanText(msg.text || msg.caption || '');
  const done = async (blocks, rows) => { await S.clearState(c.userId); return send(c.chatId, blocks, rows); };
  const again = (t) => send(c.chatId, [D.p(t)], [cancelRow()]);
  const asHome = () => ({ chatId: c.chatId, userId: c.userId, isOwner: true, private: true });

  switch (st.state) {
    case 'nom_new_title': {
      const t = oneLine(text, 60);
      if (t.length < 2) return again('Название слишком короткое. Пришлите ещё раз.');
      await S.setState(c.userId, 'nom_new_kind', { title: t });
      return send(c.chatId, [D.p(`Название: <b>${esc(t)}</b>. Выберите тип номинации — от него зависят подписи в форме.`)], kindRows('a:nkn', [cancelRow()]));
    }
    case 'nom_new_emoji': {
      const eid = customEmojiId(msg);
      if (!eid) return again('Не вижу премиум-эмодзи. Пришлите одно, или нажмите «Пропустить» выше.');
      const nid = await S.createNomination({ title: st.data.title, kind: st.data.kind, emojiId: eid });
      await S.clearState(c.userId);
      return nomView({ ...asHome(), msgId: null }, Number(nid));
    }
    case 'nom_rename': {
      const t = oneLine(text, 60);
      if (t.length < 2) return again('Название слишком короткое.');
      await S.updateNomination(st.data.nid, { title: t });
      await S.clearState(c.userId);
      return nomView(asHome(), st.data.nid);
    }
    case 'nom_emoji': {
      const eid = customEmojiId(msg);
      if (!eid) return again('Не вижу премиум-эмодзи. Пришлите одно.');
      await S.updateNomination(st.data.nid, { emoji_id: eid });
      await S.clearState(c.userId);
      return nomView(asHome(), st.data.nid);
    }
    case 'q_new': {
      const t = oneLine(text, 200);
      if (t.length < 3) return again('Вопрос слишком короткий.');
      await S.addQuestion(st.data.nid, t, false);
      await S.clearState(c.userId);
      return questionsView(asHome(), st.data.nid);
    }
    case 'app_search': {
      const q = normUsername(text).toLowerCase();
      if (!/^[a-z0-9_]{2,32}$/.test(q)) return again('Пришлите username кандидата от 2 до 32 символов: латиница, цифры и «_».');
      await S.clearState(c.userId);
      return appSearch(asHome(), q, 0, true);
    }
    case 'ban_target': {
      const t = await resolveTarget(text);
      if (!t) return again('Не нашёл такого пользователя. Пришлите числовой ID или @юзернейм человека, который открывал бота.');
      await S.clearState(c.userId);
      if (await S.isOwner(t.id)) return send(c.chatId, [D.p('Владельца забанить нельзя.')], [back('a:bans')]);
      return banScopePick({ ...asHome(), msgId: null, cbId: null }, t.id);
    }
    case 'unban_target': {
      const t = await resolveTarget(text);
      if (!t) return again('Не нашёл такого пользователя. Пришлите ID или @юзернейм.');
      await S.unban(t.id);
      return done([D.p(`${em('lock')} Пользователь <code>${t.id}</code> разбанен.`)], [[B.cb('К банам', 'a:bans')]]);
    }
    case 'bc_msg': {
      const id = await run('INSERT INTO broadcasts (from_chat, message_id, created_by, status, created_at) VALUES (:c, :m, :u, \'draft\', :t)',
        { c: msg.chat.id, m: msg.message_id, u: c.userId, t: now() });
      const n = await val(`SELECT COUNT(*) ${recipientsSql}`);
      await S.clearState(c.userId);
      await safe(() => api.copyMessage({ chat_id: c.chatId, from_chat_id: msg.chat.id, message_id: msg.message_id }));
      const bid = id?.lastInsertRowid;
      return send(c.chatId, [D.p(`${em('speak')} Так сообщение увидят получатели. Отправить <b>${n}</b> пользователям?`)],
        [[B.cb(`Отправить ${n}`, `a:bcgo:${bid}`, { style: 'success', emoji: 'rocket' }), B.cb('Отмена', `a:bcx:${bid}`, { style: 'danger' })]]);
    }
    case 'news_new': {
      const entities = msg.entities || msg.caption_entities || [];
      if (!text) return again('Нужен текст. Пришлите сообщение с текстом.');
      const id = await S.addNews(text, entities, c.userId);
      await S.clearState(c.userId);
      return send(c.chatId, [D.p(`${em('bell')} Новость #${id} опубликована в мини-аппе.`)], [[B.cb('К новостям', 'a:nw')]]);
    }
    case 'link_title': {
      const t = oneLine(text, 60);
      if (t.length < 2) return again('Слишком короткое название.');
      await S.setState(c.userId, 'link_url', { title: t });
      return send(c.chatId, [D.p('Теперь пришлите ссылку (https://… или t.me/…).')], [cancelRow()]);
    }
    case 'link_url': {
      let u = text.trim();
      if (/^(t\.me|telegram\.me)\//i.test(u)) u = 'https://' + u;
      if (!/^https?:\/\/[^\s]+\.[^\s]+$/i.test(u)) return again('Это не похоже на ссылку. Пример: https://t.me/channel');
      await S.setState(c.userId, 'link_kind', { title: st.data.title, url: u });
      const rows = Object.entries(LINK_KINDS).map(([k, n]) => B.cb(n, `a:lk:${k}`));
      return send(c.chatId, [D.p('Выберите значок для ссылки.')], [rows.slice(0, 4), rows.slice(4), cancelRow()]);
    }
    case 'owner_add': {
      const t = await resolveTarget(text);
      if (!t) return again('Не нашёл пользователя. Пришлите ID или @юзернейм человека, который открывал бота.');
      await S.addOwner(t.id, c.userId);
      return done([D.p(`${em('key')} <code>${t.id}</code> теперь владелец.`)], [[B.cb('К владельцам', 'a:ow')]]);
    }
    case 'blk_add': {
      const parts = String(text || '').split(/[\s,;]+/).map((x) => normUsername(x)).filter(Boolean);
      if (!parts.length) return again('Пришлите хотя бы один юзернейм, например @spam_bot.');
      const valid = [...new Set(parts.map((x) => x.toLowerCase()).filter((x) => isUsername(x)))];
      const bad = parts.filter((x) => !isUsername(x.toLowerCase()));
      if (!valid.length) return again('Не вижу корректных юзернеймов: 4–32 символа, латиница, цифры и «_».');
      const added = await S.addBlacklist(valid);
      const already = valid.length - added.length;
      return done([D.p(`${em('lock')} Добавлено в чёрный список: <b>${added.length}</b>${already ? ` · уже были: ${already}` : ''}${bad.length ? ` · пропущено некорректных: ${bad.length}` : ''}.`)],
        [[B.cb('Чёрный список', 'a:blk')]]);
    }
    case 'rst_file': {
      const doc = msg.document;
      if (!doc) return again('Пришлите файл как документ: скрепка → Файл.');
      if (Number(doc.file_size) > MAX_FILE) return again('Файл больше 20 МБ — через бота его не загрузить. Положите файл на сервер и выполните npm run restore (см. README).');
      let parsed;
      try { parsed = parseBackup(decodeText(await api.getFileContent(doc.file_id))); }
      catch (e) { return again(`Не получилось разобрать файл: ${esc(e.message)}. Пришлите другой или нажмите «Отмена».`); }
      const pm = previewMessage(await backupPreview(parsed));
      await S.setState(c.userId, 'rst_confirm', { file_id: doc.file_id });
      return send(c.chatId, pm.blocks, pm.rows);
    }
    case 'sponsor_user': {
      const username = normUsername(text);
      if (!isUsername(username.toLowerCase())) return again('Пришлите корректный Telegram username: 4–32 символа, латиница, цифры и «_».');
      if (await S.isSponsor(username)) return again(`@${esc(username)} уже есть в списке спонсоров.`);
      await S.addSponsor(username, c.userId);
      return done([D.p(`${em('star')} @${esc(username)} добавлен. Войти в спонсорскую форму нужно из Telegram-аккаунта с этим username.`)],
        [[B.cb('К спонсорам', 'a:sp')]]);
    }
    case 'sponsor_banner_url': {
      const url = text.trim();
      if (!isHttpsUrl(url)) return again('Нужна безопасная ссылка вида https://example.com/');
      await S.setState(c.userId, 'sponsor_banner_photo', { url });
      return send(c.chatId, [D.p('Пришлите баннер фотографией (не файлом). Подойдёт горизонтальное изображение; я сохраню версию до 1000 px.')], [cancelRow()]);
    }
    case 'sponsor_banner_photo': {
      const photo = pickPhoto(msg.photo, 'site');
      if (!photo) return again('Нужно именно фото. Пришлите картинку как обычное фото, не файлом.');
      if (photo.file_size && photo.file_size > 900000) return again('Фото слишком большое. Пришлите баннер до 900 КБ.');
      let data = '';
      try { data = toBase64(await api.getFileContent(photo.file_id)); }
      catch (e) { console.error('sponsor banner download', errText(e)); return again('Не получилось скачать фото. Пришлите его ещё раз.'); }
      if (!data) return again('Фото пришло пустым. Пришлите его ещё раз.');
      if (data.length > 1200000) return again('Фото слишком большое для хранения. Пришлите баннер поменьше (до 900 КБ).');
      await S.addSponsorBanner('', st.data.url, data);
      return done([D.p(`${em('image')} Баннер сохранён и появится в разделе спонсоров.`)],
        [[B.cb('К баннерам спонсоров', 'a:sbl')]]);
    }
    case 'about_text': {
      if (text.length < 20) return again('Слишком короткий текст.');
      await S.setSetting('about', text.slice(0, 3000));
      return done([D.p('Текст «О премии» обновлён.')], [[B.cb('К настройкам', 'a:st')]]);
    }
    case 'banner_bot':
    case 'banner_site': {
      const kind = st.state === 'banner_site' ? 'site' : 'bot';
      const photo = pickPhoto(msg.photo, kind);
      if (!photo) return again('Нужно именно фото. Пришлите картинку как обычное фото (со сжатием), не файлом.');
      let data = '';
      if (kind === 'site') {
        try { data = toBase64(await api.getFileContent(photo.file_id)); }
        catch (e) { console.error('banner download', errText(e)); return again('Не получилось скачать фото. Пришлите его ещё раз.'); }
        if (!data) return again('Фото пришло пустым. Пришлите его ещё раз.');
      }
      // для бота храним file_id самого большого размера, для сайта — выбранного (он же идёт в превью)
      const file = kind === 'site' ? photo.file_id : pickPhoto(msg.photo, 'bot').file_id;
      await S.setBanner(kind, 'custom', file, data);
      await S.clearState(c.userId);
      return bannerView({ ...asHome(), msgId: null }, kind);
    }
    case 'app_url': {
      let u = text.trim();
      if (!/^https:\/\/[^\s]+$/i.test(u)) return again('Нужен адрес вида https://app123.tgcloud.ai/');
      if (!u.endsWith('/')) u += '/';
      await S.setSetting('app_url', u);
      return done([D.p(`URL мини-аппа сохранён: ${esc(u)}`)], [[B.cb('К настройкам', 'a:st')]]);
    }
    default:
      await S.clearState(c.userId);
      return null;
  }
}
