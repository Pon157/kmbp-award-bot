// Напоминания тем, кто проголосовал не во всех номинациях — раз в 5 дней, с кнопками голосования.
// Первое напоминание — не раньше чем через сутки после первого визита (новичку сразу после /start не пишем).
// В Serverless нет cron, поэтому «ленивый планировщик»: вызывается при активности (bot-хендлеры и фоновый tick
// мини-аппа), не чаще раза в минуту, и обрабатывает небольшую пачку пользователей за вызов.
import { all, get, val, run } from './db.js';
import * as S from './store.js';
import { send, B, isForbidden, isRateLimit, safe, errText } from './tg.js';
import { D } from './doc.js';
import { em } from './emoji.js';
import { esc, now } from './util.js';
import { requiredNominations, coinProgress, coveredCountSql } from './coins.js';
import { COIN_REWARD, REMIND_EVERY_SEC, REMIND_DEFAULT, REMIND_FIRST_AFTER_SEC } from './config.js';

const MAX_BUTTONS = 8;
const IDLE_SEC = 3600; // не беспокоим тех, кто был активен в последний час

export function reminderMessage(p, url) {
  const shown = p.missing.slice(0, 5).map((n) => `<b>${esc(n.title)}</b>`).join(', ');
  const more = p.missing.length > 5 ? ` и ещё ${p.missing.length - 5}` : '';
  const blocks = [
    D.h(`${em('bell')} Вы проголосовали не во всех номинациях`),
    D.p(`Осталось: ${shown}${more}.`),
    D.p(p.earned
      ? 'Это займёт пару минут — выберите номинацию ниже.'
      : `Проголосуйте во всех номинациях и получите <b>${COIN_REWARD} монет</b>: их можно потратить на дополнительный голос во 2 туре.`),
  ];
  const rows = p.missing.slice(0, MAX_BUTTONS).map((n) => [B.web(n.title, `${url}?nom=${n.id}`, { style: 'primary' })]);
  rows.push([B.web('Открыть премию', url, { style: 'success', emoji: 'star' }), B.cb('Не напоминать', 'rm:off')]);
  return { blocks, rows };
}

export const setMuted = (userId, muted) => run(
  `INSERT INTO reminders (user_id, last_at, count, muted) VALUES (:u, 0, 0, :m)
   ON CONFLICT(user_id) DO UPDATE SET muted = :m`, { u: userId, m: muted ? 1 : 0 });

// force — обойти ограничение «не чаще раза в минуту»; manual — запуск кнопкой админа: пишем и тем, кто в боте меньше суток.
export async function runReminders({ limit = 12, force = false, manual = false } = {}) {
  if ((await S.getSetting('remind_enabled', REMIND_DEFAULT)) !== '1') return { sent: 0, reason: 'off' };
  const t = now();
  if (!force && t - Number(await S.getSetting('remind_tick_at', '0')) < 60) return { sent: 0, reason: 'throttled' };
  await S.setSetting('remind_tick_at', String(t));

  const required = await requiredNominations();
  if (!required.length) return { sent: 0, reason: 'nothing' };
  const url = await S.appUrl();
  if (!url) return { sent: 0, reason: 'no_url' };

  const ids = required.map((n) => Number(n.id)).filter(Number.isFinite).join(','); // числа из БД, не ввод пользователя
  const rows = await all(
    `SELECT u.id AS id FROM users u LEFT JOIN reminders r ON r.user_id = u.id
     WHERE u.started = 1 AND u.blocked = 0 AND COALESCE(r.muted, 0) = 0
       AND COALESCE(r.last_at, 0) <= :due AND u.first_seen <= :born AND u.last_seen <= :idle
       AND u.id NOT IN (SELECT user_id FROM bans WHERE scope IN ('all', 'bot'))
       AND ${coveredCountSql(ids)} < :need
     ORDER BY u.id LIMIT :n`,
    { due: t - REMIND_EVERY_SEC, born: manual ? t : t - REMIND_FIRST_AFTER_SEC, idle: t - IDLE_SEC, need: required.length, n: limit });

  let sent = 0, failed = 0, error = '';
  for (const r of rows) {
    // Сначала «занимаем» пользователя — параллельный вызов его уже не возьмёт.
    await run(`INSERT INTO reminders (user_id, last_at, count, muted) VALUES (:u, :t, 1, 0)
               ON CONFLICT(user_id) DO UPDATE SET last_at = :t, count = count + 1`, { u: r.id, t });
    const p = await coinProgress(r.id, required);
    if (!p.missing.length) continue;
    const { blocks, rows: kb } = reminderMessage(p, url);
    try {
      await send(r.id, blocks, kb);
      sent++;
    } catch (e) {
      if (isForbidden(e)) { await S.setBlocked(r.id, true); continue; }
      failed++; error = errText(e);
      // лимит Telegram — откатываем «занятость» и останавливаемся до следующего вызова
      await run('UPDATE reminders SET last_at = 0, count = MAX(count - 1, 0) WHERE user_id = :u', { u: r.id });
      if (isRateLimit(e)) break;
    }
  }
  return { sent, picked: rows.length, failed, error };
}

export async function reminderOverview() {
  const required = await requiredNominations();
  const [muted, total, enabled] = await Promise.all([
    val('SELECT COUNT(*) FROM reminders WHERE muted = 1'),
    val('SELECT COALESCE(SUM(count), 0) FROM reminders'),
    S.getSetting('remind_enabled', REMIND_DEFAULT),
  ]);
  let waiting = 0;
  if (required.length) {
    const ids = required.map((n) => Number(n.id)).filter(Number.isFinite).join(',');
    waiting = Number(await val(
      `SELECT COUNT(*) FROM users u LEFT JOIN reminders r ON r.user_id = u.id
       WHERE u.started = 1 AND u.blocked = 0 AND COALESCE(r.muted, 0) = 0
         AND u.id NOT IN (SELECT user_id FROM bans WHERE scope IN ('all', 'bot')) AND ${coveredCountSql(ids)} < :need`,
      { need: required.length })) || 0;
  }
  return { enabled: enabled === '1', muted: Number(muted) || 0, total: Number(total) || 0, waiting, nominations: required.length };
}

// Почему «0 отправлено»: сколько неполных пользователей отсеяно каждым правилом (правила пересекаются).
export async function reminderDiagnostics() {
  const required = await requiredNominations();
  if (!required.length) return null;
  const ids = required.map((n) => Number(n.id)).filter(Number.isFinite).join(',');
  const t = now();
  const base = `FROM users u LEFT JOIN reminders r ON r.user_id = u.id
     WHERE u.started = 1 AND u.blocked = 0 AND COALESCE(r.muted, 0) = 0
       AND u.id NOT IN (SELECT user_id FROM bans WHERE scope IN ('all', 'bot')) AND ${coveredCountSql(ids)} < :need`;
  const p = { need: required.length, t, due: t - REMIND_EVERY_SEC, born: t - REMIND_FIRST_AFTER_SEC, idle: t - IDLE_SEC };
  const c = async (extra) => Number(await val(`SELECT COUNT(*) ${base} ${extra}`, p)) || 0;
  return {
    incomplete: await c(''),
    ready: await c(`AND COALESCE(r.last_at, 0) <= :due AND u.first_seen <= :born AND u.last_seen <= :idle`),
    tooNew: await c('AND u.first_seen > :born'),
    recent: await c('AND COALESCE(r.last_at, 0) > :due'),
    activeNow: await c('AND u.last_seen > :idle'),
  };
}
