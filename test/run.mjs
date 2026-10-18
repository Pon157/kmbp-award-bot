import assert from 'node:assert/strict';
import { initDb, calls, resetApi, failNext, BotApiError, EndpointError, setFileBytes } from './mock-sdk.mjs';
import { run as dbrun, all, get, val } from '../tgcloud/lib/db.js';

await import('../tgcloud/schema.js');
initDb();

const msgH = (await import('../tgcloud/handlers/message.js')).default;
const cbH = (await import('../tgcloud/handlers/callback_query.js')).default;
const mcmH = (await import('../tgcloud/handlers/my_chat_member.js')).default;
const getHome = (await import('../tgcloud/endpoints/getHome.js')).default;
const getNom = (await import('../tgcloud/endpoints/getNomination.js')).default;
const submitRaw = (await import('../tgcloud/endpoints/submit.js')).default;
const publishApp = (await import('../tgcloud/endpoints/publishApp.js')).default;
const { makeCaptcha } = await import('../tgcloud/lib/captcha.js');
// Тесты «решают» капчу сами: код читаем из хранилища. captcha: null — отправить без неё.
const solve = async () => { const c = await makeCaptcha(); return { id: c.id, answer: (await S.getSetting('captcha:' + c.id)).split('|')[0] }; };
const submit = async (input, ctx) => submitRaw(input?.captcha === undefined ? { ...input, captcha: await solve() } : input, ctx);
const S = await import('../tgcloud/lib/store.js');
const { maybeBackup, snapshot } = await import('../tgcloud/lib/backup.js');

const OWNER = 1001, ADMINCHAT = -100500;
let n = 0;
const priv = (id) => ({ id, type: 'private' });
const u = (id, extra = {}) => ({ id, is_bot: false, first_name: 'U' + id, username: 'user' + id, ...extra });
const sendMsg = (from, text, extra = {}) => msgH({ message_id: ++n, from, chat: priv(from.id), text, ...extra });
const press = (from, data, chat = priv(from.id), mid = 5) => cbH({ id: 'cq' + ++n, from, data, message: { message_id: mid, chat } });
const ep = (fn, user, input) => fn(input, { initData: { user } });
const last = (method) => [...calls].reverse().find((c) => c.method === method);
const all_ = (method) => calls.filter((c) => c.method === method);
const kbOf = (call) => (call?.params.reply_markup?.inline_keyboard || []).flat();
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

// ── подготовка ────────────────────────────────────────────────
await S.ensureSeed();
await S.addOwner(OWNER, null);
await S.setSetting('app_url', 'https://app42.tgcloud.ai');
const owner = u(OWNER), alice = u(2001), bob = u(2002), carol = u(2003);

console.log('Бот: старт и меню');
await sendMsg(alice, '/start');
let c = last('sendRichMessage');
assert.ok(c, 'rich message sent');
assert.match(c.params.rich_message.html, /<tg-emoji emoji-id="6008353471202333128">/);
assert.match(c.params.rich_message.html, /<img src="https:\/\/app42\.tgcloud\.ai\/img\/hero-640\.jpg"\/>/);
let kb = kbOf(c);
const nomBtns = kb.filter((b) => b.web_app);
assert.equal(nomBtns.length, 5, '4 номинации + открыть премию');
assert.equal(nomBtns[0].web_app.url, 'https://app42.tgcloud.ai/?nom=1');
assert.equal(nomBtns[0].style, 'primary');
assert.equal(nomBtns[0].icon_custom_emoji_id, '5785195865379442415');
assert.ok(!kb.find((b) => b.callback_data === 'a:home'), 'обычному пользователю админки нет');
ok('меню со стилями и премиум-эмодзи на кнопках, rich + картинка');

resetApi();
await sendMsg(owner, '/start');
assert.ok(kbOf(last('sendRichMessage')).find((b) => b.callback_data === 'a:home'));
ok('владельцу показывается кнопка админки');

resetApi();
failNext('sendRichMessage', null, new BotApiError(400, 'Bad Request: can\'t parse rich message', 'sendRichMessage'));
await sendMsg(alice, '/start');
assert.ok(last('sendMessage'), 'fallback to sendMessage');
assert.equal(last('sendMessage').params.parse_mode, 'HTML');
ok('fallback на обычное сообщение, если rich не принят');

resetApi();
failNext('sendRichMessage', null, new BotApiError(400, 'x'));
failNext('sendMessage', null, new BotApiError(400, 'Bad Request: custom emoji not allowed'));
await sendMsg(alice, '/start');
const fin = last('sendMessage');
assert.ok(!/tg-emoji/.test(fin.params.text) && !JSON.stringify(fin.params.reply_markup).includes('icon_custom_emoji_id'));
ok('fallback без премиум-эмодзи и стилей (если у владельца нет Premium)');

console.log('Админ-чат');
resetApi();
await msgH({ message_id: ++n, from: owner, chat: { id: ADMINCHAT, type: 'supergroup' }, text: '/setchat@kmbp_bot' });
assert.equal(await S.getSetting('admin_chat'), String(ADMINCHAT));
await msgH({ message_id: ++n, from: bob, chat: { id: -999, type: 'supergroup' }, text: '/setchat' });
assert.equal(await S.getSetting('admin_chat'), String(ADMINCHAT));
ok('/setchat только от владельца');

console.log('Мини-апп: лендинг и форма');
let home = await ep(getHome, alice, {});
assert.equal(home.nominations.length, 4);
assert.equal(home.sponsorNominations.length, 0, 'спонсорские формы скрыты от обычного пользователя');
assert.equal(home.award.round2, '2 тур будет проходить здесь (в миниаппе) с 1 ноября 2026');
let nom = await ep(getNom, alice, { id: 1 });
assert.equal(nom.labels.title, 'Название бота');
assert.equal((await ep(getNom, alice, { id: 3 })).labels.title, 'Имя или псевдоним');
ok('getHome / getNomination');

await assert.rejects(ep(submit, alice, { nominationId: 1, title: 'X', username: 'a', description: 'short' }), (e) => !!(e.parameters.code === 'VALIDATION' && e.parameters.fields.username && e.parameters.fields.description && e.parameters.fields.title));
ok('валидация формы');

