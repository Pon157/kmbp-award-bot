/* KMBP FX — золотая «пыль» с параллаксом от скролла, искры и рябь от касаний,
   наклон баннера пальцем/гироскопом, салют из монет.
   Без зависимостей. Один canvas на весь экран, спрайты рисуются заранее (на кадр — только drawImage).
   Сам снижает качество, если телефон не тянет; полностью отключается при prefers-reduced-motion. */
(function () {
  'use strict';
  var win = window, doc = document;
  var reduce = false;
  try { reduce = win.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  var FX = win.FX = { enabled: !reduce };
  if (reduce || !doc.createElement('canvas').getContext) {
    FX.enabled = false;
    FX.mode = FX.hero = FX.burst = FX.coins = FX.setLite = function () {};
    FX.countUp = function (el, from, to) { if (el) el.textContent = String(to); };
    FX.stats = function () { return { enabled: false }; };
    return;
  }

  var MAX_PARTS = 240;
  var canvas, ctx, W = 0, H = 0, dpr = 1, maxDpr = 1.25;   // свечение мягкое — высокое разрешение не нужно, а пикселей в 4× меньше
  var mode = 'off', raf = 0, last = 0, running = false;
  var parts = [];
  var scale = 1;                 // «регулятор качества»: доля пыли и dpr
  try { // слабые телефоны (мало ядер/памяти) и режим экономии трафика стартуют с урезанной «пылью»
    var weak = (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory && navigator.deviceMemory <= 3) || (navigator.connection && navigator.connection.saveData);
    if (weak) scale = .55;
  } catch (e) {}
  var ema = 16.7, work = 1, frames = 0, calm = 0;   // ema — интервал кадров; work — сколько мс на кадр тратим мы сами
  var scrollY0 = 0, scrollDelta = 0, scrollVel = 0, scrollSigned = 0, acc = 0, nonDust = 0, heroMoving = false;
  var ptr = { x: -999, y: -999, down: false, t: 0, sx: 0, sy: 0, lx: 0, ly: 0, moved: 0, type: 'touch' };
  var hero = null;
  var gyro = { t: 0, x: 0, y: 0, b0: null };
  var sprites = {};

  var rnd = Math.random;
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ───────── спрайты ─────────
  function sprite(size, draw) {
    var c = doc.createElement('canvas'); c.width = c.height = size; draw(c.getContext('2d'), size); return c;
  }
  function buildSprites() {
    sprites.dot = sprite(48, function (g, s) {
      var r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      r.addColorStop(0, 'rgba(255,248,226,1)'); r.addColorStop(.22, 'rgba(242,220,166,.85)');
      r.addColorStop(.6, 'rgba(217,184,114,.24)'); r.addColorStop(1, 'rgba(217,184,114,0)');
      g.fillStyle = r; g.fillRect(0, 0, s, s);
    });
    sprites.star = sprite(64, function (g, s) {
      var c = s / 2, h = g.createRadialGradient(c, c, 0, c, c, c);
      h.addColorStop(0, 'rgba(255,244,214,.5)'); h.addColorStop(1, 'rgba(217,184,114,0)');
      g.fillStyle = h; g.fillRect(0, 0, s, s);
      g.fillStyle = 'rgba(255,251,238,1)'; g.beginPath(); g.moveTo(c, 3);
      g.quadraticCurveTo(c + 3, c - 3, s - 3, c); g.quadraticCurveTo(c + 3, c + 3, c, s - 3);
      g.quadraticCurveTo(c - 3, c + 3, 3, c); g.quadraticCurveTo(c - 3, c - 3, c, 3); g.fill();
    });
    sprites.coin = sprite(80, function (g, s) {
      var c = s / 2, rim = g.createLinearGradient(0, 0, s, s);
      rim.addColorStop(0, '#fff3cf'); rim.addColorStop(.5, '#d9b872'); rim.addColorStop(1, '#9c7228');
      g.fillStyle = rim; g.beginPath(); g.arc(c, c, c - 2, 0, 6.2832); g.fill();
      var face = g.createRadialGradient(c * .8, c * .7, 2, c, c, c - 8);
      face.addColorStop(0, '#fff0c4'); face.addColorStop(.6, '#e3c47f'); face.addColorStop(1, '#bf9440');
      g.fillStyle = face; g.beginPath(); g.arc(c, c, c - 9, 0, 6.2832); g.fill();
      g.strokeStyle = 'rgba(122,84,14,.55)'; g.lineWidth = 2; g.beginPath(); g.arc(c, c, c - 9, 0, 6.2832); g.stroke();
      g.fillStyle = 'rgba(122,84,14,.62)'; g.beginPath();
      for (var i = 0; i < 10; i++) { var a = -1.5708 + i * .62832, r = i % 2 ? 7 : 17; g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r); }
      g.closePath(); g.fill();
    });
  }

  // ───────── canvas ─────────
  function ensureCanvas() {
    if (canvas) return;
    canvas = doc.createElement('canvas');
    canvas.id = 'fx'; canvas.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(canvas);
    ctx = canvas.getContext('2d', { alpha: true });
    buildSprites(); resize();
  }
  function resize() {
    if (!canvas) return;
    W = Math.max(1, win.innerWidth); H = Math.max(1, win.innerHeight);
    dpr = Math.min(win.devicePixelRatio || 1, maxDpr, Math.sqrt(2.4e6 / (W * H)));
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  }
  win.addEventListener('resize', resize, { passive: true });

  // ───────── частицы ─────────
  // t: 0 пыль, 1 искра, 2 кольцо, 3 монета
  function dustTarget() { return Math.round((W < 520 ? 34 : 64) * scale * (mode === 'done' ? .7 : 1)); }
  function spawnDust(init) {
    var z = .35 + .65 * rnd();
    parts.push({ t: 0, x: rnd() * W, y: init ? rnd() * H : H + 12, z: z, s: 7 + z * 13, vx: (rnd() - .5) * 7, vy: -(6 + z * 17),
      ph: rnd() * 6.28, a: .22 + .5 * z * rnd(), star: rnd() < .22, age: 0, rot: rnd() * 6.28, vr: (rnd() - .5) * .8 });
  }
  function countDust() { var n = 0; for (var i = 0; i < parts.length; i++) if (parts[i].t === 0) n++; return n; }
  function fillDust() {
    var want = dustTarget(), have = countDust();
    for (; have < want; have++) spawnDust(true);
    if (have > want) { // убираем лишнюю пыль, оставляя прочие частицы
      for (var i = parts.length - 1; i >= 0 && have > want; i--) if (parts[i].t === 0) { parts.splice(i, 1); have--; }
    }
  }

  FX.burst = function (x, y, n, o) {
    if (mode === 'off' || !ctx) return;
    o = o || {};
    n = Math.max(4, Math.round((n || 14) * clamp(scale + .25, .5, 1)));
    for (var i = 0; i < n; i++) {
      var a = rnd() * 6.2832, sp = (70 + rnd() * 250) * (o.power || 1);
      parts.push({ t: 1, x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40, s: 8 + rnd() * 14, life: .55 + rnd() * .65, age: 0,
        g: 240, d: .9, star: rnd() < .5, rot: rnd() * 6.28, vr: (rnd() - .5) * 9 });
    }
    parts.push({ t: 2, x: x, y: y, life: .55, age: 0, r0: 6, r1: o.ring || 58 });
    trim();
  };
  FX.coins = function (x, y, n) {
    if (mode === 'off' || !ctx) return;
    n = Math.round((n || 30) * clamp(scale + .3, .6, 1));
    for (var i = 0; i < n; i++) {
      var a = -1.5708 + (rnd() - .5) * 2.3, sp = 240 + rnd() * 460;
      parts.push({ t: 3, x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, s: 22 + rnd() * 16, ph: rnd() * 6.28, vr: 6 + rnd() * 10,
        g: 980, life: 2.8 + rnd() * .8, age: 0, rot: (rnd() - .5) * .7 });
    }
    // следом — лёгкий «дождь» сверху
    for (var j = 0; j < Math.round(12 * scale); j++) {
      parts.push({ t: 3, x: rnd() * W, y: -30 - rnd() * 260, vx: (rnd() - .5) * 40, vy: 90 + rnd() * 120, s: 18 + rnd() * 12, ph: rnd() * 6.28,
        vr: 5 + rnd() * 8, g: 300, life: 4, age: 0, rot: (rnd() - .5) * .5 });
    }
    FX.burst(x, y, 22, { power: 1.25, ring: 84 });
    trim();
  };
  function trim() { if (parts.length > MAX_PARTS) parts.splice(0, parts.length - MAX_PARTS); }

  function update(dt, ts) {
    var i, p, sd = scrollDelta; scrollDelta = 0;
    scrollVel += (Math.abs(sd) - scrollVel) * .2; scrollSigned += (sd - scrollSigned) * .25;
    var R = 110, R2 = R * R, active = ptr.down || (ptr.type === 'mouse' && ptr.x > -900);
    for (i = parts.length - 1; i >= 0; i--) {
      p = parts[i]; p.age += dt;
      if (p.t === 0) {
        p.x += (p.vx + Math.sin(p.age * .8 + p.ph) * 7 * p.z) * dt;
        p.y += p.vy * dt - sd * p.z * .55;          // параллакс: пыль «отстаёт» от скролла
        p.rot += p.vr * dt;
        if (active) {                                   // палец «закручивает» пыль
          var dx = p.x - ptr.x, dy = p.y - ptr.y, d2 = dx * dx + dy * dy;
          if (d2 < R2 && d2 > 4) { var d = Math.sqrt(d2), f = (1 - d / R) * 260 * dt; p.x += dx / d * f - dy / d * f * .7; p.y += dy / d * f + dx / d * f * .7; }
        }
        if (p.y < -24) { p.y = H + 12; p.x = rnd() * W; }            // улетела вверх — появляется снизу
        else if (p.y > H + 40) { p.y = -12; p.x = rnd() * W; }       // сдвинута скроллом вниз — появляется сверху
        if (p.x < -30) p.x = W + 20; else if (p.x > W + 30) p.x = -20;
      } else if (p.t === 1) {
        if (p.age >= p.life) { parts.splice(i, 1); continue; }
        p.vy += p.g * dt; p.vx *= Math.pow(p.d, dt * 8); p.vy *= Math.pow(p.d, dt * 3);
        p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      } else if (p.t === 2) {
        if (p.age >= p.life) { parts.splice(i, 1); }
      } else {
        if (p.age >= p.life || p.y > H + 70) { parts.splice(i, 1); continue; }
        p.vy += p.g * dt; p.vx *= Math.pow(.6, dt); p.x += p.vx * dt; p.y += p.vy * dt; p.ph += p.vr * dt;
        if (p.x < -40 || p.x > W + 40) p.vx = -p.vx * .5;
      }
    }
    nonDust = 0; for (i = 0; i < parts.length; i++) if (parts[i].t) nonDust++;
    if (mode !== 'off' && frames % 20 === 0 && countDust() < dustTarget()) spawnDust(false);
    if (hero) updateHero(dt, ts);
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var i, p, k, s, a, stretch = clamp(scrollVel / 40, 0, 1.6);
    ctx.globalCompositeOperation = 'lighter';
    for (i = 0; i < parts.length; i++) {
      p = parts[i];
      if (p.t === 0) {
        a = p.a * (.55 + .45 * Math.sin(p.age * 2.1 + p.ph)); if (a < .02) continue;
        s = p.s; ctx.globalAlpha = a;
        if (p.star) { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.drawImage(sprites.star, -s * .6, -s * .6, s * 1.2, s * 1.2); ctx.restore(); }
        else ctx.drawImage(sprites.dot, p.x - s / 2, p.y - s / 2 - stretch * p.z * 3, s, s * (1 + stretch * p.z * .9));
      } else if (p.t === 1) {
        k = p.age / p.life; a = Math.pow(1 - k, 1.4); s = p.s * (1 - k * .55); ctx.globalAlpha = a;
        if (p.star) { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.drawImage(sprites.star, -s * .7, -s * .7, s * 1.4, s * 1.4); ctx.restore(); }
        else ctx.drawImage(sprites.dot, p.x - s / 2, p.y - s / 2, s, s);
      } else if (p.t === 2) {
        k = p.age / p.life; ctx.globalAlpha = (1 - k) * .75; ctx.lineWidth = 2.2 * (1 - k) + .4;
        ctx.strokeStyle = 'rgba(242,220,166,1)'; ctx.beginPath(); ctx.arc(p.x, p.y, p.r0 + (p.r1 - p.r0) * (1 - Math.pow(1 - k, 3)), 0, 6.2832); ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    for (i = 0; i < parts.length; i++) {
      p = parts[i]; if (p.t !== 3) continue;
      k = p.age / p.life; ctx.globalAlpha = k > .82 ? (1 - k) / .18 : 1; s = p.s;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(Math.max(.08, Math.abs(Math.cos(p.ph))), 1);
      ctx.drawImage(sprites.coin, -s / 2, -s / 2, s, s); ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // ───────── цикл и «регулятор качества» ─────────
  // Ориентируемся на СВОЁ время на кадр (update+draw), а не на интервал между кадрами: при экономии энергии
  // телефон и так отдаёт 30 fps, и интервал 33 мс не значит, что мы тяжёлые. Интервал смотрим только при сильных лагах.
  function govern() {
    var heavy = work > 5 || ema > 48;
    if (heavy && scale > .34) {
      scale = Math.max(.34, scale * .76); calm = 0; fillDust();
      if (scale < .62 && maxDpr > 1) { maxDpr = 1; resize(); }
    } else if (work < 2.2 && ema < 40 && scale < 1) {
      if (++calm > 6) { scale = Math.min(1, scale * 1.12); calm = 0; fillDust(); }
    } else calm = 0;
  }
  function frame(ts) {
    raf = 0; if (!running) return;
    var ms = ts - last; last = ts; if (!(ms > 0)) ms = 16.7;
    ema += (Math.min(ms, 100) - ema) * .08; frames++;
    // Фоновая «пыль» плавная и на 30 fps: каждый второй кадр пропускаем, пока нет касаний, прокрутки, искр, монет и наклона.
    var live = nonDust > 0 || ptr.down || scrollVel > 1 || Math.abs(scrollSigned) > .5 || heroMoving;
    if (!live && (frames & 1)) { acc += ms; raf = win.requestAnimationFrame(frame); return; }
    var dt = Math.min(.066, (ms + acc) / 1000); acc = 0;
    if (frames % 45 === 0) govern();
    var w0 = win.performance.now();
    update(dt, ts); draw();
    work += (win.performance.now() - w0 - work) * .1;
    raf = win.requestAnimationFrame(frame);
  }
  function start() { if (running || mode === 'off' || doc.hidden) return; running = true; last = win.performance.now(); raf = win.requestAnimationFrame(frame); }
  function stop() { running = false; if (raf) win.cancelAnimationFrame(raf); raf = 0; }
  doc.addEventListener('visibilitychange', function () { if (doc.hidden) stop(); else start(); });

  // landing | done | off. На форме всё выключаем: ничего не отвлекает и не греет телефон.
  var lite = false;
  FX.setLite = function (v) { lite = !!v; if (lite) FX.mode('off'); };
  FX.mode = function (m) {
    if (lite) m = 'off';
    mode = m;
    if (m === 'off') { stop(); parts = []; if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height); if (canvas) canvas.style.display = 'none'; return; }
    ensureCanvas(); canvas.style.display = ''; fillDust(); start();
  };

  // ───────── касания ─────────
  win.addEventListener('scroll', function () {
    var y = win.pageYOffset || 0; scrollDelta += y - scrollY0; scrollY0 = y;
  }, { passive: true });

  var lastHaptic = 0;
  function haptic() {
    var t = Date.now(); if (t - lastHaptic < 140) return; lastHaptic = t;
    try { win.Telegram.WebApp.HapticFeedback.impactOccurred('light'); } catch (e) {}
  }
  win.addEventListener('pointerdown', function (e) {
    ptr.down = true; ptr.type = e.pointerType || 'touch'; ptr.x = ptr.sx = ptr.lx = e.clientX; ptr.y = ptr.sy = ptr.ly = e.clientY; ptr.t = Date.now(); ptr.moved = 0;
  }, { passive: true });
  win.addEventListener('pointermove', function (e) {
    ptr.type = e.pointerType || ptr.type; ptr.x = e.clientX; ptr.y = e.clientY;
    if (!ptr.down || mode === 'off') return;
    var dx = e.clientX - ptr.lx, dy = e.clientY - ptr.ly, d = Math.sqrt(dx * dx + dy * dy);
    ptr.moved = Math.max(ptr.moved, Math.abs(e.clientX - ptr.sx) + Math.abs(e.clientY - ptr.sy));
    if (d >= 16) {                                  // дорожка искр за пальцем
      ptr.lx = e.clientX; ptr.ly = e.clientY;
      for (var i = 0; i < 2; i++) parts.push({ t: 1, x: e.clientX + (rnd() - .5) * 8, y: e.clientY + (rnd() - .5) * 8, vx: (rnd() - .5) * 50, vy: -20 - rnd() * 50,
        s: 6 + rnd() * 8, life: .45 + rnd() * .3, age: 0, g: 60, d: .9, star: rnd() < .35, rot: rnd() * 6.28, vr: (rnd() - .5) * 6 });
      trim();
    }
  }, { passive: true });
  function up(e) {
    if (!ptr.down) return; ptr.down = false;
    if (e.type === 'pointerup' && mode !== 'off' && ptr.moved < 12 && Date.now() - ptr.t < 450) {
      FX.burst(e.clientX, e.clientY, 12);
      if (e.target && e.target.closest && e.target.closest('[data-fx-haptic]')) haptic();
    }
    if (ptr.type !== 'mouse') { ptr.x = ptr.y = -999; }
  }
  win.addEventListener('pointerup', up, { passive: true });
  win.addEventListener('pointercancel', up, { passive: true });

  // подсветка нажатого элемента: свет идёт от точки касания
  var litEls = [];
  doc.addEventListener('pointerdown', function (e) {
    var el = e.target && e.target.closest && e.target.closest('.nom,.btn,.sponsor-card,.link,.coin-card');
    if (!el) return;
    var r = el.getBoundingClientRect();
    el.style.setProperty('--mx', (e.clientX - r.left) + 'px'); el.style.setProperty('--my', (e.clientY - r.top) + 'px');
    el.classList.add('lit'); litEls.push(el);
  }, { passive: true });
  function unlit() { var els = litEls; litEls = []; win.setTimeout(function () { for (var i = 0; i < els.length; i++) els[i].classList.remove('lit'); }, 260); }
  win.addEventListener('pointerup', unlit, { passive: true });
  win.addEventListener('pointercancel', unlit, { passive: true });

  // ───────── наклон баннера ─────────
  win.addEventListener('deviceorientation', function (e) {
    if (e.gamma == null || e.beta == null) return;
    if (gyro.b0 == null) gyro.b0 = e.beta;
    gyro.b0 += (e.beta - gyro.b0) * .004;           // «нулевое» положение медленно подстраивается под руку
    gyro.x = clamp(e.gamma / 28, -1, 1); gyro.y = clamp((e.beta - gyro.b0) / 28, -1, 1); gyro.t = Date.now();
  }, { passive: true });

  FX.hero = function (art) {
    if (lite) art = null;
    if (hero) { hero.el.removeEventListener('pointerdown', hero.down); hero.el.removeEventListener('pointermove', hero.move); hero.el.style.removeProperty('--rot'); if (hero.io) hero.io.disconnect(); hero = null; }
    if (!art) return;
    var h = hero = { el: art, rx: 0, ry: 0, vx: 0, vy: 0, tx: 0, ty: 0, touchT: 0, visible: true, lx: -1, ly: -1, lg: '' };
    function aim(e) {
      var r = art.getBoundingClientRect(); if (!r.width) return;
      h.tx = clamp((e.clientX - r.left) / r.width * 2 - 1, -1, 1); h.ty = clamp((e.clientY - r.top) / r.height * 2 - 1, -1, 1); h.touchT = Date.now();
    }
    h.down = function (e) { aim(e); haptic(); }; h.move = function (e) { if (ptr.down || e.pointerType === 'mouse') aim(e); };
    art.addEventListener('pointerdown', h.down, { passive: true }); art.addEventListener('pointermove', h.move, { passive: true });
    if ('IntersectionObserver' in win) { h.io = new IntersectionObserver(function (es) { h.visible = es[0].isIntersecting; }); h.io.observe(art); }
  };
  function updateHero(dt, ts) {
    var h = hero; if (!h.el.isConnected) { hero = null; return; } if (!h.visible || mode !== 'landing') { heroMoving = false; return; }
    var now = Date.now(), tx, ty;
    if (now - h.touchT < 1400 && ptr.down) { tx = h.tx; ty = h.ty; }
    else if (now - gyro.t < 500) { tx = gyro.x; ty = gyro.y; }
    else { tx = 0; ty = 0; }
    ty = clamp(ty + clamp(scrollSigned / 28, -1, 1) * .55, -1, 1);              // баннер «наклоняется» вслед за прокруткой
    // пружина: лёгкий перелёт при отпускании пальца. Углы небольшие, чтобы картинка (scale 1.07) всегда закрывала края
    h.vx += ((-ty * 5.5 - h.rx) * 95 - h.vx * 11) * dt; h.rx += h.vx * dt;
    h.vy += ((tx * 7 - h.ry) * 95 - h.vy * 11) * dt; h.ry += h.vy * dt;
    heroMoving = Math.abs(h.rx) > .03 || Math.abs(h.ry) > .03 || Math.abs(h.vx) > .05 || Math.abs(h.vy) > .05 || Math.abs(tx) + Math.abs(ty) > .01;
    var key = h.rx.toFixed(2) + ',' + h.ry.toFixed(2);
    if (key === h.lg) return; h.lg = key;
    var el = h.el, ang = Math.sqrt(h.rx * h.rx + h.ry * h.ry), nx = clamp(h.ry / 7, -1, 1), ny = clamp(-h.rx / 5.5, -1, 1);
    // поворот вокруг оси (rx, ry, 0) на угол |(rx, ry)| ≈ rotateX(rx) rotateY(ry) при малых углах
    el.style.setProperty('--rot', ang < .02 ? 'none' : h.rx.toFixed(3) + ' ' + h.ry.toFixed(3) + ' 0 ' + ang.toFixed(2) + 'deg');
    el.style.setProperty('--gx', (50 + nx * 38).toFixed(1) + '%'); el.style.setProperty('--gy', (38 + ny * 34).toFixed(1) + '%');
    el.style.setProperty('--px', (-nx * 8).toFixed(1) + 'px'); el.style.setProperty('--py', (-ny * 6).toFixed(1) + 'px');
  }

  // ───────── счётчик ─────────
  FX.countUp = function (el, from, to, ms) {
    if (!el) return; if (lite) { el.textContent = String(to); return; } ms = ms || 1000; var t0 = win.performance.now();
    (function step(t) {
      var k = clamp((t - t0) / ms, 0, 1), e = 1 - Math.pow(1 - k, 3);
      el.textContent = String(Math.round(from + (to - from) * e));
      if (k < 1 && el.isConnected) win.requestAnimationFrame(step);
    })(t0);
  };

  FX.stats = function () { return { enabled: true, mode: mode, parts: parts.length, dust: countDust(), scale: +scale.toFixed(2), dpr: +dpr.toFixed(2), frameMs: +ema.toFixed(1), workMs: +work.toFixed(2), running: running }; };
})();
