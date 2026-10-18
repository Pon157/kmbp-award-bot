// HTTP-сервер: статика мини-аппа (app/), POST /api/<функция> (вместо Serverless.call), POST /webhook/<секрет> (если режим webhook).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateInitData } from './initdata.mjs';
import { EndpointError } from './types.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gif': 'image/gif', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const BLOCKED = new Set(['diag']);   // служебные модули наружу не отдаём

export function createWebServer({ appDir, endpointsDir, token, rateLimit = 240, webhook = null, log = () => {} }) {
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
  // простой лимит запросов на пользователя (на платформе его делал сам Serverless)
  const hits = new Map();
  const limited = (uid) => { const t = Date.now(); let h = hits.get(uid); if (!h || t - h.t0 > 60000) { h = { t0: t, n: 0 }; hits.set(uid, h); } return ++h.n > rateLimit; };
  setInterval(() => { const t = Date.now(); for (const [k, h] of hits) if (t - h.t0 > 60000) hits.delete(k); }, 300000).unref();

  const json = (res, code, obj) => {
    const b = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(b);
  };
  const readBody = (req, max) => new Promise((resolve, reject) => {
    let n = 0; const ch = [];
    let over = false;
    req.on('data', (c) => { n += c.length; if (over) return; if (n > max) { over = true; ch.length = 0; reject(new Error('too large')); } else ch.push(c); });   // лишнее дочитываем и выбрасываем — ответ дойдёт до клиента
    req.on('end', () => { if (!over) resolve(Buffer.concat(ch).toString('utf8')); }); req.on('error', reject);
  });

  async function callEndpoint(req, res, name) {
    // initData ищем в заголовке X-Init-Data, а если его нет (прокси/WebView могли убрать заголовок) — в теле запроса, поле _init
    let input = {};
    let bodyText = '';
    try { bodyText = await readBody(req, 262144); input = bodyText ? JSON.parse(bodyText) : {}; }
    catch (e) { return e.message === 'too large' ? json(res, 413, { ok: false, description: 'Слишком большой запрос' }) : json(res, 400, { ok: false, description: 'Bad request' }); }
    const rawInit = req.headers['x-init-data'] || (typeof input._init === 'string' ? input._init : undefined);
    delete input._init;
    const auth = validateInitData(rawInit, token);
    if (!auth) {
      // диагностика: почему не прошла проверка подписи (сам токен и initData в лог не пишем)
      const hasHash = !!rawInit && /(^|&)hash=/.test(String(rawInit));
      const ad = rawInit ? Number(new URLSearchParams(String(rawInit)).get('auth_date')) : 0;
      const age = ad ? Math.round(Date.now() / 1000 - ad) : null;
      // что реально пришло: имена заголовков, ключи тела, начало User-Agent
      const hdrNames = Object.keys(req.headers).filter((h) => !/^(cookie|authorization)$/i.test(h)).join(',');
      const bodyKeys = (() => { try { return Object.keys(JSON.parse(bodyText || '{}')).join(',') || '(пусто)'; } catch (e) { return '(не JSON, ' + (bodyText || '').length + ' байт)'; } })();
      log('warn', `AUTH ${name}: заголовки=[${hdrNames}] ключи_тела=[${bodyKeys}] UA=${String(req.headers['user-agent'] || '').slice(0, 60)}`);
      log('warn', `AUTH ${name}: initData отклонён — заголовок ${rawInit === undefined ? 'НЕ ПЕРЕДАН' : rawInit === '' ? 'ПУСТОЙ (initData пуст на клиенте)' : 'есть (' + String(rawInit).length + ' симв.)'}, hash ${hasHash ? 'есть' : 'нет'}, возраст auth_date ${age ?? '—'} c, bot_id=${String(token).split(':')[0]}`);
      return json(res, 401, { ok: false, description: 'Откройте мини-апп из Telegram', parameters: { code: 'AUTH' } }); }
    const fn = await loadEndpoint(name);
    if (!fn) return json(res, 404, { ok: false, description: 'Not found' });
    if (limited(auth.user.id)) return json(res, 429, { ok: false, description: 'Слишком много запросов, подождите минуту', parameters: { code: 'RATE' } });
    try {
      const result = await fn(input, { initData: auth });
      return json(res, 200, { ok: true, result: result === undefined ? null : result });
    } catch (e) {
      if (e instanceof EndpointError || e?.isEndpointError) return json(res, 200, { ok: false, description: e.description, parameters: e.parameters });
      log('error', 'endpoint', name, e?.stack || e);
      return json(res, 500, { ok: false, description: 'Внутренняя ошибка сервера' });
    }
  }


  // ── Защита статики ──────────────────────────────────────────────────────
  // Скрипты/стили/картинки отдаём только когда их подтягивает сама страница мини-аппа.
  // Если ресурс открыт напрямую (адресная строка браузера, ссылка в чате) — 403 Forbidden.
  // Важно: это не «шифрование» кода. JS всё равно выполняется в браузере, и тот, кто умеет curl/DevTools, его увидит.
  // Настоящая защита — на сервере: проверка подписи initData для каждого /api-запроса (уже сделано).
  const PAGE_EXT = new Set(['.html', '']);
  const SEC_HEADERS = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    // Telegram Web (web.telegram.org) открывает мини-апп во фрейме — поэтому frame-ancestors, а не X-Frame-Options: DENY
    'content-security-policy': "frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org https://webz.telegram.org https://telegram.org; object-src 'none'; base-uri 'self'",
  };
  const forbidden = (res) => {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS });
    res.end('403 Forbidden');
  };
  function isDirectOpen(req, ext) {
    if (PAGE_EXT.has(ext)) return false;                         // саму страницу Telegram открывает как документ — её не блокируем
    const h = req.headers;
    const dest = h['sec-fetch-dest'], mode = h['sec-fetch-mode'], user = h['sec-fetch-user'];
    if (dest === 'document' || dest === 'iframe' || dest === 'frame' || mode === 'navigate' || user === '?1') return true;
    // Старые браузеры без Sec-Fetch-*: адресная строка шлёт Accept: text/html..., а <script>/<link>/<img> — */* или image/*
    if (!dest && /^text\/html/i.test(String(h.accept || ''))) return true;
    return false;
  }

  function serveStatic(req, res, pathname) {
    let rel; try { rel = decodeURIComponent(pathname); } catch (e) { res.writeHead(400); return res.end('Bad request'); }
    if (rel.includes('\0')) { res.writeHead(400); return res.end('Bad request'); }
    if (rel.endsWith('/')) rel += 'index.html';
    // dotfiles, source maps, служебные файлы — никогда
    if (/(^|\/)\.|\.map$|\.(env|bak|sqlite|db|log|md|json|mjs)$/i.test(rel)) return forbidden(res);
    const ext = path.extname(rel).toLowerCase();
    if (isDirectOpen(req, ext)) return forbidden(res);
    const file = path.normalize(path.join(appDir, rel));
    if (file !== appDir && !file.startsWith(appDir + path.sep)) { res.writeHead(404); return res.end('Not found'); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, SEC_HEADERS); return res.end('Not found'); }
      const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, etag, 'cache-control': 'no-cache', ...SEC_HEADERS });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  return http.createServer(async (req, res) => {
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
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);
      res.writeHead(req.method === 'POST' ? 404 : 405); res.end(req.method === 'POST' ? 'Not found' : 'Method not allowed');
    } catch (e) { log('error', 'http', e?.stack || e); if (!res.headersSent) { res.writeHead(500); } res.end(); }
  });
}
