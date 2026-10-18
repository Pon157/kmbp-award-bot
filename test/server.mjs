// Интеграционный тест рантайма для своего сервера: поддельный Telegram API + настоящие HTTP/SOCKS5-прокси + реальный процесс сервера.
// Запуск: node --no-warnings test/server.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createApi } = await import(path.join(ROOT, 'server/tgapi.mjs'));
const { InputFile, BotApiError } = await import(path.join(ROOT, 'server/types.mjs'));
const { signInitData, validateInitData } = await import(path.join(ROOT, 'server/initdata.mjs'));
const TOKEN = '123456:SECRET-TEST-TOKEN';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000, what = 'условие') => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(40); } throw new Error('не дождались: ' + what); };
let passed = 0; const ok = (m) => { passed++; console.log('  ✓ ' + m); };
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// ── поддельный Telegram API; принимает только то, что пришло через прокси ──
const proxiedPorts = new Set();
const fake = { calls: [], queue: [], files: {}, direct: 0, mid: 100 };
const fakeSrv = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks);
  if (!proxiedPorts.has(req.socket.remotePort)) { fake.direct++; res.writeHead(403); return res.end('direct connection not allowed'); }
  const send = (obj) => { const b = JSON.stringify(obj); res.writeHead(200, { 'content-type': 'application/json' }); res.end(b); };
  const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url), f = /^\/file\/bot([^/]+)\/files\/(.+)$/.exec(req.url);
  if (f) { const b = fake.files[f[2]]; if (!b) { res.writeHead(404); return res.end(); } res.writeHead(200); return res.end(Buffer.from(b)); }
  if (!m || m[1] !== TOKEN) return send({ ok: false, error_code: 401, description: 'Unauthorized' });
  const method = m[2], ct = req.headers['content-type'] || '';
  let params = {}, files = {};
  if (ct.startsWith('multipart/')) { const fd = await new Response(raw, { headers: { 'content-type': ct } }).formData(); for (const [k, v] of fd.entries()) { if (typeof v === 'string') params[k] = v; else files[k] = { name: v.name, type: v.type, text: await v.text() }; } }
  else params = raw.length ? JSON.parse(raw.toString()) : {};
  fake.calls.push({ method, params, files });
  if (method === 'getMe') return send({ ok: true, result: { id: 999, is_bot: true, first_name: 'Fake', username: 'fakebot' } });
  if (method === 'getUpdates') { const t = Date.now(); while (!fake.queue.length && Date.now() - t < 300) await sleep(30); return send({ ok: true, result: fake.queue.splice(0) }); }
  if (method === 'getFile') return send({ ok: true, result: { file_id: params.file_id, file_path: 'files/' + params.file_id } });
  if (['deleteWebhook', 'setWebhook', 'answerCallbackQuery'].includes(method)) return send({ ok: true, result: true });
  if (method === 'failme') return send({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } });
  return send({ ok: true, result: { message_id: ++fake.mid, chat: { id: params.chat_id }, date: 1 } });
});
await new Promise((r) => fakeSrv.listen(0, '127.0.0.1', r)); const FAKE = `http://127.0.0.1:${fakeSrv.address().port}`;

