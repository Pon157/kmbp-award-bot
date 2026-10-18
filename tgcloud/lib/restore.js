// Загрузка базы из выгрузки бота: JSON (полная) или CSV (только заявки).
import { val } from './db.js';
import { transaction } from './tx.js';
import { TABLES } from './backup.js';
import { now } from './util.js';

export const MAX_FILE = 20 * 1024 * 1024; // лимит Telegram на скачивание файла ботом

export function decodeText(bytes) {
  const s = new TextDecoder('utf-8').decode(bytes);
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

// CSV с «;» как разделителем, кавычками "…" и переносами строк внутри полей.
export function parseCsv(text, sep = ';') {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x !== '')) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur); if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

const parseDate = (s) => {
  const m = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})/.exec(String(s || '').trim());
  return m ? Math.floor(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) / 1000) : now();
};

export function parseBackup(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('файл пустой');
  if (t[0] === '{') {
    let j; try { j = JSON.parse(t); } catch (e) { throw new Error('это не корректный JSON'); }
    if (!j || typeof j.tables !== 'object' || !j.tables) throw new Error('в файле нет раздела tables — это не выгрузка бота');
    const tables = {};
    for (const name of TABLES) {
      const rows = j.tables[name];
      if (rows === undefined) continue;
      if (!Array.isArray(rows) || rows.some((r) => !r || typeof r !== 'object')) throw new Error(`таблица ${name} повреждена`);
      tables[name] = rows;
    }
    if (!Object.keys(tables).length) throw new Error('в выгрузке нет известных таблиц');
    return { kind: 'json', exportedAt: Number(j.exported_at) || 0, tables };
  }
  const rows = parseCsv(t);
  const head = (rows[0] || []).map((h) => h.trim().toLowerCase());
  if (!['id', 'номинация', 'название', 'юзернейм', 'id автора'].every((h) => head.includes(h))) throw new Error('не похоже ни на JSON-выгрузку, ни на CSV заявок бота');
  const at = (r, h) => (r[head.indexOf(h)] ?? '').trim();
  const items = rows.slice(1).filter((r) => r.length >= 5).map((r) => ({
    id: Number(at(r, 'id')) || 0, nomination: at(r, 'номинация'), title: at(r, 'название'), username: at(r, 'юзернейм').replace(/^@/, ''),
    description: r[head.indexOf('описание')] ?? '', answers: at(r, 'ответы') || '{}', user_id: Number(at(r, 'id автора')) || 0,
    author_username: at(r, 'юзернейм автора').replace(/^@/, ''), created_at: parseDate(at(r, 'создана')), updated_at: parseDate(at(r, 'изменена')),
    sponsor_nomination: at(r, 'спонсорская номинация'),
  }));
  return { kind: 'csv', items };
}

export async function backupPreview(parsed) {
  if (parsed.kind === 'csv') return { kind: 'csv', rows: parsed.items.length };
  const file = {}, cur = {};
  for (const [t, rows] of Object.entries(parsed.tables)) {
    file[t] = rows.length;
    try { cur[t] = Number(await val(`SELECT COUNT(*) FROM ${t}`)) || 0; } catch (e) { cur[t] = 0; }   // t — только из белого списка TABLES
  }
  return { kind: 'json', exportedAt: parsed.exportedAt, file, cur };
}

