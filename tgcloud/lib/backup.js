// Выгрузка базы: JSON со всеми таблицами + CSV заявок (открывается в Excel).
import { api, InputFile } from 'sdk';
import { all, run } from './db.js';
import * as S from './store.js';
import { BACKUP_EVERY } from './config.js';
import { now, utf8, fmtDate } from './util.js';
import { isForbidden, errText } from './tg.js';

export const TABLES = ['users', 'owners', 'bans', 'nominations', 'questions', 'applications', 'news', 'links', 'settings', 'broadcasts', 'sponsors', 'sponsor_banners', 'referrals', 'coin_log', 'reminders'];

export async function snapshot() {
  const tables = {};
  for (const t of TABLES) {
    // Изображения большие — в выгрузку не кладём (их можно загрузить заново).
    if (t === 'settings') tables[t] = await all("SELECT * FROM settings WHERE key <> 'banner_site_data' AND key NOT LIKE 'captcha:%'");
    else if (t === 'sponsor_banners') tables[t] = await all('SELECT id, title, target_url, active, position, created_at FROM sponsor_banners');
    else { try { tables[t] = await all(`SELECT * FROM ${t}`); } catch (e) { /* таблицы ещё нет (до migrate) — пропускаем */ } }
  }
  return { exported_at: now(), tables };
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export async function applicationsCsv() {
  const rows = await all(`
    SELECT a.id, n.title AS nomination, a.title, a.username, a.description, a.answers,
           a.user_id, u.username AS author_username, a.created_at, a.updated_at, sn.title AS sponsor_nomination
    FROM applications a
    LEFT JOIN nominations n ON n.id = a.nomination_id
    LEFT JOIN nominations sn ON sn.id = a.sponsor_nomination_id
    LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id`);
  const head = ['id', 'номинация', 'название', 'юзернейм', 'описание', 'ответы', 'id автора', 'юзернейм автора', 'создана', 'изменена', 'спонсорская номинация'];
  const lines = [head.join(';')];
  for (const r of rows) {
    lines.push([r.id, r.nomination, r.title, '@' + r.username, r.description, r.answers, r.user_id,
      r.author_username ? '@' + r.author_username : '', fmtDate(r.created_at), fmtDate(r.updated_at), r.sponsor_nomination || ''].map(csvCell).join(';'));
  }
  return '\ufeff' + lines.join('\r\n');
}

// Отправить файлы указанным получателям. Возвращает { ok, failed }.
export async function sendBackup(recipients, label = 'Выгрузка базы') {
  const snap = await snapshot();
  const stamp = new Date().toISOString().slice(0, 10);
  const json = utf8(JSON.stringify(snap));
  const csv = utf8(await applicationsCsv());
  const counts = Object.entries(snap.tables).map(([k, v]) => `${k}: ${v.length}`).join(', ');
  // Получатели независимы — шлём параллельно. Раньше это синхронно задерживало ответ
  // на submit/getHome раз в сутки (первый запрос после суток простоя).
  const results = await Promise.allSettled(recipients.map(async (id) => {
    await api.sendDocument({
      chat_id: id,
      document: new InputFile(json, `kmbp-backup-${stamp}.json`, { type: 'application/json' }),
      caption: `${label} · ${fmtDate(snap.exported_at)}\n${counts}`.slice(0, 1000),
    });
    await api.sendDocument({
      chat_id: id,
      document: new InputFile(csv, `kmbp-applications-${stamp}.csv`, { type: 'text/csv' }),
    });
  }));
  let ok = 0, failed = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { ok++; return; }
    failed++;
    console.warn('backup to', recipients[i], isForbidden(r.reason) ? 'forbidden' : errText(r.reason));
  });
  return { ok, failed };
}

// «Ленивый планировщик»: в Serverless нет cron, поэтому проверяем время при каждой активности.
// UPDATE срабатывает ровно для одного вызова — так выгрузка не дублируется.
export async function maybeBackup() {
  if ((await S.getSetting('auto_backup', '1')) !== '1') return false;
  const t = now();
  await run("INSERT OR IGNORE INTO settings (key, value) VALUES ('last_backup', '0')");
  const r = await run("UPDATE settings SET value = :t WHERE key = 'last_backup' AND CAST(value AS INTEGER) <= :cut",
    { t: String(t), cut: t - BACKUP_EVERY });
  if (!r?.rowsAffected) return false;
  const res = await sendBackup(await S.ownerIds(), 'Ежедневная выгрузка');
  console.info('auto backup', res);
  return true;
}
