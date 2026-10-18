// Командная строка:  npm run restore -- <файл.json|файл.csv> [--merge] [--dry-run]   |   npm run export -- <файл.json>
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(path.join(process.cwd(), '.env')); loadEnv(path.join(ROOT, '.env'));
const [cmd, file, ...flags] = process.argv.slice(2);
const usage = () => { console.error('Использование:\n  npm run restore -- <выгрузка.json|заявки.csv> [--merge] [--dry-run]\n  npm run export -- <куда-сохранить.json>'); process.exit(2); };
if (!['restore', 'export'].includes(cmd) || !file) usage();

const sdk = await import('./sdk.mjs');
const dbPath = path.resolve(process.env.DB_PATH || path.join(ROOT, 'data', 'bot.sqlite'));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
sdk.openDb(dbPath);
await import('../tgcloud/schema.js');
const { syncSchema } = await import('./sdk-db.mjs');
syncSchema(sdk.getSqlite());
const { OWNER_IDS } = await import('../tgcloud/lib/config.js');
const R = await import('../tgcloud/lib/restore.js');
const { snapshot } = await import('../tgcloud/lib/backup.js');

try {
  if (cmd === 'export') {
    fs.writeFileSync(file, JSON.stringify(await snapshot()));
    console.log('Выгрузка сохранена:', file);
  } else {
    const parsed = R.parseBackup(R.decodeText(new Uint8Array(fs.readFileSync(file))));
    const pv = await R.backupPreview(parsed);
    console.log('Файл:', parsed.kind === 'csv' ? `CSV, строк: ${pv.rows}` : Object.entries(pv.file).map(([t, n]) => `${t}=${n}`).join(' '));
    if (flags.includes('--dry-run')) { console.log('Режим --dry-run: ничего не изменено.'); }
    else if (parsed.kind === 'csv') console.log('Готово:', JSON.stringify(await R.importCsv(parsed)));
    else {
      const mode = flags.includes('--merge') ? 'merge' : 'replace';
      const rep = await R.restoreJson(parsed, { mode, keepOwner: OWNER_IDS[0] || null });
      console.log(`Готово (${mode === 'merge' ? 'добавлено недостающее' : 'заменено'}):`);
      for (const [t, r] of Object.entries(rep)) console.log(`  ${t.padEnd(16)} загружено ${r.inserted} из ${r.total}${r.note ? ' — ' + r.note : ''}`);
      console.log('Картинки баннеров спонсоров в выгрузку не входят — загрузите их заново в админке.');
    }
  }
} catch (e) { console.error('Ошибка:', e.message); process.exitCode = 1; }
sdk.closeDb();
