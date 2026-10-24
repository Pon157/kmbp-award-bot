// Проверки 2 тура: доступ, голосование, антинакрутка, рисунки, форум, админка, вход через бота, HTTP-слой.
// Запуск: cd test && node --no-warnings --import ./register.mjs r2.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-abcdefghijklmnopqrstuvwxyz12';
import { initDb, calls, resetApi } from './mock-sdk.mjs';
import { run as dbrun, all, get, val } from '../tgcloud/lib/db.js';

await import('../tgcloud/schema.js');
initDb();
const here = path.dirname(fileURLToPath(import.meta.url));
const S = await import('../tgcloud/lib/store.js');
const R = await import('../tgcloud/lib/r2.js');
const A = await import('../tgcloud/lib/r2admin.js');
const F = await import('../tgcloud/lib/forum.js');
const L = await import('../tgcloud/lib/weblogin.js');
const sec = await import('../tgcloud/lib/sec.js');
const r2ep = (await import('../tgcloud/endpoints/r2.js')).default;
const admep = (await import('../tgcloud/endpoints/r2admin.js')).default;
const forumep = (await import('../tgcloud/endpoints/forum.js')).default;
const meep = (await import('../tgcloud/endpoints/me.js')).default;
const msgH = (await import('../tgcloud/handlers/message.js')).default;
const cbH = (await import('../tgcloud/handlers/callback_query.js')).default;
const { createWebServer } = await import('../server/web.mjs');
const { makeHooks } = await import('../server/r2hooks.mjs');
const { signInitData } = await import('../server/initdata.mjs');

let passed = 0; const ok = (m) => { passed++; console.log('  ✓ ' + m); };
const rejects = async (p, code, re) => { try { await p; } catch (e) { assert.equal(e.parameters?.code, code, `код ошибки: ${e.parameters?.code} / ${e.description}`); if (re) assert.match(e.description, re); return e; } assert.fail('ожидалась ошибка ' + code); };
let skew = 0; const realNow = Date.now; Date.now = () => realNow() + skew;     // «перемотка» времени
const OWNER = 9001;
const U = (id, extra = {}) => ({ id, first_name: 'Имя' + id, username: 'user' + id, ...extra });
const ctx = (user, o = {}) => ({ initData: { user, via: 'tg' }, ip: o.ip || `198.51.100.${user.id % 200}`, ua: o.ua || 'Mozilla/5.0 (Windows NT 10.0) Chrome/120', secure: true, setCookie() {} });
const api = (fn) => (user, input, o) => fn(input, ctx(user, o));
const R2 = api(r2ep), AD = api(admep), FO = api(forumep);
const reset = () => { sec.resetLimits(); };
const unlocked = async (user, nominationId, o) => { const v = await R2(user, { op: 'nom', nominationId }, o); skew += 4000; return v; };   // открыл карточки и «посмотрел» 4 секунды
const solve = async (user) => { const c = await R2(user, { op: 'captcha' }); return { id: c.id, answer: (await S.getSetting('captcha:' + c.id)).split('|')[0] }; };
const castMain = async (user, nominationId, projectId, o) => {
  const v = await unlocked(user, nominationId, o);
  const body = { op: 'vote', nominationId, projectId, ticket: v.ticket };
  if (v.needHuman) body.captcha = await solve(user);
  return R2(user, body, o);
};

await S.ensureSeed();
await S.addOwner(OWNER, null);
await S.setSetting('bot_username', 'kmbp_test_bot');
for (const id of [OWNER, 2001, 2002, 2003, 2004, 2005, 2006]) await S.touchUser(U(id, id === 2003 ? { first_name: 'Хитрый<img src=x onerror=alert(1)>' } : {}), { started: true });
const owner = U(OWNER), alice = U(2001), bob = U(2002), carol = U(2003, { first_name: 'Хитрый<img src=x onerror=alert(1)>' }), dave = U(2004), erin = U(2005);
const banner = fs.readFileSync(path.join(here, 'fixtures/banner.jpg')).toString('base64');

console.log('Доступ только для своих ID');
await rejects(R2(alice, { op: 'home' }), 'NO_ACCESS');
await rejects(FO(alice, { op: 'topics' }), 'NO_ACCESS');
await rejects(AD(alice, { op: 'overview' }), 'FORBIDDEN');
await rejects(AD(alice, { op: 'saveProject', nominationId: 1, title: 'x' }), 'FORBIDDEN');
const me0 = await meep({}, ctx(alice));
assert.equal(me0.access, false); assert.equal(me0.owner, false);
let r = await AD(owner, { op: 'accessAdd', text: '2001, 2002 @user2003\n2004 abc_def 999999999999999999999' });
assert.deepEqual(r.added.sort(), [2001, 2002, 2003, 2004]); assert.ok(r.unknown.includes('abc_def'));
r = await AD(owner, { op: 'accessAdd', text: '2001' }); assert.deepEqual(r.known, [2001]);
assert.equal((await meep({}, ctx(alice))).access, true);
assert.equal((await meep({}, ctx(erin))).access, false);
assert.equal((await R2(owner, { op: 'home' })).nominations.length, 0);   // владелец допущен всегда
ok('чужие не проходят, владелец и допущенные — да; админка закрыта для не-владельцев');

