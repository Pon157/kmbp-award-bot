// Админ-панель 2 тура. Доступна только владельцам: сервер проверяет это при КАЖДОМ запросе, скрытие кнопок — лишь удобство.
import { h, icon, toast, sheet, confirmSheet, num, fmtDateTime, spinner } from './dom.js';
import { admin as A } from './api.js';
import { state, back } from './nav.js';
import { thumb } from './draw.js';

let tab = 'overview';
const TABS = [['overview', 'Обзор'], ['access', 'Доступ'], ['projects', 'Проекты'], ['results', 'Результаты'], ['drawings', 'Рисунки'], ['forum', 'Форум']];
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, 'err'); } };
const switchRow = (title, sub, on, set) => {
  const t = h('button', { class: 'tog', role: 'switch', 'aria-checked': String(on), 'aria-label': title });
  t.onclick = guard(async () => { const v = t.getAttribute('aria-checked') !== 'true'; await set(v); t.setAttribute('aria-checked', String(v)); });
  return h('div', { class: 'switch' }, h('div', {}, h('div', { class: 'mitem__t' }, title), sub ? h('div', { class: 'small muted' }, sub) : null), t);
};
const copyText = async (text) => {
  try { await navigator.clipboard.writeText(text); toast('Скопировано', 'ok'); }
  catch (e) { sheet({ title: 'Скопируйте текст', body: [h('textarea', { class: 'textarea', rows: 12, readonly: true }, text)] }); }
};

