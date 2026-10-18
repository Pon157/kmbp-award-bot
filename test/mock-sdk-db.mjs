// Мок sdk/db: DSL схемы → DDL, sql-тег.
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
  const refs = {};
  for (const [k, v] of Object.entries(cols)) refs[k] = v;
  const ex = extras ? Object.values(extras(refs)) : [];
  registry.push({ name, cols, ex });
  return { name, ...cols };
}
export function sql(strings, ...values) { return { strings: [...strings], values }; }
sql.raw = (s) => ({ strings: [s], values: [] });
export function ddl() {
  const out = [];
  for (const t of registry) {
    const cols = Object.values(t.cols).map((c) => {
      let s = `"${c.name}" ${c.type}`;
      if (c.pk) s += ' PRIMARY KEY' + (c.ai ? ' AUTOINCREMENT' : '');
      if (c.nn) s += ' NOT NULL';
      if (c.def !== undefined) s += ' DEFAULT ' + (c.def === true ? 1 : c.def === false ? 0 : typeof c.def === 'string' ? `'${c.def}'` : c.def);
      return s;
    });
    out.push(`CREATE TABLE "${t.name}" (${cols.join(', ')})`);
    for (const i of t.ex) out.push(`CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX "${i.name}" ON "${t.name}" (${i.cols.map((c) => `"${c.name}"`).join(', ')})`);
  }
  return out;
}
