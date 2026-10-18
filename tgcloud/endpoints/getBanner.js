import { EndpointError } from 'sdk';
import * as S from '../lib/store.js';
import { enter } from '../lib/appctx.js';

// Загруженный баннер мини-аппа (data-URI). Отдельно от getHome — он большой.
export default async function (input, ctx) {
  await enter(ctx);
  const b = await S.banners();
  const data = b.site.mode === 'custom' ? await S.siteBannerData() : '';
  if (!data) throw new EndpointError('Баннер не задан', { code: 'NO_BANNER' });
  return { src: 'data:image/jpeg;base64,' + data };
}