export async function adminScreen() {
  const body = h('div', { class: 'stack' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const views = { overview, access, projects, results, drawings, forum: forumTab };
  async function select(id) {
    tab = id;
    tabs.replaceChildren(...TABS.map(([k, t]) => h('button', { class: 'tab', role: 'tab', 'aria-selected': String(k === tab), onclick: () => select(k) }, t)));
    body.replaceChildren(spinner());
    try { body.replaceChildren(await views[tab]()); } catch (e) { body.replaceChildren(h('div', { class: 'banner' }, e.message)); }
  }
  reselect = select;
  await select(tab);
  return h('div', { class: 'screen' }, h('div', { class: 'top' }, h('button', { class: 'iconbtn', 'aria-label': 'Назад', onclick: back }, icon('back')), h('div', { class: 'top__title' }, 'Админ-панель · 2 тур')), tabs, body);
}

// ── Обзор и настройки ──
async function overview() {
  const { cfg, counts } = await A('overview');
  const set = (k) => async (v) => { await A('setCfg', { [k]: v }); state.home = null; };
  const names = { access: 'допущено ID', voters: 'проголосовали', votes: 'голосов (всего)', projects: 'карточек', drawings: 'рисунков', posts: 'сообщений', reported: 'с жалобами' };
  return h('div', { class: 'stack' },
    h('div', { class: 'kpis' }, Object.entries(names).map(([k, t]) => h('div', { class: 'kpi' }, h('b', {}, String(counts[k])), h('span', { class: 'small muted' }, t)))),
    h('div', { class: 'card' },
      switchRow('Доступ только по списку ID', 'Выключите, когда второй тур откроется для всех', cfg.restrict, set('restrict')),
      switchRow('Голосование открыто', 'Если выключить — голоса не принимаются', cfg.voting, set('voting')),
      switchRow('Форум', null, cfg.forum, set('forum')),
      switchRow('Рисунки', null, cfg.draw, set('draw')),
      switchRow('Перемешивать порядок карточек', 'У каждого человека свой стабильный порядок — позиция не влияет на итог', cfg.shuffle, set('shuffle')),
      switchRow('Рисунок — только на одной карточке во всём туре', 'Выключено: один рисунок в каждой номинации', cfg.drawScope === 'global', async (v) => { await A('setCfg', { drawScope: v ? 'global' : 'nomination' }); })),
    h('p', { class: 'small muted' }, 'Номинации (названия, порядок) по-прежнему настраиваются в боте. Здесь — карточки проектов, доступ, результаты и модерация.'));
}

// ── Доступ ──
async function access() {
  const wrap = h('div', { class: 'stack' }), list = h('div', {});
  const ta = h('textarea', { class: 'textarea', rows: 3, placeholder: 'Telegram ID или @username — через пробел, запятую или с новой строки', 'aria-label': 'ID' });
  const found = h('div', {}), q = h('input', { class: 'input', placeholder: 'Найти человека по имени, @username или ID', 'aria-label': 'Поиск' });
  async function reload() {
    const { items } = await A('accessList');
    list.replaceChildren(h('div', { class: 'sec__h' }, h('h2', { class: 'h2' }, 'Допущены · ' + items.length)),
      ...(items.length ? items.map((u) => h('div', { class: 'arow', style: { gridTemplateColumns: '1fr auto' } },
        h('div', {}, h('div', { class: 'arow__t' }, u.name || 'Без имени'), h('div', { class: 'small muted' }, 'ID ' + u.id + (u.username ? ' · @' + u.username : '') + ' · голосов: ' + u.votes + ' · был: ' + fmtDateTime(u.lastSeen))),
        h('button', { class: 'btn btn--danger btn--sm', onclick: guard(async () => { if (!(await confirmSheet({ title: 'Убрать доступ?', text: u.name + ' (ID ' + u.id + ') больше не сможет открыть второй тур. Его голоса сохранятся.', ok: 'Убрать', danger: true }))) return; await A('accessRemove', { id: u.id }); reload(); }) }, 'Убрать'))) : [h('div', { class: 'empty' }, 'Список пуст — второй тур видите только вы')]));
  }
  const add = guard(async () => {
    if (!ta.value.trim()) return;
    const r = await A('accessAdd', { text: ta.value });
    ta.value = '';
    toast('Добавлено: ' + r.added.length + (r.known.length ? ' · уже были: ' + r.known.length : '') + (r.unknown.length ? ' · не найдены: ' + r.unknown.join(', ') : ''), r.unknown.length ? '' : 'ok');
    reload();
  });
  let tm = null;
  q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(guard(async () => {
    const { items } = await A('searchUsers', { q: q.value });
    found.replaceChildren(...items.map((u) => h('div', { class: 'arow', style: { gridTemplateColumns: '1fr auto' } }, h('div', {}, h('div', { class: 'arow__t' }, u.name), h('div', { class: 'small muted' }, 'ID ' + u.id + (u.username ? ' · @' + u.username : ''))),
      h('button', { class: 'btn btn--gold btn--sm', onclick: guard(async () => { await A('accessAdd', { text: String(u.id) }); toast('Добавлен', 'ok'); reload(); }) }, 'Допустить'))));
  }), 300); });
  wrap.append(h('div', { class: 'card stack' }, h('h2', { class: 'h2' }, 'Добавить по ID'), ta, h('button', { class: 'btn btn--gold', onclick: add }, icon('plus'), 'Добавить'), h('p', { class: 'small muted' }, 'Человек может быть в базе бота — тогда подойдёт и @username. ID можно узнать, например, в боте @userinfobot.')),
    h('div', { class: 'card stack' }, h('h2', { class: 'h2' }, 'Поиск среди знакомых боту'), q, found), list);
  await reload();
  return wrap;
}