console.log('Карточки проектов и баннеры');
const mk = async (nominationId, title, extra = {}) => (await AD(owner, { op: 'saveProject', nominationId, title, description: 'Описание ' + title, ...extra })).id;
const p1 = await mk(2, 'Проект Альфа', { banner, editorsChoice: true });
const p2 = await mk(2, 'Проект Бета', { banner });
const p3 = await mk(2, 'Проект Гамма');
const b1 = await mk(1, 'Бот Один'); const b2 = await mk(1, 'Бот Два');
await rejects(AD(owner, { op: 'saveProject', nominationId: 2, title: 'Плохой', banner: 'AAAA' }), 'BAD');
await rejects(AD(owner, { op: 'saveProject', nominationId: 2, title: 'Плохой', banner: Buffer.from('not a jpeg at all'.repeat(100)).toString('base64') }), 'BAD', /JPEG/);
await rejects(AD(owner, { op: 'saveProject', nominationId: 2, title: 'Тяжёлый', banner: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(700 * 1024)]).toString('base64') }), 'BAD', /тяжелее/);
await rejects(AD(owner, { op: 'saveProject', nominationId: 2, title: '' }), 'BAD');
await rejects(AD(owner, { op: 'saveProject', nominationId: 777, title: 'Нет такой' }), 'NOT_FOUND');
const home = await R2(alice, { op: 'home' });
assert.deepEqual(home.nominations.map((n) => n.id), [1, 2]);
let view = await R2(alice, { op: 'nom', nominationId: 2 });
assert.equal(view.projects.length, 3);
const pa = view.projects.find((p) => p.id === p1);
assert.equal(pa.editorsChoice, true); assert.match(pa.banner, /^\/m\/p\/\d+\.jpg\?v=1&s=[0-9a-f]{24}$/);
assert.equal(view.projects.find((p) => p.id === p3).banner, null);
assert.ok(!JSON.stringify(view).includes('score') && !JSON.stringify(view).includes('weight'), 'пользователю не отдаются результаты');
const ord = (u) => R2(u, { op: 'nom', nominationId: 2 }).then((v) => v.projects.map((p) => p.id).join());
assert.equal(await ord(alice), await ord(alice), 'порядок у человека стабильный');
await AD(owner, { op: 'moveProject', id: p3, dir: 'up' });
const hooks = await makeHooks();
const m = /^\/m\/p\/(\d+)\.jpg\?v=(\d+)&s=(\w+)$/.exec(pa.banner);
const bytes = await hooks.media('p', m[1], m[2], m[3]);
assert.ok(bytes && bytes[0] === 0xff && bytes.length === fs.statSync(path.join(here, 'fixtures/banner.jpg')).size);
assert.equal(await hooks.media('p', m[1], m[2], 'x'.repeat(24)), null, 'неверная подпись');
assert.equal(await hooks.media('p', m[1], '2', sec.mediaSig('p', m[1], 2)), null, 'версия не совпала');
ok('карточки: проверка JPEG, выбор редакции, подписанные ссылки, порядок, результаты не утекают');

console.log('Голосование');
reset();
let v = await R2(alice, { op: 'nom', nominationId: 2 });
await rejects(R2(alice, { op: 'vote', nominationId: 2, projectId: p1, ticket: v.ticket }), 'EARLY');                       // слишком быстро
await rejects(R2(alice, { op: 'vote', nominationId: 2, projectId: p1, ticket: 'a.b.c.d.e' }), 'STALE');
await rejects(R2(alice, { op: 'vote', nominationId: 2, projectId: p1 }), 'STALE');
skew += 4000;
await rejects(R2(alice, { op: 'vote', nominationId: 2, projectId: p1, ticket: v.ticket }), 'HUMAN');                       // нужна капча
await rejects(R2(alice, { op: 'vote', nominationId: 2, projectId: p1, ticket: v.ticket, captcha: { id: 'x', answer: 'y' } }), 'HUMAN');
v = await unlocked(alice, 2);
const cap = await solve(alice);
await rejects(R2(bob, { op: 'vote', nominationId: 2, projectId: p1, ticket: v.ticket }), 'STALE', undefined);              // чужой билет
await rejects(R2(alice, { op: 'vote', nominationId: 1, projectId: p1, ticket: v.ticket, captcha: cap }), 'STALE');          // билет от другой номинации
v = await unlocked(alice, 2);
await rejects(R2(alice, { op: 'vote', nominationId: 2, projectId: b1, ticket: v.ticket, captcha: await solve(alice) }), 'NOT_FOUND');   // карточка из другой номинации
v = await unlocked(alice, 2);
const res1 = await R2(alice, { op: 'vote', nominationId: 2, projectId: p1, ticket: v.ticket, captcha: await solve(alice) });
assert.equal(res1.action, 'vote');
await rejects(R2(alice, { op: 'vote', nominationId: 2, projectId: p2, ticket: v.ticket }), 'STALE');                         // билет одноразовый
assert.equal((await castMain(alice, 2, p1)).action, 'same');                                                                 // капча уже пройдена (12 ч)
assert.equal(await val('SELECT COUNT(*) FROM r2_votes WHERE user_id = 2001'), 1);
ok('билеты: рано/подделка/чужой/повторный; капча нужна один раз; один голос на человека в номинации');

