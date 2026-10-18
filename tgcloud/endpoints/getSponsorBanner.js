import { EndpointError } from 'sdk';
import * as S from '../lib/store.js';
import { enter } from '../lib/appctx.js';

// Изображение отдаётся отдельно, чтобы не включать base64 в ответ главной страницы.
export default async function (input, ctx) {
  await enter(ctx);
  const banner = await S.getSponsorBanner(Number(input?.id));
  if (!banner?.image_data) throw new EndpointError('Баннер не найден', { code: 'NO_SPONSOR_BANNER' });
  return { src: 'data:image/jpeg;base64,' + banner.image_data };
}
