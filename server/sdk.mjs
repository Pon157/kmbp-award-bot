// Реализация платформенного модуля 'sdk' для своего сервера: db (SQLite, node:sqlite) и api (Bot API с прокси).
import { DatabaseSync } from 'node:sqlite';
import { createApi } from './tgapi.mjs';
export { BotApiError, EndpointError, InputFile } from './types.mjs';

// ── база ───────────────────────────────────────────────────────────────
let sqlite = null;
export function openDb(file) {
  sqlite = new DatabaseSync(file);
  sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  return sqlite;
}
export const getSqlite = () => sqlite;
export function closeDb() { if (sqlite) { try { sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)'); sqlite.close(); } catch (e) { /* уже закрыта */ } sqlite = null; } }

const toSql = (o) => ({ text: o.strings.join('?'), params: o.values.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)) });
const plain = (r) => (r ? { ...r } : r);
const raw = {
  all: async (o) => { const { text, params } = toSql(o); return sqlite.prepare(text).all(...params).map(plain); },
  get: async (o) => { const { text, params } = toSql(o); return plain(sqlite.prepare(text).get(...params)) ?? null; },
  run: async (text, named = {}) => { const r = sqlite.prepare(text).run(named); return { rowsAffected: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid), rows: [] }; },
};

// Пока идёт транзакция, запросы остальных обработчиков ждут — иначе они попали бы внутрь чужой транзакции и откатились вместе с ней.
let txActive = false, waiters = [];
const gate = async () => { while (txActive) await new Promise((r) => waiters.push(r)); };
export const db = {
  all: async (o) => { await gate(); return raw.all(o); },
  get: async (o) => { await gate(); return raw.get(o); },
  run: async (t, n) => { await gate(); return raw.run(t, n); },
};
globalThis.__KMBP_TX = async (fn) => {
  while (txActive) await new Promise((r) => waiters.push(r));   // проверка и захват без await между ними — иначе две транзакции пройдут одновременно
  txActive = true;
  sqlite.exec('BEGIN IMMEDIATE');
  try { const r = await fn(raw); sqlite.exec('COMMIT'); return r; }
  catch (e) { try { sqlite.exec('ROLLBACK'); } catch (x) { /* откатывать нечего */ } throw e; }
  finally { txActive = false; const w = waiters; waiters = []; w.forEach((f) => f()); }
};

// ── Bot API ────────────────────────────────────────────────────────────
let transport = null;
export function configureApi(opts) { transport = createApi(opts); }
export const api = new Proxy({}, {
  get: (_, method) => (...args) => {
    if (!transport) throw new Error('Bot API не настроен (configureApi)');
    if (method === 'getFileContent') return transport.fileContent(args[0]);
    return transport.call(String(method), args[0] || {});
  },
});
