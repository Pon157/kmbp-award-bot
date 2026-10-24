import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const html = fs.readFileSync('../app/r1/index.html', 'utf8').replace(/<script src="https:[^>]*><\/script>/, '');
const js = fs.readFileSync('../app/r1/app.js', 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Тестовые данные живут здесь, а не в боевом app.js.
const home = (banner) => ({
  award: { name: 'Премия года КМБП', community: 'Комьюнити Ботов Поддержки', round2: '2 тур будет проходить здесь (в миниаппе) с 1 ноября 2026',
    about: 'Премия года КМБП — ежегодная премия.\n\nПервый тур — выдвижение.' },
  banner, appsOpen: true, limitMode: 'nomination', sponsorNominations: [], sponsorBanners: [],
  nominations: [
    { id: 1, title: 'Бот года', kind: 'bot', open: true, submitted: null },
    { id: 2, title: 'Проект года', kind: 'project', open: true, submitted: { title: 'Demo', username: 'demo_proj' } },
    { id: 3, title: 'Личность года', kind: 'person', open: true, submitted: null },
    { id: 4, title: 'Событие года', kind: 'event', open: false, submitted: null }],
  news: [{ id: 1, pinned: true, at: 1791700000, text: 'Открыт приём заявок!\nПодробности — в канале сообщества. Секрет: тут спойлер.',
    entities: [{ type: 'bold', offset: 0, length: 20 }, { type: 'text_link', offset: 37, length: 6, url: 'https://t.me/telegram' }, { type: 'spoiler', offset: 68, length: 7 }] }],
  links: [{ id: 1, title: 'Канал сообщества', url: 'https://t.me/kmbp', kind: 'channel' }],
  user: { id: 1, name: 'Demo' },
});
const nomination = (id) => ({
  id, title: 'Бот года', kind: 'bot', open: true, blockedBy: null,
  labels: { title: 'Название бота', username: 'Юзернейм бота', description: 'Описание бота', titleHint: 'Как называется бот', usernameHint: 'username_bot', descHint: 'Чем бот помогает' },
  limits: { title: 80, desc: 1500, descMin: 20 },
  questions: [{ id: 1, text: 'Сколько пользователей у бота?', required: true, maxLen: 500 }], mine: null,
});
let PRESET = 'full', FXSTUB = null, TRANSPORT = 'serverless', FETCHERR = null, APIBASE = ''; // TRANSPORT: 'serverless' (платформа) или 'fetch' (свой сервер) // версия мини-аппа, «уже выбранная» на устройстве (null — первый запуск)
function boot(search, banner, withTg = true, homeExtras = {}, dataExtras = {}) {
  const dom = new JSDOM(html, { url: 'https://app1.tgcloud.ai/' + search, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.__openedLinks = []; w.__calls = [];
  w.scrollTo = () => {}; w.Element.prototype.scrollIntoView = () => {};
  if (PRESET) w.localStorage.setItem('kmbp_mode', PRESET);
  if (APIBASE) w.KMBP_API = APIBASE;
  if (FXSTUB) w.FX = FXSTUB(w);
  if (withTg) {
    const homeData = Object.assign(home(banner), homeExtras);
    const data = Object.assign({ getHome: homeData, getNomination: nomination(1), submit: { ok: true, id: 55, created: true }, getBanner: { src: 'data:image/jpeg;base64,AAAA' },
      getSponsorBanner: { src: 'data:image/jpeg;base64,SPONSOR' }, getCaptcha: { id: 'c1', src: 'data:image/svg+xml;base64,AAAA' }, publishApp: { ok: true } }, dataExtras);
    w.Telegram = { WebApp: { initData: 'x', openLink: (url) => w.__openedLinks.push(url),
      Serverless: { call: (name, input, cb) => { w.__calls.push({ name, input }); setTimeout(() => cb(null, data[name]), 20); } } } };
    if (TRANSPORT === 'fetch') {                       // свой сервер: платформенного Serverless нет, вызовы идут через fetch
      delete w.Telegram.WebApp.Serverless; w.__fetches = [];
      w.fetch = (url, init) => {
        w.__fetches.push({ url: String(url), init });
        if (FETCHERR === 'network') return Promise.reject(new TypeError('Failed to fetch'));
        if (FETCHERR === 'html') return Promise.resolve({ status: 502, json: () => Promise.reject(new Error('not json')) });
        const val = data[String(url).split('/api/')[1]];
        if (val && val.__error) return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: false, description: val.description, parameters: val.parameters }) });
        return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, result: val === undefined ? null : val }) });
      };
    }
  }
  w.eval(js);
  return w;
}