console.log('Смена голоса: лимит и пауза');
await rejects(castMain(alice, 2, p2), 'COOLDOWN');
await dbrun('UPDATE r2_votes SET updated_at = updated_at - 700 WHERE user_id = 2001');
let ch = await castMain(alice, 2, p2); assert.equal(ch.action, 'change'); assert.equal(ch.changesLeft, 2);
await dbrun('UPDATE r2_votes SET updated_at = updated_at - 700 WHERE user_id = 2001');
await castMain(alice, 2, p3);
await dbrun('UPDATE r2_votes SET updated_at = updated_at - 700 WHERE user_id = 2001');
await castMain(alice, 2, p1);
await dbrun('UPDATE r2_votes SET updated_at = updated_at - 700 WHERE user_id = 2001');
await rejects(castMain(alice, 2, p2), 'LIMIT');
assert.equal((await val("SELECT project_id FROM r2_votes WHERE user_id = 2001 AND kind = 'main'")), p1);
assert.equal(await val("SELECT COUNT(*) FROM r2_vote_log WHERE user_id = 2001 AND action = 'change'"), 3);
ok('смена голоса: 3 раза, не чаще раза в 10 минут, всё пишется в журнал');

console.log('Дополнительный голос за монеты (0,5)');
await rejects(castMain(bob, 2, p2).then(() => R2(bob, { op: 'extra', nominationId: 2, projectId: p2, ticket: 'zz' })), 'STALE');
const extra = async (u, n, p) => { const t = await unlocked(u, n); return R2(u, { op: 'extra', nominationId: n, projectId: p, ticket: t.ticket }); };
await rejects(extra(bob, 2, p2), 'NO_COINS', /нужно 35, у вас 0/);
await dbrun("INSERT INTO coin_log (user_id, amount, reason, created_at) VALUES (2002, 35, 'all_nominations', 1)");
await rejects(extra(bob, 1, b1), 'NEED_MAIN');                                // без основного голоса в этой номинации нельзя
const ex = await extra(bob, 2, p3); assert.equal(ex.balance, 0);
await rejects(extra(bob, 2, p3), 'ALREADY');
assert.equal(await val("SELECT COALESCE(SUM(amount),0) FROM coin_log WHERE user_id = 2002"), 0);
await dbrun("INSERT INTO coin_log (user_id, amount, reason, created_at) VALUES (2002, 35, 'bonus', 2)");
await castMain(bob, 1, b1);
await rejects(extra(bob, 1, b1).then(() => extra(bob, 1, b2)), 'ALREADY');   // по одному дополнительному в номинации
assert.equal(await val("SELECT COUNT(*) FROM r2_votes WHERE user_id = 2002 AND kind = 'extra'"), 2);
assert.equal(await val("SELECT COALESCE(SUM(amount),0) FROM coin_log WHERE user_id = 2002"), 0);
ok('0,5 голоса: цена 35, нужен основной голос, один на номинацию, баланс не уходит в минус сверх списания');

console.log('Подсчёт и скрытые результаты');
await castMain(carol, 2, p2); await castMain(dave, 2, p2);
let res = (await AD(owner, { op: 'results', nominationId: 2 })).items[0];
const score = Object.fromEntries(res.projects.map((p) => [p.title, p.score]));
assert.deepEqual(score, { 'Проект Альфа': 1, 'Проект Бета': 3, 'Проект Гамма': 0.5 });
assert.equal(res.projects[0].title, 'Проект Бета');
assert.equal(res.total, 4.5);
await AD(owner, { op: 'exclude', userId: 2004, excluded: true, reason: 'тест' });
res = (await AD(owner, { op: 'results', nominationId: 2 })).items[0];
assert.equal(res.projects.find((p) => p.id === p2).score, 2); assert.equal(res.projects.find((p) => p.id === p2).removed, 1);
await S.ban(2003, 'app', 'тест', OWNER);
res = (await AD(owner, { op: 'results', nominationId: 2 })).items[0];
assert.equal(res.projects.find((p) => p.id === p2).score, 1, 'голоса забаненных не считаются');
await S.unban(2003); await AD(owner, { op: 'exclude', userId: 2004, excluded: false });
const txt = (await AD(owner, { op: 'resultsText' })).text; assert.match(txt, /Проект Бета — 3/);
for (const u of [alice, bob]) for (const op of ['home']) { const out = JSON.stringify(await R2(u, { op })); assert.ok(!/"(score|raw|mains|extras|share)"/.test(out)); }
ok('подсчёт 1,0 + 0,5; исключение голосов; забаненные не считаются; пользователь итогов не видит');

