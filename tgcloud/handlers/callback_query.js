import * as S from '../lib/store.js';
import { adminCb } from '../lib/admin.js';
import { homeScreen, myScreen, bannedScreen } from '../lib/screens.js';
import { maybeBackup } from '../lib/backup.js';
import { runReminders, setMuted } from '../lib/reminders.js';
import { refScreen } from '../lib/referrals.js';
import { D } from '../lib/doc.js';
import { toast, safe, errText, show, B } from '../lib/tg.js';

export default async function (cq) {
  const from = cq.from;
  const msg = cq.message;
  const data = cq.data || '';
  if (!from || !msg?.chat) return toast(cq.id);
  await S.ensureSeed();

  const owner = await S.isOwner(from.id);
  const c = {
    chatId: msg.chat.id, msgId: msg.message_id, userId: from.id,
    isOwner: owner, private: msg.chat.type === 'private', cbId: cq.id,
  };

  try {
    if (data.startsWith('a:')) {
      if (!owner) return await toast(cq.id, 'Только для владельцев', true);
      if (data.startsWith('a:bcgo')) await toast(cq.id, 'Отправляю…');
      await adminCb(c, data);
      return await toast(cq.id);
    }

    if (c.private) await S.touchUser(from);
    if (await S.isBanned(from.id, 'bot')) { await toast(cq.id); return await bannedScreen(c); }

    if (data === 'home') { await S.clearState(from.id); await homeScreen(c); }
    else if (data === 'my') await myScreen(c);
    else if (data === 'ref:me') await refScreen(c);
    else if (data === 'rm:off' || data === 'rm:on') {
      const off = data === 'rm:off';
      await setMuted(from.id, off);
      await show(c, [D.p(off ? 'Хорошо, напоминания о голосовании отключены.' : 'Напоминания включены: напомню через несколько дней, если останутся номинации без вашего голоса.')],
        [[off ? B.cb('Включить обратно', 'rm:on') : B.cb('Отключить', 'rm:off'), B.cb('‹ В меню', 'home')]]);
    }
    else if (data.startsWith('nc:')) return await toast(cq.id, 'Приём заявок в этой номинации сейчас недоступен', true);
    await toast(cq.id);
  } catch (e) {
    console.error('callback error', data, errText(e), e?.stack || '');
    await toast(cq.id, 'Что-то пошло не так, попробуйте ещё раз', true);
  } finally {
    await safe(() => maybeBackup());
    await safe(() => runReminders());
  }
}
