export const now = () => Math.floor(Date.now() / 1000);

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// UTF-8 без TextEncoder (в изоляте его может не быть).
export function utf8(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

export function cleanText(s, max) {
  let t = String(s ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '');
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return max ? t.slice(0, max) : t;
}

export function oneLine(s, max) {
  return cleanText(s, max).replace(/\s+/g, ' ').trim();
}

// Юзернейм → каноничный вид: без @, без ссылки.
export function normUsername(raw) {
  let u = String(raw ?? '').trim();
  u = u.replace(/^https?:\/\/(www\.)?(t\.me|telegram\.me)\//i, '').replace(/^(t\.me|telegram\.me)\//i, '');
  u = u.replace(/^@+/, '').split(/[/?#\s]/)[0];
  return u;
}
export const isUsername = (u) => /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(u);

export function levenshtein(a, b, cap = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let min = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < min) min = v;
    }
    if (min > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

// 'exact' — тот же юзернейм; 'similar' — отличается подчёркиваниями или одним символом.
export function compareUsernames(a, b) {
  if (a === b) return 'exact';
  const sa = a.replace(/_/g, ''), sb = b.replace(/_/g, '');
  if (sa === sb) return 'similar';
  if (a.length >= 5 && b.length >= 5 && levenshtein(a, b, 1) <= 1) return 'similar';
  return null;
}

export function fmtDate(ts) {
  const d = new Date((ts || 0) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

export function userName(u) {
  if (!u) return 'без имени';
  const n = [u.first_name ?? u.firstName, u.last_name ?? u.lastName].filter(Boolean).join(' ');
  return n || (u.username ? '@' + u.username : String(u.id));
}

export const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// Байты → base64 (в рантайме нет Buffer; не полагаемся на btoa).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toBase64(bytes) {
  let out = '';
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i], b = i + 1 < n ? bytes[i + 1] : 0, c = i + 2 < n ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] +
      (i + 1 < n ? B64[((b & 15) << 2) | (c >> 6)] : '=') + (i + 2 < n ? B64[c & 63] : '=');
  }
  return out;
}