console.log('Антинакрутка: подозрительные группы');
await S.touchUser(U(3001)); await S.touchUser(U(3002)); await S.touchUser(U(3003));
for (const id of [3001, 3002, 3003]) await AD(owner, { op: 'accessAdd', text: String(id) });
for (const id of [3001, 3002, 3003]) await castMain(U(id), 1, b2, { ip: '203.0.113.77', ua: 'BotUA/1.0' });
let sus = (await AD(owner, { op: 'suspicious' })).items;
assert.deepEqual(sus.map((s) => s.userId).sort(), [3001, 3002, 3003]);
assert.ok(sus[0].reasons.some((x) => /общий IP/.test(x)) && sus[0].reasons.some((x) => /один проект/.test(x)));
assert.ok(!sus.find((s) => s.userId === 2001), 'обычные пользователи не помечены');
await AD(owner, { op: 'exclude', userId: 3001, excluded: true });
assert.equal((await AD(owner, { op: 'results', nominationId: 1 })).items[0].projects.find((p) => p.id === b2).score, 2);
await dbrun("INSERT INTO coin_log (user_id, amount, reason, created_at) VALUES (3002, 35, 'bonus', 3)");
await extra(U(3002), 1, b2);
const rv = await AD(owner, { op: 'resetVotes', userId: 3002 });
assert.equal(rv.removed, 2); assert.equal(rv.refunded, 35);
assert.equal(await val('SELECT COALESCE(SUM(amount),0) FROM coin_log WHERE user_id = 3002'), 35, 'монеты возвращены');
const stored = await get('SELECT ip_hash, ua_hash FROM r2_votes WHERE user_id = 3001');
assert.ok(!JSON.stringify(stored).includes('203.0.113') && stored.ip_hash.length === 24, 'в базе только хэш IP');
ok('кластеры по IP/одному проекту видны админу, исключение и сброс (с возвратом монет), IP не хранится');

console.log('Лимиты частоты и закрытие голосования');
reset();
await AD(owner, { op: 'setCfg', voting: false });
await rejects(castMain(erin, 2, p1), 'NO_ACCESS');
await AD(owner, { op: 'accessAdd', text: '2005' });
await rejects(castMain(erin, 2, p1), 'CLOSED');
await AD(owner, { op: 'setCfg', voting: true });
reset();
let hitRate = false;
for (let i = 0; i < 20; i++) { try { await R2(erin, { op: 'vote', nominationId: 2, projectId: p1, ticket: 'x' }); } catch (e) { if (e.parameters?.code === 'RATE') { hitRate = true; break; } } }
assert.ok(hitRate, 'частые попытки голосования режутся лимитом');
reset();
for (let i = 0; i < 40; i++) await R2(erin, { op: 'home' }).catch(() => {});
await AD(owner, { op: 'setCfg', restrict: false });
assert.equal((await meep({}, ctx(U(5555)))).access, true, 'ограничение по ID можно снять');
await S.touchUser(U(5555));
await AD(owner, { op: 'setCfg', restrict: true });
assert.equal((await meep({}, ctx(U(5555)))).access, false);
ok('лимиты, закрытие голосования, переключатель «только по ID»');

console.log('Рисунки');
reset();
const stroke = (c = 3, w = 1, ...xy) => [c, w, ...(xy.length ? xy : [10, 10, 100, 120, 200, 30])];
await rejects(R2(alice, { op: 'draw', nominationId: 2, projectId: p1, strokes: [] }), 'BAD_DRAWING');
await rejects(R2(alice, { op: 'draw', nominationId: 2, projectId: p1, strokes: [[1, 1, 5, 5, 9, 9]] }), 'BAD_DRAWING', /Нарисуйте/);   // одни «ластики»
await rejects(R2(alice, { op: 'draw', nominationId: 2, projectId: p1, strokes: [[99, 1, 5, 5]] }), 'BAD_DRAWING');
await rejects(R2(alice, { op: 'draw', nominationId: 2, projectId: p1, strokes: [[3, 1, 5, 300]] }), 'BAD_DRAWING');
await rejects(R2(alice, { op: 'draw', nominationId: 2, projectId: p1, strokes: [[3, 1, 5, 5.5]] }), 'BAD_DRAWING');
await rejects(R2(alice, { op: 'draw', nominationId: 2, projectId: p1, strokes: [{ evil: '<script>' }] }), 'BAD_DRAWING');
await rejects(R2(alice, { op: 'draw', nominationId: 2, projectId: p1, strokes: Array.from({ length: 301 }, () => stroke()) }), 'BAD_DRAWING');
await rejects(R2(alice, { op: 'draw', nominationId: 2, projectId: p1, strokes: [[3, 1, ...Array.from({ length: 16002 }, (_, i) => i % 255)]] }), 'BAD_DRAWING');
await rejects(R2(alice, { op: 'draw', nominationId: 2, projectId: b1, strokes: [stroke()] }), 'NOT_FOUND');
await R2(alice, { op: 'draw', nominationId: 2, projectId: p1, strokes: [stroke(), stroke(5, 2, 50, 50)] });
await R2(bob, { op: 'draw', nominationId: 2, projectId: p1, strokes: [stroke(7)] });
await R2(alice, { op: 'draw', nominationId: 2, projectId: p2, strokes: [stroke(8)] });   // тот же человек в той же номинации — заменяет рисунок
assert.equal(await val('SELECT COUNT(*) FROM r2_drawings WHERE user_id = 2001'), 1);
assert.equal(await val('SELECT project_id FROM r2_drawings WHERE user_id = 2001'), p2);
await R2(alice, { op: 'draw', nominationId: 1, projectId: b1, strokes: [stroke()] });      // в другой номинации — отдельный рисунок
assert.equal(await val('SELECT COUNT(*) FROM r2_drawings WHERE user_id = 2001'), 2);
await AD(owner, { op: 'setCfg', drawScope: 'global' });
await rejects(R2(alice, { op: 'draw', nominationId: 2, projectId: p3, strokes: [stroke()] }), 'ONE_ONLY');
await R2(alice, { op: 'drawDel', nominationId: 1 });
await R2(alice, { op: 'draw', nominationId: 2, projectId: p3, strokes: [stroke()] });
await AD(owner, { op: 'setCfg', drawScope: 'nomination' });
view = await R2(bob, { op: 'nom', nominationId: 2 });
assert.equal(view.projects.find((p) => p.id === p1).drawings.count, 1);
assert.equal(view.my.drawing.projectId, p1);
const gal = await R2(carol, { op: 'drawings', projectId: p1 });
assert.equal(gal.items.length, 1); assert.equal(gal.items[0].name, 'Имя2002'); assert.ok(Array.isArray(gal.items[0].strokes));
const adm = await AD(owner, { op: 'drawings' });
assert.ok(adm.items.length >= 2); await AD(owner, { op: 'deleteDrawing', id: adm.items[0].id });
assert.equal((await AD(owner, { op: 'drawings' })).items.length, adm.items.length - 1);
await AD(owner, { op: 'deleteProject', id: p3 });
assert.equal(await val('SELECT COUNT(*) FROM r2_drawings WHERE project_id = :p', { p: p3 }), 0, 'при удалении карточки её рисунки удаляются');
ok('рисунок — только штрихи (картинку не загрузить), один на номинацию, замена, режим «только один везде», удаление админом');

