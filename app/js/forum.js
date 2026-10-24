import { h, icon, toast, sheet, confirmSheet, fmtTime, fmtDay } from './dom.js';
import { forum, call } from './api.js';
import { state, go, back, onLeave } from './nav.js';

const top = (title, sub) => h('div', { class: 'top' }, h('button', { class: 'iconbtn', 'aria-label': 'Назад', onclick: back }, icon('back')), h('div', { class: 'top__title' }, title), sub || null);
const hue = (s) => { let x = 0; for (const c of String(s)) x = (x * 31 + c.codePointAt(0)) % 360; return x; };
const ago = (ts) => { if (!ts) return 'пока пусто'; const d = Math.floor(Date.now() / 1000) - ts; return d < 60 ? 'только что' : d < 3600 ? Math.floor(d / 60) + ' мин назад' : d < 86400 ? Math.floor(d / 3600) + ' ч назад' : fmtDay(ts); };

export async function forumScreen() {
  const { topics, enabled } = await forum('topics');
  return h('div', { class: 'screen' }, top('Форум'),
    h('p', { class: 'muted', style: { marginBottom: '14px' } }, 'Обсуждайте номинации и проекты. Только текст, без ссылок и рекламы — будьте вежливы.'),
    !enabled ? h('div', { class: 'banner' }, 'Форум закрыт организаторами.') : null,
    topics.length ? topics.map((t) => h('button', { class: 'topic', onclick: () => go(topicScreen(t)) },
      h('div', { class: 'topic__t' }, (t.pinned ? '📌 ' : '') + t.title + (t.locked ? ' 🔒' : '')), t.descr ? h('div', { class: 'topic__d' }, t.descr) : h('div', {}),
      h('div', { class: 'topic__n' }, t.posts + ' сообщ.', h('br'), ago(t.lastAt)))) : h('div', { class: 'empty' }, 'Тем пока нет'));
}

