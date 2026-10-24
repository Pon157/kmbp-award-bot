// Общая проверка для endpoint'ов мини-аппа.
import { EndpointError } from 'sdk';
import * as S from './store.js';
import { maybeBackup } from './backup.js';
import { safe } from './tg.js';
import { requireAccess, requireOwner } from './r2.js';
import { ipInfo, uaHash, limit } from './sec.js';

export async function enter(ctx) {
  const user = ctx.initData?.user;
  if (!user?.id) throw new EndpointError('Не удалось определить пользователя', { code: 'NO_USER' });
  await S.ensureSeed();
  if (await S.isBanned(user.id, 'app')) throw new EndpointError('Доступ ограничен', { code: 'BANNED' });
  await S.touchUser(user);
  return user;
}

export const after = () => safe(() => maybeBackup());

// Данные о запросе для антинакрутки: только хэши, сами IP и User-Agent в базу не попадают.
export function reqInfo(ctx) {
  const { ipHash, netHash } = ipInfo(ctx.ip || '');
  return { ipHash, netHash, uaHash: uaHash(ctx.ua || ''), via: ctx.initData?.via || 'tg' };
}
// Второй тур: вход подтверждён + человек в списке допущенных (или владелец).
export async function enterR2(ctx) {
  const user = await enter(ctx);
  const access = await requireAccess(user);
  return { user, access, req: reqInfo(ctx) };
}
// Админка: только владельцы, проверка на сервере при каждом вызове.
export async function enterAdmin(ctx) {
  const user = await enter(ctx);
  await requireOwner(user);
  limit(`adm:${user.id}`, 180, 60, 'Слишком много запросов админки.');
  return user;
}
export const pickOp = (ops, op) => (typeof op === 'string' && Object.prototype.hasOwnProperty.call(ops, op) ? ops[op] : null);
