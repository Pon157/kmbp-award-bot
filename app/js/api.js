// Связь с сервером. В Telegram каждый запрос подписан initData; в браузере работает HttpOnly-cookie (её скрипт прочитать не может).
export const tg = window.Telegram?.WebApp;
export const inTelegram = () => !!(window.Telegram?.WebApp?.initData);
export class ApiError extends Error {
  constructor(message, code, params) { super(message); this.code = code || ''; this.params = params || {}; }
}
let authLost = () => {};
export const onAuthLost = (fn) => { authLost = fn; };

export async function call(name, input = {}) {
  const initData = window.Telegram?.WebApp?.initData || '';
  const body = initData ? { ...input, _init: initData } : input;    // запасной путь, если прокси срежет заголовок
  let res;
  try {
    res = await fetch('/api/' + name, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(initData ? { 'x-init-data': initData } : {}) },
      body: JSON.stringify(body),
    });
  } catch (e) { throw new ApiError('Нет связи с сервером. Проверьте интернет.', 'NET'); }
  let data = null;
  try { data = await res.json(); } catch (e) { /* не JSON */ }
  if (res.status === 401) { authLost(); throw new ApiError('Нужно войти', 'AUTH'); }
  if (!data || data.ok === false) throw new ApiError(data?.description || 'Ошибка сервера (' + res.status + ')', data?.parameters?.code, data?.parameters);
  return data.result;
}
export const r2 = (op, input = {}) => call('r2', { op, ...input });
export const forum = (op, input = {}) => call('forum', { op, ...input });
export const admin = (op, input = {}) => call('r2admin', { op, ...input });

export function openUrl(url) {
  if (!/^(https?:|tg:)/i.test(url)) return;
  const t = window.Telegram?.WebApp;
  if (t?.initData) { if (/^https?:\/\/(t|telegram)\.me\//i.test(url) && t.openTelegramLink) t.openTelegramLink(url); else t.openLink ? t.openLink(url) : window.open(url, '_blank', 'noopener'); }
  else window.open(url, '_blank', 'noopener');
}
