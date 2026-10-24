import { destroySession, clearCookie } from '../lib/weblogin.js';

export default async function (input, ctx) {
  if (ctx.sessionToken) await destroySession(ctx.sessionToken);
  ctx.setCookie(clearCookie(ctx.secure));
  return { ok: true };
}
