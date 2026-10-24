// Рисунки зрителей. Хранятся как штрихи (числа), а не как картинка: загрузить своё изображение нельзя — только нарисовать.
// Формат: [[цвет 0..15, толщина 0..3, x1, y1, x2, y2, …], …], координаты — целые 0..255 (сетка 256×256).
import { EndpointError } from 'sdk';
import { R2 } from './config.js';

export const GRID = 255, COLORS = 16, SIZES = 4;

export function parseStrokes(input) {
  const bad = (m) => new EndpointError(m || 'Рисунок не принят', { code: 'BAD_DRAWING' });
  if (!Array.isArray(input) || !input.length) throw bad('Нарисуйте что-нибудь');
  if (input.length > R2.DRAW_MAX_STROKES) throw bad('Слишком много штрихов');
  let points = 0, ink = 0;
  const out = [];
  for (const s of input) {
    if (!Array.isArray(s) || s.length < 4 || s.length % 2 !== 0) throw bad();
    const [c, w, ...xy] = s;
    if (!Number.isInteger(c) || c < 0 || c >= COLORS || !Number.isInteger(w) || w < 0 || w >= SIZES) throw bad();
    for (const v of xy) if (!Number.isInteger(v) || v < 0 || v > GRID) throw bad();
    points += xy.length / 2;
    if (points > R2.DRAW_MAX_POINTS) throw bad('Рисунок слишком сложный');
    if (c !== 1) ink++;                           // цвет 1 — «белый» (ластик), пустым рисунок не считаем
    out.push([c, w, ...xy]);
  }
  if (!ink) throw bad('Нарисуйте что-нибудь');
  const json = JSON.stringify(out);
  if (json.length > R2.DRAW_MAX_BYTES) throw bad('Рисунок слишком сложный');
  return json;
}
