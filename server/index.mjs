// Запуск бота на своём сервере:  node --import ./server/register.mjs server/index.mjs   (или npm start)
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(process.cwd(), '.env')); loadEnv(path.join(ROOT, '.env'));
const env = process.env;

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const maxLevel = LEVELS[env.LOG_LEVEL] ?? 2;
const log = (level, ...a) => { if ((LEVELS[level] ?? 2) <= maxLevel) console[level === 'error' ? 'error' : 'log'](new Date().toISOString().slice(0, 19).replace('T', ' '), level.toUpperCase().padEnd(5), ...a.map((x) => String(x).split(env.BOT_TOKEN || '\0').join('<token>'))); };
const fatal = (m) => { log('error', m); process.exit(1); };

if (!env.BOT_TOKEN) fatal('Не задан BOT_TOKEN (токен бота от @BotFather). Скопируйте .env.example в .env и заполните.');
if (!env.APP_URL) log('warn', 'Не задан APP_URL (https-адрес этого сервера): кнопки «Открыть премию» не будут работать.');

const sdk = await import('./sdk.mjs');
const dbPath = path.resolve(env.DB_PATH || path.join(ROOT, 'data', 'bot.sqlite'));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
sdk.openDb(dbPath);
try { sdk.configureApi({ token: env.BOT_TOKEN, base: env.TG_API_BASE, proxy: env.TG_PROXY }); } catch (e) { fatal(e.message); }
if (env.TG_PROXY) log('info', 'Telegram API — через прокси ' + env.TG_PROXY.replace(/\/\/[^@/]*@/, '//***@'));
if (env.TG_API_BASE) log('info', 'Telegram API — через зеркало ' + env.TG_API_BASE);

await import('../tgcloud/schema.js');
const { syncSchema } = await import('./sdk-db.mjs');
const sync = syncSchema(sdk.getSqlite());
if (sync.created.length) log('info', 'Созданы таблицы: ' + sync.created.join(', '));
if (sync.addedColumns.length) log('info', 'Добавлены колонки: ' + sync.addedColumns.join(', '));
for (const e of sync.indexErrors) log('warn', 'Индекс не создан — ' + e);

const S = await import('../tgcloud/lib/store.js');
if (env.APP_URL) await S.setSetting('app_url', env.APP_URL);       // адрес мини-аппа берём из окружения — после переезда старый адрес из выгрузки не мешает

try {
  const me = await sdk.api.getMe();
  log('info', `Бот: @${me.username}`); await S.setSetting('bot_username', me.username);
} catch (e) {
  if (e.code === 401) fatal('Telegram отверг BOT_TOKEN (401): проверьте токен.');
  log('warn', `Не удалось связаться с Telegram (${e.message}). Проверьте TG_PROXY / сеть — продолжаю и буду повторять.`);
}

const { createUpdateRunner, startPolling } = await import('./poll.mjs');
const { createWebServer } = await import('./web.mjs');
const runner = createUpdateRunner({ handlersDir: path.join(ROOT, 'tgcloud', 'handlers'), log });
const mode = (env.UPDATES || 'polling').toLowerCase();
const secret = createHash('sha256').update('kmbp-webhook:' + env.BOT_TOKEN).digest('hex').slice(0, 32);

const server = createWebServer({
  appDir: env.APP_DIR || path.join(ROOT, 'app'), endpointsDir: path.join(ROOT, 'tgcloud', 'endpoints'), token: env.BOT_TOKEN,
  rateLimit: Number(env.API_RATE_PER_MIN) || 240, log,
  webhook: mode === 'webhook' ? { secret, onUpdate: (u) => runner.handle(u) } : null,
});
const port = Number(env.PORT) || 3000, host = env.HOST || '0.0.0.0';
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }).catch((e) => fatal(`Не удалось занять порт ${port}: ${e.message}`));
log('info', `Мини-апп и API слушают ${host}:${port}`);

let poller = null;
if (mode === 'webhook') {
  const base = (env.WEBHOOK_URL || env.APP_URL || '').replace(/\/+$/, '');
  if (!base) fatal('Для UPDATES=webhook нужен WEBHOOK_URL или APP_URL (публичный https-адрес).');
  try { await sdk.api.setWebhook({ url: `${base}/webhook/${secret}`, secret_token: secret, allowed_updates: ['message', 'callback_query', 'my_chat_member'] }); log('info', 'Webhook установлен'); }
  catch (e) { fatal('Не удалось установить webhook: ' + e.message); }
} else {
  poller = startPolling({ api: sdk.api, runner, log });
  log('info', 'Приём сообщений: long polling');
}

// Таймеры вместо «ленивых» вызовов платформы: напоминания, ежедневный бэкап, чистка капчи.
const { runReminders } = await import('../tgcloud/lib/reminders.js');
const { maybeBackup } = await import('../tgcloud/lib/backup.js');
const { purgeCaptcha } = await import('../tgcloud/lib/captcha.js');
const every = (ms, name, fn) => setInterval(() => { Promise.resolve().then(fn).catch((e) => log('warn', `${name}:`, e?.message || e)); }, ms).unref();
every(60 * 1000, 'напоминания', () => runReminders());
every(10 * 60 * 1000, 'бэкап', () => maybeBackup());
every(60 * 60 * 1000, 'капча', () => purgeCaptcha());

let closing = false;
async function shutdown(sig) {
  if (closing) return; closing = true;
  log('info', `${sig}: останавливаюсь…`);
  if (poller) await poller.stop();
  await new Promise((r) => { server.close(() => r()); setTimeout(r, 3000).unref(); });
  await Promise.race([runner.idle(), new Promise((r) => setTimeout(r, 5000))]);
  sdk.closeDb(); process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log('error', 'unhandledRejection', e?.stack || e));
log('info', 'Готово.');
