import { h, icon, toast, sheet, confirmSheet, num, fill } from './dom.js';
import { r2, call } from './api.js';
import { state, go, replace, back, root } from './nav.js';
import { thumb } from './draw.js';

// Спросить код с картинки («я не бот»). Нужен один раз на 12 часов.
export function askCaptcha() {
  return new Promise((resolve) => {
    let done = false;
    const img = h('img', { alt: 'Код с картинки', width: 200, height: 70 });
    const input = h('input', { class: 'input', maxlength: 5, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'Введите 5 символов', 'aria-label': 'Код с картинки' });
    const err = h('div', { class: 'err' });
    let cap = null;
    const load = async () => { err.textContent = ''; input.value = ''; try { cap = await r2('captcha'); img.src = cap.src; } catch (e) { err.textContent = e.message; } };
    const finish = (v) => { done = true; s.close(); resolve(v); };
    const s = sheet({
      title: 'Подтвердите, что вы человек', onClose: () => { if (!done) resolve(null); },
      body: [h('p', { class: 'muted' }, 'Это нужно один раз — так мы защищаем голосование от накруток.'),
        h('div', { class: 'captcha' }, img, h('button', { class: 'iconbtn', 'aria-label': 'Другая картинка', onclick: load }, '↻')), input, err,
        h('button', { class: 'btn btn--gold btn--block', onclick: () => { if (!cap) return; if (input.value.trim().length < 5) { err.textContent = 'Введите все 5 символов'; return; } finish({ id: cap.id, answer: input.value.trim() }); } }, 'Подтвердить')],
    });
    load(); setTimeout(() => input.focus(), 250);
  });
}

// Галерея рисунков к карточке.
export function openGallery(p, { onChange } = {}) {
  const grid = h('div', { class: 'gal' }), more = h('button', { class: 'btn btn--ghost btn--block hide' }, 'Показать ещё');
  let last = 0;
  const s = sheet({ title: 'Рисунки · ' + p.title, wide: true, body: [grid, more] });
  async function load() {
    try {
      const d = await r2('drawings', { projectId: p.id, before: last });
      if (!d.items.length && !last) grid.replaceWith(h('div', { class: 'empty' }, 'Пока никто не оставил рисунок. Будьте первым!'));
      for (const it of d.items) {
        last = it.id;
        const tile = h('div', { class: 'tile' }, thumb(it.strokes, 160));
        const fig = h('figure', {}, tile, h('figcaption', {}, it.name));
        if (it.mine || state.me?.owner) fig.append(h('button', { class: 'mini', onclick: async () => {
          if (!(await confirmSheet({ title: 'Удалить рисунок?', text: it.mine ? 'Ваш рисунок исчезнет с карточки.' : 'Рисунок будет удалён у всех.', ok: 'Удалить', danger: true }))) return;
          try { if (it.mine) { const nid = state.currentNomination; await r2('drawDel', { nominationId: nid }); } else await call('r2admin', { op: 'deleteDrawing', id: it.id }); fig.remove(); toast('Удалено', 'ok'); onChange?.(); } catch (e) { toast(e.message, 'err'); }
        } }, icon('trash'), 'Удалить'));
        grid.append(fig);
      }
      more.classList.toggle('hide', !d.more);
    } catch (e) { toast(e.message, 'err'); }
  }
  more.onclick = load; load();
  return s;
}

const initials = (t) => (String(t).trim()[0] || '?').toUpperCase();