// ── Проекты ──
function fileToBanner(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error('Выберите файл-картинку'));
    const url = URL.createObjectURL(file), img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть картинку')); };
    img.onload = () => {
      URL.revokeObjectURL(url);
      const W = 1280, H = 720, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d'), k = Math.max(W / img.width, H / img.height), w = img.width * k, hh = img.height * k;
      ctx.fillStyle = '#10143a'; ctx.fillRect(0, 0, W, H); ctx.drawImage(img, (W - w) / 2, (H - hh) / 2, w, hh);   // кадрирование 16:9
      for (const q of [0.86, 0.78, 0.7, 0.6, 0.5, 0.4]) {
        const data = cv.toDataURL('image/jpeg', q), b64 = data.split(',')[1];
        if (b64.length * 0.75 <= 560 * 1024) return resolve({ b64, preview: data });
      }
      reject(new Error('Картинка слишком тяжёлая'));
    };
    img.src = url;
  });
}
let curNom = null;
async function projects() {
  const { items: noms } = await A('noms');
  if (!noms.length) return h('div', { class: 'empty' }, 'Сначала создайте номинации в боте.');
  if (!noms.some((n) => n.id === curNom)) curNom = noms[0].id;
  const wrap = h('div', { class: 'stack' }), list = h('div', {});
  const chips = h('div', { class: 'chips chips--scroll' });
  const paintChips = () => chips.replaceChildren(...noms.map((n) => h('button', { class: 'chip', 'aria-pressed': String(n.id === curNom), onclick: () => { curNom = n.id; paintChips(); reload(); } }, n.title + ' · ' + n.projects)));
  async function reload() {
    const { items } = await A('projects', { nominationId: curNom });
    const n = noms.find((x) => x.id === curNom); if (n) n.projects = items.length; paintChips();
    list.replaceChildren(...(items.length ? items.map((p, i) => h('div', { class: 'arow' },
      p.banner ? h('img', { class: 'arow__img', src: p.banner, alt: '', loading: 'lazy' }) : h('div', { class: 'arow__img' }),
      h('div', {}, h('div', { class: 'arow__t' }, p.title, p.editorsChoice ? h('span', { class: 'tag tag--warn', style: { marginLeft: '8px' } }, '★ выбор редакции') : null), h('div', { class: 'small muted' }, p.description.slice(0, 80) || 'без описания')),
      h('div', { class: 'acts' },
        h('button', { class: 'iconbtn', 'aria-label': 'Выбор редакции', title: 'Выбор редакции', onclick: guard(async () => { await A('toggleChoice', { id: p.id }); reload(); }) }, icon('star')),
        h('button', { class: 'iconbtn', 'aria-label': 'Выше', disabled: i === 0 ? true : null, onclick: guard(async () => { await A('moveProject', { id: p.id, dir: 'up' }); reload(); }) }, icon('up')),
        h('button', { class: 'iconbtn', 'aria-label': 'Ниже', disabled: i === items.length - 1 ? true : null, onclick: guard(async () => { await A('moveProject', { id: p.id, dir: 'down' }); reload(); }) }, icon('down')),
        h('button', { class: 'iconbtn', 'aria-label': 'Изменить', onclick: () => editor(p) }, icon('edit')),
        h('button', { class: 'iconbtn', 'aria-label': 'Удалить', onclick: guard(async () => { if (!(await confirmSheet({ title: 'Удалить карточку?', text: '«' + p.title + '» и рисунки зрителей на ней будут удалены. Голоса за неё перестанут учитываться.', ok: 'Удалить', danger: true }))) return; await A('deleteProject', { id: p.id }); reload(); }) }, icon('trash'))))) : [h('div', { class: 'empty' }, 'В этой номинации ещё нет карточек')]));
  }
  function editor(p) {
    const f = { title: p?.title || '', description: p?.description || '', choice: !!p?.editorsChoice, banner: null, remove: false };
    const title = h('input', { class: 'input', maxlength: 80, value: f.title, placeholder: 'Название проекта', 'aria-label': 'Название' });
    const descr = h('textarea', { class: 'textarea', rows: 5, maxlength: 1200, placeholder: 'Описание (до 1200 символов)', 'aria-label': 'Описание' }); descr.value = f.description;
    const prev = h('img', { class: 'banner-prev hide', alt: 'Превью баннера' });
    const file = h('input', { type: 'file', accept: 'image/*', class: 'input', 'aria-label': 'Баннер' });
    file.onchange = guard(async () => { if (!file.files[0]) return; try { const r = await fileToBanner(file.files[0]); f.banner = r.b64; f.remove = false; prev.src = r.preview; prev.classList.remove('hide'); } catch (e) { toast(e.message, 'err'); file.value = ''; } });
    const choice = h('button', { class: 'tog', role: 'switch', 'aria-checked': String(f.choice), 'aria-label': 'Выбор редакции' }); choice.onclick = () => { f.choice = !f.choice; choice.setAttribute('aria-checked', String(f.choice)); };
    const save = h('button', { class: 'btn btn--gold btn--block' }, 'Сохранить');
    const s = sheet({ title: p ? 'Изменить карточку' : 'Новая карточка', body: [
      h('div', { class: 'field' }, h('span', { class: 'field__l' }, 'Название'), title), h('div', { class: 'field' }, h('span', { class: 'field__l' }, 'Описание'), descr),
      h('div', { class: 'field' }, h('span', { class: 'field__l' }, 'Баннер (любая картинка — будет обрезана до 16:9 и сжата)'), file, prev, p?.bannerVer ? h('button', { class: 'btn btn--ghost btn--sm', onclick: () => { f.remove = true; f.banner = null; prev.classList.add('hide'); file.value = ''; toast('Баннер будет удалён при сохранении'); } }, 'Убрать текущий баннер') : null),
      h('div', { class: 'switch' }, h('div', {}, h('div', { class: 'mitem__t' }, 'Выбор редакции'), h('div', { class: 'small muted' }, 'Золотая метка на карточке')), choice), save] });
    save.onclick = guard(async () => {
      save.disabled = true;
      try { await A('saveProject', { id: p?.id, nominationId: curNom, title: title.value, description: descr.value, editorsChoice: f.choice, banner: f.banner || undefined, removeBanner: f.remove || undefined }); s.close(); toast('Сохранено', 'ok'); reload(); }
      catch (e) { toast(e.message, 'err'); save.disabled = false; }
    });
  }
  wrap.append(chips, h('button', { class: 'btn btn--gold', onclick: () => editor(null) }, icon('plus'), 'Добавить карточку'), list);
  await reload();
  return wrap;
}

