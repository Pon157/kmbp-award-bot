import { enter, after } from '../lib/appctx.js';
import { safe } from '../lib/tg.js';
import { runReminders } from '../lib/reminders.js';

// Фоновый вызов мини-аппа после отрисовки главной: ежедневный бэкап и пачка напоминаний.
// Вынесен из getHome, чтобы пользователь не ждал их при открытии.
export default async function (input, ctx) {
  await enter(ctx);
  await after();
  const r = await safe(() => runReminders());
  return { ok: true, sent: r?.sent || 0 };
}