export function nominationScreen({ index = 0, nominationId = null, mode = 'vote', single = false } = {}) {
  return async () => {
    const home = state.home || (state.home = await r2('home'));
    const noms = home.nominations;
    if (!noms.length) throw new Error('Номинации пока не добавлены');
    let i = nominationId ? noms.findIndex((n) => n.id === nominationId) : index;
    if (i < 0) i = 0;
    const nom = noms[i];
    state.currentNomination = nom.id;
    const rootEl = h('div', { class: 'screen' });
    let data;

    async function load() { data = await r2('nom', { nominationId: nom.id }); paint(); }

    async function cast(kind, p, retry = false) {
      const isChange = kind === 'vote' && data.my.main && data.my.main.projectId !== p.id;
      if (!retry) {
        const ok = await confirmSheet(kind === 'extra'
          ? { title: 'Дополнительный голос', text: ['Отдать +0,5 голоса за «' + p.title + '»?', '\nСпишется ' + home.coins.cost + ' монет. Этот голос нельзя изменить или вернуть.'], ok: 'Отдать за ' + home.coins.cost + ' монет' }
          : isChange ? { title: 'Поменять голос?', text: ['Перенести голос на «' + p.title + '»?', '\nСмен осталось: ' + data.my.main.changesLeft + ' из ' + home.rules.maxChanges + '. Менять можно раз в ' + home.rules.cooldownMin + ' минут.'], ok: 'Перенести голос' }
            : { title: 'Отдать голос?', text: 'Ваш голос за «' + p.title + '» в номинации «' + nom.title + '». Его можно будет поменять (до ' + home.rules.maxChanges + ' раз).', ok: 'Проголосовать' });
        if (!ok) return;
      }
      let captcha;
      if (data.needHuman) { captcha = await askCaptcha(); if (!captcha) return; }
      try {
        const res = await r2(kind, { nominationId: nom.id, projectId: p.id, ticket: data.ticket, captcha });
        if (kind === 'extra') { home.coins.balance = res.balance; toast('Дополнительный голос отдан · +0,5', 'ok'); }
        else toast(res.action === 'change' ? 'Голос перенесён' : res.action === 'same' ? 'Это ваш текущий выбор' : 'Голос принят!', 'ok');
        const fresh = await r2('home'); state.home = fresh; Object.assign(home, fresh);
        await load();
      } catch (e) {
        if (e.code === 'HUMAN') { toast(e.message, 'err'); data.needHuman = true; return cast(kind, p, true); }
        if (e.code === 'EARLY') { toast(e.message); return; }
        toast(e.code === 'STALE' ? 'Страница обновлена — нажмите ещё раз' : e.message, e.code === 'STALE' ? '' : 'err');
        await load().catch(() => {});
      }
    }

    function voteBtn(p) {
      const my = data.my, isMain = my.main?.projectId === p.id, isExtra = my.extra?.projectId === p.id;
      if (!data.voting) return h('button', { class: 'btn btn--ghost btn--block', disabled: true }, icon('lock'), 'Голосование закрыто');
      if (mode === 'extra') {
        if (my.extra) return h('button', { class: 'btn btn--block ' + (isExtra ? 'btn--ok' : 'btn--ghost'), disabled: true }, isExtra ? [icon('check'), 'Доп. голос отдан'] : 'Доп. голос уже отдан');
        if (!my.main) return h('button', { class: 'btn btn--ghost btn--block', disabled: true }, 'Сначала обычный голос');
        return h('button', { class: 'btn btn--gold btn--block', onclick: () => cast('extra', p) }, icon('coin'), 'Отдать +0,5 за ' + home.coins.cost);
      }
      if (isMain) return h('button', { class: 'btn btn--ok btn--block', disabled: true }, icon('check'), 'Ваш голос');
      if (my.main) {
        const wait = my.main.nextChangeAt - Math.floor(Date.now() / 1000);
        const locked = my.main.changesLeft <= 0;
        return h('button', { class: 'btn btn--ghost btn--block', disabled: locked, onclick: () => cast('vote', p) }, icon('swap'), locked ? 'Смены исчерпаны' : wait > 0 ? 'Выбрать (через ' + Math.ceil(wait / 60) + ' мин)' : 'Выбрать этот');
      }
      return h('button', { class: 'btn btn--gold btn--block', onclick: () => cast('vote', p) }, 'Проголосовать');
    }

    function card(p) {
      const my = data.my, isMain = my.main?.projectId === p.id, isExtra = my.extra?.projectId === p.id;
      const img = h('div', { class: 'pcard__img' });
      if (p.banner) { const im = h('img', { src: p.banner, alt: '', loading: 'lazy' }); im.addEventListener('error', () => im.remove()); img.append(h('div', { class: 'pcard__ph' }, initials(p.title)), im); }
      else img.append(h('div', { class: 'pcard__ph' }, initials(p.title)));
      if (p.editorsChoice) img.append(h('span', { class: 'ribbon' }, icon('star'), 'Выбор редакции'));
      if (isMain || isExtra) img.append(h('span', { class: 'mine-tag' }, icon('check'), isMain && isExtra ? 'Ваш голос +0,5' : isMain ? 'Ваш голос' : '+0,5 от вас'));
      const long = p.description.length > 160 || p.description.split('\n').length > 3;
      const open = () => { const s = sheet({ title: p.title, body: [h('div', { class: 'pcard__img' }, p.banner ? h('img', { src: p.banner, alt: '' }) : h('div', { class: 'pcard__ph' }, initials(p.title))), h('p', { class: 'sheet__text' }, p.description || 'Описание не добавлено'), voteBtn(p)] }); };
      const draws = p.drawings.count || data.drawEnabled ? h('div', { class: 'pcard__draws' },
        h('div', { class: 'row row--between small muted' }, h('span', {}, 'Рисунки зрителей' + (p.drawings.count ? ' · ' + p.drawings.count : '')), p.drawings.count > 3 ? h('button', { class: 'linkbtn', onclick: () => openGallery(p, { onChange: load }) }, 'Все') : null),
        h('div', { class: 'dgrid' },
          p.drawings.preview.map((d) => h('button', { class: 'tile', 'aria-label': 'Открыть рисунки', onclick: () => openGallery(p, { onChange: load }) }, thumb(d.strokes, 120))),
          data.drawEnabled && p.drawings.preview.length < 4 ? h('button', { class: 'tile tile--add', onclick: async () => { const { drawScreen } = await import('./extras.js'); go(drawScreen({ nominationId: nom.id, projectId: p.id })); } }, icon('brush'), h('span', {}, 'Оставить рисунок')) : null)) : null;
      return h('article', { class: 'pcard' + (isMain ? ' is-mine' : '') + (p.editorsChoice ? ' is-choice' : ''), dataset: { id: p.id } }, img,
        h('div', { class: 'pcard__body' }, h('h3', { class: 'pcard__title' }, p.title), h('p', { class: 'pcard__desc' }, p.description || 'Описание не добавлено'), long ? h('button', { class: 'linkbtn', onclick: open }, 'Читать полностью') : null),
        draws, h('div', { class: 'pcard__foot' }, voteBtn(p)));
    }

    function paint() {
      const list = home.nominations, total = list.length, my = data.my;
      const dots = single ? null : h('div', { class: 'dots', 'aria-hidden': 'true' }, list.map((n, k) => h('i', { class: k === i ? 'now' : n.voted ? 'done' : '' })));
      let note = null;
      if (mode === 'extra') note = h('div', { class: 'banner' }, 'Дополнительный голос стоит ' + home.coins.cost + ' монет и даёт +0,5 голоса. У вас: ' + num(home.coins.balance) + '. Отдать можно один раз в номинации, изменить его нельзя.');
      else if (my.main) {
        const wait = my.main.nextChangeAt - Math.floor(Date.now() / 1000);
        note = h('div', { class: 'banner', style: { background: 'rgba(95,211,154,.1)', borderColor: 'rgba(95,211,154,.4)', color: '#b7f0d4' } }, 'Голос отдан. Смен осталось: ' + my.main.changesLeft + ' из ' + home.rules.maxChanges + (wait > 0 && my.main.changesLeft > 0 ? ' · следующая через ' + Math.ceil(wait / 60) + ' мин' : '') + '.');
      }
      const cards = h('div', { class: 'cards' }, data.projects.map(card));
      const cd = h('div', { class: 'cardsdots', 'aria-hidden': 'true' }, data.projects.map((_, k) => h('i', { class: k === 0 ? 'on' : '' })));
      cards.addEventListener('scroll', () => { const w = cards.firstElementChild?.getBoundingClientRect().width || 1; const k = Math.round(cards.scrollLeft / (w + 14)); [...cd.children].forEach((d, n) => d.classList.toggle('on', n === k)); }, { passive: true });
      const nav = h('div', { class: 'vnav' },
        single ? h('button', { class: 'btn btn--gold btn--big', onclick: back }, my.main || my.extra ? 'Готово' : 'Назад')
          : [i > 0 ? h('button', { class: 'btn btn--ghost btn--big', onclick: () => replace(nominationScreen({ index: i - 1 })) }, icon('back'), 'Назад') : null,
            h('button', { class: 'btn btn--big ' + (my.main ? 'btn--gold' : 'btn--ghost'), onclick: () => (i + 1 < total ? replace(nominationScreen({ index: i + 1 })) : go(finishScreen)) }, i + 1 < total ? 'Дальше' : 'Завершить', icon('arrow'))]);
      fill(rootEl,
        h('div', { class: 'vhead' },
          h('div', { class: 'kicker' }, single ? (mode === 'extra' ? 'Дополнительный голос' : 'Номинация') : 'Номинация ' + (i + 1) + ' из ' + total),
          h('h1', { class: 'h1' }, nom.title), dots),
        note, cards, cd, nav);
    }
    await load();
    return rootEl;
  };
}