// вне Telegram: чистая страница без демо-данных
{
  const o = boot('', null, false);
  await wait(100);
  const t = o.document.body.textContent;
  assert.match(t, /Откройте бота премии/);
  assert.ok(!/Demo|Канал сообщества|Секрет|Бот года/.test(t), 'демо-данных на сайте нет');
  assert.equal(o.document.querySelectorAll('.nom, .post, .hero').length, 0);
}

const w = boot('?nom=1', { src: 'img/hero.jpg', custom: false });
await wait(700);
const d = w.document;
assert.ok(d.querySelector('#formbox'), 'форма номинации открыта по ?nom=1');
assert.equal(d.querySelector('[data-f=title] .field__label').textContent, 'Название бота');
// пустая отправка → ошибки
d.querySelector('#send').click();
assert.equal(d.querySelectorAll('.field.bad').length, 5); // title, username, description, q1, captcha
assert.ok(d.querySelector('#cap-img').getAttribute('src'), 'картинка капчи загружена с сервера');
// корректная отправка
const set = (n, v) => { d.querySelector(`[name="${n}"]`).value = v; };
set('title', 'Hero'); set('username', 'https://t.me/Hero_bot'); set('description', 'Длинное описание бота больше двадцати символов'); set('q1', '1000'); set('captcha', 'ABCDE');
d.querySelector('#send').click();
await wait(500);
assert.match(d.querySelector('.done h1').textContent, /Заявка отправлена/);
{
  const sub = w.__calls.find((c) => c.name === 'submit').input;
  assert.equal(JSON.stringify(sub.captcha), JSON.stringify({ id: 'c1', answer: 'ABCDE' }), 'код капчи уходит на сервер');
  assert.equal(sub.defer, true, 'клиент просит ответить сразу');
  await wait(100);
  assert.equal(JSON.stringify(w.__calls.find((c) => c.name === 'publishApp').input), JSON.stringify({ id: 55 }), 'публикация карточки идёт отдельным вызовом');
}
assert.ok(!d.querySelector('.done__donate'), 'обычная подача: баннера доната нет');
d.querySelector('[data-back]').click();
await wait(500);
assert.equal(d.querySelector('.hero img').getAttribute('src'), 'img/hero.jpg');
assert.ok(d.querySelector('.hero .spark'), 'у стандартного баннера есть блёстки');
assert.equal(d.querySelectorAll('.nom').length, 4);
assert.match(d.body.textContent, /2 тур будет проходить здесь \(в миниаппе\) с 1 ноября 2026/);
// новость с форматированием
const post = d.querySelector('.post__body').innerHTML;
assert.match(post, /<strong>Открыт приём заявок!<\/strong>/);
assert.match(post, /<a href="https:\/\/t.me\/telegram">/);
assert.match(post, /class="spoiler"/);
// запрещённые эмодзи/юникод в разметке интерфейса
const ui = d.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g, '');
const emoji = ui.match(/\p{Extended_Pictographic}/gu);
assert.equal(emoji, null, 'эмодзи в интерфейсе: ' + emoji);

// Баннер спонсора открывает HTTPS-ссылку, а sponsor forms appear as a separate section.
{
  const c = boot('', null, true, {
    sponsorBanners: [{ id: 7, title: 'Партнёр', targetUrl: 'https://sponsor.example/' }],
    sponsorNominations: [{ id: 11, title: 'Спонсорская номинация — Бот', kind: 'bot', open: true, submitted: null }],
  });
  await wait(500);
  const card = c.document.querySelector('.sponsor-card');
  assert.ok(card);
  assert.equal(c.document.querySelector('[data-sponsor-banner="7"]').getAttribute('src'), 'data:image/jpeg;base64,SPONSOR');
  assert.equal(c.document.querySelectorAll('#sponsors .nom').length, 1);
  card.click();
  assert.deepEqual(c.__openedLinks, ['https://sponsor.example/']);
}

