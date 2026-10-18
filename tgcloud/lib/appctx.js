// Общая проверка для endpoint'ов мини-аппа.
import { EndpointError } from 'sdk';
import * as S from './store.js';
import { maybeBackup } from './backup.js';
import { safe } from './tg.js';

export async function enter(ctx) {
  const user = ctx.initData?.user;
  if (!user?.id) throw new EndpointError('Не удалось определить пользователя', { code: 'NO_USER' });
  await S.ensureSeed();
  if (await S.isBanned(user.id, 'app')) throw new EndpointError('Доступ ограничен', { code: 'BANNED' });
  await S.touchUser(user);
  return user;
}

export const after = () => safe(() => maybeBackup());