// ── HTTP-прокси (CONNECT и «абсолютный URL»), опционально с Basic-логином ──
function makeHttpProxy(creds) {
  const st = { hits: 0, denied: 0 };
  const authed = (h) => !creds || h['proxy-authorization'] === 'Basic ' + Buffer.from(creds).toString('base64');
  const srv = http.createServer((req, res) => {
    if (!authed(req.headers)) { st.denied++; res.writeHead(407, { 'proxy-authenticate': 'Basic' }); return res.end(); }
    st.hits++; const u = new URL(req.url);
    const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers, agent: false }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('socket', (s) => s.on('connect', () => proxiedPorts.add(s.localPort))); req.pipe(up);
  });
  srv.on('connect', (req, sock, head) => {
    if (!authed(req.headers)) { st.denied++; sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n'); return; }
    st.hits++; const [h, p] = req.url.split(':');
    const up = net.connect(Number(p), h, () => { proxiedPorts.add(up.localPort); sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.end()); sock.on('error', () => up.end());
  });
  return { srv, st };
}
// ── SOCKS5-прокси (без логина или user/pass) ──
function makeSocks(creds) {
  const st = { hits: [], denied: 0 };
  const srv = net.createServer((c) => {
    c.on('error', () => {});
    c.once('data', (d) => {
      const methods = [...d.subarray(2, 2 + d[1])], need = !!creds;
      if (need && !methods.includes(2)) { st.denied++; return c.end(Buffer.from([5, 0xff])); }
      c.write(Buffer.from([5, need ? 2 : 0]));
      const request = () => c.once('data', (r) => {
        let host, off; if (r[3] === 1) { host = [...r.subarray(4, 8)].join('.'); off = 8; } else if (r[3] === 3) { host = r.subarray(5, 5 + r[4]).toString(); off = 5 + r[4]; } else return c.end();
        const port = r.readUInt16BE(off); st.hits.push(`${host}:${port}`);
        const up = net.connect(port, host, () => { proxiedPorts.add(up.localPort); c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); up.pipe(c); c.pipe(up); });
        up.on('error', () => c.end());
      });
      if (need) c.once('data', (a) => { const ul = a[1], user = a.subarray(2, 2 + ul).toString(), pl = a[2 + ul], pass = a.subarray(3 + ul, 3 + ul + pl).toString();
        if (`${user}:${pass}` !== creds) { st.denied++; return c.end(Buffer.from([1, 1])); } c.write(Buffer.from([1, 0])); request(); });
      else request();
    });
  });
  return { srv, st };
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const httpPx = makeHttpProxy('px:s3cr3t!'), socksNo = makeSocks(null), socksAuth = makeSocks('su:pa:ss');   // пароль с «:» — проверяем разбор логина
const httpPort = await listen(httpPx.srv), socksNoPort = await listen(socksNo.srv), socksAuthPort = await listen(socksAuth.srv);

// ═════ 1. Клиент Bot API через разные прокси ═════
console.log('Клиент Bot API: прокси');
{
  const cases = [
    ['http с логином', `http://px:s3cr3t%21@127.0.0.1:${httpPort}`, () => httpPx.st.hits],
    ['socks5 без логина', `socks5://127.0.0.1:${socksNoPort}`, () => socksNo.st.hits.length],
    ['socks5h с логином', `socks5h://su:pa%3Ass@127.0.0.1:${socksAuthPort}`, () => socksAuth.st.hits.length],
  ];
  for (const [name, url, hits] of cases) {
    const h0 = hits(), d0 = fake.direct, api = createApi({ token: TOKEN, base: FAKE, proxy: url });
    assert.equal((await api.call('getMe')).username, 'fakebot', name);
    // JSON-запрос, multipart-загрузка файла и скачивание файла — всё через прокси
    await api.call('sendMessage', { chat_id: 5, text: 'привет «мир»', reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: 'y' }]] } });
    assert.equal(fake.calls.at(-1).params.text, 'привет «мир»'); assert.deepEqual(fake.calls.at(-1).params.reply_markup.inline_keyboard[0][0], { text: 'x', callback_data: 'y' });
    await api.call('sendDocument', { chat_id: 5, caption: 'бэкап', document: new InputFile(new TextEncoder().encode('{"привет":1}'), 'b.json', { type: 'application/json' }) });
    const doc = fake.calls.at(-1); assert.equal(doc.params.caption, 'бэкап'); assert.equal(doc.files.document.name, 'b.json'); assert.equal(doc.files.document.text, '{"привет":1}'); assert.equal(doc.files.document.type, 'application/json');
    fake.files.F1 = new TextEncoder().encode('данные файла'); assert.equal(new TextDecoder().decode(await api.fileContent('F1')), 'данные файла');
    assert.ok(hits() > h0, name + ': трафик прошёл через прокси'); assert.equal(fake.direct, d0, name + ': ни одного прямого соединения');
  }
  ok('http(с логином), socks5, socks5h(с логином и «:» в пароле): JSON, multipart-загрузка и скачивание файла идут через прокси');

  // ошибки: не раскрывают токен и пароль, понятный код
  const api429 = createApi({ token: TOKEN, base: FAKE, proxy: `socks5://127.0.0.1:${socksNoPort}` });
  await assert.rejects(() => api429.call('failme'), (e) => e instanceof BotApiError && e.code === 429 && e.parameters.retry_after === 7);
  await assert.rejects(() => createApi({ token: 'WRONG', base: FAKE, proxy: `socks5://127.0.0.1:${socksNoPort}` }).call('getMe'), (e) => e.code === 401);
  const leakCheck = (e) => { assert.ok(e instanceof BotApiError && e.code === 0, 'сетевая ошибка → code 0'); assert.ok(!e.message.includes('SECRET-TEST-TOKEN') && !e.message.includes('s3cr3t') && !e.message.includes('pa:ss'), 'в ошибке нет токена/пароля: ' + e.message); return true; };
  await assert.rejects(() => createApi({ token: TOKEN, base: FAKE, proxy: `http://px:wrong@127.0.0.1:${httpPort}` }).call('getMe'), leakCheck);
  await assert.rejects(() => createApi({ token: TOKEN, base: FAKE, proxy: `socks5://su:bad@127.0.0.1:${socksAuthPort}` }).call('getMe'), leakCheck);
  const deadPort = await freePort();
  await assert.rejects(() => createApi({ token: TOKEN, base: FAKE, proxy: `socks5://127.0.0.1:${deadPort}` }).call('getMe'), leakCheck);
  assert.ok(httpPx.st.denied >= 1 && socksAuth.st.denied >= 1, 'прокси отклонили неверные логины');
  assert.throws(() => createApi({ token: TOKEN, proxy: 'ftp://x:1' }), /не поддерживается/); assert.throws(() => createApi({ token: TOKEN, proxy: 'не адрес' }), /неверный адрес/);
  assert.throws(() => createApi({ token: '' }), /BOT_TOKEN/);
  const d1 = fake.direct; assert.equal((await createApi({ token: TOKEN, base: FAKE }).call('getMe').catch((e) => e.code)), 403, 'без прокси фальшивый API соединение не принимает (тест корректен)'); assert.equal(fake.direct, d1 + 1);
  ok('ошибки: 429 с retry_after, 401, неверный логин/недоступный прокси/плохой адрес — без утечки токена и пароля');
}