console.log('Форум и защита от спама');
reset();
const topics = (await FO(alice, { op: 'topics' })).topics; assert.equal(topics.length, 3);
const T = topics[0].id;
const say = (u, text, extra) => FO(u, { op: 'post', topicId: T, text, ...extra });
await say(alice, 'Всем привет! Кого поддерживаете?');
await rejects(say(alice, 'Ещё одно сообщение сразу'), 'RATE', /подождите/);
skew += 7000;
const p0 = await say(alice, 'Я за Альфу, там классные ребята');
skew += 7000;
await rejects(say(alice, 'я за АЛЬФУ!! там классные ребята'), 'DUP');
skew += 7000;
for (const [bad, re] of [['Заходи на https://spam.example.com', /Ссылки/], ['пиши в t.me/spamchannel', /Ссылки/], ['сайт moi-shop.ru дёшево', /Ссылки/], ['t . me / spam', /Ссылки/], ['пишите @spamchannel срочно', /Упоминания/], ['ААААААААААААААААААА', /одинаковых|капс/], ['ПРОГОЛОСУЙТЕ ЗА НАС ВСЕ ПОЖАЛУЙСТА СРОЧНО', /капс/], ['😀😁😂🤣😃😄😅😆😉😊😋😎 ура', /эмодзи/], ['а', /коротк/], ['  ', /коротк/]]) {
  skew += 20000; F.resetViolations();
  const e = await rejects(say(bob, bad), 'TEXT'); assert.match(e.description, re, bad);
  if (/коротк/.test(re.source)) continue;
}
const long = 'слово '.repeat(120);
skew += 20000; await rejects(say(bob, long), 'TEXT', /длиннее/);
skew += 20000; await rejects(say(bob, 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj'), 'TEXT', /строк/);
await S.touchUser(U(2002));
// автомьют: несколько нарушений подряд
reset();
const spammer = U(2004);
let muted = null;
for (let i = 0; i < 8 && !muted; i++) { skew += 7000; try { await say(spammer, 'купи тут https://a.b.com/' + i); } catch (e) { if (e.parameters?.code === 'MUTED') muted = e; } }
assert.ok(muted, 'после серии нарушений человека отправляют отдыхать'); assert.match(muted.description, /отдохнёте|не можете/);
await rejects(say(spammer, 'нормальное сообщение теперь'), 'MUTED');
await AD(owner, { op: 'mute', userId: 2004, minutes: 0 });
skew += 7000; await say(spammer, 'теперь я исправился и пишу нормально');
// копипаста разными людьми
skew += 7000; await say(bob, 'Давайте обсудим номинацию Проект года подробнее');
skew += 7000; await rejects(say(carol, 'давайте обсудим номинацию «Проект года» подробнее!'), 'DUP');
// ответы, XSS как данные, жалобы
skew += 7000; const reply = await say(carol, 'Согласен с предыдущим комментарием', { replyTo: p0.id });
let pl = await FO(dave, { op: 'posts', topicId: T });
const rp = pl.posts.find((x) => x.id === reply.id); assert.equal(rp.reply.id, p0.id); assert.match(rp.reply.text, /Альф/);
assert.equal(pl.posts.find((x) => x.name.includes('<img')).name, 'Хитрый<img src=x onerror=alert(1)>'.slice(0, 24), 'имя обрезается и отдаётся как данные (клиент показывает через textContent)');
reset();
for (const u of [bob, carol, dave]) await FO(u, { op: 'report', postId: p0.id });
await rejects(FO(alice, { op: 'report', postId: p0.id }), 'BAD');
pl = await FO(dave, { op: 'posts', topicId: T }); assert.ok(!pl.posts.find((x) => x.id === p0.id), 'после 3 жалоб сообщение скрыто'); assert.ok(pl.gone.includes(p0.id));
assert.equal((await AD(owner, { op: 'posts', filter: 'reported' })).items.length, 1);
await AD(owner, { op: 'hidePost', id: p0.id, hidden: false });
assert.ok((await FO(dave, { op: 'posts', topicId: T })).posts.find((x) => x.id === p0.id));
// организатор: без лимитов и со ссылками, тема закрыта для остальных
await AD(owner, { op: 'saveTopic', id: T, title: topics[0].title, descr: '', locked: true });
skew += 7000; await rejects(say(alice, 'можно писать?'), 'LOCKED');
const st = await say(owner, 'Правила: https://t.me/kmbp — наш канал'); assert.equal(st.name, 'Организатор');
await AD(owner, { op: 'saveTopic', id: T, title: topics[0].title, descr: '', locked: false });
await rejects(AD(owner, { op: 'mute', userId: OWNER, minutes: 10 }), 'BAD');
await AD(owner, { op: 'setCfg', forum: false });
await rejects(say(alice, 'форум выключен вообще'), 'CLOSED');
await AD(owner, { op: 'setCfg', forum: true });
const new1 = await FO(bob, { op: 'posts', topicId: T, after: reply.id }); assert.ok(Array.isArray(new1.posts));
ok('форум: темп, дубли (и между людьми), ссылки/упоминания/капс/эмодзи/повторы, автомьют, жалобы, закрытая тема, организатор');

console.log('Вход в браузере через бота (число-подтверждение)');
reset();
const bobBrowser = { ip: '192.0.2.10', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64) AppleWebKit/537.36 Chrome/120 Safari/537.36' };
const start = await L.startLogin(bobBrowser);
assert.match(start.link, /^https:\/\/t\.me\/kmbp_test_bot\?start=login_[A-Za-z0-9_-]{20,}$/); assert.match(start.code, /^\d\d$/);
assert.equal((await L.pollLogin({ id: start.id, key: start.key }, bobBrowser)).status, 'waiting');
assert.equal((await L.pollLogin({ id: start.id, key: 'wrong' }, bobBrowser)).status, 'gone', 'чужой ключ');
const nonce = start.link.split('login_')[1];
const priv = (id) => ({ id, type: 'private' });
resetApi();
await msgH({ message_id: 1, from: { id: 2002, is_bot: false, first_name: 'Боб', username: 'user2002' }, chat: priv(2002), text: '/start login_' + nonce });
const sent = calls.find((c) => c.method === 'sendMessage'); assert.ok(sent);
assert.match(sent.params.text, /Chrome · Windows/); assert.ok(!/192\.0\.2\.10/.test(sent.params.text), 'полный IP не показываем');
const btns = sent.params.reply_markup.inline_keyboard[0]; assert.equal(btns.length, 3); assert.ok(btns.some((b) => b.text === start.code));
assert.equal((await L.pollLogin({ id: start.id, key: start.key }, bobBrowser)).status, 'waiting_confirm');
// чужой пользователь не может нажать кнопку и не может занять ссылку
resetApi();
await msgH({ message_id: 2, from: { id: 2003, is_bot: false, first_name: 'Кэрол' }, chat: priv(2003), text: '/start login_' + nonce });
assert.match(calls.find((c) => c.method === 'sendMessage').params.text, /уже не действует/);
const press = (from, data) => cbH({ id: 'cq' + Math.random(), from, data, message: { message_id: 5, chat: priv(from.id) } });
await press({ id: 2003, first_name: 'Кэрол' }, btns[0].callback_data);
assert.equal((await L.pollLogin({ id: start.id, key: start.key }, bobBrowser)).status, 'waiting_confirm', 'нажатие чужого не засчитано');
// неверное число — вход гибнет
const wrong = btns.find((b) => b.text !== start.code);
await press({ id: 2002, first_name: 'Боб' }, wrong.callback_data);
assert.equal((await L.pollLogin({ id: start.id, key: start.key }, bobBrowser)).status, 'failed');
// успешный вход
const s2 = await L.startLogin(bobBrowser); const n2 = s2.link.split('login_')[1];
resetApi();
await msgH({ message_id: 3, from: { id: 2002, is_bot: false, first_name: 'Боб', username: 'user2002' }, chat: priv(2002), text: '/start login_' + n2 });
await press({ id: 2002, first_name: 'Боб' }, `lg:${n2}:${s2.code}`);
const done = await L.pollLogin({ id: s2.id, key: s2.key }, bobBrowser);
assert.equal(done.status, 'ok'); assert.ok(done.token.length >= 40);
assert.equal((await L.pollLogin({ id: s2.id, key: s2.key }, bobBrowser)).status, 'gone', 'сессия выдаётся один раз');
const who = await L.resolveSession(done.token); assert.equal(who.id, 2002);
assert.equal(await L.resolveSession(done.token + 'x'), null); assert.equal(await L.resolveSession('a'.repeat(43)), null);
assert.equal(await val('SELECT COUNT(*) FROM web_sessions WHERE id = :t', { t: done.token }), 0, 'в базе нет самого токена, только хэш');
// «Это не я» и просрочка
const s3 = await L.startLogin(bobBrowser); const n3 = s3.link.split('login_')[1];
await msgH({ message_id: 4, from: { id: 2002, is_bot: false, first_name: 'Боб' }, chat: priv(2002), text: '/start login_' + n3 });
await press({ id: 2002, first_name: 'Боб' }, `lg:${n3}:no`);
assert.equal((await L.pollLogin({ id: s3.id, key: s3.key }, bobBrowser)).status, 'denied');
const s4 = await L.startLogin(bobBrowser); skew += 400000;
assert.equal((await L.pollLogin({ id: s4.id, key: s4.key }, bobBrowser)).status, 'expired');
resetApi(); await msgH({ message_id: 5, from: { id: 2002, is_bot: false, first_name: 'Боб' }, chat: priv(2002), text: '/start login_' + s4.link.split('login_')[1] });
assert.match(calls.find((c) => c.method === 'sendMessage').params.text, /уже не действует/);
// забаненным вход закрыт, лимит на IP
await S.ban(2005, 'app', 'x', OWNER);
const s5 = await L.startLogin({ ip: '192.0.2.99', ua: 'x' }); resetApi();
await msgH({ message_id: 6, from: { id: 2005, is_bot: false, first_name: 'Эрин' }, chat: priv(2005), text: '/start login_' + s5.link.split('login_')[1] });
assert.match(calls.find((c) => c.method === 'sendMessage').params.text, /ограничен/);
await S.unban(2005);
reset(); let blocked = null;
for (let i = 0; i < 12 && !blocked; i++) { try { await L.startLogin({ ip: '192.0.2.200', ua: 'x' }); } catch (e) { blocked = e; } }
assert.equal(blocked?.parameters?.code, 'RATE');
reset();
ok('вход: число-подтверждение, чужой не перехватит, одноразовая сессия, хэш токена в базе, «это не я», просрочка, бан, лимит по IP');

console.log('HTTP-слой: сессии, CSRF, публичные функции, CSP, баннеры');
reset();
const srv = createWebServer({ appDir: path.resolve(here, '../app'), endpointsDir: path.resolve(here, '../tgcloud/endpoints'), token: process.env.BOT_TOKEN, rateLimit: 240, hooks, trustProxy: true, secure: true, log: () => {} });
await new Promise((res) => srv.listen(0, '127.0.0.1', res));
const port = srv.address().port;
const rq = (method, url, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  const q = http.request({ host: '127.0.0.1', port, method, path: url, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (rs) => {
    const ch = []; rs.on('data', (c) => ch.push(c)); rs.on('end', () => { const buf = Buffer.concat(ch); let j = null; try { j = JSON.parse(buf.toString()); } catch (e) { /* не JSON */ } resolve({ status: rs.statusCode, headers: rs.headers, body: buf, json: j }); });
  }); q.on('error', reject); if (data) q.write(data); q.end();
});
const hostH = { host: `localhost:${port}` };
let x = await rq('POST', '/api/me', { body: {} }); assert.equal(x.status, 401); assert.equal(x.json.parameters.code, 'AUTH');
x = await rq('POST', '/api/r2', { body: { op: 'home' } }); assert.equal(x.status, 401);
x = await rq('POST', '/api/authStart', { body: {}, headers: { 'x-forwarded-for': '9.9.9.9', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605 Version/17' } });
assert.equal(x.status, 200); assert.ok(x.json.result.link && x.json.result.key);
const hs = x.json.result;
x = await rq('POST', '/api/authPoll', { body: { id: hs.id, key: hs.key } }); assert.equal(x.json.result.status, 'waiting');
x = await rq('POST', '/api/diag', { body: {} }); assert.equal(x.status, 401);
x = await rq('POST', '/api/__proto__', { body: {} }); assert.ok([401, 404].includes(x.status));
// подтверждаем вход «в боте» и забираем сессию
const nn = hs.link.split('login_')[1];
await msgH({ message_id: 7, from: { id: 2002, is_bot: false, first_name: 'Боб', username: 'user2002' }, chat: priv(2002), text: '/start login_' + nn });
await press({ id: 2002, first_name: 'Боб' }, `lg:${nn}:${hs.code}`);
x = await rq('POST', '/api/authPoll', { body: { id: hs.id, key: hs.key } });
assert.equal(x.json.result.status, 'ok'); assert.ok(!JSON.stringify(x.json).includes('token'), 'токен клиенту в теле не отдаётся');
const setc = [].concat(x.headers['set-cookie'])[0]; assert.match(setc, /^kmbp_s=[\w-]{40,}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax; Secure$/);
const cookie = setc.split(';')[0];
x = await rq('POST', '/api/me', { body: {}, headers: { cookie, ...hostH, origin: `http://localhost:${port}` } });
assert.equal(x.status, 200); assert.equal(x.json.result.user.id, 2002); assert.equal(x.json.result.via, 'web'); assert.equal(x.json.result.access, true);
x = await rq('POST', '/api/me', { body: {}, headers: { cookie, ...hostH, origin: 'https://evil.example' } }); assert.equal(x.status, 403, 'запрос с чужого сайта');
x = await rq('POST', '/api/me', { body: {}, headers: { cookie, ...hostH, 'sec-fetch-site': 'cross-site' } }); assert.equal(x.status, 403);
x = await rq('POST', '/api/me', { body: {}, headers: { cookie: 'kmbp_s=' + 'a'.repeat(43) } }); assert.equal(x.status, 401);
x = await rq('POST', '/api/r2admin', { body: { op: 'overview' }, headers: { cookie, ...hostH } }); assert.equal(x.json.parameters.code, 'FORBIDDEN');
x = await rq('POST', '/api/r2', { body: { op: 'home' }, headers: { cookie, ...hostH } }); assert.equal(x.json.ok, true);
// подпись Telegram (мини-апп) тоже работает, и она не подделывается
const init = (id, at = Math.floor(Date.now() / 1000), tok = process.env.BOT_TOKEN) => signInitData({ auth_date: at, query_id: 'q', user: { id, first_name: 'Админ' } }, tok);
x = await rq('POST', '/api/r2admin', { body: { op: 'overview' }, headers: { 'x-init-data': init(OWNER) } }); assert.equal(x.json.ok, true);
x = await rq('POST', '/api/r2admin', { body: { op: 'overview' }, headers: { 'x-init-data': init(OWNER, undefined, '1:another-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa') } }); assert.equal(x.status, 401);
x = await rq('POST', '/api/r2admin', { body: { op: 'overview' }, headers: { 'x-init-data': init(OWNER, Math.floor(Date.now() / 1000) - 90000) } }); assert.equal(x.status, 401, 'просроченная подпись');
x = await rq('POST', '/api/r2admin', { body: { op: 'nope' }, headers: { 'x-init-data': init(OWNER) } }); assert.equal(x.json.parameters.code, 'BAD');
x = await rq('POST', '/api/r2admin', { body: { op: 'constructor' }, headers: { 'x-init-data': init(OWNER) } }); assert.equal(x.json.parameters.code, 'BAD');
x = await rq('POST', '/api/r2', { body: 'x'.repeat(200000), headers: { 'x-init-data': init(2001) } }); assert.equal(x.status, 413);
x = await rq('POST', '/api/r2', { body: '[1,2]', headers: { 'x-init-data': init(2001) } }); assert.equal(x.status, 400);
// выход
x = await rq('POST', '/api/authLogout', { body: {}, headers: { cookie, ...hostH } }); assert.match([].concat(x.headers['set-cookie'])[0], /Max-Age=0/);
x = await rq('POST', '/api/me', { body: {}, headers: { cookie, ...hostH } }); assert.equal(x.status, 401, 'после выхода cookie не работает');
// баннеры и заголовки безопасности
x = await rq('GET', pa.banner); assert.equal(x.status, 200); assert.equal(x.headers['content-type'], 'image/jpeg'); assert.match(x.headers['content-security-policy'], /sandbox/);
x = await rq('GET', pa.banner.replace(/s=\w+/, 's=' + 'a'.repeat(24))); assert.equal(x.status, 404);
x = await rq('GET', '/m/p/99999.jpg?v=1&s=' + 'a'.repeat(24)); assert.equal(x.status, 404);
x = await rq('GET', '/'); assert.equal(x.status, 200); const csp = x.headers['content-security-policy'];
assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src 'self' https:\/\/telegram\.org/); assert.ok(!/unsafe-inline|unsafe-eval/.test(csp)); assert.match(x.headers['strict-transport-security'], /max-age/);
x = await rq('GET', '/r1/'); assert.equal(x.status, 200); assert.match(x.headers['content-security-policy'], /style-src 'self' 'unsafe-inline'/); assert.match(x.headers['content-security-policy'], /script-src 'self' https:\/\/telegram\.org/); assert.ok(!/script-src[^;]*unsafe/.test(x.headers['content-security-policy']), 'скрипты 1 тура — без unsafe');
x = await rq('GET', '/r1'); assert.equal(x.status, 301);
x = await rq('GET', '/r1/app.js'); assert.equal(x.status, 200); x = await rq('GET', '/r1/app.js', { headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' } }); assert.equal(x.status, 403);
x = await rq('GET', '/'); assert.ok(!/unsafe-inline/.test(x.headers['content-security-policy']), 'новый сайт — строгий CSP');
x = await rq('GET', '/../server/web.mjs'); assert.ok([403, 404].includes(x.status));
x = await rq('GET', '/%2e%2e/package.json'); assert.ok([403, 404].includes(x.status));
x = await rq('GET', '/.env'); assert.equal(x.status, 403);
// лимит по IP
let lim = null; for (let i = 0; i < 50 && !lim; i++) { const y = await rq('POST', '/api/authStart', { body: {}, headers: { 'x-forwarded-for': '7.7.7.7' } }); if (y.json?.parameters?.code === 'RATE') lim = y; }
assert.ok(lim, 'лимит на публичные функции по IP');
await new Promise((res) => srv.close(res));
ok('HTTP: вход по cookie, CSRF/Origin, подпись Telegram, подделка/просрочка, дыры в путях, лимиты, CSP без unsafe-*, подписанные баннеры');

console.log(`\nГотово: ${passed} проверок прошли`);
process.exit(0);
