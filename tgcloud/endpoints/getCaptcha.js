import { enter } from '../lib/appctx.js';
import { makeCaptcha } from '../lib/captcha.js';

export default async function (input, ctx) {
  await enter(ctx);
  return makeCaptcha();
}
