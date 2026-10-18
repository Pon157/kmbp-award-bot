// Транзакция. На своём сервере (рантайм server/) — настоящая BEGIN…COMMIT: остальные запросы ждут, при ошибке откат.
// На платформе Serverless транзакций нет — выполняется как есть (поэтому перед рискованными операциями делаем бэкап).
import { db } from 'sdk';
import { bind } from './db.js';

export async function transaction(fn) {
  const g = globalThis.__KMBP_TX;
  if (!g) return fn(bind(db));
  return g((txDb) => fn(bind(txDb)));
}
