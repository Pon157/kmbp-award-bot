import { startLogin } from '../lib/weblogin.js';

// Публичный: запускает вход через Telegram (см. lib/weblogin.js).
export default async function (input, ctx) {
  return startLogin({ ip: ctx.ip, ua: ctx.ua });
}
