import { enter } from '../lib/appctx.js';
import { makeCaptcha } from '../lib/captcha.js';
import { limit } from '../lib/sec.js';

export default async function (input, ctx) {
  const user = await enter(ctx);
  limit(`cap:${user.id}`, 10, 600, 'Слишком много запросов кода.');   // иначе можно забить базу одноразовыми кодами
  return makeCaptcha();
}