export function topicScreen(topic) {
  return async () => {
    const owner = !!state.me.owner;
    let lastId = 0, firstId = 0, replyTo = null, sentAt = 0, busy = false;
    const chat = h('div', { class: 'chat', 'aria-live': 'polite' });
    const olderBtn = h('button', { class: 'btn btn--ghost btn--sm hide' }, 'Загрузить ранее');
    const rows = new Map();
    let lastDay = '';

    function msgEl(p) {
      const el = h('div', { class: 'msg' + (p.mine ? ' mine' : '') + (p.hidden ? ' is-hidden' : ''), dataset: { id: p.id }, style: { '--hue': String(hue(p.name)) } });
      const acts = h('div', { class: 'bubble__a' });
      if (!topic.locked || owner) acts.append(h('button', { class: 'mini', onclick: () => setReply(p) }, icon('reply'), 'Ответить'));
      if (!p.mine && !p.staff && !p.reported) acts.append(h('button', { class: 'mini', onclick: async () => { if (!(await confirmSheet({ title: 'Пожаловаться?', text: 'Модераторы проверят сообщение. После нескольких жалоб оно скрывается автоматически.', ok: 'Пожаловаться' }))) return; try { await forum('report', { postId: p.id }); p.reported = true; toast('Спасибо, жалоба отправлена', 'ok'); } catch (e) { toast(e.message, 'err'); } } }, icon('flag'), 'Жалоба'));
      if (p.mine) acts.append(h('button', { class: 'mini', onclick: async () => { if (!(await confirmSheet({ title: 'Удалить сообщение?', text: '', ok: 'Удалить', danger: true }))) return; try { await forum('del', { postId: p.id }); el.remove(); } catch (e) { toast(e.message, 'err'); } } }, icon('trash'), 'Удалить'));
      if (owner) {
        acts.append(h('button', { class: 'mini', onclick: async () => { try { await call('r2admin', { op: 'hidePost', id: p.id, hidden: !p.hidden }); p.hidden = !p.hidden; el.classList.toggle('is-hidden', p.hidden); toast(p.hidden ? 'Скрыто' : 'Показано', 'ok'); } catch (e) { toast(e.message, 'err'); } } }, icon('eye'), p.hidden ? 'Показать' : 'Скрыть'));
        if (!p.staff) acts.append(h('button', { class: 'mini', onclick: () => muteSheet(p) }, icon('lock'), 'Мьют'));
      }
      el.append(h('div', { class: 'ava' + (p.staff ? ' ava--staff' : '') }, (p.name[0] || '?').toUpperCase()),
        h('div', { class: 'bubble' }, h('div', { class: 'bubble__h' }, h('span', { class: 'bubble__n' + (p.staff ? ' staff' : '') }, p.name), h('span', { class: 'muted' }, fmtTime(p.at)), owner && p.reports ? h('span', { class: 'tag tag--bad' }, '⚑ ' + p.reports) : null),
          p.reply ? h('div', { class: 'quote' }, (p.reply.name ? p.reply.name + ': ' : '') + p.reply.text) : null,
          h('div', { class: 'bubble__t' }, p.text), acts));
      return el;
    }
    function muteSheet(p) {
      const s = sheet({ title: 'Заглушить ' + p.name, body: [h('div', { class: 'chips' }, [[10, '10 минут'], [60, '1 час'], [1440, 'Сутки'], [-1, 'Навсегда'], [0, 'Снять мьют']].map(([m, t]) => h('button', { class: 'chip', onclick: async () => { try { await call('r2admin', { op: 'mute', userId: p.userId, minutes: m, reason: 'решение организатора' }); toast(m === 0 ? 'Мьют снят' : 'Готово', 'ok'); s.close(); } catch (e) { toast(e.message, 'err'); } } }, t)))] });
    }
    const emptyEl = h('div', { class: 'empty' }, 'Здесь пока тихо. Напишите первым!');
    function add(posts, { prepend = false } = {}) {
      if (posts.length) emptyEl.remove();
      const frag = document.createDocumentFragment();
      for (const p of posts) {
        if (rows.has(p.id)) continue;
        const day = fmtDay(p.at);
        if (!prepend && day !== lastDay) { frag.append(h('div', { class: 'day' }, day)); lastDay = day; }
        const el = msgEl(p); rows.set(p.id, el); frag.append(el);
        lastId = Math.max(lastId, p.id); firstId = firstId ? Math.min(firstId, p.id) : p.id;
      }
      if (prepend) chat.insertBefore(frag, chat.firstChild); else chat.append(frag);
    }
    const nearBottom = () => window.innerHeight + window.scrollY > document.body.scrollHeight - 220;

    const first = await forum('posts', { topicId: topic.id });
    add(first.posts); olderBtn.classList.toggle('hide', !first.more);
    olderBtn.onclick = async () => { try { const d = await forum('posts', { topicId: topic.id, before: firstId }); const keep = document.body.scrollHeight; add(d.posts, { prepend: true }); window.scrollBy(0, document.body.scrollHeight - keep); olderBtn.classList.toggle('hide', !d.more); } catch (e) { toast(e.message, 'err'); } };

    const ta = h('textarea', { class: 'textarea', rows: 1, maxlength: 500, placeholder: topic.locked && !owner ? 'Тема закрыта' : 'Напишите сообщение…', disabled: topic.locked && !owner ? true : null, 'aria-label': 'Сообщение' });
    const cnt = h('span', { class: 'small muted' }, '0 / 500');
    const reply = h('div', { class: 'replybar hide' });
    const sendBtn = h('button', { class: 'btn btn--gold', 'aria-label': 'Отправить', disabled: topic.locked && !owner ? true : null }, icon('send'));
    function setReply(p) { replyTo = p; reply.classList.remove('hide'); reply.replaceChildren(icon('reply'), h('span', { class: 'grow small' }, 'Ответ для ' + p.name + ': ' + p.text.slice(0, 60)), h('button', { class: 'iconbtn', 'aria-label': 'Отменить ответ', onclick: () => { replyTo = null; reply.classList.add('hide'); } }, icon('close'))); ta.focus(); }
    ta.addEventListener('input', () => { cnt.textContent = ta.value.length + ' / 500'; ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; });
    async function poll() {
      if (document.visibilityState !== 'visible' || busy) return;
      try {
        const d = await forum('posts', { topicId: topic.id, after: lastId });
        const stick = nearBottom();
        for (const id of d.gone || []) { rows.get(id)?.remove(); rows.delete(id); }
        if (d.posts.length) { add(d.posts); if (stick) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }
      } catch (e) { /* временная ошибка сети — подождём следующего опроса */ }
    }
    sendBtn.onclick = async () => {
      const text = ta.value.trim(); if (!text || busy) return;
      busy = true; sendBtn.disabled = true;
      try {
        await forum('post', { topicId: topic.id, text, replyTo: replyTo?.id });
        ta.value = ''; cnt.textContent = '0 / 500'; ta.style.height = 'auto'; replyTo = null; reply.classList.add('hide'); sentAt = Date.now();
        busy = false; await poll(); window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      } catch (e) { toast(e.message, 'err'); }
      busy = false; setTimeout(() => { sendBtn.disabled = topic.locked && !owner; }, 1500);
    };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendBtn.click(); } });
    const timer = setInterval(poll, 5000); onLeave(() => clearInterval(timer));

    const el = h('div', { class: 'screen' }, top(topic.title), topic.descr ? h('p', { class: 'muted small', style: { marginBottom: '10px' } }, topic.descr) : null,
      olderBtn, chat, !first.posts.length ? emptyEl : null,
      h('div', { class: 'composer' }, reply, h('div', { class: 'composer__row' }, ta, sendBtn), h('div', { class: 'row row--between' }, cnt, h('span', { class: 'small muted' }, 'Ctrl+Enter — отправить'))));
    setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 50);
    return el;
  };
}
