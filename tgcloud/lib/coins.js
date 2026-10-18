// Монеты за голосование во всех номинациях.
// «Проголосовать» = выдвинуть кандидата в номинации (1 тур). Монеты тратятся на дополнительный голос во 2 туре.
import { all, get, val, run } from './db.js';
import * as S from './store.js';
import { COIN_REWARD } from './config.js';
import { now } from './util.js';

export const REASON_ALL = 'all_nominations';

// Номинации, во всех из которых надо проголосовать: обычные (не спонсорские) и открытые.
// Если приём закрыт глобально или лимит «одна заявка на человека» — награда невозможна, список пуст.
export function requiredFrom(noms, open, mode) {
  if (open !== '1' || mode !== 'nomination') return [];
  return noms.filter((n) => !n.sponsor_type && !n.sponsor_only && n.is_open);
}
export async function requiredNominations() {
  const [open, mode, noms] = await Promise.all([S.getSetting('apps_open', '1'), S.getSetting('limit_mode', 'nomination'), S.listNominations()]);
  return requiredFrom(noms, open, mode);
}

export const coinBalance = async (userId) => Number(await val('SELECT COALESCE(SUM(amount), 0) FROM coin_log WHERE user_id = :u', { u: userId })) || 0;
export const hasEarned = async (userId) => !!(await get('SELECT 1 AS x FROM coin_log WHERE user_id = :u AND reason = :r', { u: userId, r: REASON_ALL }));

// Голос в СПОНСОРСКОЙ номинации типа T (bot / person / project) засчитывается во всех обычных номинациях такого же типа.
// Голос, который «ушёл» в спонсорскую номинацию по совпадению юзернейма, лежит обычной строкой в обычной номинации —
// он засчитывается как есть. Спонсорские номинации сами в обязательный список не входят: подать туда могут только спонсоры.
export function coveredBy(required, myRows) {
  const direct = new Set(myRows.map((r) => r.id));
  const sponsorKinds = new Set(myRows.filter((r) => r.st).map((r) => r.st));
  return required.filter((n) => direct.has(n.id) || sponsorKinds.has(n.kind));
}
// То же на SQL: сколько из обязательных номинаций (ids) закрыто пользователем u. Используют напоминания.
export const coveredCountSql = (ids) => `(SELECT COUNT(*) FROM nominations rn WHERE rn.id IN (${ids}) AND (
  EXISTS (SELECT 1 FROM applications a WHERE a.user_id = u.id AND a.nomination_id = rn.id)
  OR EXISTS (SELECT 1 FROM applications a2 JOIN nominations sn ON sn.id = a2.nomination_id
             WHERE a2.user_id = u.id AND sn.sponsor_type IS NOT NULL AND sn.sponsor_type = rn.kind)))`;

// Прогресс пользователя: сколько номинаций закрыто и каких не хватает.
export async function coinProgress(userId, required = null) {
  const req = required || await requiredNominations();
  const [balance, earned, mine] = await Promise.all([
    coinBalance(userId), hasEarned(userId),
    all('SELECT DISTINCT a.nomination_id AS id, n.sponsor_type AS st FROM applications a JOIN nominations n ON n.id = a.nomination_id WHERE a.user_id = :u', { u: userId }),
  ]);
  const have = new Set(coveredBy(req, mine).map((n) => n.id));
  const missing = req.filter((n) => !have.has(n.id));
  return { enabled: req.length > 0, reward: COIN_REWARD, balance, earned, required: req.length, covered: req.length - missing.length, missing };
}

// Начислить награду, если проголосовал во всех. Возвращает число монет или 0 (уже получал / не все / отключено).
export async function awardCompletion(userId, progress = null) {
  const p = progress || await coinProgress(userId);
  if (p.earned || !p.enabled || p.missing.length) return 0;
  try {
    await run('INSERT INTO coin_log (user_id, amount, reason, created_at) VALUES (:u, :a, :r, :t)', { u: userId, a: COIN_REWARD, r: REASON_ALL, t: now() });
  } catch (e) { return 0; } // уникальный индекс: награду уже выдал параллельный запрос
  return COIN_REWARD;
}

// Потратить монеты (будет использоваться во 2 туре). reason уникален на пользователя — повтор не списывает дважды.
export async function spendCoins(userId, amount, reason) {
  amount = Math.floor(Number(amount));
  if (!(amount > 0) || !reason) return { ok: false, error: 'bad_args' };
  if ((await coinBalance(userId)) < amount) return { ok: false, error: 'not_enough' };
  try {
    await run('INSERT INTO coin_log (user_id, amount, reason, created_at) VALUES (:u, :a, :r, :t)', { u: userId, a: -amount, r: String(reason), t: now() });
  } catch (e) { return { ok: false, error: 'duplicate' }; }
  return { ok: true, balance: await coinBalance(userId) };
}

export async function coinStats() {
  const [holders, total, spent] = await Promise.all([
    val('SELECT COUNT(DISTINCT user_id) FROM coin_log WHERE reason = :r', { r: REASON_ALL }),
    val('SELECT COALESCE(SUM(amount), 0) FROM coin_log WHERE amount > 0'),
    val('SELECT COALESCE(-SUM(amount), 0) FROM coin_log WHERE amount < 0'),
  ]);
  return { holders: Number(holders) || 0, issued: Number(total) || 0, spent: Number(spent) || 0 };
}
