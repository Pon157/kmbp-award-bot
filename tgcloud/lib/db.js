// Тонкая обёртка над db: чтения — через sql-тег, записи — строкой с именованными параметрами.
// Параметры в тексте запроса пишутся как :name, значения передаются объектом { name: value }.
import { db } from 'sdk';
import { sql } from 'sdk/db';

function tpl(text, params = {}) {
  const strings = [];
  const values = [];
  let last = 0;
  const re = /:([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(text))) {
    strings.push(text.slice(last, m.index));
    if (!(m[1] in params)) throw new Error('missing param ' + m[1]);
    values.push(params[m[1]]);
    last = m.index + m[0].length;
  }
  strings.push(text.slice(last));
  strings.raw = strings.slice();
  return sql(strings, ...values);
}

const conv = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
const clean = (p = {}) => { const o = {}; for (const k of Object.keys(p)) o[k] = conv(p[k]); return o; };
const named = (p = {}) => { const o = {}; for (const k of Object.keys(p)) o[':' + k] = conv(p[k]); return o; };

// Хелперы поверх любого sdk-подобного объекта db (обычного или «внутри транзакции»).
export function bind(d) {
  const all = (text, p) => d.all(tpl(text, clean(p)));
  const get = async (text, p) => (await d.get(tpl(text, clean(p)))) ?? null;
  const run = (text, p) => d.run(text, named(p));
  const insert = async (text, p) => (await run(text, p))?.lastInsertRowid;
  const val = async (text, p) => { const row = await get(text, p); return row ? row[Object.keys(row)[0]] : null; };
  return { all, get, run, insert, val };
}
export const { all, get, run, insert, val } = bind(db);