// ── Результаты (видны только здесь) ──
async function results() {
  const wrap = h('div', { class: 'stack' });
  const [{ items }, sus] = await Promise.all([A('results'), A('suspicious')]);
  wrap.append(h('div', { class: 'row row--between' }, h('p', { class: 'small muted' }, 'Результаты видите только вы. Основной голос = 1, дополнительный = 0,5. Исключённые и голоса забаненных не считаются.'),
    h('button', { class: 'btn btn--ghost btn--sm', onclick: guard(async () => copyText((await A('resultsText')).text)) }, 'Копировать')));
  if (!items.length) wrap.append(h('div', { class: 'empty' }, 'Пока нет голосов'));
  for (const n of items) {
    const max = Math.max(...n.projects.map((p) => p.score), 0.0001);
    wrap.append(h('section', { class: 'card stack' }, h('div', { class: 'row row--between' }, h('h2', { class: 'h2' }, n.title), h('span', { class: 'muted small' }, 'всего ' + num(n.total))),
      h('div', { class: 'res' }, n.projects.map((p, i) => h('div', { class: 'res__row' + (i === 0 && p.score > 0 ? ' first' : '') },
        h('div', { class: 'res__top' }, h('span', {}, (p.editorsChoice ? '★ ' : '') + p.title), h('span', {}, num(p.score) + ' · ' + num(p.share) + '%')),
        h('div', { class: 'res__bar' }, h('i', { style: { width: Math.round((p.score / max) * 100) + '%' } })),
        h('div', { class: 'small muted' }, 'основных: ' + p.mains + ' · допов: ' + p.extras + (p.removed ? ' · исключено: ' + p.removed : '')))))));
  }
  const susBox = h('section', { class: 'stack' }, h('div', { class: 'sec__h' }, h('h2', { class: 'h2' }, 'Подозрительные голоса · ' + sus.items.length)),
    h('p', { class: 'small muted' }, 'Группы с общим IP, всплески голосов, одинаковые устройства. Это сигнал, а не приговор: в одной сети могут быть настоящие люди.'));
  if (!sus.items.length) susBox.append(h('div', { class: 'empty' }, 'Всё чисто'));
  for (const u of sus.items) {
    const excl = u.votes.length && u.votes.every((v) => v.excluded);
    susBox.append(h('div', { class: 'sus' }, h('div', { class: 'row row--between' }, h('div', {}, h('b', {}, u.name), h('span', { class: 'muted small' }, ' · ID ' + u.userId + (u.username ? ' · @' + u.username : ''))), h('span', { class: 'tag tag--bad' }, 'риск ' + u.score)),
      h('div', { class: 'chips' }, u.reasons.map((r) => h('span', { class: 'tag tag--warn' }, r))),
      h('div', { class: 'small muted' }, u.votes.map((v) => v.nomination + ': ' + v.project + ' (' + num(v.weight) + (v.excluded ? ', исключён' : '') + ')').join(' · ')),
      h('div', { class: 'acts', style: { justifyContent: 'flex-start' } },
        h('button', { class: 'btn btn--sm ' + (excl ? 'btn--ok' : 'btn--danger'), onclick: guard(async () => { await A('exclude', { userId: u.userId, excluded: !excl, reason: 'подозрение на накрутку' }); toast(excl ? 'Голоса возвращены' : 'Голоса исключены', 'ok'); switchTab('results'); }) }, excl ? 'Вернуть в подсчёт' : 'Исключить из подсчёта'),
        h('button', { class: 'btn btn--ghost btn--sm', onclick: guard(async () => { if (!(await confirmSheet({ title: 'Удалить голоса?', text: 'Все голоса человека будут удалены, монеты за допголоса вернутся. Он сможет проголосовать заново.', ok: 'Удалить', danger: true }))) return; const r = await A('resetVotes', { userId: u.userId }); toast('Удалено голосов: ' + r.removed, 'ok'); switchTab('results'); }) }, 'Удалить голоса'))));
  }
  wrap.append(susBox);
  return wrap;
}
let reselect = null;
const switchTab = (t) => reselect?.(t);

