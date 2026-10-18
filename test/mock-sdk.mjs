// Мок sdk: SQLite (node:sqlite) + журнал вызовов Bot API.
import { DatabaseSync } from 'node:sqlite';
import { ddl } from './mock-sdk-db.mjs';

export class BotApiError extends Error {
  constructor(code, description, method, parameters) { super(description); this.code = code; this.description = description; this.method = method; this.parameters = parameters; }
}
export class EndpointError extends Error {
  constructor(description, parameters) { super(description); this.description = description; this.parameters = parameters; this.isEndpointError = true; }
}
export class InputFile { constructor(bytes, name, opts) { this.bytes = bytes; this.name = name; this.type = opts?.type; } }
export const FormData = class {};
export const fetch = async () => ({ ok: true, json: async () => ({}), text: async () => '' });

let sqlite = new DatabaseSync(':memory:');
export function initDb() {
  sqlite = new DatabaseSync(':memory:');
  for (const q of ddl()) sqlite.exec(q);
}
const toSql = (o) => ({ text: o.strings.join('?'), params: o.values.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)) });
const plain = (r) => (r ? { ...r } : r);
export const db = {
  all: async (o) => { const { text, params } = toSql(o); return sqlite.prepare(text).all(...params).map(plain); },
  get: async (o) => { const { text, params } = toSql(o); return plain(sqlite.prepare(text).get(...params)) ?? null; },
  run: async (text, named = {}) => {
    const r = sqlite.prepare(text).run(named);
    return { rowsAffected: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid), rows: [] };
  },
};

export const calls = [];
let fileBytes = null;                                   // что вернёт api.getFileContent (null — «картинка» по умолчанию)
export const setFileBytes = (b) => { fileBytes = b; };
// Транзакция, как в рантайме server/: BEGIN … COMMIT, при ошибке ROLLBACK.
globalThis.__KMBP_TX = async (fn) => {
  sqlite.exec('BEGIN');
  try { const r = await fn({ all: db.all, get: db.get, run: db.run }); sqlite.exec('COMMIT'); return r; }
  catch (e) { try { sqlite.exec('ROLLBACK'); } catch (x) { /* уже откатилось */ } throw e; }
};
let mid = 1000;
const failures = [];
export const failNext = (method, pred, err) => failures.push({ method, pred, err });
export const resetApi = () => { calls.length = 0; failures.length = 0; };
export const api = new Proxy({}, {
  get: (_, method) => async (params = {}) => {
    calls.push({ method, params });
    const i = failures.findIndex((f) => f.method === method && (!f.pred || f.pred(params)));
    if (i >= 0) { const f = failures.splice(i, 1)[0]; throw f.err; }
    if (method === 'getFileContent') return fileBytes || new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0]);
    if (/^(send|copy)/.test(method)) return { message_id: ++mid, chat: { id: params.chat_id } };
    return true;
  },
});