// ═════ 2. initData ═════
console.log('Подпись Telegram (initData)');
{
  const now = Math.floor(Date.now() / 1000), user = { id: 1001, first_name: 'Owner', username: 'owner' };
  const good = signInitData({ user, auth_date: now, query_id: 'Q', start_param: 'ref_5' }, TOKEN);
  const v = validateInitData(good, TOKEN); assert.equal(v.user.id, 1001); assert.equal(v.start_param, 'ref_5');
  assert.equal(validateInitData(good, 'другой:токен'), null, 'чужой токен');
  assert.equal(validateInitData(good.replace('Owner', 'Hacker'), TOKEN), null, 'подмена данных');
  assert.equal(validateInitData(good.replace(/hash=[0-9a-f]{64}/, 'hash=' + '0'.repeat(64)), TOKEN), null, 'неверный hash');
  assert.equal(validateInitData(signInitData({ user, auth_date: now - 90000 }, TOKEN), TOKEN), null, 'просрочено (>24 ч)');
  assert.equal(validateInitData(signInitData({ user, auth_date: now + 4000 }, TOKEN), TOKEN), null, 'дата из будущего');
  assert.equal(validateInitData(signInitData({ auth_date: now }, TOKEN), TOKEN), null, 'нет user');
  for (const bad of [undefined, '', 'x=1', 'hash=zz', 'a'.repeat(9000)]) assert.equal(validateInitData(bad, TOKEN), null);
  const withSig = (() => { const p = new URLSearchParams(good); p.delete('hash'); p.set('signature', 'AAAA'); return p.toString(); })();
  assert.equal(validateInitData(withSig, TOKEN), null, 'добавленное поле без пересчёта подписи не проходит');
  ok('initData: валидная проходит; чужой токен, подмена, hash, просрочка, будущее, мусор — отклоняются');
}

