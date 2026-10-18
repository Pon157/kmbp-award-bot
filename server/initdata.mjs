// Проверка подписи Telegram Mini App initData (HMAC-SHA256 от токена бота) — то, что на платформе делал Serverless.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function validateInitData(raw, token, { maxAgeSec = 86400, now = Date.now() / 1000 } = {}) {
  if (!raw || typeof raw !== 'string' || raw.length > 8192) return null;
  const p = new URLSearchParams(raw);
  const hash = p.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const sig = Buffer.from(hash, 'hex');
  const check = (omit) => {
    const pairs = [...p.entries()].filter(([k]) => k !== 'hash' && !omit.includes(k)).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const calc = createHmac('sha256', secret).update(pairs.map(([k, v]) => `${k}=${v}`).join('\n')).digest();
    return sig.length === calc.length && timingSafeEqual(sig, calc);
  };
  if (!check([]) && !check(['signature'])) return null;       // signature (Ed25519) в новых версиях может входить или не входить в строку проверки
  const authDate = Number(p.get('auth_date'));
  if (!authDate || now - authDate > maxAgeSec || authDate - now > 300) return null;
  let user; try { user = JSON.parse(p.get('user')); } catch (e) { return null; }
  if (!user || !Number.isFinite(Number(user.id))) return null;
  return { user, auth_date: authDate, start_param: p.get('start_param') || null, query_id: p.get('query_id') || null };
}

// Для тестов: собрать подписанную строку так же, как это делает Telegram.
export function signInitData(fields, token) {
  const p = new URLSearchParams(); for (const [k, v] of Object.entries(fields)) p.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const pairs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  p.set('hash', createHmac('sha256', secret).update(pairs).digest('hex'));
  return p.toString();
}