// своё фото: блок появляется сразу, картинка догружается отдельным запросом, без блёсток
{
  const c = boot('', { custom: true, lazy: true });
  await wait(400);
  assert.equal(c.document.querySelector('.hero img').getAttribute('src'), 'data:image/jpeg;base64,AAAA');
  assert.equal(c.document.querySelectorAll('.hero .spark').length, 0);
}
// баннер выключен: блока нет, отступ сверху есть
{
  const c = boot('', null);
  await wait(300);
  assert.equal(c.document.querySelectorAll('.hero').length, 0);
  assert.ok(c.document.querySelector('.pillars--top'));
  assert.equal(c.document.querySelectorAll('.nom').length, 4);
}
// битая картинка баннера убирает блок
{
  const c = boot('', { src: 'img/hero.jpg', custom: false });
  await wait(300);
  c.document.querySelector('.hero img').dispatchEvent(new c.Event('error'));
  assert.equal(c.document.querySelectorAll('.hero').length, 0);
  assert.ok(c.document.querySelector('.pillars--top'));
}

// Баннер доната на экране успеха: дубль настоящего спонсорского баннера (ссылка на donationalerts)
{
  const DA = { id: 9, targetUrl: 'https://www.donationalerts.com/r/vitechek67' };
  const other = { id: 8, targetUrl: 'https://sponsor.example/' };
  const fill = async (c) => {
    const dd = c.document;
    const set2 = (n, v) => { dd.querySelector(`[name="${n}"]`).value = v; };
    set2('title', 'Hero'); set2('username', 'Hero_bot'); set2('description', 'Длинное описание бота больше двадцати символов'); set2('q1', '1000');
    if (dd.querySelector('[name="captcha"]')) set2('captcha', 'ABCDE');
    dd.querySelector('#send').click(); await wait(500);
  };
  // 1) подача прямо в спонсорскую подноминацию → баннер есть, фото и ссылка те же
  {
    const c = boot('?nom=1', null, true, { sponsorBanners: [other, DA] }, { getNomination: { ...nomination(1), sponsorType: 'bot' }, submit: { ok: true, id: 55, created: true, imported: 2, sponsorNomination: null } });
    await wait(700); await fill(c);
    const card = c.document.querySelector('.done__donate .sponsor-card');
    assert.ok(card, 'спонсорская подача: баннер доната на экране успеха');
    assert.equal(card.getAttribute('data-sponsor-url'), DA.targetUrl);
    await wait(100);
    assert.equal(c.document.querySelector('.done__donate [data-sponsor-banner="9"]').getAttribute('src'), 'data:image/jpeg;base64,SPONSOR');
    card.click(); assert.deepEqual(c.__openedLinks, [DA.targetUrl]);
  }
  // 2) обычная номинация, но юзернейм совпал со спонсорской → строка «Ваш голос ушёл…» и баннер
  {
    const c = boot('?nom=1', null, true, { sponsorBanners: [DA] }, { submit: { ok: true, id: 56, created: true, sponsorNomination: { id: 11, title: 'Спонсорская номинация — Бот' } } });
    await wait(700); await fill(c);
    assert.match(c.document.querySelector('.done').textContent, /Ваш голос ушёл в спонсорскую номинацию: Спонсорская номинация — Бот/);
    assert.ok(c.document.querySelector('.done__donate .sponsor-card'), 'совпадение со спонсорской: баннер тоже есть');
  }
  // 3) обычная подача без совпадения → ни строки, ни баннера
  {
    const c = boot('?nom=1', null, true, { sponsorBanners: [DA] }, { submit: { ok: true, id: 57, created: true, sponsorNomination: null } });
    await wait(700); await fill(c);
    assert.ok(!c.document.querySelector('.done__donate'), 'без спонсорской: баннера нет');
    assert.ok(!/Ваш голос ушёл/.test(c.document.querySelector('.done').textContent));
  }
  // 4) спонсорская подача, но баннера доната в админке нет → просто без баннера, без ошибок
  {
    const c = boot('?nom=1', null, true, { sponsorBanners: [other] }, { getNomination: { ...nomination(1), sponsorType: 'bot' } });
    await wait(700); await fill(c);
    assert.match(c.document.querySelector('.done h1').textContent, /Заявка отправлена/);
    assert.ok(!c.document.querySelector('.done__donate'));
  }
}