// ═════ 3. Реальный процесс сервера ═════
console.log('Сервер (отдельный процесс)');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kmbp-'));
async function startServer(extra = {}) {
  const port = await freePort(), logs = [];
  const env = { ...process.env, BOT_TOKEN: TOKEN, TG_API_BASE: FAKE, TG_PROXY: `http://px:s3cr3t%21@127.0.0.1:${httpPort}`, APP_URL: `http://127.0.0.1:${port}/`, OWNER_IDS: '1001',
    DB_PATH: path.join(tmp, 'bot.sqlite'), PORT: String(port), HOST: '127.0.0.1', API_RATE_PER_MIN: '40', LOG_LEVEL: 'debug', ...extra };
  const child = spawn(process.execPath, ['--no-warnings', '--import', './server/register.mjs', 'server/index.mjs'], { cwd: ROOT, env });
  child.stdout.on('data', (d) => logs.push(String(d))); child.stderr.on('data', (d) => logs.push(String(d)));
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => { try { return (await fetch(base + '/healthz')).ok; } catch (e) { return false; } }, 15000, 'запуск сервера\n' + logs.join(''));
  return { base, port, child, logs, exited, stop: async () => { child.kill('SIGTERM'); return Promise.race([exited, sleep(6000).then(() => 'timeout')]); } };
}
const update = (n, o) => ({ update_id: n, ...o });
const msg = (from, text, extra = {}) => ({ message: { message_id: ++fake.mid, from: { id: from, is_bot: false, first_name: 'U' + from, username: 'u' + from }, chat: { id: from, type: 'private' }, date: 1, text, ...extra } });
const sent = (chat, re) => fake.calls.some((c) => /^send(Rich)?Message$/.test(c.method) && c.params.chat_id === chat && (!re || re.test(JSON.stringify(c.params))));
const initFor = (id, extra = {}) => signInitData({ user: { id, first_name: 'U' + id, username: 'u' + id }, auth_date: Math.floor(Date.now() / 1000), ...extra }, TOKEN);
const post = (s, name, body, init) => fetch(`${s.base}/api/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(init ? { 'x-init-data': init } : {}) }, body: JSON.stringify(body || {}) });

const DIRECT0 = fake.direct;   // один прямой запрос сделан намеренно выше — дальше новых быть не должно
let S1 = await startServer();
{
  // запуск: бот узнан, схема создана, адрес мини-аппа из окружения
  await waitFor(() => fake.calls.some((c) => c.method === 'getMe') && fake.calls.some((c) => c.method === 'deleteWebhook') && fake.calls.some((c) => c.method === 'getUpdates'), 8000, 'getMe/deleteWebhook/getUpdates');
  assert.ok(S1.logs.join('').includes('Бот: @fakebot')); assert.ok(S1.logs.join('').includes('через прокси http://***@127.0.0.1'), 'пароль прокси в логе замаскирован');
  assert.ok(!S1.logs.join('').includes('SECRET-TEST-TOKEN') && !S1.logs.join('').includes('s3cr3t'), 'токен и пароль прокси не попали в лог');
  ok('старт: схема создана, бот узнан через прокси, webhook платформы снят, токен и пароль в логах не видны');

  // сообщение → обработчик → ответ в Telegram, всё через прокси
  const h0 = httpPx.st.hits; fake.queue.push(update(1, msg(1001, '/start')));
  await waitFor(() => sent(1001), 8000, 'ответ на /start'); assert.equal(fake.direct, DIRECT0, 'нет прямых соединений'); assert.ok(httpPx.st.hits >= h0);
  fake.queue.push(update(2, msg(1001, '/admin'))); await waitFor(() => sent(1001, /Админ-панель/), 8000, 'админ-панель');
  ok('long polling: /start и /admin обработаны, ответы ушли через прокси (прямых соединений: 0)');

  // статика
  const idx = await fetch(S1.base + '/'); assert.equal(idx.status, 200); assert.match(idx.headers.get('content-type'), /text\/html/); const html = await idx.text(); assert.match(html, /fx\.js/);
  const js = await fetch(S1.base + '/fx.js'); assert.match(js.headers.get('content-type'), /javascript/); const et = js.headers.get('etag'); assert.ok(et);
  assert.equal((await fetch(S1.base + '/fx.js', { headers: { 'if-none-match': et } })).status, 304, 'ETag → 304');
  assert.equal((await fetch(S1.base + '/img/hero.jpg')).headers.get('content-type'), 'image/jpeg');
  for (const bad of ['/../package.json', '/%2e%2e/package.json', '/..%2f..%2fetc/passwd', '/%00', '/nope.html', '/img/', '/server/index.mjs']) { const r = await fetch(S1.base + bad); assert.ok([400, 404].includes(r.status), `${bad} → ${r.status}`); assert.ok(!(await r.text()).includes('BOT_TOKEN')); }
  assert.equal((await fetch(S1.base + '/', { method: 'PUT' })).status, 405);
  ok('статика: html/js/картинки, ETag→304; выход за папку и служебные файлы недоступны');

  // API мини-аппа
  const init = initFor(2002);
  let r = await post(S1, 'getHome', {}, init); let j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.ok, true); assert.ok(j.result.nominations.length >= 3); assert.equal(j.result.user.id, 2002);
  r = await post(S1, 'getHome', {}); assert.equal(r.status, 401); assert.equal((await r.json()).parameters.code, 'AUTH');
  assert.equal((await post(S1, 'getHome', {}, init.replace(/hash=[0-9a-f]{64}/, 'hash=' + 'a'.repeat(64)))).status, 401);
  assert.equal((await post(S1, 'getHome', {}, signInitData({ user: { id: 1 }, auth_date: Math.floor(Date.now() / 1000) }, 'чужой:токен'))).status, 401);
  assert.equal((await post(S1, 'diag', {}, init)).status, 404, 'служебный модуль diag снаружи недоступен');
  assert.equal((await post(S1, 'nothere', {}, init)).status, 404); assert.equal((await post(S1, '..%2f..%2fserver%2findex', {}, init)).status, 404); assert.equal((await post(S1, 'getHome%00', {}, init)).status, 404);
  j = await (await post(S1, 'getNomination', { id: 99999 }, init)).json(); assert.equal(j.ok, false); assert.equal(j.parameters.code, 'NOT_FOUND'); assert.match(j.description, /не найдена/);
  r = await fetch(`${S1.base}/api/getHome`, { method: 'POST', headers: { 'x-init-data': init, 'content-type': 'application/json' }, body: '{ не json' }); assert.equal(r.status, 400);
  r = await fetch(`${S1.base}/api/getHome`, { method: 'POST', headers: { 'x-init-data': init }, body: 'x'.repeat(300000) }); assert.equal(r.status, 413, 'слишком большое тело — понятный отказ, а не обрыв соединения');
  // капча → отправка заявки через API (как это делает мини-апп)
  const cap = (await (await post(S1, 'getCaptcha', {}, init)).json()).result; assert.match(cap.src, /^data:image\/svg\+xml;base64,/);
  const wrong = await (await post(S1, 'submit', { nominationId: 1, title: 'X', username: 'x_bot', description: 'описание описание описание', answers: {}, captcha: { id: cap.id, answer: 'WRONG' }, defer: true }, init)).json();
  assert.equal(wrong.ok, false); assert.equal(wrong.parameters.code, 'CAPTCHA');
  ok('API: подпись обязательна; чужой токен/подделка/мусор/выход из папки/служебный diag — отказ; EndpointError доходит до клиента с кодом');

  // лимит запросов на пользователя (в тесте 40/мин)
  let limited = 0; for (let i = 0; i < 60; i++) { const x = await post(S1, 'getBanner', {}, initFor(3003)); if (x.status === 429) limited++; }
  assert.ok(limited >= 15, 'после лимита — 429, получено: ' + limited); assert.equal((await post(S1, 'getHome', {}, initFor(3004))).status, 200, 'другому пользователю лимит не мешает');
  ok('лимит запросов: 429 для перегрузившего, остальным не мешает');

  // рефералы в реальном рантайме
  fake.queue.push(update(3, msg(2020, '/start ref_1001'))); fake.queue.push(update(31, msg(2002, '/start ref_1001'))); await waitFor(() => sent(2020) && sent(2002), 8000, 'ответы обоим');
  fake.queue.push(update(4, msg(1001, '/invite'))); await waitFor(() => sent(1001, /t\.me\/fakebot\?start=ref_1001/), 8000, 'ссылка приглашения с именем бота из getMe');
  ok('рефералы: новый по ссылке привязан, уже знакомый — нет; ссылка собрана из имени бота (getMe)');

  // кнопка «Загрузить базу из файла»: скачивание файла и бэкап multipart — через прокси
  const backup = { exported_at: 1790000000, tables: { nominations: [{ id: 7, title: 'Перенесённая номинация', kind: 'bot', sponsor_type: null, sponsor_only: 0, is_open: 1, active: 1, position: 1, created_at: 1 }],
    users: [{ id: 4004, username: 'old_user', first_name: 'Старый', started: 1, blocked: 0, first_seen: 1, last_seen: 1 }], settings: [{ key: 'about', value: 'Текст из выгрузки' }, { key: 'app_url', value: 'https://old-platform.example/' }] } };
  fake.files.DB1 = new TextEncoder().encode(JSON.stringify(backup));
  const cb = (data) => ({ callback_query: { id: 'cq' + ++fake.mid, from: { id: 1001, is_bot: false, first_name: 'Owner' }, data, message: { message_id: 50, chat: { id: 1001, type: 'private' } } } });
  fake.queue.push(update(5, cb('a:rst'))); await waitFor(() => fake.calls.some((c) => c.method === 'editMessageText' && /Пришлите файл выгрузки/.test(JSON.stringify(c.params))), 8000, 'приглашение прислать файл');
  fake.queue.push(update(6, msg(1001, '', { document: { file_id: 'DB1', file_size: 500 } }))); await waitFor(() => sent(1001, /Выгрузка базы/), 8000, 'превью выгрузки');
  const docs0 = fake.calls.filter((c) => c.method === 'sendDocument').length;
  fake.queue.push(update(7, cb('a:rstgo:replace'))); await waitFor(() => sent(1001, /База загружена/), 10000, 'результат загрузки');
  const docs = fake.calls.filter((c) => c.method === 'sendDocument').slice(docs0);
  assert.ok(docs.length >= 1 && docs.some((d) => /kmbp-backup/.test(d.files.document?.name || '')), 'перед заменой ушла резервная копия (multipart через прокси)');
  const bk = JSON.parse(docs.find((d) => /kmbp-backup/.test(d.files.document.name)).files.document.text); assert.ok(bk.tables.users.length >= 2, 'в резервной копии были текущие пользователи');
  assert.equal(fake.direct, DIRECT0, 'и скачивание файла, и отправка бэкапа — только через прокси');
  ok('кнопка «Загрузить базу»: файл скачан и применён, резервная копия отправлена multipart-ом — всё через прокси');

  // состояние в файле базы
  const peek = new DatabaseSync(path.join(tmp, 'bot.sqlite'), { readOnly: true });
  const tables = peek.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((x) => x.name);
  for (const t of ['users', 'applications', 'nominations', 'settings', 'referrals', 'coin_log', 'reminders', 'owners']) assert.ok(tables.includes(t), 'таблица ' + t);
  assert.equal(peek.prepare('SELECT referrer_id FROM referrals WHERE user_id = 2020').get()?.referrer_id, 1001, 'новый пользователь привязан');
  assert.equal(peek.prepare('SELECT COUNT(*) AS n FROM referrals WHERE user_id = 2002').get().n, 0, 'пользователь 2002 уже заходил в мини-апп — он не новый, не привязывается');
  assert.equal(peek.prepare("SELECT value FROM settings WHERE key = 'app_url'").get().value, `http://127.0.0.1:${S1.port}/`, 'app_url из окружения не затёрт выгрузкой');
  assert.equal(peek.prepare("SELECT value FROM settings WHERE key = 'about'").get().value, 'Текст из выгрузки');
  assert.equal(peek.prepare("SELECT title FROM nominations WHERE id = 7").get().title, 'Перенесённая номинация');
  assert.equal(peek.prepare('SELECT COUNT(*) AS n FROM nominations').get().n, 1, 'замена очистила прежние номинации');
  peek.close();
  ok('база: все таблицы созданы автоматически, реферал записан, данные из выгрузки загружены, адрес мини-аппа сохранён');
}
const code1 = await S1.stop(); assert.equal(code1, 0, 'штатная остановка по SIGTERM, код ' + code1);
assert.ok(S1.logs.join('').includes('останавливаюсь'));
ok('остановка по SIGTERM: код 0');

