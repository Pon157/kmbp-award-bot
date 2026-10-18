// Отправка и редактирование сообщений: rich → обычный HTML → без премиум-эмодзи.
import { api, BotApiError } from 'sdk';
import { toRich, toClassic, richMedia } from './doc.js';
import { emojiId, stripEmoji } from './emoji.js';

// ── Кнопки ────────────────────────────────────────────────────────────
// style: 'primary' | 'success' | 'danger'. emoji: имя из lib/emoji.js или числовой id премиум-эмодзи.
function btn(text, extra, o = {}) {
  const b = { text, ...extra };
  if (o.style) b.style = o.style;
  if (o.emoji) b.icon_custom_emoji_id = /^\d+$/.test(String(o.emoji)) ? String(o.emoji) : emojiId(o.emoji);
  if (!b.icon_custom_emoji_id) delete b.icon_custom_emoji_id;
  return b;
}
export const B = {
  cb:  (text, data, o) => btn(text, { callback_data: data }, o),
  web: (text, url, o)  => btn(text, { web_app: { url } }, o),
  url: (text, url, o)  => btn(text, { url }, o),
};

const stripMarkup = (m) => m && {
  inline_keyboard: m.inline_keyboard.map((row) => row.map((b) => {
    const { icon_custom_emoji_id, style, ...rest } = b; // eslint-disable-line no-unused-vars
    return rest;
  })),
};

const desc = (e) => String(e?.description || e?.message || e || '');
const isBad = (e) => e instanceof BotApiError && e.code === 400;

async function chain(attempts) {
  let last;
  for (const fn of attempts) {
    try { return await fn(); }
    catch (e) {
      if (isBad(e) && /not modified/i.test(desc(e))) return null;
      if (!isBad(e)) throw e;
      last = e;
      console.warn('send fallback:', desc(e));
    }
  }
  throw last;
}

const NOPREVIEW = { is_disabled: true };

const richMsg = (blocks) => {
  const media = richMedia(blocks);
  return media.length ? { html: toRich(blocks), media } : { html: toRich(blocks) };
};

export function send(chatId, blocks, rows, extra = {}) {
  const markup = rows ? { inline_keyboard: rows } : undefined;
  const classic = toClassic(blocks);
  return chain([
    () => api.sendRichMessage({ chat_id: chatId, rich_message: richMsg(blocks), reply_markup: markup, ...extra }),
    () => api.sendMessage({ chat_id: chatId, text: classic, parse_mode: 'HTML', reply_markup: markup, link_preview_options: NOPREVIEW, ...extra }),
    () => api.sendMessage({ chat_id: chatId, text: stripEmoji(classic), parse_mode: 'HTML', reply_markup: stripMarkup(markup), link_preview_options: NOPREVIEW, ...extra }),
  ]);
}

export async function edit(chatId, messageId, blocks, rows) {
  const markup = rows ? { inline_keyboard: rows } : undefined;
  const classic = toClassic(blocks);
  try {
    return await chain([
      () => api.editMessageText({ chat_id: chatId, message_id: messageId, rich_message: richMsg(blocks), reply_markup: markup }),
      () => api.editMessageText({ chat_id: chatId, message_id: messageId, text: classic, parse_mode: 'HTML', reply_markup: markup, link_preview_options: NOPREVIEW }),
      () => api.editMessageText({ chat_id: chatId, message_id: messageId, text: stripEmoji(classic), parse_mode: 'HTML', reply_markup: stripMarkup(markup), link_preview_options: NOPREVIEW }),
    ]);
  } catch (e) {
    if (isBad(e)) return send(chatId, blocks, rows); // сообщение нельзя править — шлём новое
    throw e;
  }
}

// Показать экран: если пришли из кнопки — правим то же сообщение, иначе шлём новое.
export const show = (ctx, blocks, rows) =>
  ctx.msgId ? edit(ctx.chatId, ctx.msgId, blocks, rows) : send(ctx.chatId, blocks, rows);

export async function toast(callbackId, text = '', alert = false) {
  try { await api.answerCallbackQuery({ callback_query_id: callbackId, text: text || undefined, show_alert: alert || undefined }); }
  catch (e) { console.warn('answerCallbackQuery', desc(e)); }
}

export const safe = async (fn) => { try { return await fn(); } catch (e) { console.warn('safe:', desc(e)); return null; } };
export const isForbidden = (e) => e instanceof BotApiError && (e.code === 403 || /blocked|deactivated|chat not found/i.test(desc(e)));
export const isRateLimit = (e) => e instanceof BotApiError && e.code === 429;
export { desc as errText };
