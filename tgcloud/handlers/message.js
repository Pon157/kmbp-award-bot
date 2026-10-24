import { api } from 'sdk';
import * as S from '../lib/store.js';
import { adminState, home as adminHome } from '../lib/admin.js';
import { homeScreen, bannedScreen } from '../lib/screens.js';
import { maybeBackup } from '../lib/backup.js';
import { runReminders } from '../lib/reminders.js';
import { parseRefParam, attachReferral, refScreen } from '../lib/referrals.js';
import { send, safe } from '../lib/tg.js';
import { D } from '../lib/doc.js';
import { em } from '../lib/emoji.js';
import { botStart } from '../lib/weblogin.js';

export default async function (message) {
  const from = message.from;
  if (!from || from.is_bot) return;
  await S.ensureSeed();

  const chat = message.chat;
  const m = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(message.text || '');
  const cmd = m ? m[1].toLowerCase() : null;
  const owner = await S.isOwner(from.id);

  // Привязка админ-чата: команду принимает только владелец, в любом чате.
  if (cmd === 'setchat') {
    if (!owner) return;
    await S.setSetting('admin_chat', String(chat.id));
    await safe(() => send(chat.id, [D.p(`${em('shield')} Админ-чат подключён. Новые заявки будут приходить сюда.`)]));
    return;
  }
  if (chat.type !== 'private') return; // в группах бот молчит

  const existed = await S.getUser(from.id);            // до touchUser: «новый» = бот видит его впервые
  await S.touchUser(from, { started: true });
  const c = { chatId: chat.id, userId: from.id, isOwner: owner, private: true };
  if (cmd === 'start' && !existed) { const rid = parseRefParam(m[2]); if (rid) await safe(() => attachReferral(from.id, rid)); }

  try {
    if (await S.isBanned(from.id, 'bot')) return await bannedScreen(c);

    if (cmd === 'start' && /^login_[A-Za-z0-9_-]{10,40}$/.test(m[2] || '')) { await S.clearState(from.id); return await botStart(from, chat.id, m[2].slice(6)); }   // вход на сайт
    if (cmd === 'cancel') { await S.clearState(from.id); return await homeScreen(c); }
    if (cmd === 'invite') { await S.clearState(from.id); return await refScreen(c); }
    if (cmd === 'admin' && owner) { await S.clearState(from.id); return await adminHome(c); }
    if (cmd) { await S.clearState(from.id); return await homeScreen(c); } // /start, /help, /menu …

    if (owner) {
      const st = await S.getState(from.id);
      if (st) return await adminState(c, message, st);
    }
    return await homeScreen(c);
  } finally {
    await safe(() => maybeBackup());
    await safe(() => runReminders());
  }
}
