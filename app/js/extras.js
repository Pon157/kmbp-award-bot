// «Поменять голос», «Дополнительный голос», «Нарисовать рисунок».
import { h, icon, toast, confirmSheet, num } from './dom.js';
import { r2 } from './api.js';
import { state, go, back, root } from './nav.js';
import { nominationScreen } from './vote.js';
import { createEditor } from './draw.js';

const top = (title, sub) => h('div', { class: 'top' }, h('button', { class: 'iconbtn', 'aria-label': 'Назад', onclick: back }, icon('back')), h('div', { class: 'top__title' }, title));

export async function changeScreen() {
  const [home, mine] = await Promise.all([r2('home'), r2('mine')]);
  state.home = home;
  const main = new Map(mine.votes.filter((v) => v.kind === 'main').map((v) => [v.nomination_id, v]));
  const now = Math.floor(Date.now() / 1000);
  const rows = home.nominations.map((n) => {
    const v = main.get(n.id);
    if (!v) return h('div', { class: 'card row row--between' }, h('div', { class: 'grow' }, h('div', { class: 'mitem__t' }, n.title), h('div', { class: 'small muted' }, 'Вы ещё не голосовали')),
      h('button', { class: 'btn btn--gold btn--sm', onclick: () => go(nominationScreen({ nominationId: n.id, single: true })) }, 'Выбрать'));
    const left = Math.max(0, home.rules.maxChanges - v.changes), wait = v.updated_at + home.rules.cooldownMin * 60 - now;
    const status = left <= 0 ? 'Смены исчерпаны' : 'Смен: ' + left + (wait > 0 ? ' · следующая через ' + Math.ceil(wait / 60) + ' мин' : '');
    return h('div', { class: 'card row row--between' }, h('div', { class: 'grow' }, h('div', { class: 'mitem__t' }, n.title), h('div', { class: 'small' }, '✓ ' + v.project), h('div', { class: 'small muted' }, status)),
      h('button', { class: 'btn btn--ghost btn--sm', disabled: left <= 0, onclick: () => go(nominationScreen({ nominationId: n.id, single: true })) }, icon('swap'), 'Изменить'));
  });
  return h('div', { class: 'screen' }, top('Поменять голос'), h('p', { class: 'muted', style: { marginBottom: '14px' } }, 'В каждой номинации голос можно менять до ' + home.rules.maxChanges + ' раз, не чаще одного раза в ' + home.rules.cooldownMin + ' минут.'),
    h('div', { class: 'stack' }, rows.length ? rows : h('div', { class: 'empty' }, 'Номинации скоро появятся')));
}

export async function extraScreen() {
  const [home, mine] = await Promise.all([r2('home'), r2('mine')]);
  state.home = home;
  const main = new Set(mine.votes.filter((v) => v.kind === 'main').map((v) => v.nomination_id));
  const extra = new Map(mine.votes.filter((v) => v.kind === 'extra').map((v) => [v.nomination_id, v]));
  const enough = home.coins.balance >= home.coins.cost;
  const rows = home.nominations.map((n) => {
    const e = extra.get(n.id);
    const act = e ? h('span', { class: 'tag tag--ok' }, '+0,5 · ' + e.project)
      : !main.has(n.id) ? h('span', { class: 'tag' }, 'Сначала обычный голос')
        : h('button', { class: 'btn btn--gold btn--sm', disabled: !enough || !home.cfg.voting, onclick: () => go(nominationScreen({ nominationId: n.id, mode: 'extra', single: true })) }, 'Выбрать проект');
    return h('div', { class: 'card row row--between' }, h('div', { class: 'grow' }, h('div', { class: 'mitem__t' }, n.title)), act);
  });
  return h('div', { class: 'screen' }, top('Дополнительный голос'),
    h('section', { class: 'hero', style: { padding: '22px', marginBottom: '16px' } }, h('div', { class: 'kicker' }, 'Ваш баланс'), h('div', { class: 'h1' }, h('span', {}, num(home.coins.balance)), ' ', icon('coin')),
      h('p', { class: 'hero__lead' }, home.coins.cost + ' монет = 0,5 голоса. Дополнительный голос можно отдать в каждой номинации один раз — после основного. Отменить или перенести его нельзя.'),
      !enough ? h('p', { class: 'small', style: { marginTop: '10px', color: '#ffd9a6' } }, 'Пока не хватает монет: нужно ' + home.coins.cost + '.') : null),
    h('div', { class: 'stack' }, rows));
}

