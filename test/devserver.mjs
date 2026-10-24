// Тестовый сервер с демо-данными для проверки интерфейса в браузере: node --no-warnings --import ./register.mjs devserver.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.BOT_TOKEN = '123456:TEST-TOKEN-abcdefghijklmnopqrstuvwxyz12';
import { initDb } from './mock-sdk.mjs';
import { run as dbrun, all as dball } from '../tgcloud/lib/db.js';
await import('../tgcloud/schema.js');
initDb();
const here = path.dirname(fileURLToPath(import.meta.url));
const S = await import('../tgcloud/lib/store.js');
const A = await import('../tgcloud/lib/r2admin.js');
const R = await import('../tgcloud/lib/r2.js');
const F = await import('../tgcloud/lib/forum.js');
const L = await import('../tgcloud/lib/weblogin.js');
const { createWebServer } = await import('../server/web.mjs');
const { makeHooks } = await import('../server/r2hooks.mjs');
const { signInitData } = await import('../server/initdata.mjs');

await S.ensureSeed(); await S.addOwner(9001, null); await S.setSetting('bot_username', 'kmbp_test_bot');
const users = { 9001: 'Админ', 2001: 'Алиса', 2002: 'Борис', 2003: 'Вера', 2004: 'Дарья', 2005: 'Чужой' };
for (const [id, n] of Object.entries(users)) await S.touchUser({ id: +id, first_name: n, username: 'u' + id }, { started: true });
for (const id of [2001, 2002, 2003, 2004]) await A.accessAdd(String(id), 9001);   // 2004 — «чистый» пользователь для сценариев голосования
const b = (i) => fs.readFileSync(path.join(here, `fixtures/b${i}.jpg`)).toString('base64');
const noms = (await R.listVoteNominations().catch(() => [])) || [];
const mk = async (n, title, d, i, ch) => (await A.saveProject({ nominationId: n, title, description: d, banner: i ? b(i) : undefined, editorsChoice: !!ch })).id;
const ids = {};
ids.a = await mk(2, 'Мир ботов', 'Каталог лучших Telegram-ботов с отзывами и рейтингами. Обновляется каждый день, помогает находить полезные сервисы и избегать мошенников.\nСтарт в 2022 году, больше 40 000 участников.', 1, true);
ids.b = await mk(2, 'Антискам-центр', 'Проверка пользователей и каналов на мошенничество.', 2);
ids.c = await mk(2, 'Школа модераторов', 'Бесплатные курсы для новых админов чатов. Практика, разборы кейсов, наставники.', 3);
ids.d = await mk(2, 'Без картинки', 'Проект без баннера — проверяем заглушку.', 0);
await mk(1, 'Бот-помощник', 'Отвечает на вопросы 24/7', 4); await mk(1, 'Бот-кубик', 'Играет в кости с друзьями', 2);
await mk(3, 'Анна', 'Волонтёр года', 3); await mk(3, 'Игорь', 'Лучший модератор', 1);
await dbrun("INSERT INTO coin_log (user_id, amount, reason, created_at) VALUES (2001, 35, 'all_nominations', 1), (2004, 35, 'all_nominations', 1)");
await dbrun("INSERT INTO news (text, entities, pinned, created_at) VALUES ('Стартовал второй тур! Голосуйте за лучших.', :e, 1, 2)", { e: JSON.stringify([{ type: 'bold', offset: 0, length: 17 }]) }).catch(() => {});
await dbrun("INSERT INTO news (text, entities, pinned, created_at) VALUES ('Второй тур: правила голосования — смотрите в боте. Спасибо, что с нами!', '[]', 0, 1)").catch(() => {});
await dbrun("INSERT INTO links (title, url, kind, position) VALUES ('Канал премии', 'https://t.me/kmbp', 'channel', 1)").catch(() => {});
// несколько рисунков от других людей
const draw = (c) => [[c, 2, 20, 200, 60, 40, 110, 200, 160, 40, 220, 200], [(c + 4) % 16, 1, 30, 120, 230, 120]];
for (const [u, p, c] of [[2002, ids.a, 2], [2003, ids.a, 7], [2005, ids.a, 9]]) await dbrun('INSERT INTO r2_drawings (user_id, nomination_id, project_id, strokes, created_at, updated_at) VALUES (:u, 2, :p, :s, 1, 1)', { u, p, s: JSON.stringify(draw(c)) });
const vote = (u, p, ip, w = 2, kind = 'main') => dbrun("INSERT INTO r2_votes (user_id, nomination_id, project_id, kind, weight2, changes, excluded, ip_hash, net_hash, ua_hash, via, created_at, updated_at) VALUES (:u, 2, :p, :k, :w, 0, 0, :ip, :ip, 'ua', 'tg', 100, 100)", { u, p, ip, w, k: kind });
await vote(2002, ids.a, 'ip-b'); await vote(2003, ids.a, 'ip-c'); await vote(2001, ids.b, 'ip-a'); await vote(2001, ids.b, 'ip-a', 1, 'extra');
for (const u of [3001, 3002, 3003]) { await S.touchUser({ id: u, first_name: 'Бот' + u }); await vote(u, ids.c, 'ip-farm'); }
await F.ensureTopics();
await dbrun("INSERT INTO r2_posts (topic_id, user_id, name, is_staff, body, norm, hidden, reports, created_at) VALUES (1, 2002, 'Борис', 0, 'Всем привет! Кто за Мир ботов?', 'x1', 0, 0, :t), (1, 9001, 'Организатор', 1, 'Добро пожаловать на форум второго тура. Будьте вежливы.', 'x2', 0, 0, :t)", { t: Math.floor(Date.now() / 1000) - 300 });

