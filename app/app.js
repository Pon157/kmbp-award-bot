(function () {
  'use strict';

  var tg = window.Telegram && window.Telegram.WebApp;
  var root = document.getElementById('app');
  // Внутри Telegram: либо платформа Serverless (tg.Serverless), либо свой сервер — тогда функции вызываются по HTTP: POST /api/<имя>.
  var API_BASE = (window.KMBP_API || '').replace(/\/+$/, '');
  var IN_TG = !!(tg && tg.initData);
  var state = { home: null, view: 'home', nom: null, mode: null };

  // ───────── версия мини-аппа: «нормальная» или «лёгкая» ─────────
  // Лёгкая — без анимаций, canvas и тяжёлых эффектов (для слабых телефонов). Выбор хранится на устройстве.
  var MODE_KEY = 'kmbp_mode', modeAfter = null;
  function getSavedMode() { try { var v = localStorage.getItem(MODE_KEY); return v === 'lite' || v === 'full' ? v : null; } catch (e) { return null; } }
  function saveMode(m) { try { localStorage.setItem(MODE_KEY, m); } catch (e) {} }
  function recommendLite() {
    try {
      return (navigator.hardwareConcurrency || 8) <= 4 || !!(navigator.deviceMemory && navigator.deviceMemory <= 3) ||
        !!(navigator.connection && navigator.connection.saveData) || !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }
  function applyMode(m) {
    state.mode = m;
    document.documentElement.classList.toggle('lite', m === 'lite');
    if (window.FX && FX.setLite) FX.setLite(m === 'lite');
  }
  function smooth() { return state.mode === 'lite' ? 'auto' : 'smooth'; }

  // ───────── утилиты ─────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ico(name, cls) { return '<svg class="ico ' + (cls || '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>'; }
  function $(sel, el) { return (el || document).querySelector(sel); }
  function $$(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }
  function haptic(type) { try { tg.HapticFeedback.notificationOccurred(type); } catch (e) {} }
  function tap() { try { tg.HapticFeedback.impactOccurred('light'); } catch (e) {} }
  function paras(text) { return String(text || '').split(/\n{2,}/).map(function (p) { return p.trim(); }).filter(Boolean); }
  function fmtDay(ts) {
    try { return new Date(ts * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return ''; }
  }
  var KIND_ICON = { bot: 'bot', project: 'project', person: 'person', event: 'event' };
  var LINK_ICON = { channel: 'channel', chat: 'chat', site: 'globe', bot: 'bot', github: 'code', docs: 'doc', video: 'video', other: 'ext' };

  // ───────── баннер доната: дубль настоящего спонсорского баннера из админки ─────────
  // Ищем среди h.sponsorBanners баннер, ведущий на donationalerts.com, и показываем ту же карточку.
  function findDonateBanner(h) {
    return (h && h.sponsorBanners || []).filter(function (b) { return /donationalerts\.com/i.test(b.targetUrl || ''); })[0] || null;
  }
  function donateCardHtml(b) {
    return '<button class="sponsor-card" data-sponsor-url="' + esc(b.targetUrl) + '" aria-label="Поддержать премию">' +
      '<span class="sponsor-card__art"><img data-sponsor-banner="' + Number(b.id) + '" loading="lazy" alt=""></span></button>';
  }
  function bindSponsorBanners(container) {
    $$('[data-sponsor-banner]', container).forEach(function (img) {
      call('getSponsorBanner', { id: Number(img.dataset.sponsorBanner) }).then(function (d) {
        if (img.isConnected) img.src = d.src;
      }).catch(function () {
        var card = img.closest('.sponsor-card');
        if (card) card.classList.add('sponsor-card--unavailable');
      });
    });
  }

  // ───────── API ─────────
  function call(name, input) {
    return new Promise(function (resolve, reject) {
      if (!IN_TG) return reject(new Error('Откройте мини-апп в Telegram'));
      // Свой сервер: платформенный tg.Serverless здесь не используем — его запрос не несёт наш X-Init-Data.
      // (Оставьте ветку только если мини-апп хостится на платформе Telegram.)
      if (window.KMBP_USE_PLATFORM && tg.Serverless) return tg.Serverless.call(name, input || {}, function (err, data) { err ? reject(err) : resolve(data); });
      // свой сервер: подпись Telegram (initData) идёт в заголовке, сервер её проверяет
      fetch(API_BASE + '/api/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Init-Data': tg.initData }, body: JSON.stringify(Object.assign({}, input || {}, { _init: tg.initData })) })
        .then(function (r) { return r.json().catch(function () { return { ok: false, description: 'Сервер вернул не JSON (HTTP ' + r.status + ')' }; }); })
        .then(function (j) {
          if (j && j.ok) return resolve(j.result);
          var e = new Error((j && j.description) || 'Ошибка сервера'); e.description = j && j.description; e.parameters = (j && j.parameters) || {};
          reject(e);
        }, function () { var e = new Error('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.'); e.description = e.message; e.parameters = {}; reject(e); });
    });
  }

  // ───────── новости: Telegram entities → HTML ─────────
  function txt(s) { return esc(s).replace(/\n/g, '<br>'); }
  function safeUrl(u) { return /^(https?:|tg:|mailto:)/i.test(u) ? u : ''; }
  function wrap(e, inner, text) {
    var raw = text.slice(e.offset, e.offset + e.length);
    switch (e.type) {
      case 'bold': return '<strong>' + inner + '</strong>';
      case 'italic': return '<em>' + inner + '</em>';
      case 'underline': return '<u>' + inner + '</u>';
      case 'strikethrough': return '<s>' + inner + '</s>';
      case 'spoiler': return '<span class="spoiler" role="button" tabindex="0">' + inner + '</span>';
      case 'code': return '<code>' + inner + '</code>';
      case 'pre': return '<pre><code>' + inner + '</code></pre>';
      case 'blockquote': return '<blockquote>' + inner + '</blockquote>';
      case 'expandable_blockquote': return '<details class="bq"><summary>Показать полностью</summary>' + inner + '</details>';
      case 'text_link': { var h = safeUrl(e.url); return h ? '<a href="' + esc(h) + '">' + inner + '</a>' : inner; }
      case 'url': { var u = /^[a-z]+:/i.test(raw) ? raw : 'https://' + raw; return '<a href="' + esc(safeUrl(u)) + '">' + inner + '</a>'; }
      case 'mention': return '<a href="https://t.me/' + esc(raw.replace(/^@/, '')) + '">' + inner + '</a>';
      case 'email': return '<a href="mailto:' + esc(raw) + '">' + inner + '</a>';
      case 'custom_emoji': return ''; // в мини-аппе без эмодзи
      case 'date_time':
        try { return '<time>' + esc(new Date(e.unix_time * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })) + '</time>'; } catch (x) { return inner; }
      default: return inner;
    }
  }
  function build(text, ents, start, end) {
    var out = '', pos = start, i = 0;
    while (i < ents.length) {
      var e = ents[i];
      if (e.offset < pos) { i++; continue; }
      out += txt(text.slice(pos, e.offset));
      var inner = [], j = i + 1;
      while (j < ents.length && ents[j].offset < e.end) { if (ents[j].end <= e.end) inner.push(ents[j]); j++; }
      out += wrap(e, build(text, inner, e.offset, e.end), text);
      pos = e.end; i = j;
    }
    return out + txt(text.slice(pos, end));
  }
  function renderEntities(text, entities) {
    var ents = (entities || []).filter(function (e) { return e && e.length > 0; }).map(function (e) {
      var c = {}; for (var k in e) c[k] = e[k]; c.end = e.offset + e.length; return c;
    }).sort(function (a, b) { return a.offset - b.offset || b.end - a.end; });
    return build(text, ents, 0, text.length);
  }

  // ───────── главный экран ─────────
  var SPARKS = [
    [8, 10, 18, 0], [86, 14, 14, 1.8], [93, 46, 20, 3.1], [5, 58, 12, 2.2],
    [80, 72, 16, 4.0], [14, 84, 15, .9], [52, 5, 12, 3.6]
  ];

  function bannerImg(src, name) { return '<img src="' + esc(src) + '" alt="' + esc(name) + '">'; }
  function dropBanner() {
    var box = $('.hero'); if (box) box.parentNode.removeChild(box);
    var pl = $('.pillars'); if (pl) pl.classList.add('pillars--top');
  }

  function nominationItems(items) {
    return (items || []).map(function (n, i) {
      var sub;
      if (n.submitted) sub = '<span class="nom__s nom__s--ok">' + ico('check') + 'Заявка отправлена · можно изменить</span>';
      else if (n.open) sub = '<span class="nom__s">Приём заявок открыт</span>';
      else sub = '<span class="nom__s">' + ico('lock') + 'Приём закрыт</span>';
      var closed = !n.open && !n.submitted;
      return '<li style="--i:' + i + '"><button class="nom' + (closed ? ' is-closed' : '') + '" data-nom="' + n.id + '"' + (closed ? ' aria-disabled="true"' : '') + '>' +
        '<span class="nom__n">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="nom__ico">' + ico(KIND_ICON[n.kind] || 'project') + '</span>' +
        '<span class="nom__body"><div class="nom__t">' + esc(n.title) + '</div>' + sub + '</span>' +
        '<span class="nom__go">' + ico('arrow') + '</span></button></li>';
    }).join('');
  }

  function renderHome() {
    var h = state.home, a = h.award;
    var open = h.appsOpen;
    var pill = ['Боты', 'Люди', 'Комьюнити', 'Развитие'].map(function (w, i) { return '<span style="--i:' + i + '">' + w + '</span>'; }).join('<i></i>');
    var sparks = SPARKS.map(function (s) {
      return '<span class="spark" style="left:' + s[0] + '%;top:' + s[1] + '%;width:' + s[2] + 'px;height:' + s[2] + 'px;animation-delay:' + s[3] + 's"><svg><use href="#i-spark"/></svg></span>';
    }).join('');

    var nomsHtml = nominationItems(h.nominations);
    var sponsorNominations = h.sponsorNominations || [];
    var sponsorBanners = h.sponsorBanners || [];
    var sponsorNomsHtml = nominationItems(sponsorNominations);
    var sponsorBannersHtml = sponsorBanners.map(function (b) {
      return '<button class="sponsor-card" data-sponsor-url="' + esc(b.targetUrl) + '" aria-label="Открыть ссылку">' +
        '<span class="sponsor-card__art"><img data-sponsor-banner="' + Number(b.id) + '" loading="lazy" alt=""></span></button>';
    }).join('');
    var hasSponsors = sponsorBanners.length || sponsorNominations.length;
    var sponsorsHtml = hasSponsors
      ? '<section class="sec rv" id="sponsors"><div class="sec__kicker">Спонсоры</div><h2 class="sec__title">Партнёры премии</h2>' +
        (sponsorBannersHtml ? '<div class="sponsor-grid">' + sponsorBannersHtml + '</div>' : '<p class="empty">Баннеры спонсоров скоро появятся.</p>') +
        (sponsorNomsHtml ? '<div class="sponsor-noms"><div class="sec__kicker">Спонсорские подноминации</div><ul class="noms">' + sponsorNomsHtml + '</ul></div>' : '') +
        '</section>'
      : '';

    var newsHtml = h.news.length ? h.news.map(function (n) {
      return '<article class="post"><div class="post__meta">' + (n.pinned ? ico('pin') + 'Закреплено · ' : '') + esc(fmtDay(n.at)) + '</div>' +
        '<div class="post__body">' + renderEntities(n.text, n.entities) + '</div></article>';
    }).join('') : '<p class="empty">Новостей пока нет. Здесь появятся анонсы и итоги.</p>';

    var linksHtml = h.links.map(function (l) {
      var host = ''; try { host = new URL(l.url).host.replace(/^www\./, '') + new URL(l.url).pathname.replace(/\/$/, ''); } catch (e) { host = l.url; }
      return '<li><button class="link" data-url="' + esc(l.url) + '">' + ico(LINK_ICON[l.kind] || 'ext') +
        '<span class="link__t">' + esc(l.title) + '<span class="link__h">' + esc(host) + '</span></span>' + ico('ext') + '</button></li>';
    }).join('');

    var navItems = [['about', 'О премии'], ['noms', 'Номинации'], ['news', 'Новости']];
    if (h.links.length) navItems.push(['links', 'Ресурсы']);
    if (hasSponsors) navItems.push(['sponsors', 'Спонсоры']);

    var bn = h.banner;
    var heroHtml = '';
    if (bn && bn.lazy) {
      // своё фото: уже скачано — показываем сразу, иначе пустой блок и догрузка после отрисовки
      heroHtml = '<header class="hero"><div class="hero__art hero__art--wait">' + (state.bannerSrc ? bannerImg(state.bannerSrc, a.name) : '') + '</div></header>';
    } else if (bn && bn.src) {
      heroHtml = '<header class="hero"><div class="hero__art">' + bannerImg(bn.src, a.name) + '<div class="hero__shine"></div>' + sparks + '</div></header>';
    }

    root.innerHTML =
      heroHtml +
      '<div class="pillars' + (heroHtml ? '' : ' pillars--top') + '">' + pill + '</div>' +
      '<p class="lead">Поддержка всегда рядом</p>' +
      '<div class="cta"><button class="btn btn--gold" data-go="noms" data-fx-haptic>' + (open ? 'Предложить кандидата' : 'Смотреть номинации') + ico('arrow') + '</button></div>' +
      coinCardHtml(h.coins) +
      '<nav class="nav" aria-label="Разделы">' + navItems.map(function (n) { return '<a href="#' + n[0] + '" data-nav="' + n[0] + '">' + n[1] + '</a>'; }).join('') + '</nav>' +

      '<section class="sec rv" id="about"><div class="sec__kicker">О премии</div><h2 class="sec__title">Лучшее в сообществе — по мнению сообщества</h2>' +
      '<div class="prose">' + paras(a.about).map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') + '</div>' +
      '<ol class="tl">' +
      '<li><span class="tl__node ' + (open ? 'tl__node--on' : '') + '"></span><div class="tl__head">1 тур</div><h3 class="tl__title">Выдвижение</h3><p class="tl__text">' +
        (open ? '<b>Идёт сейчас.</b> Предложите кандидатов в номинациях — по одному от человека.' : 'Приём заявок сейчас закрыт.') + '</p></li>' +
      '<li><span class="tl__node"></span><div class="tl__head">2 тур</div><h3 class="tl__title">Голосование</h3><p class="tl__text">' + esc(a.round2) + '.</p></li>' +
      '</ol></section>' +

      '<section class="sec rv" id="noms"><div class="sec__kicker">Номинации</div><h2 class="sec__title">Выберите номинацию</h2><ul class="noms">' + nomsHtml + '</ul></section>' +
      '<section class="sec rv" id="news"><div class="sec__kicker">Новости</div><h2 class="sec__title">Что происходит</h2><div class="news">' + newsHtml + '</div></section>' +
      (h.links.length ? '<section class="sec rv" id="links"><div class="sec__kicker">Ресурсы</div><h2 class="sec__title">Где нас найти</h2><ul class="links">' + linksHtml + '</ul></section>' : '') +
      sponsorsHtml +
      '<footer class="foot"><b>' + esc(a.name) + '</b><br>' + esc(a.community) +
        '<div class="foot__mode">Версия: <b>' + (state.mode === 'lite' ? 'Лёгкая' : 'Нормальная') + '</b> · <button class="foot__btn" data-modeopen>Сменить</button></div></footer>';

    bindHome();
  }

  // Карточка «монеты за голосование во всех номинациях»: кольцо прогресса + вращающаяся монета.
  var CIRC = 170; // 2·π·27 — длина окружности кольца в SVG
  function coinCardHtml(c) {
    if (!c || !c.enabled || !c.required) return '';
    var done = !!c.earned, k = Math.min(1, c.covered / c.required), left = c.required - c.covered;
    var title = done ? 'Награда получена' : 'Проголосуйте во всех номинациях';
    var sub = done
      ? 'Монеты можно потратить на дополнительный голос во 2 туре.'
      : 'Получите <b>' + c.reward + ' монет</b> — их можно потратить на дополнительный голос во 2 туре.';
    var prog = done
      ? '<span>Баланс: <span data-count="' + Number(c.balance) + '">' + Number(c.balance) + '</span></span>'
      : '<span>' + Number(c.covered) + ' из ' + Number(c.required) + '</span><span>· осталось ' + left + '</span>';
    return '<button class="coin-card rv' + (done ? ' is-done' : '') + '" data-go="noms" data-fx-haptic style="--to:' + Math.round(CIRC * (1 - k)) + '">' +
      '<span class="coin-card__ring"><svg viewBox="0 0 64 64"><circle class="bg" cx="32" cy="32" r="27"/><circle class="fg" cx="32" cy="32" r="27"/></svg>' +
      '<span class="coin">' + ico('star') + '</span></span>' +
      '<span class="coin-card__body"><span class="coin-card__t">' + title + '</span><span class="coin-card__s">' + sub + '</span>' +
      '<span class="coin-card__p">' + prog + '</span></span></button>';
  }

  var io;
  function bindHome() {
    // золотая «пыль», наклон баннера, искры от касаний
    if (window.FX && state.mode !== 'lite') {
      FX.mode('landing');
      FX.hero($('.hero__art'));
      if (!state.introDone) {
        state.introDone = true;
        document.body.classList.add('intro');
        setTimeout(function () { document.body.classList.remove('intro'); }, 2800);
        setTimeout(function () { var a = $('.hero__art'); if (a && window.FX) { var r = a.getBoundingClientRect(); FX.burst(r.left + r.width / 2, r.top + r.height * .42, 26, { power: 1.2, ring: 90 }); } }, 650);
      }
    }
    // фоновая работа сервера (бэкап, напоминания) — после отрисовки, не задерживая открытие
    if (!state.ticked) { state.ticked = true; setTimeout(function () { call('tick').catch(function () {}); }, 2500); }
    // появление секций и таймлайна
    if (io) io.disconnect();
    io = 'IntersectionObserver' in window ? new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('in'); io.unobserve(e.target);
          if (window.FX) $$('[data-count]', e.target).forEach(function (c) { FX.countUp(c, 0, Number(c.dataset.count), 1000); });
        }
      });
    }, { threshold: 0.12 }) : null;
    $$('.rv').forEach(function (el) { io ? io.observe(el) : el.classList.add('in'); });

    // баннер: догрузка своего фото; если картинка не загрузилась — убираем блок, а не показываем пустоту
    var art = $('.hero__art');
    if (art) {
      var watch = function () {
        var im = $('img', art);
        if (im) im.addEventListener('error', dropBanner);
      };
      if (art.classList.contains('hero__art--wait') && !state.bannerSrc) {
        call('getBanner').then(function (d) {
          state.bannerSrc = d.src;
          var cur = $('.hero__art--wait');
          if (cur) { cur.innerHTML = bannerImg(d.src, state.home.award.name); watch(); }
        }, dropBanner);
      } else watch();
    }

    // подсветка раздела в меню
    var links = $$('.nav a');
    var secs = links.map(function (a) { return $(a.getAttribute('href')); }).filter(Boolean);
    function spy() {
      var y = window.scrollY + 120, cur = null;
      secs.forEach(function (s) { if (s.offsetTop <= y) cur = s.id; });
      links.forEach(function (a) { a.classList.toggle('on', a.dataset.nav === cur); });
    }
    window.removeEventListener('scroll', window.__spy);
    window.__spy = spy; window.addEventListener('scroll', spy, { passive: true }); spy();

    // Изображения спонсоров запрашиваются отдельно, не увеличивая ответ getHome.
    $$('[data-sponsor-banner]').forEach(function (img) {
      call('getSponsorBanner', { id: Number(img.dataset.sponsorBanner) }).then(function (d) {
        if (img.isConnected) img.src = d.src;
      }).catch(function () {
        var card = img.closest('.sponsor-card');
        if (card) card.classList.add('sponsor-card--unavailable');
      });
    });
  }

  // ───────── форма ─────────
  function renderForm(n) {
    var L = n.labels, m = n.mine, lim = n.limits;
    var canEdit = n.open && !n.blockedBy;
    var banner = '';
    if (n.blockedBy) banner = '<div class="note note--bad">' + ico('alert') + '<div>Вы уже предложили кандидата в номинации «' + esc(n.blockedBy) + '». От одного человека принимается одна заявка.</div></div>';
    else if (!n.open) banner = '<div class="note note--bad">' + ico('lock') + '<div>Приём заявок в этой номинации закрыт.' + (m ? ' Ваша заявка сохранена.' : '') + '</div></div>';
    else if (m) banner = '<div class="note">' + ico('edit') + '<div>Вы уже отправили заявку. Можно поправить данные — изменения сохранятся в ней, новая заявка не создаётся.</div></div>';
    if (m && m.sponsorNomination) banner += '<div class="note">' + ico('check') + '<div>Ваш голос засчитан в спонсорскую номинацию: <b>' + esc(m.sponsorNomination.title) + '</b>.</div></div>';

    var qs = n.questions.map(function (q) {
      var v = m && m.answers && m.answers[q.id] || '';
      return '<label class="field" data-f="q' + q.id + '"><span class="field__label">' + esc(q.text) + '<em>' + (q.required ? 'обязательно' : 'по желанию') + '</em></span>' +
        '<textarea class="input" style="min-height:92px" name="q' + q.id + '" maxlength="' + q.maxLen + '"' + (canEdit ? '' : ' disabled') + '>' + esc(v) + '</textarea><span class="field__err"></span></label>';
    }).join('');

    var dis = canEdit ? '' : ' disabled';
    root.innerHTML =
      '<div class="bar"><button class="bar__back" data-back aria-label="Назад">' + ico('back') + '</button><div><div class="bar__t">' + esc(n.title) + '</div><div class="bar__s">Выдвижение · 1 тур</div></div></div>' +
      '<div class="form"><h1>Предложить кандидата</h1><p class="form__lead">' +
        (n.sponsorType ? 'Подавать сюда могут только утверждённые спонсоры. Все прежние заявки с этим точным username будут скопированы в запись; исходные останутся на месте.' : 'Заполните три поля — этого достаточно, чтобы заявку рассмотрели.') +
      '</p>' + banner +
      '<div id="formbox">' +
      '<label class="field" data-f="title"><span class="field__label">' + esc(L.title) + '</span><input class="input" name="title" maxlength="' + lim.title + '" placeholder="' + esc(L.titleHint) + '" autocomplete="off" value="' + esc(m ? m.title : '') + '"' + dis + '><span class="field__err"></span></label>' +
      '<label class="field" data-f="username"><span class="field__label">' + esc(L.username) + '</span><span class="group"><span>@</span><input class="input" name="username" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="40" placeholder="' + esc(L.usernameHint) + '" value="' + esc(m ? m.username : '') + '"' + dis + '></span><div class="suggest" id="suggest" hidden></div><span class="field__err"></span></label>' +
      '<label class="field" data-f="description"><span class="field__label">' + esc(L.description) + '<em id="cnt">0 / ' + lim.desc + '</em></span><textarea class="input" name="description" maxlength="' + lim.desc + '" placeholder="' + esc(L.descHint) + '"' + dis + '>' + esc(m ? m.description : '') + '</textarea><span class="field__err"></span></label>' +
      qs +
      (canEdit && !m ? '<label class="field" data-f="captcha"><span class="field__label">Код с картинки<em>от накруток</em></span>' +
        '<div class="captcha"><img id="cap-img" alt="код с картинки" width="200" height="70"><button type="button" class="btn btn--ghost" id="cap-new" aria-label="Новый код">&#8635;</button></div>' +
        '<input class="input" name="captcha" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Введите символы с картинки"><span class="field__err"></span></label>' : '') +
      (canEdit ? '<div class="form__submit"><div class="note note--bad" id="formerr" style="display:none;margin:0 0 14px"></div><button class="btn btn--gold btn--block" id="send">' + (m ? 'Сохранить изменения' : 'Отправить заявку') + '</button><p class="form__fine">Один человек — один кандидат. Заявку можно изменить, пока приём открыт.</p></div>' : '') +
      '</div></div>';

    var ta = $('textarea[name=description]'), cnt = $('#cnt');
    function count() { cnt.textContent = ta.value.length + ' / ' + lim.desc; }
    ta.addEventListener('input', count); count();
    $$('.input').forEach(function (i) { i.addEventListener('input', function () { i.closest('.field').classList.remove('bad'); }); });

    var send = $('#send');
    if (send) send.addEventListener('click', function () { submit(n); });
    if ($('#cap-img')) {
      $('#cap-new').addEventListener('click', loadCaptcha);
      loadCaptcha();
    }
    var uInp = $('[name="username"]');
    if (uInp && !uInp.disabled) bindSuggest(uInp, n.id);
  }

  // Подсказки юзернеймов: по мере ввода показываем недавно выдвинутых кандидатов того же типа.
  function bindSuggest(inp, nomId) {
    var box = $('#suggest'), timer = null, seq = 0, skip = false;
    function hide() { box.hidden = true; box.innerHTML = ''; }
    inp.addEventListener('input', function () {
      if (skip) { skip = false; return; }
      clearTimeout(timer);
      var q = inp.value.trim().replace(/^https?:\/\/(t\.me\/)?/i, '').replace(/^@/, '').toLowerCase();
      if (!/^[a-z0-9_]{2,32}$/.test(q)) { seq++; hide(); return; }
      var my = ++seq;
      timer = setTimeout(function () {
        call('suggestUsernames', { nominationId: nomId, q: q }).then(function (d) {
          if (my !== seq || !box.isConnected) return; // устаревший ответ
          var items = (d && d.items || []).filter(function (u) { return u.toLowerCase() !== q; });
          if (!items.length) return hide();
          box.innerHTML = items.map(function (u) {
            return '<button type="button" class="suggest__item" data-u="' + esc(u) + '">@' + esc(u) + '</button>';
          }).join('');
          box.hidden = false;
        }).catch(hide);
      }, 250);
    });
    box.addEventListener('click', function (e) {
      var b = e.target.closest('.suggest__item');
      if (!b) return;
      e.preventDefault();
      skip = true; inp.value = b.dataset.u; hide(); tap();
    });
    document.addEventListener('click', function (e) { if (box.isConnected && !box.contains(e.target) && e.target !== inp) hide(); });
  }

  // Публикация карточки админам идёт отдельным вызовом, чтобы кнопка «Отправить» не ждала десятки запросов.
  // Одна повторная попытка; если и она не удалась — сервер догонит заявку сам (publishMissing).
  function publishInBackground(id) {
    if (!id) return;
    call('publishApp', { id: id }).catch(function () {
      setTimeout(function () { call('publishApp', { id: id }).catch(function () {}); }, 3000);
    });
  }

  // Капча для новой заявки: картинка приходит с сервера, код проверяет сервер.
  function loadCaptcha() {
    var img = $('#cap-img'), inp = $('[name="captcha"]');
    if (!img) return;
    state.captcha = null;
    if (inp) inp.value = '';
    call('getCaptcha').then(function (d) {
      state.captcha = d;
      if (img.isConnected) img.src = d.src;
    }).catch(function () {
      var f = $('[data-f="captcha"] .field__err'); if (f) f.textContent = 'Не удалось загрузить картинку. Нажмите ↻';
    });
  }

  function setErr(name, msg) {
    var f = $('[data-f="' + name + '"]'); if (!f) return;
    f.classList.add('bad'); $('.field__err', f).textContent = msg;
  }
  function submit(n) {
    var v = function (name) { var el = $('[name="' + name + '"]'); return el ? el.value.trim() : ''; };
    var lim = n.limits, bad = 0, first = null;
    function fail(name, msg) { setErr(name, msg); bad++; if (!first) first = name; }
    $$('.field.bad').forEach(function (f) { f.classList.remove('bad'); });
    $('#formerr').style.display = 'none';

    var username = v('username').replace(/^https?:\/\/(www\.)?t\.me\//i, '').replace(/^@+/, '');
    if (v('title').length < 2) fail('title', 'Укажите название');
    if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username)) fail('username', 'Нужен юзернейм Telegram: 4–32 символа, латиница, цифры и «_»');
    if (v('description').length < lim.descMin) fail('description', 'Опишите подробнее — минимум ' + lim.descMin + ' символов');
    var answers = {};
    n.questions.forEach(function (q) {
      var a = v('q' + q.id);
      if (q.required && !a) fail('q' + q.id, 'Обязательный вопрос');
      if (a) answers[q.id] = a;
    });
    var captcha = null;
    if (!n.mine) {
      if (!state.captcha) fail('captcha', 'Картинка ещё загружается, попробуйте через секунду');
      else if (v('captcha').length < 5) fail('captcha', 'Введите все 5 символов с картинки');
      else captcha = { id: state.captcha.id, answer: v('captcha') };
    }
    if (bad) { haptic('error'); var el = $('[data-f="' + first + '"]'); if (el) el.scrollIntoView({ behavior: smooth(), block: 'center' }); return; }

    var btn = $('#send'); btn.disabled = true; btn.textContent = 'Отправляем…';
    call('submit', { nominationId: n.id, title: v('title'), username: username, description: v('description'), answers: answers, captcha: captcha, defer: true }).then(function (r) {
      haptic('success');
      publishInBackground(r.id); // карточка админам — уже после показа экрана успеха
      var donateBanner = findDonateBanner(state.home);
      state.home = null; // обновим статусы на главной
      renderDone(n, r.created, r.imported || 0, r.sponsorNomination, donateBanner, r.coins);
    }, function (err) {
      haptic('error');
      btn.disabled = false; btn.textContent = n.mine ? 'Сохранить изменения' : 'Отправить заявку';
      var p = err && err.parameters || {};
      if (p.code === 'CAPTCHA' || (p.fields && p.fields.captcha)) loadCaptcha(); // одноразовый код уже сгорел — выдаём новый
      if (p.fields) {
        Object.keys(p.fields).forEach(function (k) { setErr(k, p.fields[k]); });
      } else {
        var box = $('#formerr'); box.style.display = 'flex';
        box.innerHTML = ico('alert') + '<div>' + esc(err && err.message || 'Не получилось отправить. Попробуйте ещё раз.') + '</div>';
        box.scrollIntoView({ behavior: smooth(), block: 'center' });
      }
    });
  }

  function renderDone(n, created, imported, sponsorNom, donateBanner, coins) {
    setView('done');
    var copied = n.sponsorType
      ? '<p>' + (imported
        ? 'В спонсорскую запись скопировано прежних заявок: <b>' + Number(imported) + '</b>. Исходные заявки сохранены.'
        : 'Совпадающих прежних заявок не найдено; новая запись сохранена.') + '</p>'
      : '';
    if (sponsorNom) copied += '<p>Ваш голос ушёл в спонсорскую номинацию: <b>' + esc(sponsorNom.title) + '</b>.</p>';
    // Донат дублируем только когда голос ушёл к спонсорам (спонсорская номинация или совпадение с спонсорской)
    var isSponsorSubmit = !!(n.sponsorType || sponsorNom);
    var donateHtml = (isSponsorSubmit && donateBanner)
      ? '<div class="done__donate"><div class="sec__kicker">Поддержать нас</div>' + donateCardHtml(donateBanner) + '</div>'
      : '';
    // Монеты: награда за голосование во всех номинациях или прогресс до неё
    var coinsHtml = '';
    if (coins && coins.awarded) {
      coinsHtml = '<div class="done__coins"><b>+<span id="coinNum">0</span></b><span>монет за голосование во всех номинациях. Баланс: ' + Number(coins.balance) +
        '. Их можно потратить на дополнительный голос во 2 туре.</span></div>';
    } else if (coins && coins.enabled && !coins.earned && coins.covered < coins.required) {
      var left = coins.required - coins.covered;
      coinsHtml = '<div class="done__prog"><span>Проголосовано в <b>' + Number(coins.covered) + ' из ' + Number(coins.required) + '</b> номинаций. Ещё ' + left +
        ' — и вы получите <b>' + Number(coins.reward) + ' монет</b> для дополнительного голоса во 2 туре.</span>' +
        '<div class="pbar"><i style="--w:' + Math.round(coins.covered / coins.required * 100) + '%"></i></div></div>';
    }
    root.innerHTML = '<div class="done"><div class="done__mark">' + ico('check') + '</div>' +
      '<h1>' + (created ? 'Заявка отправлена' : 'Изменения сохранены') + '</h1>' +
      '<p>Спасибо! Кандидат в номинации «' + esc(n.title) + '» передан организаторам премии.</p>' +
      copied +
      coinsHtml +
      donateHtml +
      '<div class="done__acts"><button class="btn btn--gold" data-back>К номинациям</button><button class="btn btn--ghost" data-edit="' + n.id + '">' + ico('edit') + 'Изменить заявку</button></div></div>';
    window.scrollTo(0, 0);
    if (donateHtml) bindSponsorBanners(root);
    if (window.FX) {
      // искры от галочки, а при награде — монетный салют из плашки с монетами
      setTimeout(function () { var m = $('.done__mark'); if (m && state.view === 'done') { var r = m.getBoundingClientRect(); FX.burst(r.left + r.width / 2, r.top + r.height / 2, 20, { ring: 74 }); } }, 380);
      if (coins && coins.awarded) {
        setTimeout(function () {
          var b = $('.done__coins'); if (!b || state.view !== 'done') return;
          var r = b.getBoundingClientRect();
          FX.coins(r.left + r.width / 2, r.top + 36, 34);
          FX.countUp($('#coinNum'), 0, Number(coins.awarded), 1100);
          haptic('success');
        }, 750);
      }
    }
    if (!(window.FX && FX.enabled) && coins && coins.awarded) { var cn = $('#coinNum'); if (cn) cn.textContent = String(coins.awarded); }
  }

  // ───────── навигация ─────────
  function setView(v) {
    state.view = v;
    if (window.FX && state.mode !== 'lite') FX.mode(v === 'home' ? 'landing' : v === 'done' ? 'done' : 'off');
    try {
      if (v === 'home') tg.BackButton.hide(); else tg.BackButton.show();
      if (v === 'form') tg.disableVerticalSwipes && tg.disableVerticalSwipes(); else tg.enableVerticalSwipes && tg.enableVerticalSwipes();
    } catch (e) {}
  }
  function loading() { root.innerHTML = '<div class="boot"><svg class="ico" viewBox="0 0 24 24"><use href="#i-spark"/></svg></div>'; }
  function showError(err, retry) {
    var banned = err && err.parameters && err.parameters.code === 'BANNED';
    root.innerHTML = '<div class="fail">' + ico(banned ? 'lock' : 'alert') + '<h1>' + (banned ? 'Доступ ограничен' : 'Не удалось загрузить') + '</h1>' +
      '<p>' + esc(banned ? 'Если вы считаете, что это ошибка, напишите организаторам премии.' : (err && err.message) || 'Проверьте соединение и попробуйте снова.') + '</p>' +
      (banned ? '' : '<button class="btn btn--gold" id="retry">Повторить</button>') + '</div>';
    var r = $('#retry'); if (r) r.addEventListener('click', retry);
  }

  function toHome(scrollTo) {
    setView('home');
    var go = function () {
      renderHome();
      window.scrollTo(0, 0);
      if (scrollTo) setTimeout(function () { var el = $('#' + scrollTo); if (el) el.scrollIntoView({ behavior: smooth() }); }, 60);
    };
    if (state.home) return go();
    loading();
    call('getHome').then(function (d) { state.home = d; go(); }, function (e) { showError(e, function () { toHome(scrollTo); }); });
  }
  function openNom(id) {
    setView('form'); loading();
    call('getNomination', { id: id }).then(function (n) { state.nom = n; renderForm(n); window.scrollTo(0, 0); },
      function (e) { showError(e, function () { openNom(id); }); });
  }
  function openExternal(url) {
    try {
      if (/^https?:\/\/(t|telegram)\.me\//i.test(url)) tg.openTelegramLink(url); else tg.openLink(url);
    } catch (e) { window.open(url, '_blank'); }
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    var el = t.closest && t.closest('[data-nom],[data-go],[data-back],[data-edit],[data-url],[data-sponsor-url],[data-nav],[data-mode],[data-modeopen],[data-modecancel],.spoiler,.post__body a');
    if (!el) return;
    if (el.classList.contains('spoiler')) { el.classList.toggle('open'); return; }
    if (el.matches('.post__body a')) { ev.preventDefault(); openExternal(el.getAttribute('href')); return; }
    if (el.dataset.nav) { ev.preventDefault(); var s = $('#' + el.dataset.nav); if (s) s.scrollIntoView({ behavior: smooth() }); return; }
    tap();
    if (el.dataset.nom) { if (el.getAttribute('aria-disabled')) return; openNom(Number(el.dataset.nom)); }
    else if (el.dataset.go) { var sec = $('#' + el.dataset.go); if (sec) sec.scrollIntoView({ behavior: smooth() }); }
    else if (el.dataset.edit) openNom(Number(el.dataset.edit));
    else if (el.dataset.url) openExternal(el.dataset.url);
    else if (el.dataset.sponsorUrl) {
      var sponsorUrl = safeUrl(el.dataset.sponsorUrl);
      if (/^https:/i.test(sponsorUrl)) openExternal(sponsorUrl);
    }
    else if (el.dataset.mode) pickMode(el.dataset.mode);
    else if (el.hasAttribute('data-modeopen')) renderModePick(true);
    else if (el.hasAttribute('data-modecancel')) toHome();
    else if (el.hasAttribute('data-back')) toHome('noms');
  });
  document.addEventListener('keydown', function (e) { if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('spoiler')) { e.preventDefault(); e.target.classList.toggle('open'); } });

  // ───────── старт ─────────
  if (tg) {
    try {
      tg.ready(); tg.expand();
      tg.setHeaderColor('#0d1024'); tg.setBackgroundColor('#0d1024'); tg.setBottomBarColor && tg.setBottomBarColor('#0d1024');
      tg.BackButton.onClick(function () { if (state.view === 'mode' && !state.mode) return; toHome('noms'); });
    } catch (e) {}
  }
  // Экран выбора версии: при первом запуске (manual=false) и из подвала главной (manual=true).
  function renderModePick(manual, after) {
    modeAfter = after || null;
    setView('mode');
    var rec = recommendLite() ? 'lite' : 'full', cur = state.mode;
    function card(id, title, text) {
      var badge = manual && cur === id ? '<em>Сейчас выбрано</em>' : (!manual && rec === id ? '<em>Рекомендуем для вашего телефона</em>' : '');
      return '<button class="mode' + (!manual && rec === id ? ' is-rec' : '') + (manual && cur === id ? ' is-cur' : '') + '" data-mode="' + id + '">' +
        '<span class="mode__t">' + title + '</span>' + badge + '<span class="mode__s">' + text + '</span></button>';
    }
    root.innerHTML = '<div class="modepick"><div class="modepick__mark">' + ico('spark') + '</div>' +
      '<h1>Выберите версию</h1><p>Так мини-апп будет выглядеть и работать на вашем телефоне.</p>' +
      card('full', 'Нормальная', 'Анимации, золотые искры, наклон баннера. Лучше всего на современных телефонах.') +
      card('lite', 'Лёгкая', 'Без анимаций и эффектов: быстрее открывается, меньше греет телефон и экономит батарею. Подойдёт для слабых устройств.') +
      (manual ? '<button class="btn btn--ghost modepick__cancel" data-modecancel>Отмена</button>' : '') +
      '<small>Изменить выбор можно в любой момент — внизу главной страницы.</small></div>';
    window.scrollTo(0, 0);
  }
  function pickMode(m) {
    saveMode(m); applyMode(m);
    var cb = modeAfter; modeAfter = null;
    if (cb) cb(); else toHome();
  }
  function ensureMode(start) {
    var saved = getSavedMode();
    if (saved) { applyMode(saved); start(); } else renderModePick(false, function () { start(); });
  }

  function renderOutside() {
    root.innerHTML = '<div class="fail">' + ico('spark') + '<h1>Премия года КМБП</h1>' +
      '<p>Мини-апп открывается внутри Telegram. Откройте бота премии и нажмите «Открыть премию».</p></div>';
  }
  var nomParam = (location.search.match(/[?&]nom=(\d+)/) || [])[1];
  if (!IN_TG) {
    renderOutside();
  } else ensureMode(function () {
    if (nomParam) {
      // сразу открыть форму номинации; «назад» ведёт на главную
      setView('form'); loading();
      call('getHome').then(function (d) { state.home = d; openNom(Number(nomParam)); }, function (e) { showError(e, function () { location.reload(); }); });
    } else {
      toHome();
    }
  });
})();