// ── Рисунки ──
async function drawings() {
  const wrap = h('div', { class: 'stack' }), grid = h('div', { class: 'gal' }), more = h('button', { class: 'btn btn--ghost btn--block hide' }, 'Показать ещё');
  let last = 0;
  async function load() {
    const d = await A('drawings', { before: last });
    for (const it of d.items) {
      last = it.id;
      const fig = h('figure', {}, h('div', { class: 'tile' }, thumb(it.strokes, 160)), h('figcaption', {}, it.name + (it.username ? ' @' + it.username : '')), h('figcaption', {}, it.nomination + ' → ' + it.project),
        h('button', { class: 'btn btn--danger btn--sm', onclick: guard(async () => { await A('deleteDrawing', { id: it.id }); fig.remove(); toast('Удалено', 'ok'); }) }, icon('trash'), 'Удалить'));
      grid.append(fig);
    }
    more.classList.toggle('hide', !d.more);
    if (!last) grid.replaceWith(h('div', { class: 'empty' }, 'Рисунков пока нет'));
  }
  more.onclick = guard(load);
  wrap.append(h('p', { class: 'small muted' }, 'Новые сверху. Рисунок можно удалить — человек сможет нарисовать другой.'), grid, more);
  await load();
  return wrap;
}

// ── Форум ──
async function forumTab() {
  const wrap = h('div', { class: 'stack' });
  let filter = 'all';
  const chips = h('div', { class: 'chips' }), list = h('div', {}), topicsBox = h('div', { class: 'card stack' });
  async function loadPosts() {
    chips.replaceChildren(...[['all', 'Все'], ['reported', 'С жалобами'], ['hidden', 'Скрытые']].map(([k, t]) => h('button', { class: 'chip', 'aria-pressed': String(filter === k), onclick: () => { filter = k; loadPosts(); } }, t)));
    const { items } = await A('posts', { filter });
    list.replaceChildren(...(items.length ? items.map((p) => h('div', { class: 'post' + (p.hidden ? '' : '') },
      h('div', { class: 'row row--between small muted' }, h('span', {}, p.name + ' · ID ' + p.userId + ' · ' + p.topic + ' · ' + fmtDateTime(p.at)), h('span', {}, (p.reports ? '⚑ ' + p.reports + ' ' : '') + (p.hidden ? 'скрыто ' : '') + (p.muted ? '🔇' : ''))),
      h('div', { style: { margin: '6px 0' } }, p.text),
      h('div', { class: 'acts', style: { justifyContent: 'flex-start' } },
        h('button', { class: 'btn btn--ghost btn--sm', onclick: guard(async () => { await A('hidePost', { id: p.id, hidden: !p.hidden }); loadPosts(); }) }, p.hidden ? 'Показать' : 'Скрыть'),
        h('button', { class: 'btn btn--danger btn--sm', onclick: guard(async () => { await A('mute', { userId: p.userId, minutes: 1440, reason: 'решение организатора' }); toast('Заглушен на сутки', 'ok'); loadPosts(); }) }, 'Мьют 24 ч'),
        h('button', { class: 'btn btn--ghost btn--sm', onclick: guard(async () => { await A('mute', { userId: p.userId, minutes: 0 }); toast('Мьют снят', 'ok'); loadPosts(); }) }, 'Снять мьют')))) : [h('div', { class: 'empty' }, 'Ничего нет')]));
  }
  async function loadTopics() {
    const { items } = await A('topics');
    topicsBox.replaceChildren(h('h2', { class: 'h2' }, 'Темы'), ...items.map((t) => h('div', { class: 'arow', style: { gridTemplateColumns: '1fr auto' } }, h('div', {}, h('div', { class: 'arow__t' }, t.title + (t.locked ? ' 🔒' : '') + (t.pinned ? ' 📌' : '')), h('div', { class: 'small muted' }, t.descr || '—')),
      h('div', { class: 'acts' }, h('button', { class: 'iconbtn', 'aria-label': 'Изменить', onclick: () => topicEditor(t) }, icon('edit')), h('button', { class: 'iconbtn', 'aria-label': 'Удалить', onclick: guard(async () => { if (!(await confirmSheet({ title: 'Удалить тему?', text: 'Тема исчезнет с форума.', ok: 'Удалить', danger: true }))) return; await A('deleteTopic', { id: t.id }); loadTopics(); }) }, icon('trash'))))),
      h('button', { class: 'btn btn--ghost', onclick: () => topicEditor(null) }, icon('plus'), 'Новая тема'));
  }
  function topicEditor(t) {
    const f = { locked: !!t?.locked, pinned: !!t?.pinned };
    const title = h('input', { class: 'input', maxlength: 60, value: t?.title || '', placeholder: 'Название темы', 'aria-label': 'Название' }), descr = h('input', { class: 'input', maxlength: 120, value: t?.descr || '', placeholder: 'Короткое описание', 'aria-label': 'Описание' });
    const tg = (key, label) => { const b = h('button', { class: 'tog', role: 'switch', 'aria-checked': String(f[key]), 'aria-label': label }); b.onclick = () => { f[key] = !f[key]; b.setAttribute('aria-checked', String(f[key])); }; return h('div', { class: 'switch' }, h('span', {}, label), b); };
    const save = h('button', { class: 'btn btn--gold btn--block' }, 'Сохранить');
    const s = sheet({ title: t ? 'Изменить тему' : 'Новая тема', body: [title, descr, tg('locked', 'Закрыта для сообщений'), tg('pinned', 'Закреплена'), save] });
    save.onclick = guard(async () => { await A('saveTopic', { id: t?.id, title: title.value, descr: descr.value, locked: f.locked, pinned: f.pinned }); s.close(); loadTopics(); });
  }
  wrap.append(h('div', { class: 'sec__h' }, h('h2', { class: 'h2' }, 'Модерация')), chips, list, topicsBox);
  await Promise.all([loadPosts(), loadTopics()]);
  return wrap;
}