const hooks = await makeHooks();
const port = Number(process.env.PORT) || 8099;
const srv = createWebServer({ appDir: path.resolve(here, '../app'), endpointsDir: path.resolve(here, '../tgcloud/endpoints'), token: process.env.BOT_TOKEN, rateLimit: 100000, hooks, log: (...a) => console.log(...a) });
// служебный путь только для тестового стенда: выдаёт подпись initData и cookie для выбранного пользователя
const orig = srv.listeners('request')[0]; srv.removeAllListeners('request');
srv.on('request', async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__test/init') { const id = +u.searchParams.get('id'); res.setHeader('content-type', 'text/plain'); return res.end(signInitData({ auth_date: Math.floor(Date.now() / 1000), query_id: 'q', user: { id, first_name: users[id] || 'X', username: 'u' + id } }, process.env.BOT_TOKEN)); }
  if (u.pathname === '/__test/cookie') { const id = +u.searchParams.get('id'); const t = await L.createSession(id, { ip: '127.0.0.1', ua: 'pw' }); res.setHeader('content-type', 'text/plain'); return res.end(t); }
  if (u.pathname === '/__test/captcha') { const raw = await S.getSetting('captcha:' + u.searchParams.get('id'), ''); res.setHeader('content-type', 'text/plain'); return res.end(raw.split('|')[0]); }
  if (u.pathname === '/__test/lastcaptcha') { const r = await dball("SELECT value FROM settings WHERE key LIKE 'captcha:%' AND value <> '' ORDER BY rowid DESC LIMIT 1"); res.setHeader('content-type', 'text/plain'); return res.end((r[0]?.value || '').split('|')[0]); }
  if (u.pathname === '/__test/botconfirm') { const uid = +u.searchParams.get('uid'), nonce = u.searchParams.get('nonce'), code = u.searchParams.get('code'); await L.botStart({ id: uid, first_name: users[uid] }, uid, nonce); const r = await L.botCallback({ id: uid, first_name: users[uid] }, uid, 1, `lg:${nonce}:${code}`); res.end(r); return; }
  if (u.pathname === '/__test/skew') { globalThis.__skew = (globalThis.__skew || 0) + Number(u.searchParams.get('s') || 0); res.end('ok'); return; }
  return orig(req, res);
});
srv.listen(port, '127.0.0.1', () => console.log('dev server on', port));