export async function finishScreen() {
  const home = await r2('home'); state.home = home;
  const { voted, total } = home.progress, all = voted >= total;
  const { homeScreen } = await import('./home.js'); const { changeScreen, extraScreen } = await import('./extras.js');
  return h('div', { class: 'screen login' }, h('span', { class: 'logo' }, icon('check')), h('h1', { class: 'h1' }, all ? 'Спасибо за голоса!' : 'Почти готово'),
    h('p', { class: 'muted' }, all ? 'Все ваши голоса приняты. Результаты скрыты и будут объявлены организаторами.' : 'Вы проголосовали в ' + voted + ' из ' + total + ' номинаций. Остальные можно пройти позже.'),
    !all ? h('button', { class: 'btn btn--gold btn--big btn--block', onclick: () => go(nominationScreen({ index: Math.max(0, home.nominations.findIndex((n) => !n.voted)) })) }, 'Проголосовать в оставшихся') : null,
    h('button', { class: 'btn btn--ghost btn--block', onclick: () => go(changeScreen) }, icon('swap'), 'Поменять голос'),
    h('button', { class: 'btn btn--ghost btn--block', onclick: () => go(extraScreen) }, icon('coin'), 'Отдать дополнительный голос'),
    h('button', { class: 'btn btn--ghost btn--block', onclick: () => root(homeScreen) }, 'На главную'));
}
