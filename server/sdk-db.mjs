// sdk/db: DSL схемы (table/integer/text/…), sql-тег и автосинхронизация схемы с файлом SQLite.
export const registry = [];
class Col {
  constructor(name, type) { this.name = name; this.type = type; }
  primaryKey(o) { this.pk = true; this.ai = !!o?.autoIncrement; return this; }
  notNull() { this.nn = true; return this; }
  default(v) { this.def = v; return this; }
  unique() { this.uq = true; return this; }
}
export const integer = (n) => new Col(n, 'INTEGER');
export const text = (n) => new Col(n, 'TEXT');
export const boolean = (n) => new Col(n, 'INTEGER');
const idx = (unique) => (name) => ({ on: (...cols) => ({ unique, name, cols }) });
export const index = idx(false);
export const uniqueIndex = idx(true);
export function table(name, cols, extras) {
  const refs = {}; for (const [k, v] of Object.entries(cols)) refs[k] = v;
  const ex = extras ? Object.values(extras(refs)) : [];
  registry.push({ name, cols, ex });
  return { name, ...cols };
}
export function sql(strings, ...values) { return { strings: [...strings], values }; }
sql.raw = (s) => ({ strings: [s], values: [] });

const defSql = (c) => (c.def === true ? 1 : c.def === false ? 0 : typeof c.def === 'string' ? `'${c.def.replace(/'/g, "''")}'` : c.def);
const colSql = (c, forAlter = false) => {
  let s = `"${c.name}" ${c.type}`;
  if (!forAlter && c.pk) s += ' PRIMARY KEY' + (c.ai ? ' AUTOINCREMENT' : '');
  if (c.nn) s += ' NOT NULL';
  if (c.def !== undefined) s += ' DEFAULT ' + defSql(c);
  else if (forAlter && c.nn) s += c.type === 'TEXT' ? " DEFAULT ''" : ' DEFAULT 0';   // SQLite не даёт добавить NOT NULL-колонку без значения по умолчанию
  return s;
};

// Создаёт недостающие таблицы/колонки/индексы. Существующие данные не трогает. Возвращает, что было сделано.
export function syncSchema(sqlite) {
  const out = { created: [], addedColumns: [], indexErrors: [] };
  for (const t of registry) {
    const exists = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t.name);
    if (!exists) {
      sqlite.exec(`CREATE TABLE "${t.name}" (${Object.values(t.cols).map((c) => colSql(c)).join(', ')})`);
      out.created.push(t.name);
    } else {
      const have = new Set(sqlite.prepare(`PRAGMA table_info("${t.name}")`).all().map((r) => r.name));
      for (const c of Object.values(t.cols)) {
        if (have.has(c.name) || c.pk) continue;
        sqlite.exec(`ALTER TABLE "${t.name}" ADD COLUMN ${colSql(c, true)}`);
        out.addedColumns.push(`${t.name}.${c.name}`);
      }
    }
    for (const i of t.ex) {
      try { sqlite.exec(`CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${i.name}" ON "${t.name}" (${i.cols.map((c) => `"${c.name}"`).join(', ')})`); }
      catch (e) { out.indexErrors.push(`${i.name}: ${e.message}`); }
    }
  }
  return out;
}
