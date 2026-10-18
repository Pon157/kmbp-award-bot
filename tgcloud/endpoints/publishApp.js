import { enter, after } from '../lib/appctx.js';
import { publishSubmission, publishMissing } from '../lib/apps.js';
import { safe } from '../lib/tg.js';
import * as S from '../lib/store.js';
import { now } from '../lib/util.js';

// Вызывается мини-аппом уже после того, как пользователь увидел «Заявка отправлена».
// Публикует карточку админам и обновляет связанные — то, что раньше тормозило кнопку «Отправить».
export default async function (input, ctx) {
  const user = await enter(ctx);
  const app = await S.getApplication(Number(input?.id));
  // Только своя заявка и только свежая — чтобы нельзя было гонять чужие карточки.
  if (!app || app.user_id !== user.id || now() - app.updated_at > 600) return { ok: false };
  await publishSubmission(app.id);
  await safe(() => publishMissing());
  await after();
  return { ok: true };
}
