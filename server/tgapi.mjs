// Клиент Bot API: любой метод — api.method({...}). Прокси (TG_PROXY) и зеркало API (TG_API_BASE) — для регионов, где Telegram недоступен.
import { fetch, FormData, ProxyAgent } from 'undici';
import { socksDispatcher } from 'fetch-socks';
import { BotApiError, InputFile } from './types.mjs';

// http(s)://[user:pass@]host:port — через HTTP CONNECT; socks4://, socks5://, socks5h:// [user:pass@]host:port — через SOCKS.
export function makeDispatcher(proxy) {
  if (!proxy) return undefined;
  let u;
  try { u = new URL(proxy); } catch (e) { throw new Error('TG_PROXY: неверный адрес (ожидается, например, socks5://user:pass@host:1080 или http://host:3128)'); }
  const proto = u.protocol.replace(':', '');
  if (proto === 'http' || proto === 'https') return new ProxyAgent({ uri: proxy });
  if (proto.startsWith('socks')) {
    return socksDispatcher({
      type: proto.startsWith('socks4') ? 4 : 5, host: u.hostname, port: Number(u.port) || 1080,
      userId: u.username ? decodeURIComponent(u.username) : undefined, password: u.password ? decodeURIComponent(u.password) : undefined,
    });
  }
  throw new Error(`TG_PROXY: схема «${proto}» не поддерживается (нужны http, https, socks4, socks5)`);
}

export function createApi({ token, base = 'https://api.telegram.org', proxy } = {}) {
  if (!token) throw new Error('Не задан BOT_TOKEN');
  base = String(base || 'https://api.telegram.org').replace(/\/+$/, '');
  const dispatcher = makeDispatcher(proxy);
  const clean = (s) => String(s).split(token).join('<token>');   // токен никогда не попадает в тексты ошибок и логи

  async function call(method, params = {}) {
    const url = `${base}/bot${token}/${method}`;
    let init;
    if (Object.values(params).some((v) => v instanceof InputFile)) {
      const form = new FormData();
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        if (v instanceof InputFile) form.append(k, new Blob([v.bytes], { type: v.type || 'application/octet-stream' }), v.name || 'file');
        else form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      init = { method: 'POST', body: form };
    } else init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) };
    const wait = method === 'getUpdates' ? (Number(params.timeout) || 0) * 1000 + 20000 : 60000;
    let res;
    try { res = await fetch(url, { ...init, dispatcher, signal: AbortSignal.timeout(wait) }); }
    catch (e) { throw new BotApiError(0, clean('network: ' + (e.cause?.message || e.message)), method); }
    let j;
    try { j = await res.json(); } catch (e) { throw new BotApiError(res.status, `bad response (HTTP ${res.status})`, method); }
    if (!j.ok) throw new BotApiError(j.error_code || res.status, j.description || 'error', method, j.parameters);
    return j.result;
  }

  // Скачать файл по file_id (платформенный api.getFileContent).
  async function fileContent(fileId) {
    const f = await call('getFile', { file_id: fileId });
    let res;
    try { res = await fetch(`${base}/file/bot${token}/${f.file_path}`, { dispatcher, signal: AbortSignal.timeout(120000) }); }
    catch (e) { throw new BotApiError(0, clean('network: ' + (e.cause?.message || e.message)), 'getFile'); }
    if (!res.ok) throw new BotApiError(res.status, 'file download failed', 'getFile');
    return new Uint8Array(await res.arrayBuffer());
  }
  return { call, fileContent };
}