// ── Рисунок: выбираете номинацию и карточку, рисуете на квадратном холсте ──
export function drawScreen(pre = {}) {
  return async () => {
    const home = state.home || (state.home = await r2('home'));
    if (!home.cfg.draw) return h('div', { class: 'screen' }, top('Рисунок'), h('div', { class: 'empty' }, 'Рисунки сейчас отключены организаторами.'));
    if (!home.nominations.length) return h('div', { class: 'screen' }, top('Рисунок'), h('div', { class: 'empty' }, 'Номинации скоро появятся.'));
    let nomId = pre.nominationId || home.nominations[0].id, projId = pre.projectId || null, data = null;
    const editor = createEditor();
    editor.onLimit = () => toast('Рисунок слишком сложный — упростите его');
    const picker = h('div', { class: 'stack' }), note = h('div', { class: 'small muted' }), saveBtn = h('button', { class: 'btn btn--gold btn--big btn--block', disabled: true }, 'Оставить рисунок');
    const delBtn = h('button', { class: 'btn btn--danger btn--block hide' }, icon('trash'), 'Удалить мой рисунок в этой номинации');
    const refreshState = () => { saveBtn.disabled = !(projId && !editor.isEmpty()); };
    editor.onChange(refreshState);
    async function loadNom() {
      data = await r2('nom', { nominationId: nomId });
      if (!data.projects.some((p) => p.id === projId)) projId = data.my.drawing?.projectId || null;
      paintPicker();
    }
    function paintPicker() {
      picker.replaceChildren(
        h('div', { class: 'field' }, h('span', { class: 'field__l' }, 'Номинация'), h('div', { class: 'chips chips--scroll' }, home.nominations.map((n) => h('button', { class: 'chip', 'aria-pressed': String(n.id === nomId), onclick: async () => { nomId = n.id; projId = null; await loadNom().catch((e) => toast(e.message, 'err')); } }, n.title)))),
        h('div', { class: 'field' }, h('span', { class: 'field__l' }, 'Карточка проекта, на которой останется рисунок'), h('div', { class: 'chips' }, data.projects.map((p) => h('button', { class: 'chip', 'aria-pressed': String(p.id === projId), onclick: () => { projId = p.id; paintPicker(); refreshState(); } }, p.title)))));
      const mineD = data.my.drawing;
      note.textContent = mineD ? 'У вас уже есть рисунок в этой номинации — новый заменит его. В каждой номинации можно оставить один рисунок.' : 'В каждой номинации можно оставить один рисунок — на любой карточке. Организаторы могут удалить неподходящие.';
      delBtn.classList.toggle('hide', !mineD);
      refreshState();
    }
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try { await r2('draw', { nominationId: nomId, projectId: projId, strokes: editor.getStrokes() }); toast('Рисунок оставлен на карточке!', 'ok'); back(); }
      catch (e) { toast(e.message, 'err'); refreshState(); }
    };
    delBtn.onclick = async () => {
      if (!(await confirmSheet({ title: 'Удалить рисунок?', text: 'Он исчезнет с карточки.', ok: 'Удалить', danger: true }))) return;
      try { await r2('drawDel', { nominationId: nomId }); toast('Удалено', 'ok'); await loadNom(); } catch (e) { toast(e.message, 'err'); }
    };
    await loadNom();
    return h('div', { class: 'screen' }, top('Нарисовать рисунок'), h('div', { class: 'stack' }, picker, editor.el, note, saveBtn, delBtn));
  };
}