// Подсказки юзернеймов в форме
{
  const c = boot('?nom=1', null, true, {}, { suggestUsernames: { items: ['hero_bot', 'hero_two_bot', 'HERO'] } });
  await wait(700);
  const dd = c.document, inp = dd.querySelector('[name="username"]'), box = dd.querySelector('#suggest');
  const type = async (v) => { inp.value = v; inp.dispatchEvent(new c.Event('input', { bubbles: true })); await wait(450); };
  const reqs = () => c.__calls.filter((x) => x.name === 'suggestUsernames');
  assert.ok(box && box.hidden, 'список подсказок скрыт, пока ничего не введено');
  await type('h');
  assert.equal(reqs().length, 0, 'меньше 2 символов — запроса нет');
  await type('he');
  assert.equal(reqs().length, 1);
  assert.equal(JSON.stringify(reqs()[0].input), JSON.stringify({ nominationId: 1, q: 'he' }));
  assert.equal(box.hidden, false);
  assert.equal([...box.querySelectorAll('.suggest__item')].map((b) => b.textContent).join(','), '@hero_bot,@hero_two_bot,@HERO');
  await type('https://t.me/Hero_x'); // ссылка нормализуется до юзернейма
  assert.equal(reqs()[reqs().length - 1].input.q, 'hero_x');
  await type('hero_bot'); // точное совпадение не предлагаем само себе
  assert.ok(!([...box.querySelectorAll('.suggest__item')].some((b) => b.dataset.u === 'hero_bot')));
  await type('he');
  box.querySelector('.suggest__item[data-u="hero_two_bot"]').click();
  assert.equal(inp.value, 'hero_two_bot', 'выбор подставляет юзернейм в поле');
  assert.ok(box.hidden, 'после выбора список скрыт');
  const before = reqs().length;
  await wait(450);
  assert.equal(reqs().length, before, 'подстановка не запускает новый запрос');
  await type('he#'); // недопустимые символы — запроса нет и список скрыт
  assert.equal(reqs().length, before);
  assert.ok(box.hidden);
}

// Монеты: карточка на главной и экран успеха
{
  const fill_ = async (c) => {
    const dd = c.document, set2 = (n, v) => { dd.querySelector(`[name="${n}"]`).value = v; };
    set2('title', 'Hero'); set2('username', 'Hero_bot'); set2('description', 'Длинное описание бота больше двадцати символов'); set2('q1', '1000');
    if (dd.querySelector('[name="captcha"]')) set2('captcha', 'ABCDE');
    dd.querySelector('#send').click(); await wait(500);
  };
  // прогресс 2 из 5
  let c = boot('', null, true, { coins: { enabled: true, reward: 35, balance: 0, earned: false, required: 5, covered: 2 } });
  await wait(300);
  let card = c.document.querySelector('.coin-card');
  assert.ok(card, 'карточка монет на главной');
  assert.match(card.textContent, /35 монет/); assert.match(card.textContent, /2 из 5/); assert.match(card.textContent, /осталось 3/);
  assert.equal(card.getAttribute('style').replace(/\s/g, ''), '--to:102', 'кольцо заполнено на 40%');
  assert.ok(!card.classList.contains('is-done'));
  // награда получена
  c = boot('', null, true, { coins: { enabled: true, reward: 35, balance: 35, earned: true, required: 5, covered: 5 } });
  await wait(300); card = c.document.querySelector('.coin-card');
  assert.ok(card.classList.contains('is-done')); assert.match(card.textContent, /Награда получена/); assert.match(card.textContent, /Баланс/);
  assert.equal(card.getAttribute('style').replace(/\s/g, ''), '--to:0');
  // отключено / нет данных — карточки нет
  for (const coins of [null, { enabled: false, reward: 35, balance: 0, earned: false, required: 0, covered: 0 }]) {
    c = boot('', null, true, { coins }); await wait(300);
    assert.ok(!c.document.querySelector('.coin-card'), 'карточка скрыта, когда монет нет');
  }
  // экран успеха: награда
  c = boot('?nom=1', null, true, {}, { submit: { ok: true, id: 55, created: true, coins: { enabled: true, reward: 35, awarded: 35, balance: 35, earned: true, required: 5, covered: 5 } } });
  await wait(700); await fill_(c);
  assert.match(c.document.querySelector('.done__coins').textContent, /\+35/); assert.match(c.document.querySelector('.done__coins').textContent, /Баланс: 35/);
  assert.equal(c.document.getElementById('coinNum').textContent, '35');
  // экран успеха: прогресс, награды ещё нет
  c = boot('?nom=1', null, true, {}, { submit: { ok: true, id: 55, created: true, coins: { enabled: true, reward: 35, awarded: 0, balance: 0, earned: false, required: 5, covered: 3 } } });
  await wait(700); await fill_(c);
  assert.ok(!c.document.querySelector('.done__coins'));
  assert.match(c.document.querySelector('.done__prog').textContent, /3 из 5/); assert.match(c.document.querySelector('.done__prog').textContent, /Ещё 2/);
  assert.equal(c.document.querySelector('.pbar i').getAttribute('style').replace(/\s/g, ''), '--w:60%');
  // экран успеха: монет нет (старый сервер / нет таблиц) — просто успех
  c = boot('?nom=1', null, true, {}, { submit: { ok: true, id: 55, created: true, coins: null } });
  await wait(700); await fill_(c);
  assert.match(c.document.querySelector('.done h1').textContent, /Заявка отправлена/);
  assert.ok(!c.document.querySelector('.done__coins') && !c.document.querySelector('.done__prog'));
}

