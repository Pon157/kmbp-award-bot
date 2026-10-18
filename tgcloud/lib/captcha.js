// Капча для новых заявок: картинка с искажённым кодом (SVG, без внешних зависимостей).
// Код хранится на сервере, одноразовый и живёт 10 минут. Клиенту уходит только картинка.
import * as S from './store.js';
import { utf8, toBase64 } from './util.js';

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без похожих: 0/O, 1/I/L
const LEN = 5;
const TTL_MS = 10 * 60 * 1000;

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (s) => s[rnd(s.length)];

function svgFor(code) {
  const W = 200, H = 70;
  const colors = ['#2b2f4a', '#4a2b3f', '#2b4a3d', '#3d2b4a', '#4a3d2b'];
  let text = '';
  for (let i = 0; i < code.length; i++) {
    const x = 22 + i * 34 + rnd(6) - 3;
    const y = 46 + rnd(8) - 4;
    const rot = rnd(40) - 20;
    const size = 30 + rnd(8);
    text += `<text x="${x}" y="${y}" font-family="monospace" font-weight="bold" font-size="${size}" fill="${colors[rnd(colors.length)]}" transform="rotate(${rot} ${x} ${y})">${code[i]}</text>`;
  }
  let noise = '';
  for (let i = 0; i < 6; i++) {
    noise += `<line x1="${rnd(W)}" y1="${rnd(H)}" x2="${rnd(W)}" y2="${rnd(H)}" stroke="${colors[rnd(colors.length)]}" stroke-width="${1 + rnd(2)}" opacity=".55"/>`;
  }
  for (let i = 0; i < 40; i++) {
    noise += `<circle cx="${rnd(W)}" cy="${rnd(H)}" r="${1 + rnd(2)}" fill="${colors[rnd(colors.length)]}" opacity=".4"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="100%" height="100%" fill="#f3efe4"/>${noise}${text}</svg>`;
  return 'data:image/svg+xml;base64,' + toBase64(utf8(svg));
}

export async function makeCaptcha() {
  let code = '';
  for (let i = 0; i < LEN; i++) code += pick(ALPHABET);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  await S.setSetting('captcha:' + id, code + '|' + (Date.now() + TTL_MS));
  return { id, src: svgFor(code) };
}

// Одноразовая проверка: код удаляется сразу, даже если ответ неверный.
export async function verifyCaptcha(id, answer) {
  if (!id || typeof id !== 'string' || typeof answer !== 'string') return false;
  const key = 'captcha:' + id;
  const raw = await S.getSetting(key, '');
  await S.setSetting(key, ''); // гасим, чтобы код нельзя было перебирать
  const [code, exp] = raw.split('|');
  if (!code || Date.now() > Number(exp)) return false;
  return answer.trim().toUpperCase() === code;
}

// Удаляет использованные и просроченные коды (раньше они копились в settings). На своём сервере вызывается раз в час.
import { run } from './db.js';
export const purgeCaptcha = () => run(
  "DELETE FROM settings WHERE key LIKE 'captcha:%' AND (value = '' OR CAST(substr(value, instr(value, '|') + 1) AS INTEGER) < :t)", { t: Date.now() });
