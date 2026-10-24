// HTTP-сервер: статика мини-аппа (app/), POST /api/<функция>, GET /m/… (баннеры по подписанным ссылкам), POST /webhook/<секрет>.
// Вход: либо подпись Telegram (initData в заголовке), либо HttpOnly-cookie сессии браузера (вход через бота).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateInitData } from './initdata.mjs';
import { EndpointError } from './types.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gif': 'image/gif', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const BLOCKED = new Set(['diag']);                       // служебные модули наружу не отдаём
const PUBLIC = new Set(['authStart', 'authPoll']);       // единственные функции, которые работают без входа
const BODY_LIMIT = { r2admin: 1100000 };                 // загрузка баннера карточки (base64); остальным хватает малого тела
const DEFAULT_BODY = 131072;
const COOKIE = 'kmbp_s';

export function createWebServer({ appDir, endpointsDir, token, rateLimit = 240, webhook = null, log = () => {}, hooks = {}, trustProxy = false, secure = false }) {
  appDir = path.resolve(appDir);
  const cache = new Map();
  async function loadEndpoint(name) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(name) || BLOCKED.has(name)) return null;
    if (cache.has(name)) return cache.get(name);
    const file = path.join(endpointsDir, name + '.js');
    if (!fs.existsSync(file)) return null;
    const fn = (await import(pathToFileURL(file).href)).default;
    cache.set(name, fn); return fn;
  }

  // ── лимиты запросов: на пользователя (после входа) и на IP (до любой работы с подписью/базой) ──
  const counters = new Map();
  const over = (key, max, windowMs = 60000) => {
    const t = Date.now(); let h = counters.get(key);
    if (!h || t - h.t0 > windowMs) { h = { t0: t, n: 0, w: windowMs }; counters.set(key, h); }
    return ++h.n > max;
  };
  setInterval(() => { const t = Date.now(); for (const [k, h] of counters) if (t - h.t0 > h.w) counters.delete(k); if (counters.size > 300000) counters.clear(); }, 120000).unref();

  // Адрес клиента. За обратным прокси (Caddy) доверяем ПОСЛЕДНЕМУ адресу из X-Forwarded-For (его дописал наш прокси) — только если TRUST_PROXY=1.
  const clientIp = (req) => {
    if (trustProxy) {
      const xf = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (xf.length) return xf[xf.length - 1];
    }
    return req.socket.remoteAddress || '';
  };
  const cookieOf = (req, name) => {
    const h = req.headers.cookie; if (!h) return null;
    for (const part of String(h).split(';')) { const i = part.indexOf('='); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); }
    return null;
  };
  // Запрос с cookie обязан прийти с нашего же сайта (дополнительно к SameSite=Lax).
  const sameSite = (req) => {
    const sfs = req.headers['sec-fetch-site'];
    if (sfs && sfs !== 'same-origin' && sfs !== 'none') return false;
    const o = req.headers.origin;
    if (o) { try { return new URL(o).host === req.headers.host; } catch (e) { return false; } }
    return true;
  };

  const json = (res, code, obj, cookies) => {
    const b = JSON.stringify(obj);
    const h = { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (cookies && cookies.length) h['set-cookie'] = cookies;
    res.writeHead(code, h); res.end(b);
  };
  const readBody = (req, max) => new Promise((resolve, reject) => {
    let n = 0; const ch = [];
    let over_ = false;
    req.on('data', (c) => { n += c.length; if (over_) return; if (n > max) { over_ = true; ch.length = 0; reject(new Error('too large')); } else ch.push(c); });   // лишнее дочитываем и выбрасываем — ответ дойдёт до клиента
    req.on('end', () => { if (!over_) resolve(Buffer.concat(ch).toString('utf8')); }); req.on('error', reject);
  });

  async function callEndpoint(req, res, name) {
    const ip = clientIp(req);
    if (over('ip:' + ip, 600)) return json(res, 429, { ok: false, description: 'Слишком много запросов с вашего адреса', parameters: { code: 'RATE' } });
    if (PUBLIC.has(name) && over('pub:' + ip, 40)) return json(res, 429, { ok: false, description: 'Слишком много запросов, подождите минуту', parameters: { code: 'RATE' } });
    let input = {};
    let bodyText = '';
    try { bodyText = await readBody(req, BODY_LIMIT[name] || DEFAULT_BODY); input = bodyText ? JSON.parse(bodyText) : {}; if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('shape'); }
    catch (e) { return e.message === 'too large' ? json(res, 413, { ok: false, description: 'Слишком большой запрос' }) : json(res, 400, { ok: false, description: 'Bad request' }); }
    // initData ищем в заголовке X-Init-Data, а если его нет (прокси/WebView могли убрать заголовок) — в теле запроса, поле _init
    const rawInit = req.headers['x-init-data'] || (typeof input._init === 'string' ? input._init : undefined);
    delete input._init;

    let auth = validateInitData(rawInit, token);
    let sessionToken = null;
    if (auth) auth.via = 'tg';
    else {
      const ck = cookieOf(req, COOKIE);
      if (ck && hooks.resolveSession) {
        if (!sameSite(req)) return json(res, 403, { ok: false, description: 'Запрос с чужого сайта отклонён', parameters: { code: 'ORIGIN' } });
        const u = await hooks.resolveSession(ck);
        if (u) { auth = { user: u, auth_date: Math.floor(Date.now() / 1000), start_param: null, query_id: null, via: 'web' }; sessionToken = ck; }
      }
    }
    if (!auth && !PUBLIC.has(name)) {
      if (!over('authlog:' + ip, 3, 60000)) {   // диагностика без флуда: максимум 3 записи в минуту с адреса (сам токен и initData в лог не пишем)
        const hasHash = !!rawInit && /(^|&)hash=/.test(String(rawInit));
        log('warn', `AUTH ${name}: нет входа — initData ${rawInit === undefined ? 'не передан' : rawInit === '' ? 'пустой' : 'отклонён (' + String(rawInit).length + ' симв.)'}, hash ${hasHash ? 'есть' : 'нет'}, cookie ${cookieOf(req, COOKIE) ? 'есть' : 'нет'}, UA=${String(req.headers['user-agent'] || '').slice(0, 60)}`);
      }
      return json(res, 401, { ok: false, description: 'Войдите через Telegram', parameters: { code: 'AUTH' } });
    }
    const fn = await loadEndpoint(name);
    if (!fn) return json(res, 404, { ok: false, description: 'Not found' });
    if (auth && over('u:' + auth.user.id, rateLimit)) return json(res, 429, { ok: false, description: 'Слишком много запросов, подождите минуту', parameters: { code: 'RATE' } });
    const cookies = [];
    const ctx = { initData: auth, ip, ua: String(req.headers['user-agent'] || ''), secure, sessionToken, setCookie: (c) => cookies.push(c) };
    try {
      const result = await fn(input, ctx);
      return json(res, 200, { ok: true, result: result === undefined ? null : result }, cookies);
    } catch (e) {
      if (e instanceof EndpointError || e?.isEndpointError) return json(res, 200, { ok: false, description: e.description, parameters: e.parameters }, cookies);
      log('error', 'endpoint', name, e?.stack || e);
      return json(res, 500, { ok: false, description: 'Внутренняя ошибка сервера' });
    }
  }

  // ── Защита статики ──────────────────────────────────────────────────────
  // Скрипты/стили/картинки отдаём только когда их подтягивает сама страница. Открыты напрямую (адресная строка, ссылка в чате) — 403.
  // Это не «шифрование» кода (JS всё равно виден в DevTools). Настоящая защита — на сервере: подпись Telegram или сессия для каждого /api-запроса.
  const PAGE_EXT = new Set(['.html', '']);
  const framing = "https://web.telegram.org https://webk.telegram.org https://webz.telegram.org https://telegram.org";
  const CSP = [
    "default-src 'none'", "script-src 'self' https://telegram.org", "style-src 'self'", "img-src 'self' data: blob:", "font-src 'self'",
    "connect-src 'self'", "manifest-src 'self'", `frame-ancestors 'self' ${framing}`, "base-uri 'none'", "form-action 'none'", "object-src 'none'",
  ].join('; ');
  // Сайт 1 тура (/r1/) собран со style="…" внутри разметки, поэтому ему разрешены inline-стили. Скрипты и там только свои + telegram.org.
  const CSP_R1 = CSP.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'");
  const SEC_HEADERS = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'content-security-policy': CSP,
    'cross-origin-resource-policy': 'same-origin',
    ...(secure ? { 'strict-transport-security': 'max-age=31536000' } : {}),
  };
  const forbidden = (res) => {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS });
    res.end('403 Forbidden');
  };
  function isDirectOpen(req, ext) {
    if (PAGE_EXT.has(ext)) return false;                         // саму страницу открывают как документ — её не блокируем
    const h = req.headers;
    const dest = h['sec-fetch-dest'], mode = h['sec-fetch-mode'], user = h['sec-fetch-user'];
    if (dest === 'document' || dest === 'iframe' || dest === 'frame' || mode === 'navigate' || user === '?1') return true;
    if (!dest && /^text\/html/i.test(String(h.accept || ''))) return true;   // старые браузеры без Sec-Fetch-*
    return false;
  }

  function serveStatic(req, res, pathname) {
    let rel; try { rel = decodeURIComponent(pathname); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
    if (rel.includes('\0')) { res.writeHead(400); return res.end('Bad request'); }
    if (rel.endsWith('/')) rel += 'index.html';
    if (/(^|\/)\.|\.map$|\.(env|bak|sqlite|db|log|md|json|mjs)$/i.test(rel)) return forbidden(res);   // dotfiles, source maps, служебные файлы — никогда
    const ext = path.extname(rel).toLowerCase();
    if (isDirectOpen(req, ext)) return forbidden(res);
    const file = path.normalize(path.join(appDir, rel));
    if (file !== appDir && !file.startsWith(appDir + path.sep)) { res.writeHead(404); return res.end('Not found'); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, SEC_HEADERS); return res.end('Not found'); }
      const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, ...SEC_HEADERS }); return res.end(); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, etag, 'cache-control': 'no-cache', ...SEC_HEADERS, ...(rel.startsWith('/r1/') ? { 'content-security-policy': CSP_R1 } : {}) });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  // Баннеры карточек: адрес подписан (id + версия картинки), поэтому подобрать чужой нельзя, а после замены картинки старые ссылки гаснут.
  async function serveMedia(req, res, m, url) {
    if (over('media:' + clientIp(req), 400)) { res.writeHead(429); return res.end(); }
    let buf = null;
    try { buf = hooks.media ? await hooks.media(m[1], m[2], url.searchParams.get('v'), url.searchParams.get('s')) : null; } catch (e) { log('warn', 'media', e?.message || e); }
    if (!buf) { res.writeHead(404, { 'cache-control': 'no-store', ...SEC_HEADERS }); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'private, max-age=31536000, immutable', ...SEC_HEADERS, 'content-security-policy': "default-src 'none'; sandbox" });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      if (p === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
      if (req.method === 'POST' && p.startsWith('/api/')) return await callEndpoint(req, res, p.slice(5));
      if (req.method === 'POST' && webhook && p === `/webhook/${webhook.secret}`) {
        if (req.headers['x-telegram-bot-api-secret-token'] !== webhook.secret) { res.writeHead(403); return res.end(); }
        let upd; try { upd = JSON.parse(await readBody(req, 1048576)); } catch (e) { res.writeHead(e.message === 'too large' ? 413 : 400); return res.end(); }
        webhook.onUpdate(upd); res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}');
      }
      if (req.method === 'GET' && p === '/r1') { res.writeHead(301, { location: '/r1/' + url.search }); return res.end(); }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const mm = /^\/m\/(p)\/(\d{1,9})\.jpg$/.exec(p);
        if (mm) return await serveMedia(req, res, mm, url);
        return serveStatic(req, res, p);
      }
      res.writeHead(req.method === 'POST' ? 404 : 405); res.end(req.method === 'POST' ? 'Not found' : 'Method not allowed');
    } catch (e) { log('error', 'http', e?.stack || e); if (!res.headersSent) { res.writeHead(500); } res.end(); }
  });
  // Защита от медленных соединений (slowloris) и зависших запросов.
  server.headersTimeout = 20000; server.requestTimeout = 40000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 60;
  return server;
}
