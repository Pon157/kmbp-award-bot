import { pollLogin, sessionCookie } from '../lib/weblogin.js';

// Публичный: браузер спрашивает, подтвердили ли вход в боте. При успехе ставится HttpOnly-cookie, сам токен клиенту не отдаётся.
export default async function (input, ctx) {
  const r = await pollLogin({ id: input?.id, key: input?.key }, { ip: ctx.ip, ua: ctx.ua });
  if (r.status === 'ok') { ctx.setCookie(sessionCookie(r.token, ctx.secure)); return { status: 'ok' }; }
  return { status: r.status };
}
