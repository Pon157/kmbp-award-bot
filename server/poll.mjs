// Приём апдейтов: long polling (по умолчанию — работает за NAT и через прокси) или webhook. Обработчики — tgcloud/handlers/*.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES = ['message', 'callback_query', 'my_chat_member'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createUpdateRunner({ handlersDir, log, concurrency = 16 }) {
  const mods = {}, chains = new Map(), queue = []; let running = 0;
  const loadH = async (t) => (mods[t] ||= (await import(pathToFileURL(path.join(handlersDir, t + '.js')).href)).default);
  const keyOf = (u) => { const o = u.message || u.callback_query || u.my_chat_member; return String(o?.from?.id ?? o?.chat?.id ?? 'x'); };
  const slot = () => new Promise((r) => { if (running < concurrency) { running++; r(); } else queue.push(r); });
  const free = () => { const n = queue.shift(); if (n) n(); else running--; };
  // Апдейты одного пользователя идут строго по очереди, разных — параллельно.
  function handle(u) {
    const type = TYPES.find((t) => u[t]);
    if (!type) return Promise.resolve();
    const key = keyOf(u), prev = chains.get(key) || Promise.resolve();
    const next = prev.then(async () => {
      await slot();
      try { await (await loadH(type))(u[type]); } catch (e) { log('error', 'handler', type, e?.stack || e); } finally { free(); }
    });
    chains.set(key, next);
    next.finally(() => { if (chains.get(key) === next) chains.delete(key); });
    return next;
  }
  return { handle, idle: () => Promise.all([...chains.values()]) };
}

export function startPolling({ api, runner, log }) {
  let stopped = false, offset = 0, current = null;
  const loop = (async () => {
    try { await api.deleteWebhook({ drop_pending_updates: false }); } catch (e) { log('warn', 'deleteWebhook:', e.message); }   // getUpdates не работает, пока на боте висит старый webhook (например, платформы)
    let backoff = 1000;
    while (!stopped) {
      try {
        const updates = await api.getUpdates({ offset, timeout: 50, allowed_updates: TYPES });
        backoff = 1000;
        for (const u of updates) { offset = Math.max(offset, u.update_id + 1); runner.handle(u); }
      } catch (e) {
        if (stopped) break;
        log('warn', 'getUpdates:', e.code === 409 ? 'конфликт (запущен второй экземпляр бота или стоит webhook)' : e.message);
        if (e.code === 409) { try { await api.deleteWebhook({}); } catch (x) { /* повторим на следующем круге */ } }
        await sleep(backoff); backoff = Math.min(backoff * 2, 30000);
      }
    }
  })();
  return { stop: async () => { stopped = true; await Promise.race([loop, sleep(2000)]); } };
}
