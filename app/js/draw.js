// Рисунки хранятся как штрихи: [[цвет, толщина, x1, y1, x2, y2, …], …] на сетке 256×256 (так же проверяет сервер).
import { h, icon } from './dom.js';

export const GRID = 255;
export const PAPER = '#fbf3df';
export const PALETTE = ['#1c1b2e', PAPER, '#e5484d', '#f76b15', '#f5c211', '#99d52a', '#46a758', '#12a594',
  '#05a2c2', '#3e63dd', '#6e56cf', '#a855f7', '#e93d82', '#a18072', '#8b8d98', '#ffffff'];
export const SIZES = [3, 6, 11, 20];          // толщина кисти в клетках сетки 256
export const LIMITS = { strokes: 300, points: 8000 };

export function renderStrokes(canvas, strokes) {
  const ctx = canvas.getContext('2d'), k = canvas.width / 256;
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const s of strokes || []) paintStroke(ctx, k, s);
}
function paintStroke(ctx, k, s) {
  const [c, w, ...xy] = s;
  const col = PALETTE[c] || PALETTE[0], lw = (SIZES[w] || SIZES[0]) * k;
  ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = lw;
  if (xy.length <= 2) { ctx.beginPath(); ctx.arc(xy[0] * k, xy[1] * k, lw / 2, 0, Math.PI * 2); ctx.fill(); return; }
  ctx.beginPath(); ctx.moveTo(xy[0] * k, xy[1] * k);
  for (let i = 2; i < xy.length; i += 2) ctx.lineTo(xy[i] * k, xy[i + 1] * k);
  ctx.stroke();
}

// Маленькая «квадратная» превьюшка рисунка.
export function thumb(strokes, px = 128) {
  const cv = document.createElement('canvas'), d = Math.min(2, window.devicePixelRatio || 1);
  cv.width = cv.height = Math.round(px * d);
  renderStrokes(cv, strokes);
  return cv;
}

export function createEditor() {
  const cv = h('canvas', { class: 'paint__cv', width: 512, height: 512, 'aria-label': 'Холст для рисунка' });
  const ctx = cv.getContext('2d'), k = cv.width / 256;
  let strokes = [], cur = null, color = 0, size = 1, points = 0;
  const listeners = new Set();
  const changed = () => listeners.forEach((f) => f());
  const redraw = () => renderStrokes(cv, strokes);
  redraw();
  const pos = (e) => { const r = cv.getBoundingClientRect(); return [Math.max(0, Math.min(GRID, Math.round(((e.clientX - r.left) / r.width) * GRID))), Math.max(0, Math.min(GRID, Math.round(((e.clientY - r.top) / r.height) * GRID)))]; };
  cv.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    if (strokes.length >= LIMITS.strokes || points >= LIMITS.points) { editor.onLimit?.(); return; }
    cv.setPointerCapture(e.pointerId); e.preventDefault();
    const [x, y] = pos(e);
    cur = [color, size, x, y]; points++;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    paintStroke(ctx, k, cur);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!cur) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) {
      if (points >= LIMITS.points) break;
      const [x, y] = pos(ev), n = cur.length;
      if (Math.abs(x - cur[n - 2]) + Math.abs(y - cur[n - 1]) < 2) continue;
      ctx.strokeStyle = PALETTE[cur[0]]; ctx.lineWidth = SIZES[cur[1]] * k;
      ctx.beginPath(); ctx.moveTo(cur[n - 2] * k, cur[n - 1] * k); ctx.lineTo(x * k, y * k); ctx.stroke();
      cur.push(x, y); points++;
    }
  });
  const end = () => { if (!cur) return; strokes.push(cur); cur = null; changed(); };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('contextmenu', (e) => e.preventDefault());

  const swatches = PALETTE.map((c, i) => h('button', { class: 'sw', style: { background: c }, 'aria-label': i === 1 ? 'Ластик' : 'Цвет ' + (i + 1), 'aria-pressed': i === 0 ? 'true' : 'false', onclick: () => { color = i; sync(); } }));
  const sizeBtns = SIZES.map((s, i) => h('button', { class: 'sz', 'aria-label': 'Толщина ' + (i + 1), 'aria-pressed': i === size ? 'true' : 'false', onclick: () => { size = i; sync(); } }, h('i', { style: { width: Math.min(28, 4 + s) + 'px', height: Math.min(28, 4 + s) + 'px' } })));
  const sync = () => { swatches.forEach((b, i) => b.setAttribute('aria-pressed', String(i === color))); sizeBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(i === size))); };
  const undoBtn = h('button', { class: 'btn btn--ghost btn--sm', onclick: () => { strokes.pop(); points = strokes.reduce((a, s) => a + (s.length - 2) / 2, 0); redraw(); changed(); } }, icon('undo'), 'Отменить');
  const clearBtn = h('button', { class: 'btn btn--ghost btn--sm', onclick: () => { strokes = []; points = 0; redraw(); changed(); } }, icon('trash'), 'Очистить');
  const el = h('div', { class: 'paint' }, cv, h('div', { class: 'palette' }, swatches), h('div', { class: 'row row--between' }, h('div', { class: 'sizes' }, sizeBtns), h('div', { class: 'row' }, undoBtn, clearBtn)));
  const editor = {
    el, onLimit: null,
    getStrokes: () => strokes.map((s) => s.slice()),
    isEmpty: () => !strokes.some((s) => s[0] !== 1),
    onChange: (f) => listeners.add(f),
  };
  return editor;
}
