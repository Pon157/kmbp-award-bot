// Транзакции в рантайме для своего сервера: изоляция от параллельных запросов и откат.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdk = await import(path.join(ROOT, 'server/sdk.mjs'));
const { sql } = await import(path.join(ROOT, 'server/sdk-db.mjs'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
sdk.openDb(':memory:'); sdk.getSqlite().exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
const rows = async () => (await sdk.db.all(sql`SELECT v FROM t ORDER BY id`)).map((r) => r.v);
let n = 0; const ok = (m) => { n++; console.log('  ✓ ' + m); };

// 1) обычный запрос во время транзакции ждёт и выполняется ПОСЛЕ неё; при откате транзакции его запись остаётся
let order = [];
const tx = globalThis.__KMBP_TX(async (d) => {
  await d.run("INSERT INTO t (v) VALUES ('tx-1')"); order.push('tx-1'); await sleep(120);
  await d.run("INSERT INTO t (v) VALUES ('tx-2')"); order.push('tx-2'); await sleep(60);
  throw new Error('сбой посреди транзакции');
});
await sleep(20);
const other = sdk.db.run("INSERT INTO t (v) VALUES ('other')").then(() => order.push('other'));   // чужой запрос, пришёл во время транзакции
await assert.rejects(tx, /сбой/); await other;
assert.deepEqual(order, ['tx-1', 'tx-2', 'other'], 'чужая запись дождалась конца транзакции');
assert.deepEqual(await rows(), ['other'], 'запись транзакции откатилась, чужая — сохранилась');
ok('во время транзакции чужие запросы ждут; при откате чужая запись не теряется');

// 2) успешная транзакция фиксируется целиком; чтение внутри видит свои незавершённые изменения
await globalThis.__KMBP_TX(async (d) => { await d.run("INSERT INTO t (v) VALUES ('a')"); await d.run("INSERT INTO t (v) VALUES ('b')"); assert.equal((await d.all(sql`SELECT COUNT(*) AS n FROM t`))[0].n, 3); });
assert.deepEqual(await rows(), ['other', 'a', 'b']); ok('успешная транзакция фиксируется целиком');

// 3) две транзакции подряд не пересекаются
const log = [];
await Promise.all([1, 2].map((i) => globalThis.__KMBP_TX(async (d) => { log.push('start' + i); await sleep(30); await d.run(`INSERT INTO t (v) VALUES ('t${i}')`); log.push('end' + i); })));
assert.deepEqual(log, ['start1', 'end1', 'start2', 'end2']); ok('параллельные транзакции выполняются по очереди');

// 4) повторная ошибка не оставляет базу заблокированной
await assert.rejects(globalThis.__KMBP_TX(async () => { throw new Error('x'); })); await sdk.db.run("INSERT INTO t (v) VALUES ('after')");
assert.ok((await rows()).includes('after')); ok('после ошибки база не остаётся заблокированной');
console.log(`\nГотово: ${n} проверок прошли`); sdk.closeDb(); process.exit(0);
