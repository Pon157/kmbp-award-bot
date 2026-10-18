import { enter } from '../lib/appctx.js';
import { all } from '../lib/db.js';
import * as S from '../lib/store.js';
import { normUsername } from '../lib/util.js';

// Подсказки юзернеймов в форме: недавно выдвинутые кандидаты того же типа (бот/канал/проект…).
// Отдаём только сами юзернеймы — без авторов, счётчиков и номеров заявок. Чёрный список не показываем.
export default async function (input, ctx) {
  await enter(ctx);
  const q = normUsername(input?.q).toLowerCase();
  if (!/^[a-z0-9_]{2,32}$/.test(q)) return { items: [] };
  const nom = await S.getNomination(Number(input?.nominationId));
  if (!nom) return { items: [] };
  // substr вместо LIKE: символ «_» в LIKE — шаблон «любой символ», а в юзернеймах он частый.
  const rows = await all(
    `SELECT a.username AS u, MAX(a.created_at) AS t FROM applications a JOIN nominations n ON n.id = a.nomination_id
     WHERE n.kind = :kind AND substr(a.username_norm, 1, :len) = :q
     GROUP BY a.username_norm ORDER BY t DESC LIMIT 20`,
    { kind: nom.kind, len: q.length, q });
  const black = new Set(await S.getBlacklist());
  const items = rows.map((r) => r.u).filter((u) => u && !black.has(String(u).toLowerCase())).slice(0, 8);
  return { items };
}