// mode: 'replace' — очистить таблицы из файла и залить их; 'merge' — добавить то, чего нет (существующее не трогаем).
// Всё в одной транзакции: при любой ошибке база остаётся как была.
export async function restoreJson(parsed, { mode = 'replace', keepOwner = null } = {}) {
  if (parsed.kind !== 'json') throw new Error('для полной загрузки нужен JSON-файл');
  const report = {};
  const envApp = !!(globalThis.process && globalThis.process.env && globalThis.process.env.APP_URL);
  await transaction(async (d) => {
    for (const [t, rows] of Object.entries(parsed.tables)) {
      const cols = new Set((await d.all(`PRAGMA table_info("${t}")`)).map((r) => r.name));
      if (!cols.size) { report[t] = { total: rows.length, inserted: 0, skipped: rows.length, note: 'таблицы нет в базе' }; continue; }
      if (mode === 'replace' && t !== 'settings') await d.run(`DELETE FROM "${t}"`);
      const verb = mode === 'replace' ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
      let ins = 0, skip = 0;
      for (const raw of rows) {
        const row = { ...raw };
        if (t === 'settings') {                      // служебное и привязанное к окружению не переносим
          const k = String(row.key);
          if (k.startsWith('captcha:') || k === 'bot_username' || k === 'seeded' && mode === 'merge' || (k === 'app_url' && envApp)) { skip++; continue; }
        }
        if (t === 'sponsor_banners' && !row.image_data) { row.image_data = ''; row.active = 0; }   // картинок в выгрузке нет — загрузите заново
        const keys = Object.keys(row).filter((k) => cols.has(k));
        if (!keys.length) { skip++; continue; }
        const params = {}; keys.forEach((k, i) => { const v = row[k]; params['p' + i] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v; });
        const r = await d.run(`${verb} INTO "${t}" (${keys.map((k) => `"${k}"`).join(', ')}) VALUES (${keys.map((k, i) => ':p' + i).join(', ')})`, params);
        if (r && r.rowsAffected) ins++; else skip++;
      }
      report[t] = { total: rows.length, inserted: ins, skipped: skip };
    }
    if (keepOwner) await d.run('INSERT OR IGNORE INTO owners (user_id, added_by, added_at) VALUES (:id, :id, :t)', { id: keepOwner, t: now() });   // не заблокировать себя
  });
  return report;
}

// CSV: только заявки. Добавляет недостающие (по номинации-названию), существующие не трогает.
export async function importCsv(parsed) {
  if (parsed.kind !== 'csv') throw new Error('для импорта заявок нужен CSV-файл');
  const report = { total: parsed.items.length, inserted: 0, skipped: 0, unmatched: {} };
  await transaction(async (d) => {
    const byTitle = new Map((await d.all('SELECT id, title FROM nominations')).map((n) => [String(n.title).trim().toLowerCase(), n.id]));
    for (const it of parsed.items) {
      const nid = byTitle.get(it.nomination.trim().toLowerCase());
      if (!nid) { report.unmatched[it.nomination] = (report.unmatched[it.nomination] || 0) + 1; report.skipped++; continue; }
      if (!it.user_id || !it.username) { report.skipped++; continue; }
      await d.run('INSERT OR IGNORE INTO users (id, username, first_name, started, blocked, first_seen, last_seen) VALUES (:id, :un, :fn, 0, 0, :t, :t)',
        { id: it.user_id, un: it.author_username || null, fn: it.author_username || '', t: it.created_at });
      const sn = it.sponsor_nomination ? byTitle.get(it.sponsor_nomination.trim().toLowerCase()) : null;
      const r = await d.run(`INSERT OR IGNORE INTO applications (id, nomination_id, user_id, title, username, username_norm, description, answers, sponsor_nomination_id, created_at, updated_at)
                             VALUES (:id, :n, :u, :title, :un, :unn, :d, :a, :sn, :c, :m)`,
        { id: it.id || null, n: nid, u: it.user_id, title: it.title, un: it.username, unn: it.username.toLowerCase(), d: it.description, a: it.answers, sn: sn || null, c: it.created_at, m: it.updated_at });
      if (r && r.rowsAffected) report.inserted++; else report.skipped++;
    }
  });
  return report;
}

export async function restoreBytes(bytes, opts = {}) {
  const parsed = parseBackup(decodeText(bytes));
  return parsed.kind === 'csv' ? { kind: 'csv', report: await importCsv(parsed) } : { kind: 'json', report: await restoreJson(parsed, opts) };
}
