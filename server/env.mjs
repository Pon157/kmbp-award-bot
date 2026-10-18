// Минимальный разбор .env (KEY=VALUE, # комментарии, значения в кавычках). Уже заданные переменные окружения не перезаписывает.
import fs from 'node:fs';
export function loadEnv(file) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '').trim();   // обрезаем комментарий в конце строки: KEY=value  # комментарий
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}