// Выбор версии: «Нормальная» / «Лёгкая»
{
  const sel = (c, q) => c.document.querySelector(q);
  const fxCalls = [];
  PRESET = null; FXSTUB = () => ({ enabled: true, setLite: (v) => fxCalls.push(['lite', v]), mode: (m) => fxCalls.push(['mode', m]), hero() {}, burst() {}, coins() {}, countUp() {} });
  // 1) первый запуск: сначала вопрос, данные не грузим и главную не рисуем
  let c = boot('', null);
  await wait(200);
  assert.ok(sel(c, '.modepick'), 'при первом запуске показан выбор версии');
  assert.equal(c.document.querySelectorAll('.mode').length, 2);
  assert.match(sel(c, '[data-mode="full"]').textContent, /Нормальная/); assert.match(sel(c, '[data-mode="lite"]').textContent, /Лёгкая/);
  assert.equal(c.document.querySelectorAll('.mode em').length, 1, 'ровно одна подсказка «Рекомендуем»');
  assert.ok(!sel(c, '.hero') && !c.__calls.some((x) => x.name === 'getHome'), 'главная не загружается до выбора');
  assert.ok(!c.document.documentElement.classList.contains('lite'));
  assert.ok(!c.document.querySelector('[data-modecancel]'), 'при первом запуске отмены нет');
  // 2) выбрали «Лёгкая»: сохранилось, класс включён, главная загрузилась
  sel(c, '[data-mode="lite"]').click(); await wait(300);
  assert.equal(c.localStorage.getItem('kmbp_mode'), 'lite');
  assert.ok(c.document.documentElement.classList.contains('lite'));
  assert.ok(sel(c, '.hero') || sel(c, '.pillars'), 'после выбора открылась главная');
  assert.ok(fxCalls.some((x) => x[0] === 'lite' && x[1] === true), 'движок анимаций получил команду «лёгкая»');
  assert.ok(!fxCalls.some((x) => x[0] === 'mode' && x[1] === 'landing'), 'в лёгкой версии движок на главной не запускается');
  assert.match(sel(c, '.foot__mode').textContent, /Версия: Лёгкая/);
  assert.ok(!c.document.body.classList.contains('intro'), 'в лёгкой версии нет интро');
  // 3) смена из подвала: выбор открывается, текущая отмечена, отмена возвращает на главную
  sel(c, '[data-modeopen]').click(); await wait(50);
  assert.ok(sel(c, '.modepick')); assert.match(sel(c, '[data-mode="lite"]').textContent, /Сейчас выбрано/);
  assert.ok(sel(c, '[data-modecancel]')); sel(c, '[data-modecancel]').click(); await wait(300);
  assert.ok(!sel(c, '.modepick') && sel(c, '.foot__mode'), 'отмена вернула на главную без изменений');
  assert.equal(c.localStorage.getItem('kmbp_mode'), 'lite');
  sel(c, '[data-modeopen]').click(); await wait(50); sel(c, '[data-mode="full"]').click(); await wait(300);
  assert.equal(c.localStorage.getItem('kmbp_mode'), 'full');
  assert.ok(!c.document.documentElement.classList.contains('lite'), 'после выбора «Нормальная» класс снят');
  assert.ok(fxCalls.some((x) => x[0] === 'lite' && x[1] === false));
  assert.match(sel(c, '.foot__mode').textContent, /Версия: Нормальная/);
  assert.ok(fxCalls.some((x) => x[0] === 'mode' && x[1] === 'landing'), 'в нормальной версии движок запущен');
  // 4) повторный запуск с сохранённым выбором: вопроса нет, лёгкая применена сразу
  PRESET = 'lite'; c = boot('', null); await wait(300);
  assert.ok(!sel(c, '.modepick') && sel(c, '.foot__mode'), 'выбор уже сделан — вопроса нет');
  assert.ok(c.document.documentElement.classList.contains('lite'));
  // 5) переход по кнопке из напоминания (?nom=1) при первом запуске: сначала выбор, потом форма
  PRESET = null; c = boot('?nom=1', null); await wait(200);
  assert.ok(sel(c, '.modepick') && !sel(c, '#formbox'));
  sel(c, '[data-mode="full"]').click(); await wait(400);
  assert.ok(sel(c, '#formbox'), 'после выбора открылась нужная форма');
  // 6) вне Telegram вопроса нет
  c = boot('', null, false); await wait(100);
  assert.ok(!sel(c, '.modepick') && /Мини-апп открывается внутри Telegram/.test(c.document.body.textContent));
  PRESET = 'full'; FXSTUB = null;
}

