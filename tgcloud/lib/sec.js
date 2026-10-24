// Безопасность 2 тура: хэши, подписи, случайные токены, лимиты частоты.
// Работает только на своём сервере (Node): использует node:crypto.
import { createHash, createHmac, randomBytes, randomInt as nodeRandomInt, timingSafeEqual } from 'node:crypto';
import { EndpointError } from 'sdk';

const secretKey = () => String(globalThis.process?.env?.KMBP_SECRET || globalThis.process?.env?.BOT_TOKEN || 'dev-secret-change-me');

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
export const hmacHex = (label, data, len = 32) => createHmac('sha256', secretKey()).update(label + '\0' + String(data)).digest('hex').slice(0, len);
export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');
export const randomInt = (min, max) => nodeRandomInt(min, max);   // [min, max)
export function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ── IP / User-Agent: в базе хранятся только необратимые хэши (с секретом сервера) ──
export function ipParts(ip) {
  let s = String(ip || '').trim().toLowerCase();
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return { full: s, net: s.split('.').slice(0, 3).join('.') + '.0/24', mask: s.split('.').slice(0, 2).join('.') + '.•.•' };
  if (s.includes(':')) {
    const parts = s.split(':').filter((x, i, a) => x !== '' || i === 0 || i === a.length - 1);
    return { full: s, net: parts.slice(0, 3).join(':') + '::/48', mask: parts.slice(0, 2).join(':') + ':•' };
  }
  return { full: s || 'unknown', net: s || 'unknown', mask: '•' };
}
export function ipInfo(ip) {
  const p = ipParts(ip);
  return { ipHash: hmacHex('ip', p.full, 24), netHash: hmacHex('net', p.net, 24), mask: p.mask };
}
export const uaHash = (ua) => hmacHex('ua', String(ua || '').slice(0, 300), 16);

export function uaLabel(ua) {
  const s = String(ua || '');
  const br = /YaBrowser/i.test(s) ? 'Яндекс Браузер' : /Edg\//i.test(s) ? 'Edge' : /OPR\/|Opera/i.test(s) ? 'Opera' : /Firefox\//i.test(s) ? 'Firefox'
    : /Chrome\/|CriOS/i.test(s) ? 'Chrome' : /Safari\//i.test(s) ? 'Safari' : 'Браузер';
  const os = /Windows/i.test(s) ? 'Windows' : /Android/i.test(s) ? 'Android' : /iPhone|iPad|iOS/i.test(s) ? 'iOS' : /Mac OS X|Macintosh/i.test(s) ? 'macOS' : /Linux/i.test(s) ? 'Linux' : 'неизвестная ОС';
  return `${br} · ${os}`;
}

// ── Ограничитель частоты (скользящее окно, в памяти процесса) ──
const buckets = new Map();
export function hit(key, max, windowSec) {
  const t = Date.now(), w = windowSec * 1000;
  let b = buckets.get(key);
  if (!b) { b = { w, a: [] }; buckets.set(key, b); }
  b.w = w;
  while (b.a.length && b.a[0] <= t - w) b.a.shift();
  if (b.a.length >= max) return { ok: false, retry: Math.max(1, Math.ceil((b.a[0] + w - t) / 1000)) };
  b.a.push(t);
  return { ok: true, retry: 0 };
}
export function limit(key, max, windowSec, message = 'Слишком часто. Подождите немного.') {
  const r = hit(key, max, windowSec);
  if (!r.ok) throw new EndpointError(`${message} (через ${r.retry} с)`, { code: 'RATE', retry: r.retry });
}
export const resetLimits = () => buckets.clear();
const sweep = setInterval(() => {
  const t = Date.now();
  for (const [k, b] of buckets) { while (b.a.length && b.a[0] <= t - b.w) b.a.shift(); if (!b.a.length) buckets.delete(k); }
  if (buckets.size > 200000) buckets.clear();   // защита памяти от лавины ключей
}, 120000);
sweep.unref?.();

// ── «Билет» на голосование: привязан к человеку и номинации, не раньше MIN_VIEW_SEC и не позже TTL, одноразовый ──
const usedTickets = new Map();
export function makeTicket(userId, nominationId) {
  const iat = Math.floor(Date.now() / 1000), nonce = randomToken(9);
  const body = `${userId}.${nominationId}.${iat}.${nonce}`;
  return body + '.' + hmacHex('ticket', body, 22);
}
export function checkTicket(ticket, userId, nominationId, { minAge, maxAge }) {
  const p = String(ticket || '').split('.');
  if (p.length !== 5) return 'bad';
  const [u, n, iat, nonce, sig] = p;
  if (!safeEq(sig, hmacHex('ticket', `${u}.${n}.${iat}.${nonce}`, 22))) return 'bad';
  if (Number(u) !== Number(userId) || Number(n) !== Number(nominationId)) return 'bad';
  const age = Math.floor(Date.now() / 1000) - Number(iat);
  if (age < minAge) return 'early';
  if (age > maxAge) return 'expired';
  return 'ok';
}
export function burnTicket(ticket) {
  const t = Date.now();
  for (const [k, e] of usedTickets) if (e < t) usedTickets.delete(k);
  if (usedTickets.has(ticket)) return false;
  usedTickets.set(ticket, t + 3600 * 1000);
  return true;
}

// Подписанная ссылка на баннер: версия в подписи, поэтому после замены картинки старые ссылки перестают работать.
export const mediaSig = (kind, id, ver) => hmacHex('media', `${kind}:${id}:${ver}`, 24);
export const mediaUrl = (kind, id, ver) => `/m/${kind}/${id}.jpg?v=${ver}&s=${mediaSig(kind, id, ver)}`;
