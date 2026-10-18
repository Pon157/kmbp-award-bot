import { EndpointError } from 'sdk';
import { enter, after } from '../lib/appctx.js';
import { submitApplication } from '../lib/apps.js';
import { verifyCaptcha } from '../lib/captcha.js';
import * as S from '../lib/store.js';
import { safe } from '../lib/tg.js';
import { coinProgress, awardCompletion } from '../lib/coins.js';

export default async function (input, ctx) {
  const user = await enter(ctx);
  // Капча нужна только для НОВОЙ заявки. Правка уже отправленной ничего не добавляет к голосам.
  const nomId = Number(input?.nominationId);
  const existing = nomId ? await S.userApplication(user.id, nomId) : null;
  if (!existing) {
    const ok = await verifyCaptcha(input?.captcha?.id, input?.captcha?.answer);
    if (!ok) {
      throw new EndpointError('Код с картинки неверный или устарел', { code: 'CAPTCHA', fields: { captcha: 'Код неверный — введите новый' } });
    }
  }
  // defer: клиент просит ответить сразу, а карточку админам опубликует отдельным вызовом publishApp.
  const defer = input?.defer === true;
  const res = await submitApplication(user, input, { defer });
  if (!defer) await after();
  // Монеты за голосование во всех номинациях. safe: если таблиц ещё нет (до migrate) — заявка всё равно принята.
  const p = await safe(() => coinProgress(user.id));
  let awarded = 0;
  if (p && p.enabled && !p.earned && !p.missing.length) awarded = (await safe(() => awardCompletion(user.id, p))) || 0;
  const coins = p ? { enabled: p.enabled, reward: p.reward, awarded, balance: p.balance + awarded, earned: p.earned || !!awarded, required: p.required, covered: p.covered } : null;
  return { ok: true, id: res.id, created: res.created, imported: res.imported || 0, sponsorNomination: res.sponsorNomination || null, coins };
}