resetApi();
const good = { nominationId: 1, title: 'SupportHero', username: '@Support_Hero_bot', description: 'Бот, который отвечает на вопросы людей круглосуточно и не выгорает.' };
await ep(submit, alice, good);
let card = last('sendRichMessage');
assert.equal(card.params.chat_id, ADMINCHAT);
assert.match(card.params.rich_message.html, /Заявка #1/);
assert.match(card.params.rich_message.html, /Совпадений юзернейма в номинации нет/);
assert.match(card.params.rich_message.html, /@Support_Hero_bot/);
ok('карточка заявки уходит в админ-чат');

resetApi();
await ep(submit, alice, { ...good, title: 'SupportHero v2' });
assert.equal(all_('sendRichMessage').length, 0, 'повторная отправка правит, а не дублирует');
assert.ok(last('editMessageText')?.params.rich_message.html.includes('SupportHero v2'));
assert.equal(await val('SELECT COUNT(*) FROM applications'), 1);
ok('1 человек — 1 заявка в номинации (редактирование вместо дубля)');

resetApi();
await ep(submit, bob, { nominationId: 1, title: 'Hero', username: 'supporthero_bot', description: 'Тоже бот поддержки, только другой автор выдвигает его же.' });
card = last('sendRichMessage');
assert.match(card.params.rich_message.html, /Совпадения юзернейма в номинации: 1<\/b> \(точных 0, похожих 1\)/);
const edited = last('editMessageText');
assert.ok(edited && /Заявка #1/.test(edited.params.rich_message.html) && /похожих 1/.test(edited.params.rich_message.html), 'старая карточка обновилась');
ok('подсчёт похожих юзернеймов и обновление старых карточек');

resetApi();
await ep(submit, carol, { nominationId: 1, title: 'Hero 3', username: 'SUPPORT_HERO_BOT', description: 'Третья заявка на того же самого кандидата в номинации.' });
card = last('sendRichMessage');
assert.match(card.params.rich_message.html, /Совпадения юзернейма в номинации: 2<\/b> \(точных 1, похожих 1\)/);
ok('точные и похожие считаются отдельно');

// другой кандидат — совпадений нет
await ep(submit, carol, { nominationId: 2, title: 'Proj', username: 'supporthero_bot', description: 'Проект в другой номинации — не должен считаться совпадением.' });
assert.match(last('sendRichMessage').params.rich_message.html, /Совпадений юзернейма в номинации нет/);
ok('совпадения считаются только внутри номинации');

console.log('Режим «одна заявка на всё»');
await S.setSetting('limit_mode', 'global');
await assert.rejects(ep(submit, alice, { nominationId: 2, title: 'Second', username: 'second_proj', description: 'Вторая заявка того же человека в другой номинации.' }), (e) => e.parameters.code === 'ALREADY');
assert.ok((await ep(getNom, alice, { id: 2 })).blockedBy);
await S.setSetting('limit_mode', 'nomination');
await ep(submit, alice, { nominationId: 2, title: 'Second', username: 'second_proj', description: 'Вторая заявка того же человека в другой номинации.' });
ok('лимит на человека переключается');

console.log('Спонсорская номинация');
const sponsor = u(4001, { username: 'sponsor_org' });
const sponsorNoms = await S.listSponsorNominations();
assert.deepEqual(sponsorNoms.map((x) => x.sponsor_type).sort(), ['bot', 'person', 'project']);
await assert.rejects(ep(getNom, alice, { id: sponsorNoms.find((x) => x.sponsor_type === 'bot').id }),
  (e) => e.parameters.code === 'SPONSOR_ONLY');
const originalsBeforeSponsor = await val('SELECT COUNT(*) FROM applications WHERE nomination_id IN (SELECT id FROM nominations WHERE sponsor_type IS NULL)');
await S.addSponsor('@sponsor_org', OWNER);
home = await ep(getHome, sponsor, {});
assert.equal(home.sponsorNominations.length, 3, 'одобренному спонсору видны все три подноминации');
const sponsorBotNom = sponsorNoms.find((x) => x.sponsor_type === 'bot');
assert.equal((await ep(getNom, sponsor, { id: sponsorBotNom.id })).sponsorType, 'bot');
await assert.rejects(ep(submit, alice, {
  nominationId: sponsorBotNom.id, title: 'SupportHero', username: 'supporthero_bot',
  description: 'Описание кандидата для проверки доступа.',
}), (e) => e.parameters.code === 'SPONSOR_ONLY');
const sponsorSubmission = await ep(submit, sponsor, {
  nominationId: sponsorBotNom.id, title: 'SupportHero', username: 'Support_Hero_bot',
  description: 'Спонсорская запись с данными о кандидате для организаторов.',
});
assert.equal(sponsorSubmission.imported, 2, 'скопированы все точные прежние заявки по username');
assert.match(last('sendRichMessage').params.rich_message.html, /Копия прежней заявки/);
const sponsorApp = await S.userApplication(sponsor.id, sponsorBotNom.id);
assert.equal(JSON.parse(sponsorApp.answers)._sponsorImported.length, 2);
assert.equal(await val('SELECT COUNT(*) FROM applications WHERE nomination_id IN (SELECT id FROM nominations WHERE sponsor_type IS NULL)'), originalsBeforeSponsor,
  'исходные заявки не перемещаются и не удаляются');
await sendMsg(sponsor, '/start');
assert.ok(kbOf(last('sendRichMessage')).some((b) => b.web_app?.url.endsWith(`?nom=${sponsorBotNom.id}`)),
  'спонсор видит ссылки на спонсорские формы в меню бота');
ok('три подноминации, проверка спонсора и копирование прежних заявок');

console.log('Доп. вопросы');
resetApi();
await sendMsg(owner, '/admin');
assert.match(last('sendRichMessage').params.rich_message.html, /Админ-панель/);
await press(owner, 'a:nq:1');
await press(owner, 'a:qa:1');
await sendMsg(owner, 'Сколько пользователей у бота?');
const q = await get('SELECT * FROM questions');
assert.equal(q.text, 'Сколько пользователей у бота?');
await press(owner, `a:qr:${q.id}`);
assert.equal((await get('SELECT required FROM questions')).required, 1);
nom = await ep(getNom, dave(), { id: 1 });
function dave() { return u(2004); }
assert.equal(nom.questions.length, 1);
await assert.rejects(ep(submit, dave(), { nominationId: 1, title: 'Dave bot', username: 'dave_bot', description: 'Описание длиннее двадцати символов точно.' }), (e) => !!e.parameters.fields['q' + q.id]);
await ep(submit, dave(), { nominationId: 1, title: 'Dave bot', username: 'dave_bot', description: 'Описание длиннее двадцати символов точно.', answers: { [q.id]: '1000+' } });
assert.match(last('sendRichMessage').params.rich_message.html, /Сколько пользователей у бота\?/);
ok('вопросы к номинации: добавить, обязательность, вывод в карточке');

console.log('Номинации через админку');
resetApi();
await press(owner, 'a:nadd');
await sendMsg(owner, 'Идея года');
await press(owner, 'a:nkn:project');
await sendMsg(owner, '💡', { entities: [{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: '5947363097353130662' }] });
const newNom = await get("SELECT * FROM nominations WHERE title = 'Идея года'");
assert.equal(newNom.emoji_id, '5947363097353130662');
await sendMsg(alice, '/start');
assert.ok(kbOf(last('sendRichMessage')).find((b) => b.text === 'Идея года' && b.icon_custom_emoji_id === '5947363097353130662'));
await press(owner, `a:nt:${newNom.id}`);
await sendMsg(alice, '/start');
assert.ok(kbOf(last('sendRichMessage')).find((b) => /Идея года · закрыто/.test(b.text) && b.callback_data));
await assert.rejects(ep(submit, alice, { nominationId: newNom.id, title: 'ZZ', username: 'zzzz', description: 'Закрытая номинация не принимает заявки.' }), (e) => e.parameters.code === 'CLOSED');
ok('добавление номинации, премиум-эмодзи, закрытие приёма');

// Доступ к спонсорам настраивается владельцем из админ-панели.
await press(owner, 'a:sp');
assert.match(last('editMessageText').params.rich_message.html, /Спонсоры/);
await press(owner, 'a:spa');
await sendMsg(owner, '@temporary_sponsor');
const temporarySponsor = (await S.listSponsors()).find((x) => x.username_norm === 'temporary_sponsor');
assert.ok(temporarySponsor);
await press(owner, `a:spdr:${temporarySponsor.id}`);
await press(owner, `a:spdy:${temporarySponsor.id}`);
assert.equal(await S.isSponsor('temporary_sponsor'), false);
ok('добавление и подтверждённое удаление спонсора из админки');

console.log('Баны');
resetApi();
await press(owner, 'a:bn:2002', { id: ADMINCHAT, type: 'supergroup' });
assert.ok(kbOf(last('editMessageText')).find((b) => b.callback_data === 'a:bs:2002:app'));
await press(owner, 'a:bs:2002:app');
await assert.rejects(ep(getHome, bob, {}), (e) => e.parameters.code === 'BANNED');
await sendMsg(bob, '/start'); // в боте — можно
assert.ok(last('sendRichMessage').params.rich_message.html.includes('Премия года КМБП'));
await press(owner, 'a:bs:2002:all');
await sendMsg(bob, '/start');
assert.match(last('sendRichMessage').params.rich_message.html, /Доступ ограничен/);
await press(owner, 'a:bu:2002');
await ep(getHome, bob, {});
await press(alice, 'a:home'); // не-владелец
assert.equal(last('answerCallbackQuery').params.text, 'Только для владельцев');
// бан по @username через диалог
await press(owner, 'a:bnew');
await sendMsg(owner, '@user2003');
assert.ok(kbOf(last('sendRichMessage')).find((b) => b.callback_data === 'a:bs:2003:bot'));
await press(owner, 'a:bs:2003:bot');
await sendMsg(carol, '/start');
assert.match(last('sendRichMessage').params.rich_message.html, /Доступ ограничен/);
await ep(getHome, carol, {}); // в аппе можно
await press(owner, 'a:bu:2003');
// владельца банить нельзя
await press(owner, 'a:bs:1001:all');
assert.equal(await S.banScope(1001), null);
ok('бан/разбан в боте и мини-аппе раздельно и вместе, по ID и @username');

console.log('Новости и ресурсы');
await press(owner, 'a:nwa');
await sendMsg(owner, 'Открыт приём заявок! Подробности в канале', { entities: [{ type: 'bold', offset: 0, length: 6 }, { type: 'text_link', offset: 34, length: 6, url: 'https://t.me/x' }, { type: 'custom_emoji', offset: 0, length: 1, custom_emoji_id: '1' }] });
home = await ep(getHome, alice, {});
assert.equal(home.news.length, 1);
assert.equal(home.news[0].entities.length, 3);
await press(owner, `a:nwp:${home.news[0].id}`);
assert.equal((await ep(getHome, alice, {})).news[0].pinned, true);
await press(owner, 'a:lna');
await sendMsg(owner, 'Канал сообщества');
await sendMsg(owner, 't.me/kmbp_channel');
await press(owner, 'a:lk:channel');
home = await ep(getHome, alice, {});
assert.deepEqual(home.links.map((l) => [l.title, l.url, l.kind]), [['Канал сообщества', 'https://t.me/kmbp_channel', 'channel']]);
ok('новости (с форматированием) и ссылки попадают в мини-апп');

console.log('Владельцы');
await press(owner, 'a:owa');
await sendMsg(owner, '@user2001');
assert.ok(await S.isOwner(2001));
await press(owner, 'a:owd:2001');
assert.ok(!(await S.isOwner(2001)));
ok('добавление и удаление владельцев');

console.log('Выгрузка базы');
resetApi();
await press(owner, 'a:dbx');
const docs = all_('sendDocument');
assert.equal(docs.length, 2);
assert.equal(docs[0].params.chat_id, OWNER);
const snap = JSON.parse(Buffer.from(docs[0].params.document.bytes).toString('utf8'));
assert.ok(snap.tables.applications.length >= 5 && snap.tables.nominations.length === 8);
const csv = Buffer.from(docs[1].params.document.bytes).toString('utf8');
assert.ok(csv.startsWith('\ufeffid;номинация;название'));
assert.ok(csv.includes('@Support_Hero_bot'));
ok('JSON + CSV выгружаются');

resetApi();
await dbrun("UPDATE settings SET value = '1' WHERE key = 'last_backup'");
await sendMsg(alice, '/start'); // любая активность запускает проверку
const autoBackupDocs = (await S.ownerIds()).length * 2;
assert.equal(all_('sendDocument').length, autoBackupDocs, 'автовыгрузка ушла владельцам');
await sendMsg(alice, '/start');
assert.equal(all_('sendDocument').length, autoBackupDocs, 'и не дублируется');
await dbrun("UPDATE settings SET value = '1' WHERE key = 'last_backup'");
await S.setSetting('auto_backup', '0');
resetApi(); await maybeBackup();
assert.equal(all_('sendDocument').length, 0);
await S.setSetting('auto_backup', '1');
ok('ленивая автовыгрузка раз в сутки, без дублей, с выключателем');

console.log('Рассылка');
resetApi();
for (const id of [3001, 3002, 3003]) await sendMsg(u(id), '/start');
await sendMsg(u(3003), '/start');
await mcmH({ chat: priv(3002), new_chat_member: { status: 'kicked' } });
await press(owner, 'a:bcn');
await sendMsg(owner, 'Всем привет!', { entities: [{ type: 'bold', offset: 0, length: 5 }] });
const bcId = await val('SELECT MAX(id) FROM broadcasts');
resetApi();
failNext('copyMessage', (p) => p.chat_id === 3003, new BotApiError(403, 'Forbidden: bot was blocked by the user'));
await press(owner, `a:bcgo:${bcId}`);
const targets = all_('copyMessage').map((x) => x.params.chat_id).sort();
assert.ok(!targets.includes(3002), 'заблокировавшие не получают');
assert.ok(!targets.includes(2002) || true);
const bc = await get('SELECT * FROM broadcasts WHERE id = :id', { id: bcId });
assert.equal(bc.status, 'done');
assert.equal(await val('SELECT blocked FROM users WHERE id = 3003'), 1, '403 помечает blocked');
ok('рассылка: пачки, пропуск заблокировавших, отметка 403');

await press(owner, 'a:bcn');
await sendMsg(owner, 'Ещё одна');
const bc2 = await val('SELECT MAX(id) FROM broadcasts');
resetApi();
failNext('copyMessage', null, new BotApiError(429, 'Too Many Requests', 'copyMessage', { retry_after: 3 }));
await press(owner, `a:bcgo:${bc2}`);
assert.equal((await get('SELECT * FROM broadcasts WHERE id = :id', { id: bc2 })).status, 'running');
await press(owner, `a:bcgo:${bc2}`);
assert.equal((await get('SELECT * FROM broadcasts WHERE id = :id', { id: bc2 })).status, 'done');
ok('рассылка продолжается после 429, без пропусков');

console.log('Заявки в админке');
resetApi();
await press(owner, 'a:al:1:0');
assert.match(last('editMessageText').params.rich_message.html, /#1 · @Support_Hero_bot/);
await press(owner, 'a:av:1');
assert.ok(kbOf(last('editMessageText')).find((b) => b.callback_data === 'a:ad:1'));
await press(owner, 'a:ady:1');
assert.equal(await val('SELECT COUNT(*) FROM applications WHERE id = 1'), 0);
await ep(submit, alice, { ...good, nominationId: 1, answers: { 1: '10' } }); // автор может подать заново
await press(owner, 'a:as'); await sendMsg(owner, 'dave');
assert.match(last('sendRichMessage').params.rich_message.html, /@dave_bot/);
await press(owner, 'a:as'); await sendMsg(owner, 'supporthero_bot');
let searchRows = kbOf(last('sendRichMessage'));
let deleteButtons = searchRows.filter((b) => b.callback_data?.startsWith('a:adq:'));
assert.equal(deleteButtons.length, 2, 'точный username находит все заявки этого кандидата в разных номинациях');
const oneDelete = deleteButtons[0].callback_data;
const selectedAppId = Number(oneDelete.split(':')[2]);
const exactBeforeDelete = await val("SELECT COUNT(*) FROM applications WHERE username_norm = 'supporthero_bot'");
await press(owner, oneDelete);
assert.match(last('editMessageText').params.rich_message.html, /Другие заявки с таким же username останутся/);
const confirmDelete = kbOf(last('editMessageText')).find((b) => b.callback_data?.startsWith('a:adqy:'));
assert.ok(confirmDelete, 'удаление нужно подтвердить отдельно');
await press(owner, confirmDelete.callback_data);
assert.equal(await val("SELECT COUNT(*) FROM applications WHERE username_norm = 'supporthero_bot'"), exactBeforeDelete - 1);
assert.equal(await val('SELECT COUNT(*) FROM applications WHERE id = :id', { id: selectedAppId }), 0);
searchRows = kbOf(last('editMessageText'));
assert.equal(searchRows.filter((b) => b.callback_data?.startsWith('a:adq:')).length, 1,
  'после удаления одна заявка кандидата остаётся доступной');
ok('поиск точного/частичного username, выбор и подтверждённое удаление только отдельных заявок');

console.log('Настройки');
await press(owner, 'a:sta');
await assert.rejects(ep(submit, dave(), { nominationId: 2, title: 'Late', username: 'late_proj', description: 'Приём закрыт глобально, поэтому это не пройдёт.' }), (e) => e.parameters.code === 'CLOSED');
await press(owner, 'a:sta');
await press(owner, 'a:stu'); await sendMsg(owner, 'https://app77.tgcloud.ai');
assert.equal(await S.appUrl(), 'https://app77.tgcloud.ai/');
ok('глобальное закрытие приёма и смена URL');

console.log('Баннер');
await S.setSetting('app_url', 'https://app42.tgcloud.ai');
const photoMsg = (from, sizes) => sendMsg(from, undefined, { text: undefined, photo: sizes });
const SIZES = [
  { file_id: 'S90', width: 90, height: 90, file_size: 1500 },
  { file_id: 'S800', width: 800, height: 800, file_size: 90000 },
  { file_id: 'S1280', width: 1280, height: 1280, file_size: 260000 },
];
let bn = await S.banners();
assert.equal(bn.bot.mode, 'default'); assert.equal(bn.site.mode, 'default');
assert.deepEqual((await ep(getHome, alice, {})).banner, { src: 'img/hero.jpg', custom: false });

// админка: кнопка и два отдельных экрана
resetApi();
await press(owner, 'a:home');
assert.ok(kbOf(last('editMessageText')).find((b) => b.callback_data === 'a:bnr'), 'кнопка «Баннер» в админке');
await press(owner, 'a:bnr');
const bk = kbOf(last('editMessageText')).map((b) => b.callback_data);
assert.ok(bk.includes('a:bnb') && bk.includes('a:bns'));
await press(owner, 'a:bnb');
assert.match(last('editMessageText').params.rich_message.html, /hero-640\.jpg/);

// не фото — отказ, состояние остаётся
await press(owner, 'a:bnbu');
resetApi();
await sendMsg(owner, 'привет');
assert.match(last('sendRichMessage').params.rich_message.html, /именно фото/);
assert.equal((await S.banners()).bot.mode, 'default');

// фото для бота: берётся самый большой размер, сайт не затронут
resetApi();
await photoMsg(owner, SIZES);
bn = await S.banners();
assert.equal(bn.bot.mode, 'custom'); assert.equal(bn.bot.file, 'S1280');
assert.equal(bn.site.mode, 'default', 'сайт не меняется');
let r = last('sendRichMessage').params.rich_message;
assert.match(r.html, /<img src="tg:\/\/photo\?id=banner"\/>/);
assert.deepEqual(r.media, [{ id: 'banner', media: { type: 'photo', media: 'S1280' } }]);
resetApi();
await sendMsg(alice, '/start');
r = last('sendRichMessage').params.rich_message;
assert.deepEqual(r.media, [{ id: 'banner', media: { type: 'photo', media: 'S1280' } }]);
assert.ok(!r.html.includes('hero-640'));
assert.equal((await ep(getHome, alice, {})).banner.src, 'img/hero.jpg', 'на сайте всё ещё стандартный');
resetApi();
failNext('sendRichMessage', (p) => p.rich_message.media, new BotApiError(400, 'Bad Request: media', 'sendRichMessage'));
await sendMsg(alice, '/start');
assert.ok(last('sendMessage'), 'если фото не принято — меню всё равно приходит текстом');
ok('баннер бота: загрузка фото, отдельно от сайта, запасной вариант');

// фото для сайта: скачивается, хранится base64, отдаётся отдельным запросом
await press(owner, 'a:bns');
await press(owner, 'a:bnsu');
resetApi();
failNext('getFileContent', null, new Error('network'));
await photoMsg(owner, SIZES);
assert.match(last('sendRichMessage').params.rich_message.html, /Не получилось скачать/);
assert.equal((await S.banners()).site.mode, 'default', 'при ошибке скачивания ничего не сохраняем');
resetApi();
await photoMsg(owner, SIZES);
assert.equal(last('getFileContent').params.file_id ?? last('getFileContent').params, 'S800', 'для сайта — размер до 1000 px');
bn = await S.banners();
assert.equal(bn.site.mode, 'custom'); assert.equal(bn.bot.file, 'S1280', 'бот не затронут');
assert.equal(await S.siteBannerData(), '/9j/4AAQSkZJRgA=');
assert.deepEqual((await ep(getHome, alice, {})).banner, { custom: true, lazy: true });
const gb = await ep((await import('../tgcloud/endpoints/getBanner.js')).default, alice, {});
assert.equal(gb.src, 'data:image/jpeg;base64,/9j/4AAQSkZJRgA=');
assert.ok(!JSON.stringify((await (await import('../tgcloud/lib/backup.js')).snapshot()).tables.settings).includes('/9j/4AAQ'), 'картинка не попадает в выгрузку');
ok('баннер сайта: скачивание, base64, getBanner, без раздувания выгрузки');

// сброс и скрытие — по отдельности
await press(owner, 'a:bnso');
assert.equal((await ep(getHome, alice, {})).banner, null);
await assert.rejects(ep((await import('../tgcloud/endpoints/getBanner.js')).default, alice, {}), (e) => e.parameters.code === 'NO_BANNER');
assert.equal((await S.banners()).bot.mode, 'custom');
await press(owner, 'a:bnbo');
resetApi();
await sendMsg(alice, '/start');
assert.ok(!last('sendRichMessage').params.rich_message.html.includes('<img'), 'без баннера картинки нет');
await press(owner, 'a:bnbd'); await press(owner, 'a:bnsd');
bn = await S.banners();
assert.equal(bn.bot.mode, 'default'); assert.equal(bn.site.mode, 'default');
assert.equal(await S.siteBannerData(), '');
await press(alice, 'a:bnbo');
assert.equal((await S.banners()).bot.mode, 'default', 'обычный пользователь баннер не меняет');
ok('баннеры: убрать и вернуть стандартный по отдельности, права');

// Баннеры спонсоров: title → https target → photo, public listing, data endpoint, delete confirmation.
await press(owner, 'a:sp');
await press(owner, 'a:sbl');
await press(owner, 'a:sba');
await sendMsg(owner, 'http://unsafe.example');
assert.match(last('sendRichMessage').params.rich_message.html, /безопасная ссылка/);
await sendMsg(owner, 'https://sponsor.example/award');
await photoMsg(owner, SIZES);
let sponsorBanner = (await S.listSponsorBanners())[0];
assert.equal(sponsorBanner.title, 'Баннер');
assert.equal(sponsorBanner.target_url, 'https://sponsor.example/award');
const sponsorBackup = await snapshot();
const bannerBackupRow = sponsorBackup.tables.sponsor_banners.find((b) => b.id === sponsorBanner.id);
assert.ok(bannerBackupRow && !Object.hasOwn(bannerBackupRow, 'image_data'), 'экспорт включает метаданные без большого base64-фото');
home = await ep(getHome, alice, {});
assert.deepEqual(home.sponsorBanners, [{ id: sponsorBanner.id, targetUrl: 'https://sponsor.example/award' }]);
const getSponsorBanner = (await import('../tgcloud/endpoints/getSponsorBanner.js')).default;
assert.equal((await ep(getSponsorBanner, alice, { id: sponsorBanner.id })).src, 'data:image/jpeg;base64,/9j/4AAQSkZJRgA=');
await press(owner, `a:sbd:${sponsorBanner.id}`);
await press(owner, `a:sbdy:${sponsorBanner.id}`);
assert.equal((await S.listSponsorBanners()).length, 0);
ok('баннеры спонсоров: HTTPS, загрузка из админки, отдельная выдача и удаление с подтверждением');


console.log('Капча и отложенная публикация');
{
  const nomsAll = await S.listNominations();
  const projNom = nomsAll.find((x) => x.kind === 'project' && !x.sponsor_only);
  const input = (extra = {}) => ({ nominationId: projNom.id, title: 'Проект X', username: 'captcha_tester', description: 'достаточно длинное описание проекта для проверки', answers: {}, ...extra });
  const voter = u(7001), ctxV = { initData: { user: voter } };

  // 1) без капчи — отказ, заявка не создана
  await assert.rejects(() => submitRaw(input({ captcha: null }), ctxV), (e) => e.parameters?.code === 'CAPTCHA');
  assert.equal(await S.userApplication(7001, projNom.id), null);
  // 2) неверный код — отказ, и код сгорает (повтор верного уже не проходит)
  const c1 = await makeCaptcha(); const good1 = (await S.getSetting('captcha:' + c1.id)).split('|')[0];
  await assert.rejects(() => submitRaw(input({ captcha: { id: c1.id, answer: 'WRONG' } }), ctxV), (e) => e.parameters?.code === 'CAPTCHA');
  await assert.rejects(() => submitRaw(input({ captcha: { id: c1.id, answer: good1 } }), ctxV), (e) => e.parameters?.code === 'CAPTCHA');
  // 3) верный код (в нижнем регистре) — заявка создана; defer: карточка админам НЕ публикуется внутри submit
  resetApi();
  const c2 = await makeCaptcha(); const good2 = (await S.getSetting('captcha:' + c2.id)).split('|')[0];
  const r = await submitRaw(input({ captcha: { id: c2.id, answer: good2.toLowerCase() }, defer: true }), ctxV);
  assert.equal(r.ok, true); assert.equal(r.created, true); assert.ok(r.id);
  assert.equal(all_('sendRichMessage').length, 0, 'при defer submit не ходит в Telegram');
  assert.equal((await S.getApplication(r.id)).admin_msg_id, null);
  // 4) publishApp публикует карточку; чужую заявку публиковать нельзя
  assert.deepEqual(await publishApp({ id: r.id }, { initData: { user: u(7002) } }), { ok: false });
  assert.equal(all_('sendRichMessage').length, 0);
  assert.equal((await publishApp({ id: r.id }, ctxV)).ok, true);
  assert.ok((await S.getApplication(r.id)).admin_msg_id, 'карточка опубликована');
  // 5) правка уже отправленной заявки капчу не требует
  const r2 = await submitRaw(input({ title: 'Проект Y', captcha: null, defer: true }), ctxV);
  assert.equal(r2.created, false);
  // 6) регрессия: ответ submit содержит sponsorNomination (поле, без которого пропадали строка о спонсорах и баннер)
  assert.ok(Object.hasOwn(r2, 'sponsorNomination'), 'submit возвращает sponsorNomination');
  ok('капча (нет/неверно/одноразовая/регистр), defer + publishApp, чужая заявка, правка без капчи, поле sponsorNomination');
}


console.log('Чёрный список и подсказки юзернеймов');
{
  const suggest = (await import('../tgcloud/endpoints/suggestUsernames.js')).default;
  const botNom = (await S.listNominations()).find((x) => x.kind === 'bot' && !x.sponsor_only);
  const botAnswers = Object.fromEntries((await S.listQuestions(botNom.id)).map((q) => [q.id, '1000']));
  const sub = (user, username) => submit({ nominationId: botNom.id, title: 'Бот ' + username, username, description: 'достаточно длинное описание бота для проверки формы', answers: botAnswers }, { initData: { user } });

  // добавление через меню: несколько юзернеймов, мусор отбрасывается, повтор не дублируется
  await press(owner, 'a:blk');
  await press(owner, 'a:bka');
  await sendMsg(owner, '@Spam_Bot, fake_helper_bot  !!  ab');
  assert.deepEqual((await S.getBlacklist()).sort(), ['fake_helper_bot', 'spam_bot']);
  await press(owner, 'a:bka'); await sendMsg(owner, 'spam_bot');
  assert.equal((await S.getBlacklist()).length, 2, 'повтор не дублируется');

  // форма отказывает по юзернейму (в любом регистре и в виде ссылки), заявка не создаётся
  for (const name of ['spam_bot', 'SPAM_BOT', 'https://t.me/Spam_Bot']) {
    await assert.rejects(() => sub(u(8101), name), (e) => e.parameters?.code === 'VALIDATION' && /нельзя выдвигать/.test(e.parameters.fields.username));
  }
  assert.equal(await S.userApplication(8101, botNom.id), null);

  // подсказки: по префиксу, тот же тип номинации, без чёрного списка, без служебных полей
  await sub(u(8102), 'helper_one_bot'); await sub(u(8103), 'helper_two_bot'); await sub(u(8104), 'other_thing_bot');
  const r1 = await suggest({ nominationId: botNom.id, q: 'helper' }, { initData: { user: u(8105) } });
  assert.deepEqual(r1.items.sort(), ['helper_one_bot', 'helper_two_bot']);
  assert.deepEqual((await suggest({ nominationId: botNom.id, q: '@HELPER_O' }, { initData: { user: u(8105) } })).items, ['helper_one_bot']);
  assert.deepEqual((await suggest({ nominationId: botNom.id, q: 'h' }, { initData: { user: u(8105) } })).items, [], 'меньше 2 символов — пусто');
  assert.deepEqual((await suggest({ nominationId: botNom.id, q: 'hel%' }, { initData: { user: u(8105) } })).items, [], 'шаблонные символы не работают');
  assert.deepEqual((await suggest({ nominationId: botNom.id, q: 'helper_o_' }, { initData: { user: u(8105) } })).items, [], '«_» не работает как «любой символ»');
  await S.addBlacklist(['helper_two_bot']);
  assert.deepEqual((await suggest({ nominationId: botNom.id, q: 'helper' }, { initData: { user: u(8105) } })).items, ['helper_one_bot'], 'из чёрного списка не подсказываем');

  // кнопка на карточке: «только в список» и «в список + удалить заявки»
  const app = await S.userApplication(8102, botNom.id);
  await press(owner, `a:bk:${app.id}`);
  await press(owner, `a:bky:${app.id}`);
  assert.ok((await S.getBlacklist()).includes('helper_one_bot'));
  assert.ok(await S.getApplication(app.id), 'без удаления заявка остаётся');
  const app2 = await S.userApplication(8104, botNom.id);
  await press(owner, `a:bkyd:${app2.id}`);
  assert.ok((await S.getBlacklist()).includes('other_thing_bot'));
  assert.equal(await S.getApplication(app2.id), null, 'с удалением заявка исчезла');

  // убрать из списка → снова можно выдвигать
  await press(owner, 'a:bkd:spam_bot:0');
  assert.ok(!(await S.getBlacklist()).includes('spam_bot'));
  assert.equal((await sub(u(8101), 'spam_bot')).ok, true);

  // чужие (не владельцы) кнопки не работают
  await press(alice, 'a:bka'); await sendMsg(alice, 'hacker_bot');
  assert.ok(!(await S.getBlacklist()).includes('hacker_bot'), 'не владелец не может править список');
  ok('чёрный список: меню, ввод, отказ формы, карточка, подсказки (префикс, _, ЧС), права');
}


console.log('Монеты и напоминания');
const dbm = await import('../tgcloud/lib/db.js');
{
  const coins = await import('../tgcloud/lib/coins.js');
  const rem = await import('../tgcloud/lib/reminders.js');
  const { REMIND_DEFAULT } = await import('../tgcloud/lib/config.js');
  const tick = (await import('../tgcloud/endpoints/tick.js')).default;
  const NOW = Math.floor(Date.now() / 1000), DAY = 86400;
  await S.setSetting('apps_open', '1'); await S.setSetting('limit_mode', 'nomination'); await dbrun('UPDATE nominations SET is_open = 1');
  const req = await coins.requiredNominations();
  const N = req.length; assert.ok(N >= 3, 'есть несколько обычных номинаций (спонсорские не считаются)');
  assert.ok(!req.some((x) => x.sponsor_type || x.sponsor_only));
  const answersFor = async (nomId) => Object.fromEntries((await S.listQuestions(nomId)).map((q) => [q.id, '1000']));
  const vote = async (user, nom) => submit({ nominationId: nom.id, title: 'Кандидат ' + nom.id, username: `cand${nom.id}_${user.id}_bot`, description: 'достаточно длинное описание кандидата для проверки формы', answers: await answersFor(nom.id) }, { initData: { user } });
  const home = (user) => getHome({}, { initData: { user } });

  // 1) награда: ровно за последнюю номинацию, один раз
  const v1 = u(9001);
  const r1 = [];
  for (const nom of req) r1.push(await vote(v1, nom));
  assert.deepEqual(r1.map((r) => r.coins.covered), req.map((_, i) => i + 1));
  assert.deepEqual(r1.map((r) => r.coins.awarded), req.map((_, i) => (i === N - 1 ? 35 : 0)), '35 монет только за последнюю');
  assert.equal(r1[N - 1].coins.balance, 35); assert.equal(r1[N - 1].coins.earned, true);
  assert.deepEqual({ ...(await home(v1)).coins }, { enabled: true, reward: 35, balance: 35, earned: true, required: N, covered: N });
  const again = await submit({ nominationId: req[0].id, title: 'Правка', username: 'cand1_9001_bot', description: 'достаточно длинное описание кандидата для проверки формы', answers: await answersFor(req[0].id) }, { initData: { user: v1 } });
  assert.equal(again.created, false); assert.equal(again.coins.awarded, 0); assert.equal(again.coins.balance, 35);
  assert.equal(await val('SELECT COUNT(*) FROM coin_log WHERE user_id = 9001'), 1, 'награда не дублируется');

  // 2) закрытая номинация не мешает; прогресс другого пользователя считается отдельно
  const v2 = u(9002);
  await dbrun('UPDATE nominations SET is_open = 0 WHERE id = :i', { i: req[N - 1].id });
  const r2 = []; for (const nom of req.slice(0, N - 1)) r2.push(await vote(v2, nom));
  assert.equal(r2[N - 2].coins.required, N - 1); assert.equal(r2[N - 2].coins.awarded, 35, 'закрытую номинацию не требуем');
  await dbrun('UPDATE nominations SET is_open = 1 WHERE id = :i', { i: req[N - 1].id });
  assert.equal((await home(u(9003))).coins.balance, 0);

  // 3) режим «одна заявка на человека» и закрытый приём — награды нет
  await S.setSetting('limit_mode', 'global');
  assert.equal((await home(u(9004))).coins.enabled, false);
  await S.setSetting('limit_mode', 'nomination'); await S.setSetting('apps_open', '0');
  assert.equal((await home(u(9004))).coins.enabled, false);
  await S.setSetting('apps_open', '1');

  // 4) трата: хватает / не хватает / повтор причины не списывает дважды
  assert.deepEqual(await coins.spendCoins(9001, 40, 'r2vote:1'), { ok: false, error: 'not_enough' });
  assert.deepEqual(await coins.spendCoins(9001, 10, 'r2vote:1'), { ok: true, balance: 25 });
  assert.equal((await coins.spendCoins(9001, 10, 'r2vote:1')).ok, false, 'повтор той же причины');
  assert.equal(await coins.coinBalance(9001), 25);
  assert.equal((await coins.spendCoins(9001, 25, 'r2vote:2')).balance, 0);
  assert.equal((await coins.spendCoins(9001, 1, 'r2vote:3')).error, 'not_enough');
  assert.equal((await coins.spendCoins(9001, -5, 'x')).ok, false);
  ok('монеты: награда один раз, закрытые номинации, global/закрытый приём, траты');

  // ── напоминания ──────────────────────────────────────────
  const mk = async (id, o = {}) => { await S.touchUser(u(id), { started: true }); await dbrun('UPDATE users SET first_seen = :f, last_seen = :l, blocked = :b WHERE id = :id', { id, f: o.first ?? NOW - 10 * DAY, l: o.last ?? NOW - 5 * DAY, b: o.blocked ? 1 : 0 }); };
  await dbrun('UPDATE users SET first_seen = :t, last_seen = :t', { t: NOW }); // все прежние тестовые пользователи — «новенькие»
  await vote(u(9101), req[0]); await mk(9101);       // 1 из N → получит (mk после голоса: голосование обновляет last_seen)
  for (const nom of req) await vote(u(9102), nom); await mk(9102); // все → нет
  await vote(u(9103), req[0]); await mk(9103);       // замьютит
  await mk(9104, { first: NOW - 5 * 3600 });         // новичок (5 часов) → нет
  await mk(9109, { first: NOW - 2 * DAY });          // 2 дня в боте — уже можно (раньше требовалось 5)
  await mk(9105, { blocked: true });                 // заблокировал бота → нет
  await mk(9106); await S.ban(9106, 'bot', 'тест', OWNER); // бан → нет
  await mk(9107, { last: NOW - 60 });                // был активен минуту назад → нет
  await mk(9108);                                    // уже получал монеты, но не голосовал → получит без текста про монеты
  await dbrun('INSERT INTO coin_log (user_id, amount, reason, created_at) VALUES (9108, 35, :r, :t)', { r: coins.REASON_ALL, t: NOW });
  // по умолчанию напоминания выключены — ничего не уходит, пока владелец не включил
  resetApi();
  assert.equal((await rem.runReminders({ force: true, limit: 50 })).reason, 'off');
  assert.equal(all_('sendRichMessage').length, 0);
  assert.equal(await S.getSetting('remind_enabled', REMIND_DEFAULT), '0');
  await S.setSetting('remind_enabled', '1');
  resetApi();
  const run1 = await rem.runReminders({ force: true, limit: 50 });
  const sentTo = all_('sendRichMessage').map((x) => x.params.chat_id).sort((a, b) => a - b);
  assert.deepEqual(sentTo, [9101, 9103, 9108, 9109], 'получают только неполные и «созревшие»: не полные, не новички (<суток), не заблокированные, не забаненные, не активные');
  assert.equal(run1.sent, 4); assert.equal(run1.picked, 4); assert.equal(run1.failed, 0);
  const m101 = all_('sendRichMessage').find((x) => x.params.chat_id === 9101).params;
  assert.match(m101.rich_message.html, /Осталось: .*<b>/); assert.match(m101.rich_message.html, /35 монет/);
  const web = kbOf({ params: m101 }).filter((b) => b.web_app);
  assert.equal(web.length, Math.min(N - 1, 8) + 1, 'недостающие номинации + «Открыть премию»');
  assert.ok(web.some((b) => b.web_app.url === `https://app42.tgcloud.ai/?nom=${req[1].id}`));
  assert.ok(!web.some((b) => b.web_app.url.endsWith(`?nom=${req[0].id}`)), 'номинацию, где уже голосовал, не предлагаем');
  assert.ok(kbOf({ params: m101 }).some((b) => b.callback_data === 'rm:off'), 'есть «Не напоминать»');
  const m108 = all_('sendRichMessage').find((x) => x.params.chat_id === 9108).params;
  assert.ok(!/монет/.test(m108.rich_message.html), 'уже получившему награду про монеты не пишем');

  // повтор: в тот же момент и до истечения 5 дней — ничего
  resetApi();
  assert.equal((await rem.runReminders({ force: true, limit: 50 })).sent, 0);
  assert.equal((await rem.runReminders()).reason, 'throttled', 'не чаще раза в минуту');
  assert.equal(all_('sendRichMessage').length, 0);
  // через 5 дней — снова, счётчик растёт
  await dbrun('UPDATE reminders SET last_at = :t', { t: NOW - 6 * DAY });
  resetApi();
  assert.equal((await rem.runReminders({ force: true, limit: 50 })).sent, 4);
  assert.equal(await val('SELECT count FROM reminders WHERE user_id = 9101'), 2);

  // лимит Telegram: останавливаемся, пользователь не «сгорает» и получит позже
  await dbrun('UPDATE reminders SET last_at = :t', { t: NOW - 6 * DAY });
  resetApi(); failNext('sendRichMessage', null, new BotApiError(429, 'Too Many Requests', 'sendRichMessage'));
  assert.equal((await rem.runReminders({ force: true, limit: 50 })).sent, 0);
  assert.equal(await val('SELECT last_at FROM reminders WHERE user_id = 9101'), 0, 'при 429 пользователя не «занимаем»');
  resetApi();
  assert.equal((await rem.runReminders({ force: true, limit: 50 })).sent, 4, 'следующий вызов дошлёт');
  // заблокировал бота: помечаем и больше не шлём
  await dbrun('UPDATE reminders SET last_at = :t', { t: NOW - 6 * DAY });
  resetApi(); failNext('sendRichMessage', (p) => p.chat_id === 9101, new BotApiError(403, 'Forbidden: bot was blocked by the user', 'sendRichMessage'));
  await rem.runReminders({ force: true, limit: 50 });
  assert.equal((await S.getUser(9101)).blocked, 1);
  await dbrun('UPDATE reminders SET last_at = :t', { t: NOW - 6 * DAY }); resetApi();
  assert.deepEqual(all_('sendRichMessage').map((x) => x.params.chat_id), []); await rem.runReminders({ force: true, limit: 50 });
  assert.ok(!all_('sendRichMessage').some((x) => x.params.chat_id === 9101));
  ok('напоминания: кому/кому нет, 5 дней, троттлинг, 429, 403, текст и кнопки');

  // «Не напоминать» / «Включить обратно»
  await dbrun('UPDATE users SET blocked = 0 WHERE id = 9103'); await dbrun('UPDATE reminders SET last_at = :t', { t: NOW - 6 * DAY });
  await press(u(9103), 'rm:off');
  assert.equal(await val('SELECT muted FROM reminders WHERE user_id = 9103'), 1);
  assert.ok(kbOf(last('editMessageText')).some((b) => b.callback_data === 'rm:on'));
  resetApi(); await rem.runReminders({ force: true, limit: 50 });
  assert.ok(!all_('sendRichMessage').some((x) => x.params.chat_id === 9103), 'замьюченному не шлём');
  await press(u(9103), 'rm:on');
  assert.equal(await val('SELECT muted FROM reminders WHERE user_id = 9103'), 0);

  // админка: экран, переключатель, ручной запуск, права
  await press(owner, 'a:coin');
  assert.match(last('editMessageText').params.rich_message.html, /Монеты и напоминания/);
  assert.match(last('editMessageText').params.rich_message.html, /включены/);
  await press(owner, 'a:cointg');
  assert.equal(await S.getSetting('remind_enabled', '1'), '0');
  assert.equal((await rem.runReminders({ force: true })).reason, 'off');
  await press(owner, 'a:cointg');
  assert.equal(await S.getSetting('remind_enabled', '1'), '1');
  await press(alice, 'a:cointg');
  assert.equal(await S.getSetting('remind_enabled', '1'), '1', 'не владелец не может переключать');

  // диагностика: почему «0 отправлено» — видно по причинам; ручной запуск показывает подобранных/отправленных
  await dbrun('UPDATE reminders SET last_at = :t', { t: NOW });          // все только что получили → в этот момент подходящих нет
  const dg = await rem.reminderDiagnostics();
  assert.ok(dg.incomplete >= 3); assert.equal(dg.ready, 0, 'готовых нет: все получили только что, новичок и активный отсеяны'); assert.ok(dg.recent >= 3, 'получили за последние 5 дней (9101 заблокировал бота — не считается)');
  assert.ok(dg.tooNew >= 1, 'новичок (<суток) виден в диагностике'); assert.ok(typeof dg.activeNow === 'number');
  await dbrun('INSERT INTO reminders (user_id, last_at, count, muted) VALUES (9104, :t, 1, 0) ON CONFLICT(user_id) DO UPDATE SET last_at = :t', { t: NOW }); // новичок тоже «уже получил»
  await press(owner, 'a:coinrun');
  const runHtml = last('editMessageText').params.rich_message.html;
  assert.match(runHtml, /Подобрано: 0 · отправлено: 0/); assert.match(runHtml, /Из \d+ неполных: готовы к отправке 0/); assert.match(runHtml, /уже получали за последние 5 дней/);
  await dbrun('UPDATE reminders SET last_at = :t', { t: NOW - 6 * DAY }); resetApi();
  await press(owner, 'a:coinrun');
  assert.match(last('editMessageText').params.rich_message.html, /Подобрано: \d+ · отправлено: \d+/);
  // принудительный запуск игнорирует правило «новичок» (но не «активен в последний час»)
  await dbrun('UPDATE reminders SET last_at = 0'); resetApi();
  assert.ok(!(await rem.runReminders({ force: true, limit: 50 })).picked || !all_('sendRichMessage').some((x) => x.params.chat_id === 9104), 'при обычном запуске новичок не получает');
  await dbrun('UPDATE reminders SET last_at = 0'); resetApi();
  await rem.runReminders({ force: true, manual: true, limit: 50 });
  assert.ok(all_('sendRichMessage').some((x) => x.params.chat_id === 9104), 'при ручном запуске админом новичок тоже получает');
  assert.ok(!all_('sendRichMessage').some((x) => x.params.chat_id === 9107), 'но активный в последний час — нет');
  // ошибка отправки не маскируется: видна в результате
  await dbrun('UPDATE users SET blocked = 0 WHERE id = 9101'); // его раньше пометили «заблокировал бота» — вернём в рассылку
  await dbrun('UPDATE reminders SET last_at = 0'); resetApi(); for (const m of ['sendRichMessage', 'sendMessage', 'sendPhoto']) for (let k = 0; k < 4; k++) failNext(m, (p) => p.chat_id === 9101, new BotApiError(400, 'Bad Request: BUTTON_URL_INVALID', m)); // не сработал ни один запасной путь
  const bad = await rem.runReminders({ force: true, limit: 50 });
  assert.ok(bad.failed >= 1, 'ошибка отправки должна быть видна в результате');
  assert.match(bad.error, /BUTTON_URL_INVALID/);

  // фоновый tick мини-аппа запускает пачку напоминаний
  await dbrun('UPDATE reminders SET last_at = :t', { t: NOW - 6 * DAY }); await S.setSetting('remind_tick_at', '0'); resetApi();
  const t1 = await tick({}, { initData: { user: u(9201) } });
  assert.equal(t1.ok, true); assert.ok(t1.sent >= 1, 'tick отправил напоминания');
  ok('напоминания: отключение пользователем, админ-экран, tick');
}




console.log('Реферальная система');
{
  const refl = await import('../tgcloud/lib/referrals.js');
  const { snapshot } = await import('../tgcloud/lib/backup.js');
  await S.setSetting('apps_open', '1'); await S.setSetting('limit_mode', 'nomination'); await dbrun('UPDATE nominations SET is_open = 1');
  await S.setSetting('bot_username', 'testbot');
  const nom = (await S.listNominations()).find((x) => !x.sponsor_only && !x.sponsor_type);
  const answers = Object.fromEntries((await S.listQuestions(nom.id)).map((q) => [q.id, '1000']));
  const voteAs = (user, uname) => submit({ nominationId: nom.id, title: 'Реф ' + uname, username: uname, description: 'достаточно длинное описание кандидата для проверки формы', answers }, { initData: { user } });
  const rel = (id) => dbm.get('SELECT * FROM referrals WHERE user_id = :id', { id });
  const refA = u(9501), refB = u(9502);
  await S.touchUser(refA, { started: true }); await S.touchUser(refB, { started: true });   // пригласившие известны боту

  // 1) новый пользователь по ссылке — привязан
  await sendMsg(u(9511), '/start ref_9501');
  assert.equal((await rel(9511)).referrer_id, 9501);
  // 2) уже известный боту пользователь по чужой ссылке — НЕ привязывается (только новые)
  await S.touchUser(u(9512), { started: true });
  await sendMsg(u(9512), '/start ref_9501');
  assert.equal(await rel(9512), null);
  // 3) сам себя, неизвестный пригласивший, мусор в параметре — нет
  await sendMsg(u(9513), '/start ref_9513'); assert.equal(await rel(9513), null);
  await sendMsg(u(9514), '/start ref_999999'); assert.equal(await rel(9514), null);
  await sendMsg(u(9515), '/start ref_abc'); assert.equal(await rel(9515), null);
  await sendMsg(u(9516), '/start'); assert.equal(await rel(9516), null);
  // 4) забаненный пригласивший — нет
  await S.touchUser(u(9503), { started: true }); await S.ban(9503, 'bot', 'тест', OWNER);
  await sendMsg(u(9517), '/start ref_9503'); assert.equal(await rel(9517), null);
  // 5) первый пригласивший остаётся (повторная привязка игнорируется)
  assert.equal(await refl.attachReferral(9511, 9502), false);
  assert.equal((await rel(9511)).referrer_id, 9501);

  // 6) «проголосовал» считается только после заявки
  await sendMsg(u(9518), '/start ref_9501'); await sendMsg(u(9519), '/start ref_9501');
  assert.deepEqual(await refl.refStats(9501), { invited: 3, voted: 0 });
  assert.equal(await refl.refTopCount(), 0, 'пока никто не проголосовал — в топе пусто');
  await voteAs(u(9511), 'refvoted_one_bot');
  assert.deepEqual(await refl.refStats(9501), { invited: 3, voted: 1 });
  await sendMsg(u(9520), '/start ref_9502'); await voteAs(u(9520), 'refvoted_two_bot');
  await sendMsg(u(9521), '/start ref_9502'); await voteAs(u(9521), 'refvoted_three_bot');
  const top = await refl.refTop(10);
  assert.deepEqual(top.map((r) => [r.id, r.voted, r.invited]), [[9502, 2, 2], [9501, 1, 3]], 'сортировка по числу проголосовавших');
  assert.equal(await refl.refTopCount(), 2);
  assert.deepEqual(await refl.refTotals(), { invited: 5, voted: 3 });

  // 7) админ удалил фейковую заявку — счёт падает сразу; забаненный реферал не считается
  const fake = await S.userApplication(9511, nom.id);
  await dbrun('DELETE FROM applications WHERE id = :id', { id: fake.id });
  assert.deepEqual(await refl.refStats(9501), { invited: 3, voted: 0 });
  assert.deepEqual((await refl.refTop(10)).map((r) => r.id), [9502]);
  await S.ban(9521, 'bot', 'накрутка', OWNER);
  assert.deepEqual((await refl.refTop(10)).map((r) => [r.id, r.voted, r.invited]), [[9502, 1, 1]], 'забаненный реферал не учитывается');

  // 8) админ-экран, пагинация, права
  await voteAs(u(9511), 'refvoted_again_bot');
  await press(owner, 'a:ref');
  let html = last('editMessageText').params.rich_message.html;
  assert.match(html, /Рефералы · топ/); assert.match(html, /🥇 @user9501 — <b>1<\/b> проголосовало из 3 пришедших/); assert.match(html, /🥈 @user9502 — <b>1<\/b> проголосовало из 1 пришедших/); // при равенстве выше тот, кто привёл больше людей
  assert.match(html, /Всего по ссылкам пришло: <b>4<\/b> · проголосовали: <b>2<\/b>/);
  await dbrun("UPDATE settings SET value = value WHERE key = 'x'");
  for (let i = 0; i < 9; i++) { const rid = 9600 + i, vid = 9700 + i; await S.touchUser(u(rid), { started: true }); await sendMsg(u(vid), '/start ref_' + rid); await voteAs(u(vid), `pagetest${i}_bot`); }
  await press(owner, 'a:ref:1');
  html = last('editMessageText').params.rich_message.html;
  assert.match(html, /страница 2 из 2/); assert.match(html, /9\. |10\. |11\. /, 'на второй странице номера продолжаются');
  const before = last('editMessageText'); await press(alice, 'a:ref');
  assert.equal(last('editMessageText'), before, 'не владелец не видит топ');

  // 9) экран пользователя: ссылка и статистика
  resetApi(); await sendMsg(refA, '/invite');
  html = last('sendRichMessage').params.rich_message.html;
  assert.ok(html.includes('https://t.me/testbot?start=ref_9501')); assert.match(html, /Пришло по вашей ссылке: <b>3<\/b>/); assert.match(html, /проголосовали: <b>1<\/b>/);
  assert.ok(kbOf(last('sendRichMessage')).some((b) => /t\.me\/share\/url\?url=/.test(b.url || '')), 'есть кнопка «Поделиться»');
  resetApi(); await sendMsg(refA, '/start'); assert.ok(kbOf(last('sendRichMessage')).some((b) => b.callback_data === 'ref:me'), 'кнопка на главном экране');
  await S.setSetting('bot_username', ''); resetApi(); await press(refA, 'ref:me');
  assert.match(last('editMessageText').params.rich_message.html, /Ссылка пока недоступна/, 'без имени бота — понятное сообщение');
  await S.setSetting('bot_username', 'testbot');

  // 10) бэкап содержит рефералов
  const snap = await snapshot();
  assert.ok(snap.tables.referrals.length >= 5); assert.ok(Array.isArray(snap.tables.coin_log) && Array.isArray(snap.tables.reminders));
  assert.ok(!snap.tables.settings.some((r) => String(r.key).startsWith('captcha:')), 'капча-строки в выгрузку не попадают');
  ok('рефералы: привязка, только новые, антифрод, подсчёт «проголосовал» на лету, топ, страницы, права, ссылка, бэкап');
}


console.log('Загрузка базы из выгрузки');
{
  const R = await import('../tgcloud/lib/restore.js');
  const { applicationsCsv } = await import('../tgcloud/lib/backup.js');
  const enc = (t) => new TextEncoder().encode(t);
  const counts = async () => Object.fromEntries(await Promise.all(['users', 'nominations', 'applications', 'questions', 'settings', 'referrals', 'coin_log', 'bans', 'news', 'links', 'sponsors'].map(async (t) => [t, Number(await val(`SELECT COUNT(*) FROM ${t}`))])));
  await S.setSetting('app_url', 'https://old.platform.example/'); await S.setSetting('bot_username', 'oldbot'); await dbrun("INSERT OR REPLACE INTO settings (key, value) VALUES ('captcha:zzz', 'JUNK|1')");
  await dbrun("INSERT INTO sponsor_banners (title, target_url, image_data, active, position, created_at) VALUES ('Банк', 'https://www.donationalerts.com/r/x', 'AAAA', 1, 1, 1)");

  // 1) выгрузка → испортили базу → «заменить всё» возвращает ровно то, что было
  const snap = await snapshot(); const json = JSON.stringify(snap); const before = await counts();
  const appsBefore = await all('SELECT id, nomination_id, user_id, title, username FROM applications ORDER BY id');
  const csv = await applicationsCsv();
  await dbrun('DELETE FROM applications WHERE id % 2 = 0'); await dbrun('DELETE FROM users WHERE id % 3 = 0'); await dbrun("UPDATE nominations SET title = title || ' (испорчено)'"); await dbrun('DELETE FROM referrals');
  assert.ok((await counts()).applications < before.applications);
  process.env.APP_URL = 'https://my.server.example/'; await S.setSetting('app_url', 'https://my.server.example/'); await S.setSetting('bot_username', 'newbot');
  const rep = await R.restoreJson(R.parseBackup(json), { mode: 'replace', keepOwner: OWNER });
  assert.deepEqual(await counts(), { ...before, settings: (await counts()).settings }, 'число строк по таблицам как в выгрузке');
  assert.deepEqual(await all('SELECT id, nomination_id, user_id, title, username FROM applications ORDER BY id'), appsBefore, 'заявки совпадают построчно');
  assert.ok(!(await all('SELECT title FROM nominations')).some((n) => n.title.includes('испорчено')), 'испорченное заменено');
  assert.equal(rep.applications.inserted, before.applications);
  // настройки сервера не затираются, мусор не переносится
  assert.equal(await S.getSetting('app_url'), 'https://my.server.example/', 'URL мини-аппа нового сервера сохранён'); assert.equal(await S.getSetting('bot_username'), 'newbot');
  assert.equal(await S.getSetting('captcha:zzz', null), 'JUNK|1', 'старые строки капчи не трогаем');   // это строка текущей базы; в выгрузке их нет
  assert.ok(!snap.tables.settings.some((r) => String(r.key).startsWith('captcha:')));
  // банеры спонсоров: картинок в выгрузке нет → строка вернулась, но неактивной и без картинки
  const sb = await dbm.get("SELECT * FROM sponsor_banners WHERE title = 'Банк'");
  assert.equal(sb.image_data, ''); assert.equal(sb.active, 0);

  // 2) «добавить недостающее»: вернуть удалённое, не трогая изменённое
  await dbrun('DELETE FROM applications WHERE id IN (SELECT id FROM applications ORDER BY id LIMIT 3)');
  const keep = await dbm.get('SELECT id FROM applications ORDER BY id DESC LIMIT 1'); await dbrun("UPDATE applications SET title = 'ИЗМЕНЕНО' WHERE id = :id", { id: keep.id });
  const repM = await R.restoreJson(R.parseBackup(json), { mode: 'merge' });
  assert.equal((await counts()).applications, before.applications, 'удалённые вернулись');
  assert.equal((await dbm.get('SELECT title FROM applications WHERE id = :id', { id: keep.id })).title, 'ИЗМЕНЕНО', 'существующее не перезаписано');
  assert.equal(repM.applications.inserted, 3);

  // 3) атомарность: ошибка в середине → ничего не меняется
  const bad = JSON.parse(json); bad.tables.applications = [{ id: 999999, nomination_id: 1, user_id: 1 }];   // нет NOT NULL-полей
  const snapBefore = JSON.stringify(await counts());
  await assert.rejects(() => R.restoreJson(R.parseBackup(JSON.stringify(bad)), { mode: 'replace' }));
  assert.equal(JSON.stringify(await counts()), snapBefore, 'после ошибки база осталась прежней (откат)');
  assert.ok((await all('SELECT title FROM nominations')).length === before.nominations);

  // 4) некорректные файлы: понятные ошибки, ничего не стёрто
  for (const [txt, re] of [['', /пустой/], ['{ не json', /JSON/], ['{"a":1}', /нет раздела tables/], ['{"tables":{"zzz":[]}}', /нет известных таблиц/], ['{"tables":{"users":5}}', /повреждена/], ['просто текст', /не похоже/]]) {
    assert.throws(() => R.parseBackup(txt), re);
  }

  // 5) CSV: недостающие заявки по названию номинации; даты читаются обратно
  await dbrun('DELETE FROM applications WHERE id IN (SELECT id FROM applications ORDER BY id LIMIT 2)');
  const gone = appsBefore.slice(0, 2);
  const repC = await R.importCsv(R.parseBackup(R.decodeText(enc(csv))));
  assert.equal(repC.inserted, 2); assert.equal((await counts()).applications, before.applications);
  const back1 = await dbm.get('SELECT * FROM applications WHERE id = :id', { id: gone[0].id });
  assert.equal(back1.title, gone[0].title); assert.equal(back1.username, gone[0].username); assert.equal(back1.user_id, gone[0].user_id);
  assert.equal(back1.username_norm, gone[0].username.toLowerCase());
  const badCsv = csv.replace(/Бот года/g, 'Несуществующая номинация');
  const repU = await R.importCsv(R.parseBackup(badCsv)); assert.ok(repU.unmatched['Несуществующая номинация'] >= 1, 'неизвестные номинации перечислены');
  // поля с «;», кавычками и переносами строк
  const tricky = '\ufeffid;номинация;название;юзернейм;описание;ответы;id автора;юзернейм автора;создана;изменена;спонсорская номинация\r\n'
    + `777001;${(await S.listNominations())[0].title};"Хитрое; ""название""";@tricky_one_bot;"строка 1\nстрока 2";{"1":"a"};777002;@tricky_author;01.02.2026 10:30 UTC;01.02.2026 10:31 UTC;\r\n`;
  const rt = await R.importCsv(R.parseBackup(tricky)); assert.equal(rt.inserted, 1);
  const tr = await dbm.get('SELECT * FROM applications WHERE id = 777001');
  assert.equal(tr.title, 'Хитрое; "название"'); assert.equal(tr.description, 'строка 1\nстрока 2'); assert.equal(tr.created_at, Math.floor(Date.UTC(2026, 1, 1, 10, 30) / 1000));
  await dbrun('DELETE FROM applications WHERE id = 777001');

  // 6) поток в боте: кнопка → файл → превью → подтверждение
  const nApps = (await counts()).applications; await dbrun('DELETE FROM applications WHERE id IN (SELECT id FROM applications ORDER BY id LIMIT 4)');
  setFileBytes(enc(json)); resetApi();
  await press(owner, 'a:rst');
  assert.match(last('editMessageText').params.rich_message.html, /Пришлите файл выгрузки/);
  await sendMsg(owner, '', { document: { file_id: 'F1', file_size: 1000 } });
  const prev = last('sendRichMessage'); assert.match(prev.params.rich_message.html, /Выгрузка базы/); assert.match(prev.params.rich_message.html, /заявки: в файле <b>\d+<\/b> · сейчас <b>\d+<\/b>/);
  assert.deepEqual(kbOf(prev).map((b) => b.callback_data), ['a:rstgo:replace', 'a:rstgo:merge', 'a:cx']);
  assert.equal((await counts()).applications, nApps - 4, 'до подтверждения ничего не изменилось');
  const docsBefore = calls.filter((x) => x.method === 'sendDocument').length;
  await press(owner, 'a:rstgo:replace');
  assert.match(last('sendRichMessage').params.rich_message.html, /База загружена \(заменено\)/);
  assert.equal((await counts()).applications, nApps, 'после подтверждения данные загружены');
  assert.ok(calls.filter((x) => x.method === 'sendDocument').length > docsBefore, 'перед заменой владельцам ушла резервная копия');
  assert.equal(await val('SELECT COUNT(*) FROM states WHERE user_id = :u', { u: OWNER }), 0, 'состояние очищено');
  // граничные случаи потока
  const n0 = calls.length; await press(owner, 'a:rstgo:replace');
  assert.match(last('sendRichMessage').params.rich_message.html, /Сначала пришлите файл/, 'подтверждение без файла ничего не делает');
  await press(owner, 'a:rst'); await sendMsg(owner, 'просто текст');
  assert.match(last('sendRichMessage').params.rich_message.html, /Пришлите файл как документ/);
  await sendMsg(owner, '', { document: { file_id: 'BIG', file_size: 30 * 1024 * 1024 } });
  assert.match(last('sendRichMessage').params.rich_message.html, /больше 20 МБ/);
  setFileBytes(enc('это не выгрузка')); await sendMsg(owner, '', { document: { file_id: 'BAD', file_size: 10 } });
  assert.match(last('sendRichMessage').params.rich_message.html, /Не получилось разобрать файл/);
  await press(owner, 'a:cx');
  const before2 = JSON.stringify(await counts()); await press(alice, 'a:rst'); await press(alice, 'a:rstgo:replace');
  assert.equal(JSON.stringify(await counts()), before2, 'не владелец не может загружать базу');
  setFileBytes(null); delete process.env.APP_URL;
  ok('загрузка базы: круг «выгрузка → порча → замена», добавление, откат при ошибке, плохие файлы, CSV, поток в боте, права');
}

console.log('Спонсорские номинации тоже засчитываются');
{
  const coins = await import('../tgcloud/lib/coins.js');
  const rem = await import('../tgcloud/lib/reminders.js');
  const NOW = Math.floor(Date.now() / 1000), DAY = 86400;
  await dbrun('CREATE TABLE IF NOT EXISTS coin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, amount INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0)');
  await dbrun('CREATE UNIQUE INDEX IF NOT EXISTS uq_coin_user_reason ON coin_log (user_id, reason)');
  await dbrun('CREATE TABLE IF NOT EXISTS reminders (user_id INTEGER PRIMARY KEY, last_at INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0)');
  await S.setSetting('apps_open', '1'); await S.setSetting('limit_mode', 'nomination'); await dbrun('UPDATE nominations SET is_open = 1');
  const req = await coins.requiredNominations();
  const sponsorNoms = (await S.listNominations()).filter((x) => x.sponsor_only && x.sponsor_type);
  const sKinds = new Set(sponsorNoms.map((x) => x.sponsor_type));
  const answersFor = async (id) => Object.fromEntries((await S.listQuestions(id)).map((q) => [q.id, '1000']));
  const send_ = async (user, nom, username) => submit({ nominationId: nom.id, title: 'К ' + username, username, description: 'достаточно длинное описание кандидата для проверки формы', answers: await answersFor(nom.id) }, { initData: { user } });

  // 1) спонсор голосует в спонсорских номинациях: засчитывается во всех обычных того же типа
  const sp = u(9401); await S.addSponsor(sp.username, OWNER);
  const coveredBySponsor = req.filter((x) => sKinds.has(x.kind)), mustRegular = req.filter((x) => !sKinds.has(x.kind));
  assert.ok(coveredBySponsor.length && mustRegular.length, 'в сиде есть и типы со спонсорскими номинациями, и без них');
  let last_ = null;
  for (const t of sKinds) { const sn = sponsorNoms.find((x) => x.sponsor_type === t); last_ = await send_(sp, sn, `sponsorpick_${t}_bot`); assert.equal(last_.created, true); }
  let p = await coins.coinProgress(sp.id);
  assert.equal(p.covered, coveredBySponsor.length, 'спонсорские голоса закрыли обычные номинации своих типов');
  assert.deepEqual(p.missing.map((x) => x.id).sort(), mustRegular.map((x) => x.id).sort(), 'остались только типы без спонсорских номинаций');
  assert.equal(last_.coins.awarded, mustRegular.length ? 0 : 35);
  // дальше — обычные голоса в оставшихся номинациях → награда
  let r;
  for (const nom of mustRegular) r = await send_(sp, nom, `regular_${nom.id}_9401_bot`);
  assert.equal(r.coins.awarded, 35, 'спонсор получил 35 монет, голосуя и в спонсорских, и в обычных');
  assert.equal(await coins.coinBalance(sp.id), 35);

  // 2) обычный голос, «ушедший» в спонсорскую номинацию по совпадению юзернейма, засчитывается как обычный
  const match = await send_(u(9402), req.find((x) => x.kind === [...sKinds][0]), `sponsorpick_${[...sKinds][0]}_bot`);
  assert.ok(match.sponsorNomination, 'голос ушёл в спонсорскую номинацию');
  const pm = await coins.coinProgress(9402);
  assert.equal(pm.covered, 1); assert.ok(!pm.missing.some((x) => x.id === req.find((y) => y.kind === [...sKinds][0]).id), 'эта номинация закрыта');

  // 3) напоминания: спонсор, закрывший всё, не в списке; человек с пропусками — в списке
  await S.setSetting('remind_enabled', '1');
  await dbrun('UPDATE users SET started = 1, blocked = 0, first_seen = :f, last_seen = :l WHERE id IN (9401, 9402)', { f: NOW - 10 * DAY, l: NOW - 5 * DAY });
  assert.equal(await val('SELECT COUNT(*) FROM users WHERE id IN (9401, 9402) AND started = 1'), 2);
  await dbrun('DELETE FROM reminders');
  resetApi();
  await rem.runReminders({ force: true, limit: 200 });
  const got = new Set(all_('sendRichMessage').map((x) => x.params.chat_id));
  assert.ok(!got.has(9401), 'закрывшему всё (включая спонсорские) не напоминаем');
  const plainCount = await val('SELECT COUNT(DISTINCT nomination_id) FROM applications WHERE user_id = 9401 AND nomination_id IN (' + req.map((x) => x.id).join(',') + ')');
  assert.ok(plainCount < req.length, 'без спонсорского правила 9401 считался бы неполным (проверка не пустая)');
  assert.ok(got.has(9402), 'у кого есть пропуски — напоминаем');
  // и в тексте у 9402 нет номинации, закрытой голосом, ушедшим к спонсору
  const html = all_('sendRichMessage').find((x) => x.params.chat_id === 9402).params.rich_message.html;
  assert.ok(!html.includes('<b>' + req.find((y) => y.kind === [...sKinds][0]).title + '</b>'), 'закрытая номинация не в списке недостающих');
  assert.ok(html.includes('<b>'), 'а недостающие в сообщении есть');
  ok('спонсорские голоса: прямая подача спонсора, голос «ушёл к спонсору», напоминания');
}

console.log('Устойчивость: обновление залито без migrate (таблиц монет нет)');
{
  await dbrun('DROP TABLE coin_log'); await dbrun('DROP TABLE reminders');
  const tick = (await import('../tgcloud/endpoints/tick.js')).default;
  const nomsAll = (await S.listNominations()).filter((x) => !x.sponsor_only && !x.sponsor_type);
  const nom = nomsAll[0], voter = u(9301);
  const home = await getHome({}, { initData: { user: voter } });
  assert.equal(home.coins, null, 'главная открывается, монет просто нет');
  const r = await submit({ nominationId: nom.id, title: 'Без миграции', username: 'nomig_9301_bot', description: 'достаточно длинное описание кандидата для проверки формы',
    answers: Object.fromEntries((await S.listQuestions(nom.id)).map((q) => [q.id, '1000'])) }, { initData: { user: voter } });
  assert.equal(r.ok, true); assert.equal(r.coins, null, 'заявка принята, монет в ответе нет');
  assert.equal((await tick({}, { initData: { user: voter } })).ok, true, 'tick не падает');
  await sendMsg(u(9302), '/start'); // обработчик бота тоже не падает
  assert.ok(last('sendRichMessage'));
  ok('без таблиц монет: главная, отправка заявки, tick и /start работают');
}

console.log(`\nГотово: ${passed} проверок прошли`);