// Транспорт fetch (свой сервер, без платформенного Serverless)
{
  const sel = (c, q) => c.document.querySelector(q);
  TRANSPORT = 'fetch';
  let c = boot('', null); await wait(400);
  assert.ok(sel(c, '.hero') || sel(c, '.pillars'), 'главная отрисована через HTTP-вызовы');
  const f0 = c.__fetches.find((x) => /\/api\/getHome$/.test(x.url));
  assert.ok(f0, 'getHome вызван по HTTP'); assert.equal(f0.url, '/api/getHome'); assert.equal(f0.init.method, 'POST');
  assert.equal(f0.init.headers['X-Init-Data'], 'x', 'подпись Telegram уходит в заголовке'); assert.equal(f0.init.headers['Content-Type'], 'application/json'); assert.equal(f0.init.body, '{}');
  assert.ok(!c.__calls.some(() => true), 'платформенный Serverless не используется');
  // отдельный адрес API (мини-апп и API на разных доменах)
  APIBASE = 'https://api.example.com/'; c = boot('', null); await wait(400);
  assert.equal(c.__fetches.find((x) => /getHome$/.test(x.url)).url, 'https://api.example.com/api/getHome', 'адрес API можно задать отдельно (завершающий «/» не мешает)'); APIBASE = '';
  // ошибка сервера с кодом и полями доходит до формы
  c = boot('?nom=1', null, true, {}, { submit: { __error: true, description: 'Код с картинки неверный или устарел', parameters: { code: 'CAPTCHA', fields: { captcha: 'Код неверный — введите новый' } } } });
  await wait(600);
  const dd = c.document, set2 = (n, v) => { dd.querySelector(`[name="${n}"]`).value = v; };
  set2('title', 'Hero'); set2('username', 'Hero_bot'); set2('description', 'Длинное описание бота больше двадцати символов'); set2('q1', '1000'); set2('captcha', 'ABCDE');
  dd.querySelector('#send').click(); await wait(500);
  assert.ok(sel(c, '[data-f="captcha"].bad') || /неверн/.test(dd.body.textContent), 'ошибка сервера показана у поля');
  assert.ok(c.__fetches.some((x) => /\/api\/submit$/.test(x.url)));
  const sent = JSON.parse(c.__fetches.find((x) => /\/api\/submit$/.test(x.url)).init.body); assert.equal(sent.defer, true); assert.equal(sent.captcha.answer, 'ABCDE');
  // обрыв связи и не-JSON ответ: понятное сообщение, а не падение
  FETCHERR = 'network'; c = boot('', null); await wait(400);
  assert.match(c.document.body.textContent, /Нет связи с сервером/, 'при обрыве связи — понятный текст');
  FETCHERR = 'html'; c = boot('', null); await wait(400);
  assert.match(c.document.body.textContent, /не JSON|Сервер вернул/, 'ответ не JSON (например, страница прокси) — понятный текст');
  FETCHERR = null; TRANSPORT = 'serverless';
}

console.log('UI ok');