// перезапуск на той же базе: данные на месте, схема не пересоздаётся
let S2 = await startServer();
{
  await waitFor(() => S2.logs.join('').includes('Готово.'), 8000, 'готовность');
  assert.ok(!S2.logs.join('').includes('Созданы таблицы'), 'таблицы уже есть');
  const peek = new DatabaseSync(path.join(tmp, 'bot.sqlite'), { readOnly: true }); assert.equal(peek.prepare('SELECT username FROM users WHERE id = 4004').get().username, 'old_user'); peek.close();
  ok('перезапуск: данные сохранились, схема не пересоздавалась');
}
await S2.stop();

// режим webhook
let S3 = await startServer({ UPDATES: 'webhook' });
{
  const secret = createHash('sha256').update('kmbp-webhook:' + TOKEN).digest('hex').slice(0, 32);
  const wh = await waitFor(() => fake.calls.filter((c) => c.method === 'setWebhook').at(-1), 8000, 'setWebhook');
  assert.equal(wh.params.url, `${S3.base}/webhook/${secret}`); assert.equal(wh.params.secret_token, secret);
  const upd = update(10, msg(5005, '/start')), post2 = (p, h) => fetch(S3.base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(upd) });
  assert.equal((await post2('/webhook/wrong', { 'x-telegram-bot-api-secret-token': secret })).status, 404, 'чужой путь');
  assert.equal((await post2('/webhook/' + secret, {})).status, 403, 'без секретного заголовка');
  assert.equal((await post2('/webhook/' + secret, { 'x-telegram-bot-api-secret-token': 'bad' })).status, 403);
  assert.equal(sent(5005), false, 'отклонённые запросы ничего не запустили');
  assert.equal((await post2('/webhook/' + secret, { 'x-telegram-bot-api-secret-token': secret })).status, 200);
  await waitFor(() => sent(5005), 8000, 'ответ на update из webhook');
  ok('режим webhook: setWebhook с секретом; чужой путь/без заголовка/неверный секрет отклонены; верный update обработан');
}
await S3.stop();

fakeSrv.close(); httpPx.srv.close(); socksNo.srv.close(); socksAuth.srv.close(); fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nГотово: ${passed} проверок прошли`); process.exit(0);
